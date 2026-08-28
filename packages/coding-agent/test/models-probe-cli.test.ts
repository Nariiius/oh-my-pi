import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	formatProbeResultsText,
	type ModelProbeResult,
	type ProbeModelFn,
	parseModelsProbeArgs,
	runModelProbes,
	runModelsProbe,
	runModelsProbeSlash,
} from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function makeModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:9/v1",
		provider,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}) as Model<Api>;
}

/**
 * Minimal registry stand-in: `runModelsProbe` only needs the availability,
 * extension-registration, and runtime-refresh surface (all no-ops here) when a
 * `probeModel` is injected.
 */
function fakeRegistry(models: Model<Api>[]): ModelRegistry {
	return {
		getAvailable: () => models,
		syncExtensionSources: () => {},
		clearSourceRegistrations: () => {},
		registerProvider: () => {},
		refreshRuntimeProviders: async () => {},
	} as unknown as ModelRegistry;
}

function resultFor(model: Model<Api>, ok: boolean, error?: string): ModelProbeResult {
	return {
		provider: model.provider,
		id: model.id,
		selector: `${model.provider}/${model.id}`,
		name: model.name,
		ok,
		latencyMs: 5,
		...(ok ? {} : { error: error ?? "probe failed" }),
	};
}

describe("runModelProbes", () => {
	test("probes with bounded concurrency and preserves input order", async () => {
		const models = [makeModel("prov-a", "m1"), makeModel("prov-a", "m2"), makeModel("prov-b", "m3")];
		const order: string[] = [];
		let active = 0;
		let maxActive = 0;
		let release: () => void = () => {};
		const allGates = new Promise<void>(resolve => {
			release = resolve;
		});
		const probeModel: ProbeModelFn = async model => {
			order.push(model.id);
			active += 1;
			maxActive = Math.max(maxActive, active);
			await allGates;
			active -= 1;
			return resultFor(model, true);
		};

		// Both workers start synchronously and block on the shared gate, so the
		// third model cannot begin before the first two finish.
		const pending = runModelProbes(models, probeModel, { concurrency: 2 });
		expect(order).toEqual(["m1", "m2"]);
		expect(maxActive).toBe(2);

		release();
		const results = await pending;
		expect(results.map(result => result.id)).toEqual(["m1", "m2", "m3"]);
		expect(maxActive).toBeLessThanOrEqual(2);
	});

	test("converts a throwing probe into a failed result", async () => {
		const models = [makeModel("prov-a", "m1")];
		const results = await runModelProbes(models, async () => {
			throw new Error("boom");
		});
		expect(results).toHaveLength(1);
		expect(results[0]!.ok).toBe(false);
		expect(results[0]!.error).toBe("boom");
	});

	test("reports start callbacks for every probed model", async () => {
		const models = [makeModel("prov-a", "m1"), makeModel("prov-a", "m2")];
		const started: string[] = [];
		await runModelProbes(models, model => Promise.resolve(resultFor(model, true)), {
			onStart: (_index, _total, model) => started.push(`${model.provider}/${model.id}`),
		});
		expect(started).toEqual(["prov-a/m1", "prov-a/m2"]);
	});

	test("reports every result through onResult in input order", async () => {
		const models = [makeModel("prov-a", "m1"), makeModel("prov-a", "m2")];
		const seen: Array<{ index: number; selector: string }> = [];
		await runModelProbes(models, model => Promise.resolve(resultFor(model, model.id === "m1")), {
			onResult: (index, result) => seen.push({ index, selector: result.selector }),
		});
		expect(seen).toEqual([
			{ index: 0, selector: "prov-a/m1" },
			{ index: 1, selector: "prov-a/m2" },
		]);
	});
});

describe("runModelsProbe", () => {
	describe("parseModelsProbeArgs", () => {
		test("parses pattern, --apply, and --timeout", () => {
			expect(parseModelsProbeArgs("agentrouter --apply --timeout 30")).toEqual({
				pattern: "agentrouter",
				apply: true,
				timeoutSeconds: 30,
			});
			expect(parseModelsProbeArgs("")).toEqual({ apply: false });
			expect(parseModelsProbeArgs("--apply")).toEqual({ apply: true });
			expect(parseModelsProbeArgs("agentrouter")).toEqual({ pattern: "agentrouter", apply: false });
		});

		test("ignores unknown flags and malformed --timeout values", () => {
			expect(parseModelsProbeArgs("agentrouter --json --timeout nope")).toEqual({
				pattern: "agentrouter",
				apply: false,
			});
			expect(parseModelsProbeArgs("a b --apply")).toEqual({ pattern: "a", apply: true });
		});
	});

	describe("runModelsProbeSlash", () => {
		let slashDir = "";

		beforeEach(async () => {
			slashDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "models-probe-slash-"));
		});

		afterEach(async () => {
			await removeSyncWithRetries(slashDir);
		});

		test("probes the session registry and applies working selectors", async () => {
			const settings = await Settings.loadIsolated({ cwd: slashDir, agentDir: slashDir });
			const registry = fakeRegistry([makeModel("prov-a", "works"), makeModel("prov-a", "dead")]);
			const probeModel: ProbeModelFn = async model => resultFor(model, model.id === "works", "timeout");

			const started: string[] = [];
			const run = await runModelsProbeSlash({
				modelRegistry: registry,
				settings,
				args: "prov-a --apply",
				onStart: (_index, _total, model) => started.push(`${model.provider}/${model.id}`),
				probeModel,
			});

			expect(run.working.map(result => result.selector)).toEqual(["prov-a/works"]);
			expect(run.applied).toBe(true);
			expect(run.applyRequested).toBe(true);
			expect(started).toEqual(["prov-a/works", "prov-a/dead"]);
			expect(settings.get("enabledModels")).toEqual(["prov-a/works"]);
		});

		test("reports an empty run for a non-matching pattern without applying", async () => {
			const settings = await Settings.loadIsolated({ cwd: slashDir, agentDir: slashDir });
			settings.set("enabledModels", ["prov-a/old"]);
			await settings.flush();
			const registry = fakeRegistry([makeModel("prov-a", "m1")]);
			const probeModel: ProbeModelFn = async model => resultFor(model, true);

			const run = await runModelsProbeSlash({
				modelRegistry: registry,
				settings,
				args: "nope --apply",
				probeModel,
			});

			expect(run.models).toHaveLength(0);
			expect(run.applied).toBe(false);
			expect(run.pattern).toBe("nope");
			expect(settings.get("enabledModels")).toEqual(["prov-a/old"]);
		});
	});

	describe("formatProbeResultsText", () => {
		test("renders results and the apply hint", () => {
			const results = [
				resultFor(makeModel("prov-a", "ok"), true),
				resultFor(makeModel("prov-a", "bad"), false, "HTTP 402: quota"),
			];
			const text = formatProbeResultsText(results, false);
			expect(text).toContain("OK   prov-a/ok");
			expect(text).toContain("FAIL prov-a/bad");
			expect(text).toContain("1/2 models responded");
			expect(text).toContain("--apply");
			expect(formatProbeResultsText(results, true)).toContain("applied 1 models to enabledModels");
		});
	});

	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "models-probe-"));
	});

	afterEach(async () => {
		await removeSyncWithRetries(tempDir);
	});

	function captureStdout(): { chunks: string[]; restore: () => void } {
		const chunks: string[] = [];
		const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
			chunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
			return true;
		});
		return { chunks, restore: () => spy.mockRestore() };
	}

	test("--apply writes the working selectors to enabledModels and reports them as JSON", async () => {
		const settings = await Settings.loadIsolated({ cwd: tempDir, agentDir: tempDir });
		const registry = fakeRegistry([
			makeModel("prov-a", "works"),
			makeModel("prov-a", "dead"),
			makeModel("prov-b", "ignored"),
		]);
		const probeModel: ProbeModelFn = async model => resultFor(model, model.id === "works", "400 bad model");

		const { chunks, restore } = captureStdout();
		try {
			await runModelsProbe({
				modelRegistry: registry,
				settings,
				cwd: tempDir,
				pattern: "prov-a",
				json: true,
				apply: true,
				disableExtensionDiscovery: true,
				probeModel,
			});
		} finally {
			restore();
		}

		const parsed = JSON.parse(chunks.join("")) as {
			probed: number;
			working: Array<{ selector: string; ok: boolean }>;
			failed: Array<{ selector: string; ok: boolean; error?: string; errorStatus?: number }>;
			applied: boolean;
		};
		expect(parsed.probed).toBe(2);
		expect(parsed.working.map(entry => entry.selector)).toEqual(["prov-a/works"]);
		expect(parsed.failed.map(entry => entry.selector)).toEqual(["prov-a/dead"]);
		expect(parsed.failed[0]!.error).toBe("400 bad model");
		expect(parsed.applied).toBe(true);

		expect(settings.get("enabledModels")).toEqual(["prov-a/works"]);
		// Persisted on disk: a fresh isolated instance reads it back.
		const onDisk = await Settings.loadIsolated({ cwd: tempDir, agentDir: tempDir });
		expect(onDisk.get("enabledModels")).toEqual(["prov-a/works"]);
	});

	test("without --apply reports the summary and leaves enabledModels untouched", async () => {
		const settings = await Settings.loadIsolated({ cwd: tempDir, agentDir: tempDir });
		const registry = fakeRegistry([makeModel("prov-a", "works"), makeModel("prov-a", "dead")]);
		const probeModel: ProbeModelFn = async model => resultFor(model, model.id === "works", "timeout");

		const { chunks, restore } = captureStdout();
		try {
			await runModelsProbe({
				modelRegistry: registry,
				settings,
				cwd: tempDir,
				disableExtensionDiscovery: true,
				probeModel,
			});
		} finally {
			restore();
		}

		const output = chunks.join("");
		expect(output).toContain("OK   prov-a/works");
		expect(output).toContain("FAIL prov-a/dead");
		expect(output).toContain("1/2 models responded");
		expect(output).toContain("--apply");
		expect(settings.get("enabledModels")).toEqual([]);
	});

	test("does not apply an empty working set", async () => {
		const settings = await Settings.loadIsolated({ cwd: tempDir, agentDir: tempDir });
		settings.set("enabledModels", ["prov-a/old"]);
		await settings.flush();
		const registry = fakeRegistry([makeModel("prov-a", "dead")]);
		const probeModel: ProbeModelFn = async model => resultFor(model, false, "error");

		const { chunks, restore } = captureStdout();
		try {
			await runModelsProbe({
				modelRegistry: registry,
				settings,
				cwd: tempDir,
				json: true,
				apply: true,
				disableExtensionDiscovery: true,
				probeModel,
			});
		} finally {
			restore();
		}

		const parsed = JSON.parse(chunks.join("")) as { applied: boolean; failed: unknown[] };
		expect(parsed.applied).toBe(false);
		expect(parsed.failed).toHaveLength(1);
		expect(settings.get("enabledModels")).toEqual(["prov-a/old"]);
	});

	test("reports an empty probe set when nothing matches", async () => {
		const settings = await Settings.loadIsolated({ cwd: tempDir, agentDir: tempDir });
		const registry = fakeRegistry([makeModel("prov-a", "m1")]);
		const probeModel: ProbeModelFn = async model => resultFor(model, true);

		const { chunks, restore } = captureStdout();
		try {
			await runModelsProbe({
				modelRegistry: registry,
				settings,
				cwd: tempDir,
				pattern: "nope",
				json: true,
				disableExtensionDiscovery: true,
				probeModel,
			});
		} finally {
			restore();
		}

		const parsed = JSON.parse(chunks.join("")) as {
			probed: number;
			working: unknown[];
			failed: unknown[];
			applied: boolean;
		};
		expect(parsed).toEqual({ probed: 0, working: [], failed: [], applied: false });
	});
});
