/**
 * Fullscreen probe panel for `/model probe` (and `/models probe`): probes every
 * available model through omp's own provider routing while the view is open,
 * flipping each row from a spinner to OK/FAIL as its result lands.
 *
 * Separation: working and still-pending models stay visible as rows; failed
 * models collapse into a single `✗ Failed (N)` row at the bottom (`f` expands
 * them). Failed models are unselectable — space only toggles working models
 * (which start enabled). Enter applies the toggled selectors to
 * `enabledModels` and closes; Esc closes (and — with `--apply` — applies the
 * toggles at close time).
 */
import type { Api, Model } from "@oh-my-pi/pi-ai";
import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { type ModelProbeResult, type ProbeModelFn, runModelProbes } from "../../cli/models-cli";
import { theme } from "../theme/theme";
import { bottomBorder, row, topBorder } from "./overlay-box";

export interface ModelsProbePanelOptions {
	/** The (pattern-filtered) models to probe, in display order. */
	models: Model<Api>[];
	/** Per-model probe; the host wires auth + timeout + abort. */
	probeModel: ProbeModelFn;
	/** Esc also applies the toggled set when true (`--apply`). */
	autoApply: boolean;
}

export interface ModelsProbePanelCallbacks {
	/**
	 * Fired once when the panel closes. `selectors` is the sorted toggled set
	 * when the user applied (Enter, or Esc with `autoApply`), `null` when the
	 * view was dismissed without applying.
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

function resultStatus(result: ModelProbeResult | undefined, spinnerFrame: number): string {
	if (!result) return theme.fg("muted", SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]);
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
		this.#autoApply = options.autoApply;
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
				onResult: (index, result) => {
					if (this.#closed) return;
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
				this.#summary = this.#summaryText();
				this.#stopSpinner();
				this.#tui.requestRender();
			}
		} catch (error) {
			if (this.#closed) return;
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
		if (!row || row === "failed-summary") return;
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
		// Fullscreen overlays enable mouse tracking; drop stray SGR reports.
		if (data.startsWith("\x1b[<")) return;
		switch (data) {
			case "\x1b[A":
			case "k":
				this.#move(-1);
				return;
			case "\x1b[B":
			case "j":
				this.#move(1);
				return;
			case " ":
				this.#toggle();
				return;
			case "f":
				if (this.#failedCount() === 0) return;
				this.#failedExpanded = !this.#failedExpanded;
				this.#tui.requestRender();
				return;
			case "\r":
			case "\n":
				void this.#close(this.#selectors());
				return;
			case "\x1b":
				void this.#close(this.#autoApply ? this.#selectors() : null);
				return;
			default:
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
		if (rows.length > 0 && this.#cursor >= rows.length) {
			this.#cursor = rows.length - 1;
		}

		// Keep the cursor row visible; the viewport follows it.
		if (this.#cursor < this.#scrollStart) this.#scrollStart = this.#cursor;
		if (this.#cursor >= this.#scrollStart + listBudget) {
			this.#scrollStart = this.#cursor - listBudget + 1;
		}

		const out: string[] = [];
		out.push(topBorder(width, "Probe Models"));

		const pending = this.#models.length - this.#completed;
		const status = this.#summary
			? theme.fg("muted", ` ${this.#summary}`)
			: theme.fg("muted", ` Probing ${this.#completed}/${this.#models.length} models… (${pending} pending)`);
		out.push(row(status, width));

		for (
			let rowIndex = this.#scrollStart;
			rowIndex < Math.min(rows.length, this.#scrollStart + listBudget);
			rowIndex += 1
		) {
			const visibleRow = rows[rowIndex]!;
			const cursorMark = rowIndex === this.#cursor ? theme.fg("accent", "›") : " ";
			if (visibleRow === "failed-summary") {
				const failedCount = this.#failedCount();
				out.push(row(`${cursorMark} ${theme.fg("error", "✗")} Failed (${failedCount}) — press f to show`, width));
				continue;
			}
			const model = this.#models[visibleRow.modelIndex]!;
			const result = this.#results[visibleRow.modelIndex];
			const selector = `${model.provider}/${model.id}`;
			const enabled = this.#enabled.has(selector);
			const mark =
				result && !result.ok ? theme.fg("error", "✗") : enabled ? theme.fg("success", "✓") : theme.fg("dim", "·");
			out.push(row(`${cursorMark} ${mark} ${selector}  ${resultStatus(result, this.#spinnerFrame)}`, width));
		}

		out.push(row(theme.fg("dim", this.#autoApply ? AUTO_APPLY_FOOTER_HINT : FOOTER_HINT), width));
		out.push(bottomBorder(width));
		return out;
	}
}
