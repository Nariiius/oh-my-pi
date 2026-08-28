import { beforeEach, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type ModelProbeResult, type ProbeModelFn, recordProbeResults } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ModelsProbePanelCallbacks,
	ModelsProbePanelComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/models-probe-panel";
import { getThemeByName, setThemeInstance } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { TUI } from "@oh-my-pi/pi-tui";

function makeModel(provider: string, id: string): Model<Api> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1:9/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
	}) as Model<Api>;
}

function resultFor(model: Model<Api>, ok: boolean, error?: string): ModelProbeResult {
	return {
		provider: model.provider,
		id: model.id,
		selector: `${model.provider}/${model.id}`,
		name: model.name,
		ok,
		latencyMs: ok ? 1200 : 5000,
		...(ok ? {} : { error: error ?? "timeout" }),
	};
}

/** Flush the microtask chain runModelProbes' workers settle on. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

let testTheme: Awaited<ReturnType<typeof getThemeByName>>;

function installTestTheme(): void {
	if (!testTheme) {
		throw new Error("Failed to load theme for ModelsProbePanel tests");
	}
	setThemeInstance(testTheme);
}

function createHarness(options: {
	models: Model<Api>[];
	autoApply?: boolean;
	probeModel?: ProbeModelFn;
	rows?: number;
}) {
	const requestRender = vi.fn();
	const tui = {
		requestRender,
		terminal: { rows: options.rows ?? 40 },
	} as unknown as TUI;
	const onClose = vi.fn(async () => {});
	const callbacks: ModelsProbePanelCallbacks = { onClose };
	const probeModel =
		options.probeModel ?? (async (model: Model<Api>) => resultFor(model, model.id !== "dead", "400 bad model"));
	const panel = new ModelsProbePanelComponent(
		tui,
		{
			models: options.models,
			probeModel,
			autoApply: options.autoApply ?? false,
		},
		callbacks,
	);
	return { tui, requestRender, onClose, panel };
}

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

describe("ModelsProbePanelComponent", () => {
	beforeEach(async () => {
		testTheme = await getThemeByName("dark");
		installTestTheme();
	});

	test("separates working rows from a collapsed failed summary", async () => {
		const { panel } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
		});
		await flushMicrotasks();

		const collapsed = normalize(panel.render(80));
		expect(collapsed).toContain("prov-a/works OK (1.2s)");
		expect(collapsed).not.toContain("prov-a/dead");
		expect(collapsed).toContain("Failed (1) — press f to show");
		expect(collapsed).toContain("1 working, 1 failed");

		panel.handleInput("f");
		const expanded = normalize(panel.render(80));
		expect(expanded).toContain("prov-a/dead FAIL (5.0s)");
		expect(expanded).not.toContain("Failed (1) — press f to show");
	});

	test("failed models are unselectable: space on them never enables them", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
		});
		await flushMicrotasks();

		// Cursor on the working row: toggle it off, then move to the failed summary.
		panel.handleInput(" ");
		panel.handleInput("\x1b[B");
		panel.handleInput(" "); // space on the collapsed failed row: no-op
		panel.handleInput("\r");
		await flushMicrotasks();

		expect(onClose).toHaveBeenCalledWith([]);
	});

	test("expanded failed rows stay unselectable", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
		});
		await flushMicrotasks();

		panel.handleInput("f");
		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		panel.handleInput("\r");
		await flushMicrotasks();

		// Failed row was never enabled; only the working model applies.
		expect(onClose).toHaveBeenCalledWith(["prov-a/works"]);
	});

	test("working models start enabled", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
		});
		await flushMicrotasks();

		panel.handleInput("\r");
		await flushMicrotasks();

		expect(onClose).toHaveBeenCalledWith(["prov-a/works"]);
	});

	test("Esc closes without applying", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "works")],
		});
		await flushMicrotasks();

		panel.handleInput("\x1b");
		await flushMicrotasks();

		expect(onClose).toHaveBeenCalledWith(null);
	});

	test("Esc applies the toggles when autoApply is set", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
			autoApply: true,
		});
		await flushMicrotasks();

		panel.handleInput("\x1b");
		await flushMicrotasks();

		expect(onClose).toHaveBeenCalledWith(["prov-a/works"]);
	});

	test("dispose stops later results from applying or rendering", async () => {
		let release!: () => void;
		const gate = new Promise<void>(resolve => {
			release = resolve;
		});
		const { panel, requestRender, onClose } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
			probeModel: async model => {
				await gate;
				return resultFor(model, true);
			},
		});

		panel.dispose();
		release();
		await flushMicrotasks();

		expect(onClose).not.toHaveBeenCalled();
		const rendersAfterClose = requestRender.mock.calls.length;
		panel.handleInput("\r");
		await flushMicrotasks();
		expect(onClose).not.toHaveBeenCalled();
		expect(requestRender.mock.calls.length).toBe(rendersAfterClose);
	});

	test("clamps the cursor to the visible rows", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "m1"), makeModel("prov-a", "m2")],
		});
		await flushMicrotasks();

		panel.handleInput("\x1b[B");
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		panel.handleInput("\r");
		await flushMicrotasks();

		// Cursor stays on the last row; toggling flips m2 off (was enabled).
		expect(onClose).toHaveBeenCalledWith(["prov-a/m1"]);
	});

	test("getResults exposes verdicts for the host to persist", async () => {
		const { panel } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
		});
		await flushMicrotasks();

		const results = panel.getResults();
		expect(results[0]?.ok).toBe(true);
		expect(results[1]?.ok).toBe(false);
		expect(results[1]?.error).toBe("400 bad model");
	});
});

describe("recordProbeResults", () => {
	test("round-trips verdicts through AgentStorage", async () => {
		const storage = await AgentStorage.open(":memory:");
		try {
			const settings = Settings.isolated({}, { storage });
			const models = [makeModel("prov-a", "works"), makeModel("prov-a", "dead")];

			recordProbeResults(settings, [resultFor(models[0]!, true), resultFor(models[1]!, false, "HTTP 402")]);

			const records = storage.getModelProbeResults();
			expect(records.get("prov-a/works")?.ok).toBe(true);
			const failed = records.get("prov-a/dead");
			expect(failed?.ok).toBe(false);
			expect(failed?.error).toBe("HTTP 402");
			expect(failed?.probedAt).toBeGreaterThan(0);
		} finally {
			AgentStorage.resetInstance();
		}
	});
});
