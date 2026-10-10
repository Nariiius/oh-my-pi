/**
 * Fullscreen probe panel for `/model probe` (and `/models probe`): probes every
 * available model through omp's own provider routing while the view is open,
 * flipping each row from a spinner to OK/FAIL as its result lands.
 *
 * Separation: working and still-pending models stay visible as rows; failed
 * models collapse into a single `✗ Failed (N)` row at the bottom (`f` expands
 * them). Failed models are unselectable — space only toggles working models
 * (which start enabled). Enter applies the toggled selectors to
 * `enabledModels` and closes; Esc closes without modifying `enabledModels`
 * (recording probe results and updating the last-checked timestamp).
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { type Component, matchesKey, parseSgrMouse, type TUI } from "@oh-my-pi/pi-tui";
import { type ModelProbeResult, type ProbeModelFn, runModelProbes } from "../../cli/models-cli";
import { clampSelection, renderScrollableList } from "@oh-my-pi/pi-tui/chrome/selector-helpers";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { bottomBorder, row, topBorder } from "@oh-my-pi/pi-tui/chrome/overlay-box";
import type { DescribeContext, NativeNode, NativeUiEvent } from "@oh-my-pi/pi-tui/native/node";
import { card, node, span, text } from "@oh-my-pi/pi-tui/native/describe";
import { actionHint, hintsRow, type NativeHint } from "@oh-my-pi/pi-tui/native/overlay";
import { CLOSE_ACTION, picker, pickerAction, pickerEvent } from "@oh-my-pi/pi-tui/native/picker";
import type { TspPickerAction, TspPickerColumn, TspPickerItem, TspPickerProps } from "@oh-my-pi/pi-wire";

export interface ModelsProbePanelOptions {
	/** The (pattern-filtered) models to probe, in display order. */
	models: Model<Api>[];
	/** Per-model probe; the host wires auth + timeout + abort. */
	probeModel: ProbeModelFn;
	/** Legacy flag; Esc now always closes without modifying enabledModels. */
	autoApply?: boolean;
}

export interface ModelsProbePanelCallbacks {
	/**
	 * Fired once when the panel closes. `selectors` is the sorted toggled set
	 * when the user applied (Enter), `null` when the view was closed without
	 * modifying enabledModels (Esc).
	 */
	onClose: (selectors: string[] | null) => void | Promise<void>;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Fixed chrome rows: top border, status row, footer, bottom border. */
const CHROME_ROWS = 4;
/** Minimum rows for the list window on short terminals. */
const MIN_VISIBLE = 5;

const FOOTER_HINT = "↑/↓ navigate · space toggle · f failed · Enter apply & close · Esc close";
const AUTO_APPLY_FOOTER_HINT = "↑/↓ navigate · space toggle · f failed · Enter apply & close · Esc close (applies)";

const PROBE_COLUMNS: readonly TspPickerColumn[] = [
	{ id: "latency", head: "Latency", format: "time", priority: 80, min: 6 },
	{ id: "status", head: "Status", format: "text", priority: 100, min: 10 },
];

function formatLatency(latencyMs: number): string {
	return `${(latencyMs / 1000).toFixed(1)}s`;
}

function resultStatus(result: ModelProbeResult | undefined, spinnerFrame: number, inFlight: boolean): string {
	if (!result) {
		if (inFlight) {
			return theme.fg("accent", `${SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]} probing…`);
		}
		return theme.fg("dim", "· queued");
	}
	if (result.ok) return theme.fg("success", `OK (${formatLatency(result.latencyMs)})`);
	const status = result.errorStatus !== undefined ? `HTTP ${result.errorStatus}: ` : "";
	return theme.fg("error", `FAIL (${formatLatency(result.latencyMs)}) — ${status}${result.error ?? "no response"}`);
}

/** A visible list row: a model (by index into the options' models) or the collapsed failed-summary row. */
type VisibleRow = { modelIndex: number } | "failed-summary";

// Let native row transitions settle before publishing another result batch.
const NATIVE_UPDATE_INTERVAL_MS = 350;
function itemFieldsEqual(a: TspPickerItem, b: TspPickerItem): boolean {
	if (a === b) return true;
	if (a.dot !== b.dot || a.tone !== b.tone || a.label !== b.label || a.detail !== b.detail) return false;
	const aFacts = a.facts;
	const bFacts = b.facts;
	if (aFacts !== bFacts) {
		if (!aFacts || !bFacts) return false;
		if (aFacts.latency !== bFacts.latency || aFacts.status !== bFacts.status) {
			return false;
		}
	}
	const aBadges = a.badges;
	const bBadges = b.badges;
	if (aBadges !== bBadges) {
		if (!aBadges || !bBadges) return false;
		if (aBadges.length !== bBadges.length) return false;
		for (let i = 0; i < aBadges.length; i++) {
			if (aBadges[i]!.text !== bBadges[i]!.text || aBadges[i]!.tone !== bBadges[i]!.tone) return false;
		}
	}
	return true;
}

/**
 * The `/model probe` view. Hosted as a fullscreen overlay (`ui.showOverlay`
 * with `fullscreen: true`); keyboard-only, like the alt+p picker.
 */
export class ModelsProbePanelComponent implements Component {
	#tui: TUI;
	#models: Model<Api>[];
	#probeModel: ProbeModelFn;
	#autoApply: boolean;
	#onClose: (selectors: string[] | null) => void | Promise<void>;

	#results: Array<ModelProbeResult | undefined> = [];
	/** 0-based model indices currently in flight in the probe pool. */
	#inFlight = new Set<number>();
	/** Selectors the user has enabled; working models start enabled. */
	#enabled = new Set<string>();
	#completed = 0;
	#cursor = 0;
	#scrollStart = 0;
	#closed = false;
	#spinnerFrame = 0;
	#spinnerTimer: Timer | undefined;
	#summary: string | undefined;
	/** Failed models collapse into one summary row until `f` expands them. */
	#failedExpanded = false;
	#itemCache = new Map<number, { result: ModelProbeResult | undefined; inFlight: boolean; item: TspPickerItem }>();
	#pickerBase: readonly TspPickerItem[] | undefined;
	#lastSentItems = new Map<string, TspPickerItem>();
	#selectedSelector: string | null = null;
	#nativeShowFailed = false;
	#lastOrder: readonly string[] = [];
	#cachedCurrent: readonly string[] | undefined;
	#cachedCurrentVersion = -1;
	#enabledVersion = 0;
	#cachedActions: readonly TspPickerAction[] | undefined;
	#cachedActionsKey: string | undefined;
	#renderTimer: Timer | undefined;
	#nativePicker: TspPickerProps | undefined;
	#nativeItems: readonly TspPickerItem[] = [];
	#nativeNode: NativeNode | undefined;
	#nativePublishedAt = 0;

	constructor(tui: TUI, options: ModelsProbePanelOptions, callbacks: ModelsProbePanelCallbacks) {
		this.#tui = tui;
		this.#models = options.models;
		this.#probeModel = options.probeModel;
		this.#autoApply = options.autoApply ?? false;
		this.#onClose = callbacks.onClose;
		this.#results = new Array<ModelProbeResult | undefined>(options.models.length);
		this.#selectedSelector = options.models[0] ? `${options.models[0].provider}/${options.models[0].id}` : null;

		// Animate pending rows while any probe is outstanding in terminal rendering.
		this.#spinnerTimer = setInterval(() => {
			if (this.#closed || this.#completed >= this.#models.length) return;
			this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;
			if (!this.#tui.nativeRendering && this.#renderTimer === undefined) {
				this.#tui.requestRender();
			}
		}, 120);

		void this.#run();
	}
	#scheduleRender(): void {
		if (this.#closed || this.#renderTimer !== undefined) return;
		const delay = this.#nativePicker
			? Math.max(0, NATIVE_UPDATE_INTERVAL_MS - (Date.now() - this.#nativePublishedAt))
			: this.#tui.nativeRendering
				? NATIVE_UPDATE_INTERVAL_MS
				: 180;
		this.#renderTimer = setTimeout(() => {
			this.#renderTimer = undefined;
			if (this.#closed) return;
			if (this.#nativePicker) {
				if (Date.now() - this.#nativePublishedAt < NATIVE_UPDATE_INTERVAL_MS) {
					this.#scheduleRender();
					return;
				}
				this.#publishPicker();
			}
			this.#tui.requestRender();
		}, delay);
	}

	#flushRender(): void {
		if (!this.#nativePicker && this.#renderTimer !== undefined) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
		}
		if (!this.#closed) {
			this.#tui.requestRender();
		}
	}

	/** Kick off the bounded probe pool; results land via `onResult`. */
	async #run(): Promise<void> {
		try {
			await runModelProbes(this.#models, this.#probeModel, {
				onStart: (index1Based, _total, _model) => {
					if (this.#closed) return;
					const modelIndex = index1Based - 1;
					this.#inFlight.add(modelIndex);
					this.#scheduleRender();
				},
				onResult: (index, result) => {
					if (this.#closed) return;
					this.#inFlight.delete(index);
					this.#results[index] = result;
					this.#completed += 1;
					if (result.ok) {
						this.#enabled.add(result.selector);
						this.#enabledVersion += 1;
					}
					if (this.#completed < this.#models.length) {
						this.#scheduleRender();
					}
				},
			});
			if (this.#completed >= this.#models.length) {
				this.#inFlight.clear();
				this.#summary = this.#summaryText();
				this.#stopSpinner();
				if (this.#nativePicker || this.#tui.nativeRendering) this.#scheduleRender();
				else this.#flushRender();
			}
		} catch (error) {
			if (this.#closed) return;
			this.#inFlight.clear();
			this.#summary = `Probe run failed: ${error instanceof Error ? error.message : String(error)}`;
			this.#stopSpinner();
			if (this.#nativePicker || this.#tui.nativeRendering) this.#scheduleRender();
			else this.#flushRender();
		}
	}

	#summaryText(): string {
		const working = this.#results.filter(result => result?.ok).length;
		const failed = this.#results.filter(result => result && !result.ok).length;
		return `Probe complete: ${this.#models.length}/${this.#models.length} — ${working} working, ${failed} failed`;
	}

	#statusText(): string {
		if (this.#summary) return this.#summary;
		const inFlightCount = this.#inFlight.size;
		const queuedCount = Math.max(0, this.#models.length - this.#completed - inFlightCount);
		const working = this.#results.filter(result => result?.ok).length;
		const failed = this.#results.filter(result => result && !result.ok).length;
		let details = `${this.#completed}/${this.#models.length} completed`;
		if (inFlightCount > 0) details += ` (${inFlightCount} in flight, ${queuedCount} queued)`;
		if (working > 0 || failed > 0) details += ` · ${working} working, ${failed} failed`;
		return `Probing models… ${details}`;
	}

	#stopSpinner(): void {
		if (this.#spinnerTimer) {
			clearInterval(this.#spinnerTimer);
			this.#spinnerTimer = undefined;
		}
	}

	#selectors(): string[] {
		return [...this.#enabled].sort((left, right) => left.localeCompare(right));
	}

	/**
	 * Verdicts gathered so far (undefined for still-pending models), for the
	 * host to persist when the view closes.
	 */
	getResults(): Array<ModelProbeResult | undefined> {
		return this.#results;
	}

	async #close(selectors: string[] | null): Promise<void> {
		if (this.#closed) return;
		this.#closed = true;
		this.#stopSpinner();
		if (this.#renderTimer !== undefined) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
		}
		await this.#onClose(selectors);
	}

	#failedCount(): number {
		return this.#results.filter(result => result !== undefined && !result.ok).length;
	}

	/** The rows the list currently shows: model rows (failed collapsed unless expanded) + optional summary. */
	#visibleRows(): VisibleRow[] {
		const rows: VisibleRow[] = [];
		for (let index = 0; index < this.#models.length; index += 1) {
			const result = this.#results[index];
			if (result && !result.ok && !this.#failedExpanded) continue;
			rows.push({ modelIndex: index });
		}
		if (this.#failedCount() > 0 && !this.#failedExpanded) {
			rows.push("failed-summary");
		}
		return rows;
	}

	#move(delta: number): void {
		if (this.#nativePicker) {
			const index = Math.max(0, this.#lastOrder.indexOf(this.#selectedSelector ?? ""));
			this.#selectedSelector =
				this.#lastOrder[Math.max(0, Math.min(index + delta, this.#lastOrder.length - 1))] ?? null;
			this.#flushRender();
			return;
		}
		const last = this.#visibleRows().length - 1;
		const next = Math.min(Math.max(0, this.#cursor + delta), Math.max(0, last));
		if (next === this.#cursor) return;
		this.#cursor = next;
		const row = this.#visibleRows()[this.#cursor];
		if (row && row !== "failed-summary") {
			this.#selectedSelector = `${this.#models[row.modelIndex]!.provider}/${this.#models[row.modelIndex]!.id}`;
		}
		this.#flushRender();
	}

	#toggle(): void {
		let result: ModelProbeResult | undefined;
		if (this.#nativePicker) {
			const index = this.#models.findIndex(model => `${model.provider}/${model.id}` === this.#selectedSelector);
			result = this.#itemCache.get(index)?.result;
		} else {
			const row = this.#visibleRows()[this.#cursor];
			if (!row) return;
			if (row === "failed-summary") {
				this.#failedExpanded = !this.#failedExpanded;
				this.#flushRender();
				return;
			}
			result = this.#results[row.modelIndex];
		}
		// Pending and failed models are unselectable: only working models toggle.
		if (!result?.ok) return;
		const selector = result.selector;
		if (this.#enabled.has(selector)) {
			this.#enabled.delete(selector);
		} else {
			this.#enabled.add(selector);
		}
		this.#enabledVersion += 1;
		if (this.#nativePicker) {
			this.#nativePicker = {
				...this.#nativePicker,
				current: this.#buildCurrent().filter(id => this.#lastSentItems.get(id)?.tone === "success"),
			};
			this.#nativeNode = undefined;
		}
		this.#flushRender();
	}

	handleInput(data: string): void {
		// Route SGR mouse wheel events for trackpad / mouse scrolling
		if (data.startsWith("\x1b[<")) {
			const event = parseSgrMouse(data);
			if (event?.wheel === -1) {
				this.#move(-3);
				return;
			}
			if (event?.wheel === 1) {
				this.#move(3);
				return;
			}
			return;
		}
		if (matchesKey(data, "up") || matchesKey(data, "k") || data === "\x1b[A") {
			this.#move(-1);
			return;
		}
		if (matchesKey(data, "down") || matchesKey(data, "j") || data === "\x1b[B") {
			this.#move(1);
			return;
		}
		if (matchesKey(data, "pageUp") || data === "\x1b[5~") {
			this.#move(-10);
			return;
		}
		if (matchesKey(data, "pageDown") || data === "\x1b[6~") {
			this.#move(10);
			return;
		}
		if (matchesKey(data, "home")) {
			if (this.#nativePicker) {
				this.#selectedSelector = this.#lastOrder[0] ?? null;
				this.#flushRender();
				return;
			}
			this.#cursor = 0;
			this.#scrollStart = 0;
			const row = this.#visibleRows()[0];
			if (row && row !== "failed-summary") {
				this.#selectedSelector = `${this.#models[row.modelIndex]!.provider}/${this.#models[row.modelIndex]!.id}`;
			}
			this.#flushRender();
			return;
		}
		if (matchesKey(data, "end")) {
			if (this.#nativePicker) {
				this.#selectedSelector = this.#lastOrder[this.#lastOrder.length - 1] ?? null;
				this.#flushRender();
				return;
			}
			const rows = this.#visibleRows();
			this.#cursor = Math.max(0, rows.length - 1);
			const row = rows[this.#cursor];
			if (row && row !== "failed-summary") {
				this.#selectedSelector = `${this.#models[row.modelIndex]!.provider}/${this.#models[row.modelIndex]!.id}`;
			}
			this.#flushRender();
			return;
		}
		if (matchesKey(data, "space") || data === " ") {
			this.#toggle();
			return;
		}
		if (matchesKey(data, "f") || data === "f" || data === "F") {
			if (this.#nativePicker) {
				this.#toggleShowFailed();
			} else {
				if (this.#failedCount() === 0) return;
				this.#failedExpanded = !this.#failedExpanded;
				this.#flushRender();
			}
			return;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "return") || data === "\r" || data === "\n") {
			void this.#close(this.#selectors());
			return;
		}
		if (
			matchesKey(data, "escape") ||
			matchesKey(data, "esc") ||
			matchesKey(data, "q") ||
			data === "q" ||
			data === "Q" ||
			data === "\x1b"
		) {
			void this.#close(null);
			return;
		}
	}

	invalidate(): void {}

	dispose(): void {
		this.#closed = true;
		this.#stopSpinner();
		if (this.#renderTimer !== undefined) {
			clearTimeout(this.#renderTimer);
			this.#renderTimer = undefined;
		}
	}

	render(width: number): string[] {
		const termRows = Math.max(16, this.#tui.terminal?.rows || process.stdout.rows || 40);
		const listBudget = Math.max(MIN_VISIBLE, termRows - CHROME_ROWS);

		const rows = this.#visibleRows();
		const { selectedIndex, scrollOffset } = clampSelection(this.#cursor, this.#scrollStart, rows.length, listBudget);
		this.#cursor = selectedIndex;
		this.#scrollStart = scrollOffset;

		const out: string[] = [];
		out.push(topBorder(width, "Probe Models"));

		const status = theme.fg("muted", ` ${this.#statusText()}`);
		out.push(row(status, width));

		const renderedRowStrings: string[] = [];
		for (let rowIndex = scrollOffset; rowIndex < Math.min(rows.length, scrollOffset + listBudget); rowIndex += 1) {
			const visibleRow = rows[rowIndex]!;
			const cursorMark = rowIndex === this.#cursor ? theme.fg("accent", "›") : " ";
			if (visibleRow === "failed-summary") {
				const failedCount = this.#failedCount();
				renderedRowStrings.push(
					`${cursorMark} ${theme.fg("error", "✗")} Failed (${failedCount}) — press f to show`,
				);
				continue;
			}
			const model = this.#models[visibleRow.modelIndex]!;
			const result = this.#results[visibleRow.modelIndex];
			const inFlight = this.#inFlight.has(visibleRow.modelIndex);
			const selector = `${model.provider}/${model.id}`;
			const enabled = this.#enabled.has(selector);
			const mark =
				result && !result.ok
					? theme.fg("error", "✗")
					: inFlight
						? theme.fg("accent", SPINNER_FRAMES[this.#spinnerFrame % SPINNER_FRAMES.length])
						: enabled
							? theme.fg("success", "✓")
							: theme.fg("dim", "·");
			renderedRowStrings.push(
				`${cursorMark} ${mark} ${selector}  ${resultStatus(result, this.#spinnerFrame, inFlight)}`,
			);
		}

		const scrollableRows = renderScrollableList(renderedRowStrings, {
			width: width - 2,
			totalRows: rows.length,
			scrollOffset,
		});
		for (const sRow of scrollableRows) {
			out.push(row(sRow, width));
		}
		for (let i = scrollableRows.length; i < listBudget; i++) {
			out.push(row("", width));
		}

		out.push(row(theme.fg("dim", FOOTER_HINT), width));
		out.push(bottomBorder(width));
		return out;
	}

	/** Whether Tern should mount this component natively in `layer` as a picker sheet. */
	nativeSheet(cx: DescribeContext): boolean {
		return cx.supports("picker");
	}

	handleNativeEvent(event: NativeUiEvent): void {
		const picked = pickerEvent(event);
		if (!picked) return;
		if (picked.kind === "select" || picked.kind === "activate") {
			if (!this.#nativePicker || !this.#lastOrder.includes(picked.item)) return;
			this.#selectedSelector = picked.item;
			if (picked.kind === "activate") {
				this.#toggle();
			} else {
				this.#flushRender();
			}
			return;
		}
		if (picked.kind === "action") {
			switch (picked.act) {
				case "apply":
					void this.#close(this.#selectors());
					return;
				case "toggle":
					this.#toggle();
					return;
				case "failed":
					this.#toggleShowFailed();
					return;
				case "close":
				case CLOSE_ACTION.id:
					void this.#close(null);
					return;
			}
		}
	}

	describe(cx?: DescribeContext): NativeNode {
		return cx?.supports("picker") ? this.#describePicker() : this.#describeCard();
	}

	#buildPickerItem(index: number): TspPickerItem {
		const model = this.#models[index]!;
		const result = this.#results[index];
		const inFlight = this.#inFlight.has(index);
		const cached = this.#itemCache.get(index);
		if (cached && cached.result === result && cached.inFlight === inFlight) {
			return cached.item;
		}
		const selector = `${model.provider}/${model.id}`;
		const latency = result ? formatLatency(result.latencyMs) : inFlight ? "…" : "—";
		const rawStatus = !result
			? inFlight
				? "probing…"
				: "queued"
			: result.ok
				? "OK"
				: result.errorStatus !== undefined
					? `HTTP ${result.errorStatus}`
					: (result.error ?? "FAIL");
		const status = rawStatus.replace(/[\x00-\x1F\x7F-\x9F]/g, " ").trim();
		const facts: Record<string, string> = { latency, status };
		const dot = !result
			? inFlight
				? ("accent" as const)
				: ("muted" as const)
			: result.ok
				? ("success" as const)
				: ("error" as const);
		const tone = result ? (result.ok ? ("success" as const) : ("error" as const)) : undefined;
		const item: TspPickerItem = {
			id: selector,
			label: selector,
			mono: true,
			detail: model.name !== model.id ? model.name : undefined,
			facts,
			dot,
			tone,
		};
		this.#itemCache.set(index, { result, inFlight, item });
		return item;
	}

	#patchCatalogue(rows: readonly TspPickerItem[]): Pick<TspPickerProps, "items" | "itemsAdd"> {
		if (!this.#pickerBase) {
			this.#pickerBase = rows;
			for (const rowItem of rows) {
				this.#lastSentItems.set(rowItem.id, rowItem);
			}
			return { items: rows };
		}

		const add: TspPickerItem[] = [];
		for (const rowItem of rows) {
			const sent = this.#lastSentItems.get(rowItem.id);
			if (!sent || !itemFieldsEqual(sent, rowItem)) {
				add.push(rowItem);
			}
		}

		if (add.length === 0) {
			return { items: this.#pickerBase };
		}

		for (const rowItem of add) {
			this.#lastSentItems.set(rowItem.id, rowItem);
		}

		return {
			items: this.#pickerBase,
			itemsAdd: add,
		};
	}

	#toggleShowFailed(): void {
		this.#nativeShowFailed = !this.#nativeShowFailed;
		this.#publishPicker();
		this.#flushRender();
	}

	#pickNearestVisibleModel(
		previousSelector: string | null,
		newOrder: readonly string[],
		oldOrder: readonly string[],
	): string | null {
		if (newOrder.length === 0) return null;
		if (!previousSelector) return newOrder[0] ?? null;
		if (newOrder.includes(previousSelector)) return previousSelector;
		const oldIndex = oldOrder.indexOf(previousSelector);
		if (oldIndex === -1) return newOrder[0] ?? null;
		for (let offset = 1; offset < oldOrder.length; offset++) {
			const nextCandidate = oldOrder[oldIndex + offset];
			if (nextCandidate && newOrder.includes(nextCandidate)) {
				return nextCandidate;
			}
			const prevCandidate = oldOrder[oldIndex - offset];
			if (prevCandidate && newOrder.includes(prevCandidate)) {
				return prevCandidate;
			}
		}
		return newOrder[0] ?? null;
	}

	#buildOrder(): readonly string[] {
		const order: string[] = [];
		for (let i = 0; i < this.#models.length; i++) {
			const result = this.#results[i];
			if (result && !result.ok && !this.#nativeShowFailed) continue;
			order.push(`${this.#models[i]!.provider}/${this.#models[i]!.id}`);
		}
		if (this.#lastOrder.length === order.length && this.#lastOrder.every((id, idx) => id === order[idx])) {
			return this.#lastOrder;
		}
		this.#lastOrder = order;
		return order;
	}

	#buildCurrent(): readonly string[] {
		if (this.#cachedCurrent && this.#cachedCurrentVersion === this.#enabledVersion) {
			return this.#cachedCurrent;
		}
		const current = Array.from(this.#enabled);
		this.#cachedCurrent = current;
		this.#cachedCurrentVersion = this.#enabledVersion;
		return current;
	}

	#buildActions(): readonly TspPickerAction[] {
		const failedCount = this.#failedCount();
		const key = `${this.#nativeShowFailed}:${failedCount}`;
		if (this.#cachedActions && this.#cachedActionsKey === key) {
			return this.#cachedActions;
		}
		const actions = [
			pickerAction("apply", "Apply & close", "enter", { primary: true }),
			pickerAction("toggle", "Toggle", "space"),
			pickerAction(
				"failed",
				this.#nativeShowFailed ? `Hide failed (${failedCount})` : `Show failed (${failedCount})`,
				"f",
				{ disabled: failedCount === 0 ? true : undefined },
			),
			CLOSE_ACTION,
		];
		this.#cachedActions = actions;
		this.#cachedActionsKey = key;
		return actions;
	}

	#publishPicker(): void {
		this.#nativeItems = this.#models.map((_, i) => this.#buildPickerItem(i));
		const previousOrder = this.#lastOrder;
		const order = this.#buildOrder();

		this.#selectedSelector = this.#pickNearestVisibleModel(this.#selectedSelector, order, previousOrder);

		this.#nativePicker = {
			title: "Probe Models",
			subtitle: this.#statusText(),
			icon: "cpu",
			noun: "models",
			size: "lg",
			layout: "rows",
			preview: "none",
			query: null,
			columns: PROBE_COLUMNS,
			order,
			selected: this.#selectedSelector,
			current: this.#buildCurrent(),
			total: this.#models.length,
			empty: "No models to probe",
			actions: this.#buildActions(),
		};
		this.#nativePublishedAt = Date.now();
		this.#nativeNode = undefined;
	}

	#describePicker(): NativeNode {
		// Freeze published rows between batches, including unrelated TUI frames and selection updates.
		if (!this.#nativePicker) this.#publishPicker();
		if (!this.#nativeNode) {
			this.#nativePicker = { ...this.#nativePicker!, ...this.#patchCatalogue(this.#nativeItems) };
		}
		if (this.#nativeNode?.k !== "picker" || this.#nativeNode.p?.selected !== this.#selectedSelector) {
			this.#nativeNode = picker({ ...this.#nativePicker!, selected: this.#selectedSelector });
		}
		return this.#nativeNode;
	}

	#describeCard(): NativeNode {
		const failedCount = this.#failedCount();
		const status = span(this.#statusText(), "muted");
		const rows = this.#visibleRows();
		const listItems: NativeNode[] = [];
		for (let i = 0; i < rows.length; i++) {
			const visible = rows[i]!;
			if (visible === "failed-summary") {
				listItems.push(
					node(
						"item",
						{
							label: `Failed (${failedCount}) — press f to show`,
							tone: "error",
						},
						undefined,
						"failed-summary",
					),
				);
				continue;
			}
			const model = this.#models[visible.modelIndex]!;
			const result = this.#results[visible.modelIndex];
			const selector = `${model.provider}/${model.id}`;
			const latency = result ? ` (${formatLatency(result.latencyMs)})` : "";
			listItems.push(
				node(
					"item",
					{
						label: `${selector}${latency}`,
						disabled: result ? !result.ok : true,
					},
					undefined,
					selector,
				),
			);
		}
		const hints: (NativeHint | undefined)[] = [
			actionHint(["tui.select.up", "tui.select.down"], "navigate"),
			{ keys: ["space"], label: "toggle" },
			failedCount > 0 ? { keys: ["f"], label: this.#failedExpanded ? "hide failed" : "show failed" } : undefined,
			{ keys: ["enter"], label: "apply & close" },
			actionHint("tui.select.cancel", "close"),
		];
		return card(
			{
				role: "omp.overlay.model-probe",
				head: "Probe Models",
			},
			[
				text([status], { wrap: "word" }),
				node("list", { selected: String(this.#cursor) }, listItems),
				hintsRow(hints),
			],
		);
	}
}
