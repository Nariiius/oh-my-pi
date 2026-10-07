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
	#spinnerTimer: ReturnType<typeof setInterval> | undefined;
	#summary: string | undefined;
	/** Failed models collapse into one summary row until `f` expands them. */
	#failedExpanded = false;

	constructor(tui: TUI, options: ModelsProbePanelOptions, callbacks: ModelsProbePanelCallbacks) {
		this.#tui = tui;
		this.#models = options.models;
		this.#probeModel = options.probeModel;
		this.#autoApply = options.autoApply ?? false;
		this.#onClose = callbacks.onClose;
		this.#results = new Array<ModelProbeResult | undefined>(options.models.length);

		// Animate pending rows while any probe is outstanding.
		this.#spinnerTimer = setInterval(() => {
			if (this.#closed || this.#completed >= this.#models.length) return;
			this.#spinnerFrame = (this.#spinnerFrame + 1) % SPINNER_FRAMES.length;
			this.#tui.requestRender();
		}, 120);

		void this.#run();
	}

	/** Kick off the bounded probe pool; results land via `onResult`. */
	async #run(): Promise<void> {
		try {
			await runModelProbes(this.#models, this.#probeModel, {
				onStart: (index1Based, _total, _model) => {
					if (this.#closed) return;
					const modelIndex = index1Based - 1;
					this.#inFlight.add(modelIndex);
					this.#tui.requestRender();
				},
				onResult: (index, result) => {
					if (this.#closed) return;
					this.#inFlight.delete(index);
					this.#results[index] = result;
					this.#completed += 1;
					if (result.ok) this.#enabled.add(result.selector);
					if (this.#completed >= this.#models.length) {
						this.#summary = this.#summaryText();
						this.#stopSpinner();
					}
					this.#tui.requestRender();
				},
			});
			if (this.#completed >= this.#models.length) {
				this.#inFlight.clear();
				this.#summary = this.#summaryText();
				this.#stopSpinner();
				this.#tui.requestRender();
			}
		} catch (error) {
			if (this.#closed) return;
			this.#inFlight.clear();
			this.#summary = `Probe run failed: ${error instanceof Error ? error.message : String(error)}`;
			this.#stopSpinner();
			this.#tui.requestRender();
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
		const last = this.#visibleRows().length - 1;
		const next = Math.min(Math.max(0, this.#cursor + delta), Math.max(0, last));
		if (next === this.#cursor) return;
		this.#cursor = next;
		this.#tui.requestRender();
	}

	#toggle(): void {
		const row = this.#visibleRows()[this.#cursor];
		if (!row) return;
		if (row === "failed-summary") {
			this.#failedExpanded = !this.#failedExpanded;
			this.#tui.requestRender();
			return;
		}
		const result = this.#results[row.modelIndex];
		// Pending and failed models are unselectable: only working models toggle.
		if (!result?.ok) return;
		const selector = result.selector;
		if (this.#enabled.has(selector)) {
			this.#enabled.delete(selector);
		} else {
			this.#enabled.add(selector);
		}
		this.#tui.requestRender();
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
			this.#cursor = 0;
			this.#scrollStart = 0;
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "end")) {
			const rows = this.#visibleRows();
			this.#cursor = Math.max(0, rows.length - 1);
			this.#tui.requestRender();
			return;
		}
		if (matchesKey(data, "space") || data === " ") {
			this.#toggle();
			return;
		}
		if (matchesKey(data, "f") || data === "f" || data === "F") {
			if (this.#failedCount() === 0) return;
			this.#failedExpanded = !this.#failedExpanded;
			this.#tui.requestRender();
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
}
