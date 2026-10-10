import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { type ModelProbeResult, type ProbeModelFn, recordProbeResults } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type ModelsProbePanelCallbacks,
	ModelsProbePanelComponent,
} from "@oh-my-pi/pi-coding-agent/modes/components/models-probe-panel";
import { getThemeByName, setThemeInstance, type Theme } from "@oh-my-pi/pi-tui/theme";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { TUI } from "@oh-my-pi/pi-tui";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { Reconciler } from "@oh-my-pi/pi-tui/native/reconcile";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";

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

const pickerCx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: kind => kind === "picker",
	feature: () => true,
};

const fallbackCx: DescribeContext = {
	cols: 100,
	reduceMotion: false,
	dark: true,
	supports: () => false,
	feature: () => false,
};

/** Flush the microtask chain runModelProbes' workers settle on. */
async function flushMicrotasks(): Promise<void> {
	for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

let testTheme: Theme | undefined;
const panels = new Set<ModelsProbePanelComponent>();

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
	nativeRendering?: boolean;
}) {
	const requestRender = vi.fn();
	const tui = {
		requestRender,
		nativeRendering: options.nativeRendering ?? false,
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
	panels.add(panel);
	return { tui, requestRender, onClose, panel };
}

function normalize(lines: readonly string[]): string {
	return stripVTControlCharacters(lines.join("\n")).replace(/\s+/g, " ").trim();
}

describe("ModelsProbePanelComponent", () => {
	beforeEach(async () => {
		testTheme = await getThemeByName("dark");
		installTestTheme();
		vi.useFakeTimers();
	});

	afterEach(() => {
		for (const panel of panels) panel.dispose();
		panels.clear();
		vi.useRealTimers();
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

	test("Enter applies only the models remaining enabled after toggling", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "m1"), makeModel("prov-a", "m2")],
		});
		await flushMicrotasks();

		// Cursor starts on m1. Toggle m1 off.
		panel.handleInput(" ");
		panel.handleInput("\r");
		await flushMicrotasks();

		// Only m2 was left enabled
		expect(onClose).toHaveBeenCalledWith(["prov-a/m2"]);
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

	test("Esc closes without modifying enabledModels even when autoApply is set", async () => {
		const { panel, onClose } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
			autoApply: true,
		});
		await flushMicrotasks();

		panel.handleInput("\x1b");
		await flushMicrotasks();

		expect(onClose).toHaveBeenCalledWith(null);
	});

	test("dispose stops later results from applying or rendering", async () => {
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
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

	test("shows queued and in-flight states before results arrive", async () => {
		const { promise: gate, resolve: finishSecond } = Promise.withResolvers<void>();
		const { panel } = createHarness({
			models: [makeModel("prov-a", "m1"), makeModel("prov-a", "m2")],
			probeModel: async model => {
				if (model.id === "m2") {
					await gate;
				}
				return resultFor(model, true);
			},
		});

		await flushMicrotasks();
		// m1 has completed, m2 is in-flight (probing)
		const text = normalize(panel.render(100));
		expect(text).toContain("prov-a/m1");
		expect(text).toContain("OK");
		expect(text).toContain("prov-a/m2");
		expect(text).toContain("probing…");

		finishSecond();
		await flushMicrotasks();
		const textDone = normalize(panel.render(100));
		expect(textDone).toContain("Probe complete: 2/2 — 2 working, 0 failed");
	});

	test("space on failed-summary expands and collapses failed models", async () => {
		const { panel } = createHarness({
			models: [makeModel("prov-a", "works"), makeModel("prov-a", "dead")],
		});
		await flushMicrotasks();

		// Initially, failed models are collapsed in summary
		let text = normalize(panel.render(100));
		expect(text).toContain("Failed (1) — press f to show");
		expect(text).not.toContain("FAIL");

		// Move cursor to failed-summary and press space to toggle expansion
		panel.handleInput("\x1b[B"); // Move to failed-summary row
		panel.handleInput(" ");
		await flushMicrotasks();

		text = normalize(panel.render(100));
		expect(text).toContain("FAIL");
		expect(text).not.toContain("Failed (1) — press f to show");

		// Press f to collapse
		panel.handleInput("f");
		await flushMicrotasks();
		text = normalize(panel.render(100));
		expect(text).toContain("Failed (1) — press f to show");
	});

	test("supports mouse wheel and page scrolling in probe panel", async () => {
		const { panel } = createHarness({
			models: [
				makeModel("prov-a", "m1"),
				makeModel("prov-a", "m2"),
				makeModel("prov-a", "m3"),
				makeModel("prov-a", "m4"),
			],
		});
		await flushMicrotasks();

		// Mouse wheel down
		panel.handleInput("\x1b[<65;10;10M");
		// Page down
		panel.handleInput("\x1b[6~");
		// Mouse wheel up
		panel.handleInput("\x1b[<64;10;10M");

		const text = normalize(panel.render(100));
		expect(text).toContain("Probe Models");
		expect(text).toContain("prov-a/m1");
	});

	test("nativeSheet reflects picker capability", () => {
		const { panel } = createHarness({
			models: [makeModel("prov-a", "m1")],
		});
		expect(panel.nativeSheet(pickerCx)).toBe(true);
		expect(panel.nativeSheet(fallbackCx)).toBe(false);
	});

	test("describes native picker with status, latency, and order", async () => {
		const models = [makeModel("prov-a", "works"), makeModel("prov-a", "dead")];
		const probeModel: ProbeModelFn = async model =>
			resultFor(model, model.id !== "dead", "400 bad model");

		const { panel } = createHarness({ models, probeModel });
		await flushMicrotasks();

		const node = panel.describe(pickerCx);
		expect(node.k).toBe("picker");
		const props = node.p as unknown as TspPickerProps;
		expect(props.title).toBe("Probe Models");
		expect(props.noun).toBe("models");
		expect(props.icon).toBe("cpu");
		expect(props.total).toBe(2);
		expect(props.subtitle).toContain("1 working, 1 failed");
		expect(props.current).toEqual(["prov-a/works"]);
		expect(props.selected).toBe("prov-a/works");
		// By default in native mode, failed models automatically disappear from order
		expect(props.order).toEqual(["prov-a/works"]);
		const items = props.items ?? [];
		const workingItem = items.find(item => item.id === "prov-a/works");
		expect(workingItem).toBeDefined();
		expect(workingItem?.dot).toBe("success");
		expect(workingItem?.facts?.latency).toBe("1.2s");
		expect(workingItem?.facts?.status).toBe("OK");

		const deadItem = items.find(item => item.id === "prov-a/dead");
		expect(deadItem).toBeDefined();
		expect(deadItem?.dot).toBe("error");
		expect(deadItem?.facts?.latency).toBe("5.0s");
		expect(deadItem?.facts?.status).toBe("400 bad model");
	});

	test("handles native select, activate, and action events", async () => {
		const models = [makeModel("prov-a", "m1"), makeModel("prov-a", "m2"), makeModel("prov-a", "dead")];
		const probeModel: ProbeModelFn = async model => resultFor(model, model.id !== "dead", "fail");

		const { panel, onClose, requestRender } = createHarness({ models, probeModel });
		await flushMicrotasks();

		// Initial describe: m1 and m2 enabled
		let props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.current).toEqual(["prov-a/m1", "prov-a/m2"]);
		expect(props.selected).toBe("prov-a/m1");

		// 1. Select event moves cursor without toggling enablement
		panel.handleNativeEvent({ type: "select", key: "", item: "prov-a/m2" });
		expect(requestRender).toHaveBeenCalled();
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.selected).toBe("prov-a/m2");
		expect(props.current).toEqual(["prov-a/m1", "prov-a/m2"]);

		// 2. Activate event on working model toggles enablement
		panel.handleNativeEvent({ type: "activate", key: "", item: "prov-a/m2" });
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.current).toEqual(["prov-a/m1"]);

		// Activate again re-enables
		panel.handleNativeEvent({ type: "activate", key: "", item: "prov-a/m2" });
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.current).toEqual(["prov-a/m1", "prov-a/m2"]);

		// 3. Action "failed" reveals failures in order
		panel.handleNativeEvent({ type: "action", key: "", act: "failed", mods: [] });
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m2", "prov-a/dead"]);
		expect(props.actions?.find(a => a.id === "failed")?.label).toBe("Hide failed (1)");

		// Action "failed" again resumes automatic filtering (hides failures)
		panel.handleNativeEvent({ type: "action", key: "", act: "failed", mods: [] });
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m2"]);
		expect(props.actions?.find(a => a.id === "failed")?.label).toBe("Show failed (1)");
		// 4. Action "toggle" toggles current cursor model
		panel.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.current).toEqual(["prov-a/m1"]);

		// 5. Action "apply" closes with enabled selectors
		panel.handleNativeEvent({ type: "action", key: "", act: "apply", mods: [] });
		await flushMicrotasks();
		expect(onClose).toHaveBeenCalledWith(["prov-a/m1"]);

		// 6. Action "close" closes with null
		const harness2 = createHarness({ models, probeModel });
		await flushMicrotasks();
		harness2.panel.handleNativeEvent({ type: "action", key: "", act: "close", mods: [] });
		await flushMicrotasks();
		expect(harness2.onClose).toHaveBeenCalledWith(null);
	});

	test("falls back to card when picker is unsupported", async () => {
		const { panel } = createHarness({
			models: [makeModel("prov-a", "m1")],
		});
		await flushMicrotasks();

		const node = panel.describe(fallbackCx);
		expect(node.k).toBe("card");
	});

	test("maintains stable order and selection across probe completions", async () => {
		const models = [makeModel("prov-a", "m1"), makeModel("prov-a", "m2"), makeModel("prov-a", "m3")];
		const { promise: p3, resolve: r3 } = Promise.withResolvers<ModelProbeResult>();
		const probeModel: ProbeModelFn = async model => {
			if (model.id === "m3") return p3;
			return resultFor(model, true);
		};

		const { panel } = createHarness({ models, probeModel });
		await flushMicrotasks();

		panel.describe(pickerCx);
		// User explicitly selects m2
		panel.handleNativeEvent({ type: "select", key: "", item: "prov-a/m2" });
		const first = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(first.selected).toBe("prov-a/m2");
		const firstOrder = first.order;

		// When m3 finishes successfully, order and selected remain unchanged
		r3(resultFor(models[2]!, true));
		await flushMicrotasks();
		vi.advanceTimersByTime(350);

		const second = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(second.selected).toBe("prov-a/m2");
		expect(second.order).toEqual(firstOrder);
	});

	test("publishes bounded native batches despite unrelated frames, selection, and final completion", async () => {
		const models = ["m1", "m2", "m3", "m4"].map(id => makeModel("prov-a", id));
		const pending = new Map(models.map(model => [model.id, Promise.withResolvers<ModelProbeResult>()]));
		const { panel } = createHarness({
			models,
			nativeRendering: true,
			probeModel: model => pending.get(model.id)!.promise,
		});
		await flushMicrotasks();
		const wire = new Reconciler("probe");
		const regions = { main: [], dock: [], layer: [panel] };
		wire.reconcile(regions, pickerCx);
		const initialOrder = models.map(model => `prov-a/${model.id}`);

		pending.get("m1")!.resolve(resultFor(models[0]!, false));
		await flushMicrotasks();
		expect(wire.reconcile(regions, pickerCx)).toEqual([]);
		panel.handleNativeEvent({ type: "select", key: "", item: "prov-a/m2" });
		const selectionFrame = wire.reconcile(regions, pickerCx);
		expect(selectionFrame.some(op => op[0] === "set" && op[2].order !== undefined)).toBe(false);
		vi.advanceTimersByTime(200);
		pending.get("m2")!.resolve(resultFor(models[1]!, false));
		await flushMicrotasks();
		expect((panel.describe(pickerCx).p as unknown as TspPickerProps).order).toEqual(initialOrder);
		expect(wire.reconcile(regions, pickerCx)).toEqual([]);

		vi.advanceTimersByTime(150);
		let props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m3", "prov-a/m4"]);
		expect(props.selected).toBe("prov-a/m3");
		wire.reconcile(regions, pickerCx);

		pending.get("m3")!.resolve(resultFor(models[2]!, true));
		pending.get("m4")!.resolve(resultFor(models[3]!, false));
		await flushMicrotasks();
		vi.advanceTimersByTime(349);
		expect(wire.reconcile(regions, pickerCx)).toEqual([]);
		vi.advanceTimersByTime(1);
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m3"]);
		expect(props.current).toEqual(["prov-a/m3"]);
		expect(props.selected).toBe("prov-a/m3");
	});

	test("automatic failure removal: 1,431 models with 1,192 failures removes failures automatically", async () => {
		const models = Array.from({ length: 1431 }, (_, i) => makeModel("prov-a", `model-${i}`));
		const failures = new Set(Array.from({ length: 1192 }, (_, i) => `model-${i}`));
		const probeModel: ProbeModelFn = async model =>
			resultFor(model, !failures.has(model.id), failures.has(model.id) ? "500 server error" : undefined);

		const { panel } = createHarness({ models, probeModel });
		const initial = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(initial.order?.length).toBe(1431);
		expect(initial.selected).toBe("prov-a/model-0");

		while (panel.getResults().filter(Boolean).length < 1431) {
			await Promise.resolve();
		}
		await flushMicrotasks();
		vi.advanceTimersByTime(350);

		const afterProbing = panel.describe(pickerCx).p as unknown as TspPickerProps;
		// Failed models automatically disappeared: exactly 239 nonfailed models remain visible
		expect(afterProbing.order?.length).toBe(239);
		expect(afterProbing.order?.includes("prov-a/model-0")).toBe(false); // model-0 failed and was removed
		expect(afterProbing.total).toBe(1431);
		expect(afterProbing.subtitle).toContain("239 working, 1192 failed");
		// Selection never references a hidden item
		expect(afterProbing.order?.includes(afterProbing.selected!)).toBe(true);

		// Catalogue still holds all items for F toggle or inspection
		expect(afterProbing.items?.length).toBe(1431);
	});

	test("failure visibility toggle reveals failures and resumes automatic filtering", async () => {
		const models = [
			makeModel("prov-a", "m1"),
			makeModel("prov-a", "m2"),
			makeModel("prov-a", "m3"),
			makeModel("prov-a", "m4"),
			makeModel("prov-a", "m5"),
		];
		const r3 = Promise.withResolvers<ModelProbeResult>();
		const r4 = Promise.withResolvers<ModelProbeResult>();
		const probeModel: ProbeModelFn = async model => {
			if (model.id === "m1") return resultFor(model, true);
			if (model.id === "m2") return resultFor(model, false, "400 error");
			if (model.id === "m3") return r3.promise;
			if (model.id === "m4") return r4.promise;
			return resultFor(model, true);
		};

		const { panel } = createHarness({ models, probeModel });
		await flushMicrotasks();

		// Default: m2 failed and disappeared automatically
		let props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m3", "prov-a/m4", "prov-a/m5"]);
		expect(props.actions?.find(a => a.id === "failed")?.label).toBe("Show failed (1)");

		// Press F to reveal all failures
		panel.handleNativeEvent({ type: "action", key: "", act: "failed", mods: [] });
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m2", "prov-a/m3", "prov-a/m4", "prov-a/m5"]);
		expect(props.actions?.find(a => a.id === "failed")?.label).toBe("Hide failed (1)");

		// m3 fails while failures are shown: m3 remains visible
		r3.resolve(resultFor(models[2]!, false, "500 error"));
		await flushMicrotasks();
		vi.advanceTimersByTime(350);
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m2", "prov-a/m3", "prov-a/m4", "prov-a/m5"]);
		expect(props.actions?.find(a => a.id === "failed")?.label).toBe("Hide failed (2)");

		// Press F again: resumes automatic filtering, hiding both m2 and m3
		panel.handleNativeEvent({ type: "action", key: "", act: "failed", mods: [] });
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m4", "prov-a/m5"]);
		expect(props.actions?.find(a => a.id === "failed")?.label).toBe("Show failed (2)");

		// Subsequent failure (m4) also disappears automatically
		r4.resolve(resultFor(models[3]!, false, "404 not found"));
		await flushMicrotasks();
		vi.advanceTimersByTime(350);
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m5"]);
		expect(props.actions?.find(a => a.id === "failed")?.label).toBe("Show failed (3)");
	});

	test("preserves nearest surviving visible selection when selected model fails", async () => {
		const models = [
			makeModel("prov-a", "m1"),
			makeModel("prov-a", "m2"),
			makeModel("prov-a", "m3"),
			makeModel("prov-a", "m4"),
		];
		const r2 = Promise.withResolvers<ModelProbeResult>();
		const probeModel: ProbeModelFn = async model => {
			if (model.id === "m2") return r2.promise;
			return resultFor(model, true);
		};

		const { panel } = createHarness({ models, probeModel });
		await flushMicrotasks();

		panel.describe(pickerCx);
		// User explicitly highlights m2
		panel.handleNativeEvent({ type: "select", key: "", item: "prov-a/m2" });
		let props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.selected).toBe("prov-a/m2");

		// m2 fails and is removed from order
		r2.resolve(resultFor(models[1]!, false, "500 crash"));
		await flushMicrotasks();
		vi.advanceTimersByTime(350);

		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/m1", "prov-a/m3", "prov-a/m4"]);
		// Selection must anchor to the nearest surviving neighbor (m3), NOT reset to m1!
		expect(props.selected).toBe("prov-a/m3");
	});

	test("native actions and keyboard navigation target the selected model after earlier rows disappear", async () => {
		const models = ["m1", "m2", "m3"].map(id => makeModel("prov-a", id));
		const first = Promise.withResolvers<ModelProbeResult>();
		const { panel, onClose } = createHarness({
			models,
			nativeRendering: true,
			probeModel: model => (model.id === "m1" ? first.promise : Promise.resolve(resultFor(model, true))),
		});
		await flushMicrotasks();
		panel.describe(pickerCx);
		panel.handleNativeEvent({ type: "select", key: "", item: "prov-a/m2" });
		first.resolve(resultFor(models[0]!, false));
		await flushMicrotasks();
		vi.advanceTimersByTime(350);
		expect((panel.describe(pickerCx).p as unknown as TspPickerProps).selected).toBe("prov-a/m2");

		panel.handleNativeEvent({ type: "action", key: "", act: "toggle", mods: [] });
		expect((panel.describe(pickerCx).p as unknown as TspPickerProps).current).toEqual(["prov-a/m3"]);
		panel.handleInput("\x1b[B");
		panel.handleInput(" ");
		expect((panel.describe(pickerCx).p as unknown as TspPickerProps).current).toEqual([]);
		panel.handleInput("\x1b[A");
		panel.handleInput(" ");
		panel.handleInput("f");
		panel.handleInput("\x1b[H");
		expect((panel.describe(pickerCx).p as unknown as TspPickerProps).selected).toBe("prov-a/m1");
		panel.handleNativeEvent({ type: "activate", key: "", item: "prov-a/m1" });
		expect((panel.describe(pickerCx).p as unknown as TspPickerProps).current).toEqual(["prov-a/m2"]);
		panel.handleInput("\x1b[F");
		panel.handleInput(" ");
		panel.handleInput("\r");
		await flushMicrotasks();
		expect(onClose).toHaveBeenCalledWith(["prov-a/m2", "prov-a/m3"]);
	});

	test("an all-failed native batch clears selection and remains revealable", async () => {
		const { panel, onClose } = createHarness({ models: [makeModel("prov-a", "dead")], nativeRendering: true });
		panel.describe(pickerCx);
		await flushMicrotasks();
		vi.advanceTimersByTime(350);
		let props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual([]);
		expect(props.selected).toBeNull();
		panel.handleInput("f");
		props = panel.describe(pickerCx).p as unknown as TspPickerProps;
		expect(props.order).toEqual(["prov-a/dead"]);
		expect(props.selected).toBe("prov-a/dead");
		panel.handleInput(" ");
		panel.handleInput("\r");
		await flushMicrotasks();
		expect(onClose).toHaveBeenCalledWith([]);
	});
});

describe("recordProbeResults", () => {
	test("round-trips verdicts through AgentStorage", async () => {
		const storage = await AgentStorage.open(":memory:");
		try {
			const settings = Settings.isolated({}, { storage });
			const models = [makeModel("prov-a", "works"), makeModel("prov-a", "dead")];

			const before = Date.now();
			recordProbeResults(settings, [resultFor(models[0]!, true), resultFor(models[1]!, false, "HTTP 402")]);
			const after = Date.now();

			const records = storage.getModelProbeResults();
			expect(records.get("prov-a/works")?.ok).toBe(true);
			const failed = records.get("prov-a/dead");
			expect(failed?.ok).toBe(false);
			expect(failed?.error).toBe("HTTP 402");
			expect(failed?.probedAt).toBeGreaterThanOrEqual(before);
			expect(failed?.probedAt).toBeLessThanOrEqual(after);
		} finally {
			AgentStorage.close();
		}
	});

	test("normalizes legacy second timestamps to milliseconds", async () => {
		const storage = await AgentStorage.open(":memory:");
		try {
			// Insert a legacy record in seconds directly into SQLite
			const legacySeconds = 1725000000;
			storage.recordModelProbeResults([
				{
					selector: "prov-a/legacy",
					ok: true,
					latencyMs: 500,
					probedAt: legacySeconds,
				},
			]);

			const records = storage.getModelProbeResults();
			const record = records.get("prov-a/legacy");
			expect(record?.ok).toBe(true);
			expect(record?.probedAt).toBe(legacySeconds * 1000);
		} finally {
			AgentStorage.close();
		}
	});
});
