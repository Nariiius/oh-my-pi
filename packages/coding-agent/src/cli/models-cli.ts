/**
 * `omp models` — list, search, probe, and refresh available models.
 *
 * Subcommands:
 * - `ls` (default): list every available model grouped by provider.
 * - `find <substring>`: list models whose provider, id, or name contains the substring.
 * - `refresh`: force an online catalog re-fetch (ignoring the model cache TTL),
 *   then list. This is the supported replacement for `rm -rf ~/.omp/models.db`
 *   when a provider ships a new model that the 24h cache has not picked up yet.
 * - `probe [pattern] [--apply]`: send a minimal request to every (filtered)
 *   available model through omp's own provider routing and report which ones
 *   respond. `--apply` writes the working `provider/model` selectors to the
 *   `enabledModels` setting so only responding models stay selectable.
 *
 * `ls`/`find`/`probe` use the cache when fresh (`online-if-uncached`); only
 * `refresh` forces the network (`online`).
 */
import { type Api, completeSimple, type Effort, type FetchImpl, type Model } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getSupportedEfforts } from "@oh-my-pi/pi-catalog/model-thinking";
import { formatNumber, getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { ModelRegistry } from "../config/model-registry";
import { Settings } from "../config/settings";
import { discoverAndLoadExtensions, ExtensionRunner, emitSessionShutdownEvent } from "../extensibility/extensions";
import { discoverAuthStorage } from "../sdk";
import { SessionManager } from "../session/session-manager";
import { EventBus } from "../utils/event-bus";

export type ModelsAction = "ls" | "find" | "refresh" | "probe";

export interface ModelsCommandArgs {
	action: ModelsAction;
	/** Search substring for `find`, or optional filter for `ls`. */
	pattern?: string;
	flags: {
		json?: boolean;
		/** `probe`: write the models that responded to `enabledModels` in config. */
		apply?: boolean;
		/** `probe`: per-model timeout in seconds (default 20). */
		timeout?: number;
		/** CLI `-e <path>` extension paths to load before listing (issue #905). */
		extensions?: string[];
		/** Skip extension discovery; only load explicit `extensions`. */
		noExtensions?: boolean;
		/** Extra `config.yml` overlays to apply for this invocation. */
		config?: string[];
	};
}

/**
 * Known action keywords. Any other first token (e.g. `openai-codex`) is treated
 * as a provider/substring filter for the default `ls` view, so every provider
 * name doubles as an `omp models <provider>` shortcut.
 */
const KNOWN_ACTIONS: Record<string, ModelsAction> = {
	ls: "ls",
	list: "ls",
	find: "find",
	refresh: "refresh",
	probe: "probe",
};

/** Resolve the two positional args into an action + filter (provider names fall through to `ls`). */
export function resolveModelsArgs(
	first: string | undefined,
	second: string | undefined,
): { action: ModelsAction; pattern: string | undefined } {
	const known = first === undefined ? undefined : KNOWN_ACTIONS[first];
	if (known) {
		return { action: known, pattern: second };
	}
	return { action: "ls", pattern: first };
}

interface ModelJson {
	provider: string;
	id: string;
	selector: string;
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	/** Supported thinking efforts when the model thinks, otherwise null. */
	thinking: readonly Effort[] | null;
	input: ("text" | "image")[];
	cost: Model<Api>["cost"];
}

interface ModelsJson {
	models: ModelJson[];
}

function writeLine(line = ""): void {
	process.stdout.write(`${line}\n`);
}

function writeModelsConfigError(error: Error): void {
	writeLine(chalk.yellow("Warning: models.yml validation failed — custom providers disabled"));
	for (const line of error.message.split("\n")) {
		writeLine(`  ${line}`);
	}
	writeLine();
}

function formatLimit(n: number | null): string {
	return n === null ? "-" : formatNumber(n);
}

function byProviderThenId(left: Model<Api>, right: Model<Api>): number {
	const providerCmp = left.provider.localeCompare(right.provider);
	if (providerCmp !== 0) return providerCmp;
	return left.id.localeCompare(right.id);
}

/**
 * Apply the `ls`/`find`/`probe` filter: an exact provider name wins, otherwise
 * substring-match provider, id, `provider/id`, or name.
 */
export function filterModelsByPattern(models: Model<Api>[], pattern: string | undefined): Model<Api>[] {
	if (!pattern) return models;
	const needle = pattern.toLowerCase();
	let exactFound = false;
	let filtered = models.filter(m => m.provider.toLowerCase() === needle);
	if (filtered.length > 0) {
		exactFound = true;
	}
	if (!exactFound) {
		filtered = models.filter(
			model =>
				model.id.toLowerCase().includes(needle) ||
				model.provider.toLowerCase().includes(needle) ||
				`${model.provider}/${model.id}`.toLowerCase().includes(needle) ||
				model.name.toLowerCase().includes(needle),
		);
	}
	return filtered;
}

function toModelJson(model: Model<Api>): ModelJson {
	return {
		provider: model.provider,
		id: model.id,
		selector: `${model.provider}/${model.id}`,
		name: model.name,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens,
		reasoning: model.reasoning,
		thinking: model.thinking ? getSupportedEfforts(model) : null,
		input: model.input,
		cost: model.cost,
	};
}

type ColumnAlign = "left" | "right";

interface BoxColumn {
	header: string;
	align?: ColumnAlign;
}

/** Right- or left-pad a plain (ANSI-free) cell to `width` display columns. */
function padCell(text: string, width: number, align: ColumnAlign = "left"): string {
	const space = width - Bun.stringWidth(text);
	if (space <= 0) return text;
	const fill = " ".repeat(space);
	return align === "right" ? fill + text : text + fill;
}

/**
 * Render `rows` as a box-drawing table. Cells must be plain text (no ANSI); the
 * header row is bolded and the borders dimmed (both no-ops on non-TTY output).
 */
function boxTable(columns: BoxColumn[], rows: string[][]): string[] {
	const widths = columns.map((column, index) =>
		Math.max(Bun.stringWidth(column.header), ...rows.map(row => Bun.stringWidth(row[index] ?? ""))),
	);
	const bar = chalk.dim("│");
	const segments = widths.map(width => "─".repeat(width + 2));
	const renderRow = (cells: string[], bold: boolean): string => {
		const padded = columns.map((column, index) => {
			const cell = padCell(cells[index] ?? "", widths[index]!, column.align);
			return bold ? chalk.bold(cell) : cell;
		});
		return `${bar} ${padded.join(` ${bar} `)} ${bar}`;
	};
	const lines = [chalk.dim(`┌${segments.join("┬")}┐`)];
	lines.push(
		renderRow(
			columns.map(column => column.header),
			true,
		),
	);
	lines.push(chalk.dim(`├${segments.join("┼")}┤`));
	for (const row of rows) {
		lines.push(renderRow(row, false));
	}
	lines.push(chalk.dim(`└${segments.join("┴")}┘`));
	return lines;
}

/** `omp models ls`/`find`: provider-grouped listing (one box table per provider). */
function renderProviderModels(modelRegistry: ModelRegistry, pattern: string | undefined, json: boolean): void {
	const available = modelRegistry.getAvailable();
	const filtered = filterModelsByPattern(available, pattern);

	const configError = modelRegistry.getError();

	if (json) {
		if (configError) {
			process.stderr.write(
				`Warning: models.yml validation failed — custom providers disabled\n${configError.message}\n`,
			);
		}
		const output: ModelsJson = { models: filtered.slice().sort(byProviderThenId).map(toModelJson) };
		writeLine(JSON.stringify(output));
		return;
	}

	if (configError) {
		writeModelsConfigError(configError);
	}

	if (available.length === 0) {
		writeLine("No models available. Set API keys in environment variables.");
		return;
	}
	if (filtered.length === 0) {
		writeLine(`No models matching "${pattern}"`);
		return;
	}

	// One section per provider: bold heading + a box table of that provider's models.
	const byProvider = new Map<string, Model<Api>[]>();
	for (const model of filtered.slice().sort(byProviderThenId)) {
		let group = byProvider.get(model.provider);
		if (!group) {
			group = [];
			byProvider.set(model.provider, group);
		}
		group.push(model);
	}

	let firstProvider = true;
	for (const [provider, models] of byProvider) {
		if (!firstProvider) writeLine();
		firstProvider = false;
		writeLine(`${chalk.bold.cyan(provider)} ${chalk.dim(`(${models.length})`)}`);
		const rows = models.map(model => [
			model.id,
			formatLimit(model.contextWindow),
			formatLimit(model.maxTokens),
			model.thinking ? getSupportedEfforts(model).join(",") : model.reasoning ? "yes" : "-",
			model.input.includes("image") ? "yes" : "no",
		]);
		for (const line of boxTable(
			[
				{ header: "model" },
				{ header: "context", align: "right" },
				{ header: "max-out", align: "right" },
				{ header: "thinking" },
				{ header: "images" },
			],
			rows,
		)) {
			writeLine(line);
		}
	}
}

/**
 * Options for {@link runModelsListing}: render the catalog from a caller-supplied
 * registry. Loads extensions (CLI `-e` paths and configured `settings.extensions`)
 * and discovers their providers before rendering so extension-contributed models
 * appear (issue #905). The caller is responsible for refreshing built-in providers.
 */
export interface RunModelsListingOptions {
	modelRegistry: ModelRegistry;
	cwd: string;
	action?: ModelsAction;
	pattern?: string;
	json?: boolean;
	/** CLI-supplied extension paths (e.g. from `-e <path>`). */
	additionalExtensionPaths?: string[];
	/** Extension paths configured under `extensions:` in user settings. */
	settingsExtensions?: string[];
	/** Disabled extension ids from settings (`disabledExtensions`). */
	disabledExtensionIds?: string[];
	/** When true, exclude ambient factories and resolve only `additionalExtensionPaths`. */
	disableExtensionDiscovery?: boolean;
}

/**
 * Shared extension-loading options for `omp models` subcommands.
 */
export interface ModelsExtensionLoadOptions {
	cwd: string;
	/** CLI-supplied extension paths (e.g. from `-e <path>`). */
	additionalExtensionPaths?: string[];
	/** Extension paths configured under `extensions:` in user settings. */
	settingsExtensions?: string[];
	/** Disabled extension ids from settings (`disabledExtensions`). */
	disabledExtensionIds?: string[];
	/** When true, exclude ambient factories and resolve only `additionalExtensionPaths`. */
	disableExtensionDiscovery?: boolean;
}

/**
 * Load extensions and drain their provider/custom-API registrations into the
 * registry. Shared by `ls`/`find` and `probe` so both see the same
 * extension-contributed model set (issue #905). Returns the extension runner
 * (when any extension loaded) for the caller to shut down via
 * `emitSessionShutdownEvent`.
 */
async function loadModelsExtensions(
	modelRegistry: ModelRegistry,
	options: ModelsExtensionLoadOptions,
): Promise<ExtensionRunner | undefined> {
	const {
		cwd,
		additionalExtensionPaths = [],
		settingsExtensions = [],
		disabledExtensionIds = [],
		disableExtensionDiscovery = false,
	} = options;
	const eventBus = new EventBus();
	const configuredPaths = disableExtensionDiscovery
		? additionalExtensionPaths
		: [...additionalExtensionPaths, ...settingsExtensions];
	const extensionsResult = await discoverAndLoadExtensions(
		configuredPaths,
		cwd,
		eventBus,
		disableExtensionDiscovery ? undefined : disabledExtensionIds,
		{ ambient: !disableExtensionDiscovery, includeAmbientHooks: false },
	);
	const extensionRunner =
		extensionsResult.extensions.length > 0
			? new ExtensionRunner(
					extensionsResult.extensions,
					extensionsResult.runtime,
					cwd,
					SessionManager.inMemory(cwd),
					modelRegistry,
				)
			: undefined;

	for (const { path: extPath, error } of extensionsResult.errors) {
		process.stderr.write(`Failed to load extension: ${extPath}: ${error}\n`);
	}

	// Mirror sdk.ts: drain pending provider registrations into the registry.
	const activeSources = extensionsResult.extensions.map(extension => extension.path);
	modelRegistry.syncExtensionSources(activeSources);
	for (const sourceId of new Set(activeSources)) {
		modelRegistry.clearSourceRegistrations(sourceId);
	}
	for (const { name, config, sourceId } of extensionsResult.runtime.pendingProviderRegistrations) {
		modelRegistry.registerProvider(name, config, sourceId);
	}
	extensionsResult.runtime.pendingProviderRegistrations = [];
	return extensionRunner;
}

export async function runModelsListing(options: RunModelsListingOptions): Promise<void> {
	const {
		modelRegistry,
		cwd,
		action = "ls",
		pattern,
		json = false,
		additionalExtensionPaths = [],
		settingsExtensions = [],
		disabledExtensionIds = [],
		disableExtensionDiscovery = false,
	} = options;

	const extensionRunner = await loadModelsExtensions(modelRegistry, {
		cwd,
		additionalExtensionPaths,
		settingsExtensions,
		disabledExtensionIds,
		disableExtensionDiscovery,
	});
	try {
		// Discover runtime (extension) provider catalogs now that they are registered.
		await modelRegistry.refreshRuntimeProviders(action === "refresh" ? "online" : "online-if-uncached");
		renderProviderModels(modelRegistry, pattern, json);
	} finally {
		await emitSessionShutdownEvent(extensionRunner);
	}
}

// -----------------------------------------------------------------------------
// `omp models probe` — verify which models actually respond
// -----------------------------------------------------------------------------

export interface ModelProbeResult {
	provider: string;
	id: string;
	selector: string;
	name: string;
	ok: boolean;
	/** Round-trip latency of the probe request, in milliseconds. */
	latencyMs: number;
	error?: string;
	errorStatus?: number;
}

export type ProbeModelFn = (model: Model<Api>) => Promise<ModelProbeResult>;

/**
 * Minimal probe system prompt. Real sessions always carry a system prompt, and
 * some WAF-gated gateways (e.g. agentrouter.org) reject requests whose first
 * system prompt is not the canonical Pi harness header — the same header every
 * omp session starts with — so the probe sends it verbatim.
 */
const PROBE_SYSTEM_PROMPT =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

/**
 * Build the default per-model probe: a single-word request through omp's own
 * provider routing (`completeSimple`), which applies the exact auth, headers,
 * and wire format a real session would use. A model counts as responding when
 * the provider returns a non-error completion; HTTP/network/auth failures and
 * timeouts are surfaced on the result instead of throwing.
 */
export function createModelProbe(
	modelRegistry: ModelRegistry,
	timeoutMs: number,
	fetch?: FetchImpl,
	/** External abort (e.g. the probe view closing); combined with the per-model timeout. */
	signal?: AbortSignal,
): ProbeModelFn {
	return async model => {
		const startedAt = performance.now();
		const base = {
			provider: model.provider,
			id: model.id,
			selector: `${model.provider}/${model.id}`,
			name: model.name,
		};
		try {
			const response = await completeSimple(
				model,
				{
					systemPrompt: [PROBE_SYSTEM_PROMPT],
					messages: [{ role: "user", content: "Reply with the single word OK.", timestamp: Date.now() }],
				},
				{
					apiKey: modelRegistry.resolver(model),
					maxTokens: 16,
					disableReasoning: true,
					signal: signal
						? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal])
						: AbortSignal.timeout(timeoutMs),
					metadata: { purpose: "model-probe" },
					...(fetch ? { fetch } : {}),
				},
			);
			const latencyMs = Math.round(performance.now() - startedAt);
			if (response.stopReason === "error" || response.errorMessage) {
				return {
					...base,
					ok: false,
					latencyMs,
					error: response.errorMessage ?? "provider returned an error",
					errorStatus: response.errorStatus,
				};
			}
			return { ...base, ok: true, latencyMs };
		} catch (error) {
			const latencyMs = Math.round(performance.now() - startedAt);
			const message = error instanceof Error ? error.message : String(error);
			const status = AIError.status(error);
			return { ...base, ok: false, latencyMs, error: message, errorStatus: status ?? undefined };
		}
	};
}

const PROBE_CONCURRENCY = 8;

/**
 * Probe `models` with a bounded worker pool, preserving input order in the
 * returned results. `onStart` fires (once per model, before its probe) for
 * live progress output.
 */
export async function runModelProbes(
	models: Model<Api>[],
	probeModel: ProbeModelFn,
	options: {
		concurrency?: number;
		onStart?: (index: number, total: number, model: Model<Api>) => void;
		onResult?: (index: number, result: ModelProbeResult) => void;
	} = {},
): Promise<ModelProbeResult[]> {
	const concurrency = Math.max(1, Math.min(options.concurrency ?? PROBE_CONCURRENCY, models.length));
	const results = new Array<ModelProbeResult>(models.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (true) {
			const index = next++;
			if (index >= models.length) return;
			const model = models[index]!;
			options.onStart?.(index + 1, models.length, model);
			try {
				results[index] = await probeModel(model);
				options.onResult?.(index, results[index]!);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				results[index] = {
					provider: model.provider,
					id: model.id,
					selector: `${model.provider}/${model.id}`,
					name: model.name,
					ok: false,
					latencyMs: 0,
					error: message,
				};
				options.onResult?.(index, results[index]!);
			}
		}
	};
	await Promise.all(Array.from({ length: concurrency }, worker));
	return results;
}

/**
 * Parsed `/models probe`-style arguments (shared with the CLI flag form).
 */
export interface ModelsProbeArgs {
	/** First non-flag token; filters the probed model set. */
	pattern?: string;
	/** Write the working models to `enabledModels`. */
	apply: boolean;
	/** Per-model probe timeout in seconds; defaults to 20 when unset. */
	timeoutSeconds?: number;
}

/**
 * Parse `/models probe <args>` text: `[pattern] [--apply] [--timeout <secs>]`.
 * Unknown `--flags` are ignored; the first non-flag token is the filter.
 */
export function parseModelsProbeArgs(args: string): ModelsProbeArgs {
	const parsed: ModelsProbeArgs = { apply: false };
	const tokens = args.split(/\s+/).filter(Boolean);
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--apply") {
			parsed.apply = true;
			continue;
		}
		if (token === "--timeout") {
			const raw = tokens[index + 1];
			const seconds = raw === undefined ? Number.NaN : Number(raw);
			if (Number.isFinite(seconds) && seconds > 0) {
				parsed.timeoutSeconds = seconds;
				index += 1;
			}
			continue;
		}
		if (token.startsWith("--")) continue;
		if (parsed.pattern === undefined) parsed.pattern = token;
	}
	return parsed;
}

/**
 * Result of a probe run shared by the CLI (`omp models probe`) and the
 * `/models probe` slash command.
 */
export interface ModelsProbeRun {
	/** The (pattern-filtered) models that were probed; empty when nothing matched. */
	models: Model<Api>[];
	/** One result per probed model, in input order. */
	results: ModelProbeResult[];
	working: ModelProbeResult[];
	failed: ModelProbeResult[];
	/** Whether the working selectors were written to `enabledModels`. */
	applied: boolean;
	/** Whether `--apply` was requested (distinguishes "not applied" from "nothing to apply"). */
	applyRequested: boolean;
	/** The filter that produced `models` (for empty-state messages). */
	pattern?: string;
}

/**
 * Options for {@link runModelsProbeCore}: probe every (pattern-filtered)
 * available model with a minimal request. Rendering, extension loading, and
 * runtime-provider refresh are the caller's job, so the CLI and the TUI slash
 * command share one core.
 */
export interface ModelsProbeCoreOptions {
	modelRegistry: ModelRegistry;
	settings: Settings;
	pattern?: string;
	/** Write the models that responded to `enabledModels` in config. */
	apply?: boolean;
	/** Per-model probe timeout in seconds (default 20). */
	timeoutSeconds?: number;
	/** Test hook: replace the live `completeSimple` probe. */
	probeModel?: ProbeModelFn;
	/** Progress hook fired once per model before its probe starts. */
	onStart?: (index: number, total: number, model: Model<Api>) => void;
}

/**
 * Filter the registry's available models, probe them with a bounded pool, and
 * (optionally) write the working selectors to `enabledModels`. Never applies an
 * empty working set: a run where nothing responds leaves the setting untouched.
 */
export async function runModelsProbeCore(options: ModelsProbeCoreOptions): Promise<ModelsProbeRun> {
	const { modelRegistry, settings, pattern, apply = false, timeoutSeconds = 20 } = options;
	const models = filterModelsByPattern(modelRegistry.getAvailable(), pattern);
	if (models.length === 0) {
		return { models: [], results: [], working: [], failed: [], applied: false, applyRequested: apply, pattern };
	}

	const timeoutMs = Math.max(1, Math.round(timeoutSeconds * 1000));
	const probeModel = options.probeModel ?? createModelProbe(modelRegistry, timeoutMs);
	const results = await runModelProbes(models, probeModel, { onStart: options.onStart });

	let applied = false;
	if (apply) {
		const working = results
			.filter(result => result.ok)
			.map(result => result.selector)
			.sort((left, right) => left.localeCompare(right));
		if (working.length > 0) {
			settings.set("enabledModels", working);
			await settings.flush();
			applied = true;
		}
	}

	return {
		models,
		results,
		working: results.filter(result => result.ok),
		failed: results.filter(result => !result.ok),
		applied,
		applyRequested: apply,
		pattern,
	};
}

/** Plain (ANSI-free) probe report for transcript/status rendering in the TUI. */
export function formatProbeResultsText(results: ModelProbeResult[], applied: boolean): string {
	const lines = results.map(result => {
		const latency = formatProbeLatency(result.latencyMs);
		if (result.ok) {
			return `  OK   ${result.selector} (${latency})`;
		}
		const status = result.errorStatus !== undefined ? `HTTP ${result.errorStatus}: ` : "";
		return `  FAIL ${result.selector} (${latency}) — ${status}${result.error ?? "no response"}`;
	});

	const working = results.filter(result => result.ok).length;
	const summary = `${working}/${results.length} models responded`;
	if (applied) {
		lines.push("", `${summary} — applied ${working} models to enabledModels`);
	} else if (working < results.length) {
		lines.push("", `${summary}. Run with --apply to write the working models to enabledModels.`);
	} else {
		lines.push("", `${summary}.`);
	}
	return lines.join("\n");
}

/**
 * Options for {@link runModelsProbeSlash}: run the probe against a live
 * session's registry (extensions are already loaded) and report through a
 * caller-supplied emit hook (TUI status bar or ACP output).
 */
export interface ModelsProbeSlashOptions {
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** Raw text after `probe`, e.g. `agentrouter --apply`. */
	args: string;
	/** Progress hook fired once per model before its probe starts. */
	onStart?: (index: number, total: number, model: Model<Api>) => void;
	/** Test hook: replace the live `completeSimple` probe. */
	probeModel?: ProbeModelFn;
}

/** Run `/models probe` against a live session's registry. */
export async function runModelsProbeSlash(options: ModelsProbeSlashOptions): Promise<ModelsProbeRun> {
	const parsed = parseModelsProbeArgs(options.args);
	return runModelsProbeCore({
		modelRegistry: options.modelRegistry,
		settings: options.settings,
		pattern: parsed.pattern,
		apply: parsed.apply,
		timeoutSeconds: parsed.timeoutSeconds ?? 20,
		onStart: options.onStart,
		probeModel: options.probeModel,
	});
}

function formatProbeLatency(latencyMs: number): string {
	return `${(latencyMs / 1000).toFixed(1)}s`;
}

function toProbeJson(result: ModelProbeResult): Record<string, unknown> {
	return {
		provider: result.provider,
		id: result.id,
		selector: result.selector,
		name: result.name,
		ok: result.ok,
		latencyMs: result.latencyMs,
		...(result.ok ? {} : { error: result.error, errorStatus: result.errorStatus }),
	};
}

function renderProbeResults(results: ModelProbeResult[], json: boolean, applied: boolean): void {
	if (json) {
		const output = {
			probed: results.length,
			working: results.filter(result => result.ok).map(toProbeJson),
			failed: results.filter(result => !result.ok).map(toProbeJson),
			applied,
		};
		writeLine(JSON.stringify(output));
		return;
	}

	for (const result of results) {
		if (result.ok) {
			writeLine(
				`  ${chalk.green("OK")}   ${result.selector} ${chalk.dim(`(${formatProbeLatency(result.latencyMs)})`)}`,
			);
			continue;
		}
		const status = result.errorStatus !== undefined ? `HTTP ${result.errorStatus}: ` : "";
		writeLine(
			`  ${chalk.red("FAIL")} ${result.selector} ${chalk.dim(`(${formatProbeLatency(result.latencyMs)})`)} — ${status}${result.error ?? "no response"}`,
		);
	}

	const working = results.filter(result => result.ok).length;
	writeLine();
	const summary = `${chalk.bold(`${working}/${results.length}`)} models responded`;
	if (applied) {
		writeLine(`${summary} — ${chalk.green(`applied ${working} models to enabledModels`)}`);
	} else if (working < results.length) {
		writeLine(`${summary}. Run with --apply to write the working models to enabledModels.`);
	} else {
		writeLine(`${summary}.`);
	}
}

/**
 * Options for {@link runModelsProbe}: probe every (pattern-filtered) available
 * model with a minimal request and report which ones respond. Shares the
 * extension-loading bootstrap with {@link runModelsListing}.
 */
export interface RunModelsProbeOptions extends ModelsExtensionLoadOptions {
	modelRegistry: ModelRegistry;
	settings: Settings;
	pattern?: string;
	json?: boolean;
	/** Write the models that responded to `enabledModels` in config. */
	apply?: boolean;
	/** Per-model probe timeout in seconds (default 20). */
	timeoutSeconds?: number;
	/** Test hook: replace the live `completeSimple` probe. */
	probeModel?: ProbeModelFn;
}

export async function runModelsProbe(options: RunModelsProbeOptions): Promise<void> {
	const { modelRegistry, settings, pattern, json = false, apply = false, timeoutSeconds = 20 } = options;

	const extensionRunner = await loadModelsExtensions(modelRegistry, options);
	try {
		// Discover runtime (extension) provider catalogs now that they are registered.
		await modelRegistry.refreshRuntimeProviders("online-if-uncached");
		const previewCount = filterModelsByPattern(modelRegistry.getAvailable(), pattern).length;
		if (!json && previewCount > 0 && process.stderr.isTTY) {
			process.stderr.write(`Probing ${previewCount} models (${timeoutSeconds}s timeout each)…\n`);
		}

		const run = await runModelsProbeCore({
			modelRegistry,
			settings,
			pattern,
			apply,
			timeoutSeconds,
			probeModel: options.probeModel,
			onStart: json
				? undefined
				: (index, total, model) => writeLine(`[${index}/${total}] ${model.provider}/${model.id}`),
		});

		if (run.models.length === 0) {
			const message = pattern
				? `No models matching "${pattern}" to probe`
				: "No models available to probe. Set API keys in environment variables or run /login.";
			if (json) {
				writeLine(JSON.stringify({ probed: 0, working: [], failed: [], applied: false }));
			} else {
				writeLine(message);
			}
			return;
		}

		if (apply && !run.applied && !json) {
			writeLine(chalk.yellow("No models responded — enabledModels left unchanged."));
		}
		renderProbeResults(run.results, json, run.applied);
		recordProbeResults(settings, run.results);
	} finally {
		await emitSessionShutdownEvent(extensionRunner);
	}
}

/**
 * Entry point for the standalone `omp models` command: bootstraps auth storage,
 * settings, and the model registry, force/cache-refreshes built-in providers per
 * the chosen action, then delegates to {@link runModelsListing}.
 */
export async function runModelsCommand(command: ModelsCommandArgs): Promise<void> {
	const { action, pattern } = command;
	const json = command.flags.json ?? false;

	if (action === "find" && (!pattern || pattern.trim().length === 0)) {
		process.stderr.write("`omp models find` requires a search substring, e.g. `omp models find minimax`\n");
		process.exitCode = 1;
		return;
	}

	const cwd = getProjectDir();
	const authStorage = await discoverAuthStorage();
	try {
		const settings = await Settings.init({ cwd, configFiles: command.flags.config });
		const modelRegistry = new ModelRegistry(authStorage);

		if (action === "refresh" && !json && process.stderr.isTTY) {
			process.stderr.write("Refreshing models from all providers…\n");
		}
		await modelRegistry.refresh(action === "refresh" ? "online" : "online-if-uncached");

		if (action === "probe") {
			await runModelsProbe({
				modelRegistry,
				settings,
				cwd,
				pattern,
				json,
				apply: command.flags.apply ?? false,
				timeoutSeconds: command.flags.timeout ?? 20,
				additionalExtensionPaths: command.flags.extensions ?? [],
				settingsExtensions: settings.get("extensions") ?? [],
				disabledExtensionIds: settings.get("disabledExtensions") ?? [],
				disableExtensionDiscovery: Boolean(command.flags.noExtensions),
			});
			return;
		}

		const cliExtensionPaths = command.flags.extensions ?? [];
		await runModelsListing({
			modelRegistry,
			cwd,
			action,
			pattern,
			json,
			additionalExtensionPaths: cliExtensionPaths,
			settingsExtensions: settings.get("extensions") ?? [],
			disabledExtensionIds: settings.get("disabledExtensions") ?? [],
			disableExtensionDiscovery: Boolean(command.flags.noExtensions),
		});
	} finally {
		authStorage.close();
	}
}
/**
 * Persist a probe run's verdicts so the model browser can mark working models
 * (`storage.recordModelProbeResults`). No-op when the storage is unavailable;
 * failures are logged, never thrown.
 */
export function recordProbeResults(settings: Settings, results: readonly ModelProbeResult[]): void {
	const storage = settings.getStorage?.();
	if (!storage) return;
	storage.recordModelProbeResults(
		results.map(result => ({
			selector: result.selector,
			ok: result.ok,
			latencyMs: result.latencyMs,
			error: result.error,
		})),
	);
}
