import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import {
	armOutboxResume,
	enqueueOutbox,
	getOutboxStore,
	pauseOutbox,
	startOutbox,
} from "../outbox/service";
import type { OutboxStore } from "../outbox/store";
import type { OutboxJob } from "../outbox/types";
import { clearSubmittedText, restoreDetachedDraft } from "./helpers/draft";
import { parseSubcommand } from "./helpers/parse";
import type {
	ParsedSlashCommand,
	SlashCommandResult,
	SlashCommandRuntime,
	SlashCommandSpec,
	TuiSlashCommandRuntime,
} from "./types";

export function resolveJobById(
	store: OutboxStore,
	selector: string,
): { job?: OutboxJob; error?: string } {
	const trimmed = selector.trim();
	if (!trimmed) return { error: "Job id cannot be empty" };
	const exact = store.get(trimmed);
	if (exact) return { job: exact };
	const matches = store.list().filter((j) => j.id.startsWith(trimmed));
	if (matches.length === 1) return { job: matches[0] };
	if (matches.length > 1)
		return {
			error: `Ambiguous job selector '${trimmed}'; matches ${matches.length} jobs`,
		};
	return { error: `Job not found: ${trimmed}` };
}

function parsePosition(posStr: string): { pos?: number; error?: string } {
	const pos = Number(posStr.trim());
	if (!Number.isInteger(pos) || pos < 1) {
		return { error: "Position must be a positive integer" };
	}
	return { pos };
}

export type OutboxSubcommandResult =
	| { ok: true; message: string }
	| { ok: false; error: string; isUsage?: boolean };

export async function executeOutboxMutation(
	verb: string,
	rest: string,
	store: OutboxStore,
): Promise<OutboxSubcommandResult> {
	if (verb === "run") {
		await startOutbox();
		return { ok: true, message: "Outbox armed and started." };
	}

	if (verb === "pause") {
		pauseOutbox();
		return { ok: true, message: "Outbox paused." };
	}

	if (verb === "cancel") {
		if (!rest.trim())
			return { ok: false, error: "Usage: /outbox cancel <id>", isUsage: true };
		const resolved = resolveJobById(store, rest);
		if (!resolved.job) return { ok: false, error: resolved.error! };
		store.cancel(resolved.job.id);
		return {
			ok: true,
			message: `Cancelled outbox job ${resolved.job.id.slice(0, 8)}.`,
		};
	}

	if (verb === "remove") {
		if (!rest.trim())
			return { ok: false, error: "Usage: /outbox remove <id>", isUsage: true };
		const resolved = resolveJobById(store, rest);
		if (!resolved.job) return { ok: false, error: resolved.error! };
		try {
			store.remove(resolved.job.id);
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
		return { ok: true, message: `Removed outbox job ${resolved.job.id.slice(0, 8)}.` };
	}

	if (verb === "retry") {
		if (!rest.trim())
			return { ok: false, error: "Usage: /outbox retry <id>", isUsage: true };
		const resolved = resolveJobById(store, rest);
		if (!resolved.job) return { ok: false, error: resolved.error! };
		store.retry(resolved.job.id);
		return {
			ok: true,
			message: `Retried outbox job ${resolved.job.id.slice(0, 8)}.`,
		};
	}

	if (verb === "move") {
		const parts = rest.trim().split(/\s+/);
		if (parts.length < 2 || !parts[0] || !parts[1]) {
			return {
				ok: false,
				error: "Usage: /outbox move <id> <position>",
				isUsage: true,
			};
		}
		const [idPart, posStr] = parts;
		const parsedPos = parsePosition(posStr);
		if (parsedPos.error)
			return { ok: false, error: parsedPos.error, isUsage: true };
		const resolved = resolveJobById(store, idPart);
		if (!resolved.job) return { ok: false, error: resolved.error! };
		store.move(resolved.job.id, parsedPos.pos!);
		return {
			ok: true,
			message: `Moved outbox job ${resolved.job.id.slice(0, 8)} to position ${parsedPos.pos}.`,
		};
	}

	if (verb === "edit") {
		const spaceIdx = rest.indexOf(" ");
		const id = spaceIdx === -1 ? rest.trim() : rest.slice(0, spaceIdx).trim();
		const text = spaceIdx === -1 ? "" : rest.slice(spaceIdx + 1).trim();
		if (!id || !text) {
			return {
				ok: false,
				error: "Usage: /outbox edit <id> <new text>",
				isUsage: true,
			};
		}
		const resolved = resolveJobById(store, id);
		if (!resolved.job) return { ok: false, error: resolved.error! };
		store.edit(resolved.job.id, { text });
		return {
			ok: true,
			message: `Updated outbox job ${resolved.job.id.slice(0, 8)}.`,
		};
	}

	return {
		ok: false,
		error: `Unknown /outbox subcommand: ${verb}. Usage: /outbox [add|resume|run|pause|cancel|remove|retry|move|edit]`,
		isUsage: true,
	};
}

function formatJobSummary(job: OutboxJob): string {
	const check = job.nextCheckAt
		? ` (recheck in ${Math.max(0, Math.ceil((job.nextCheckAt - Date.now()) / 1000))}s)`
		: "";
	const reason = job.reason
		? ` [${sanitizeText(job.reason).replace(/\s+/g, " ").trim()}]`
		: "";
	const session = sanitizeText(job.sessionName ?? job.sessionId.slice(0, 8))
		.replace(/\s+/g, " ")
		.trim();
	const preview = truncateToWidth(
		sanitizeText(job.text).replace(/\s+/g, " ").trim(),
		50,
	);
	return `#${job.position} [${job.state}] ${job.id.slice(0, 8)} (${session}, ${job.provider}/${job.model})${reason}${check}: ${preview}`;
}

async function handleOutboxAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	const store = getOutboxStore();

	if (!verb || verb === "list") {
		const jobs = store.list();
		const armed = store.isArmed();
		if (jobs.length === 0) {
			await runtime.output(`Outbox is empty (${armed ? "armed" : "paused"}).`);
			return;
		}
		const lines = [
			`Outbox (${armed ? "armed" : "paused"}): ${jobs.length} job${jobs.length === 1 ? "" : "s"}`,
			...jobs.map(formatJobSummary),
		];
		await runtime.output(lines.join("\n"));
		return;
	}

	if (verb === "resume") {
		if (rest.trim()) {
			await runtime.output("Usage: /outbox resume");
			return;
		}
		const job = await armOutboxResume(runtime.session);
		await runtime.output(`Armed resume #${job.position} when quota returns.`);
		return;
	}

	if (verb === "add") {
		const text = rest.trim();
		if (!text) {
			await runtime.output("Usage: /outbox add <message>");
			return;
		}
		const job = await enqueueOutbox(runtime.session, { text });
		await runtime.output(
			`Added job #${job.position} (${job.id.slice(0, 8)}) to outbox.`,
		);
		return;
	}

	const result = await executeOutboxMutation(verb, rest, store);
	await runtime.output(result.ok ? result.message : result.error);
}

async function handleOutboxTui(
	command: ParsedSlashCommand,
	runtime: TuiSlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (runtime.ctx.collabGuest) {
		runtime.ctx.showStatus("/outbox is host-only during a collab session");
		clearSubmittedText(runtime);
		return;
	}

	const { verb, rest } = parseSubcommand(command.args);
	const store = getOutboxStore();

	const onParseError = (message: string) => {
		if (runtime.draftDetached) {
			restoreDetachedDraft(
				runtime.ctx.editor,
				command.text,
				runtime.input?.images,
				runtime.input?.imageLinks,
			);
		}
		runtime.ctx.showWarning(message);
	};

	if (!verb || verb === "list") {
		clearSubmittedText(runtime);
		await runtime.ctx.showOutboxSelector();
		return;
	}

	if (verb === "resume") {
		if (rest.trim()) {
			onParseError("Usage: /outbox resume");
			return;
		}
		clearSubmittedText(runtime);
		try {
			const job = await armOutboxResume(runtime.ctx.session);
			runtime.ctx.showStatus(
				`Armed resume #${job.position} when quota returns.`,
			);
		} catch (error) {
			runtime.ctx.showError(
				error instanceof Error ? error.message : String(error),
			);
		}
		return;
	}

	if (verb === "add") {
		const text = rest.trim();
		if (!text) {
			onParseError("Usage: /outbox add <message>");
			return;
		}
		clearSubmittedText(runtime);
		await runtime.ctx.handleOutboxAddCommand(
			text,
			runtime.draftDetached ? { ...runtime.input, text } : undefined,
		);
		return;
	}

	const result = await executeOutboxMutation(verb, rest, store);
	if (!result.ok) {
		if (result.isUsage) onParseError(result.error);
		else {
			clearSubmittedText(runtime);
			runtime.ctx.showError(result.error);
		}
		return;
	}

	clearSubmittedText(runtime);
	runtime.ctx.showStatus(result.message);
}

export const BUILTIN_OUTBOX_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "outbox",
		description: "Manage outbox queue of messages waiting for quota reset",
		allowArgs: true,
		subcommandOptional: true,
		subcommands: [
			{
				name: "add",
				description: "Queue a message in outbox",
				usage: "<message>",
			},
			{
				name: "resume",
				description: "Resume existing chat work when quota returns",
			},
			{ name: "run", description: "Arm and start outbox processing" },
			{ name: "pause", description: "Pause outbox processing" },
			{ name: "cancel", description: "Cancel an outbox job", usage: "<id>" },
			{ name: "remove", description: "Delete an inactive outbox job and its saved images", usage: "<id>" },
			{
				name: "retry",
				description: "Retry an attention/failed outbox job",
				usage: "<id>",
			},
			{
				name: "move",
				description: "Move an outbox job to a new position",
				usage: "<id> <position>",
			},
			{
				name: "edit",
				description: "Edit an outbox job's text",
				usage: "<id> <new text>",
			},
		],
		inlineHint: "[add|resume|run|pause|cancel|remove|retry|move|edit]",
		handle: handleOutboxAcp,
		handleTui: handleOutboxTui,
	},
];
