import * as path from "node:path";
import {
	bottomBorder,
	clampSelection,
	contentRowWidth,
	OverlayPanel,
	renderScrollableList,
	row,
	topBorder,
} from "@oh-my-pi/pi-tui/chrome";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "@oh-my-pi/pi-tui/keybinding-matchers";
import { matchesKey } from "@oh-my-pi/pi-tui/keys";
import { col, compact, item, span, text } from "@oh-my-pi/pi-tui/native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent, TspSpan } from "@oh-my-pi/pi-tui/native/node";
import { actionBar, actionButton, overlayCard, selectList } from "@oh-my-pi/pi-tui/native/overlay";
import { truncateToWidth } from "@oh-my-pi/pi-tui/render/render-utils";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { isOutboxSessionLive } from "../../outbox/activity";
import { pauseOutbox, startOutbox } from "../../outbox/service";
import { outboxJobBlocker, type OutboxStore } from "../../outbox/store";
import type { OutboxJob, OutboxSessionSnapshot, OutboxState } from "../../outbox/types";

const MAX_VISIBLE_ROWS = 8;

export interface OutboxViewState {
	scope: "current" | "all";
	selectedJobId?: string;
}

export interface OutboxSelectorCallbacks {
	currentSessionId: string;
	onClose: () => void;
	onAdd: (sessionId: string | undefined) => void | Promise<void>;
	onResume: (sessionId: string | undefined) => void | Promise<void>;
	onEdit?: (job: OutboxJob) => void | Promise<void>;
	requestRender?: () => void;
}

function cleanText(val: string | undefined | null): string {
	return sanitizeText(val ?? "")
		.replace(/\s+/g, " ")
		.trim();
}

function getProjectName(cwd: string): string {
	const base = path.basename(cwd || "");
	return cleanText(base || cwd || "-");
}

function formatSessionName(job: OutboxJob, snapshot?: OutboxSessionSnapshot): string {
	const raw = snapshot?.sessionName || job.sessionName;
	if (raw) return cleanText(raw);
	const base = path.basename(job.cwd || "");
	const suffix = job.sessionId ? job.sessionId.slice(-8) : "session";
	return cleanText(base ? `${base} · ${suffix}` : suffix);
}

function formatModel(job: OutboxJob, snapshot?: OutboxSessionSnapshot): { queued: string; live?: string } {
	const queued = cleanText(`${job.provider}/${job.model}`);
	if (!snapshot?.model) return { queued };
	const live = cleanText(snapshot.provider ? `${snapshot.provider}/${snapshot.model}` : snapshot.model);
	return { queued, live: live !== "" && live !== queued ? live : undefined };
}

function formatActivity(snapshot: OutboxSessionSnapshot | undefined, now: number): string {
	if (!snapshot) return "unavailable";
	return isOutboxSessionLive(snapshot, now) ? cleanText(snapshot.activity || "Idle") : "unavailable";
}

function stateTone(state: OutboxState): "success" | "error" | "warning" | "accent" | undefined {
	switch (state) {
		case "completed":
			return "success";
		case "attention":
			return "error";
		case "waiting":
		case "watching":
			return "warning";
		case "running":
		case "dispatching":
			return "accent";
		default:
			return undefined;
	}
}

export class OutboxSelectorComponent extends OverlayPanel {
	#store: OutboxStore;
	#callbacks: OutboxSelectorCallbacks;
	#state: OutboxViewState;
	#allJobs: OutboxJob[] = [];
	#jobs: OutboxJob[] = [];
	#snapshots: Map<string, OutboxSessionSnapshot> = new Map();
	#head: OutboxJob | undefined;
	#blockers = new Map<string, OutboxJob>();
	#selectedIndex = 0;
	#scrollOffset = 0;
	#isArmed = false;
	#storeError: string | undefined;
	#actionError: string | undefined;
	#timer: NodeJS.Timeout | undefined;
	#editing = false;
	#disposed = false;

	constructor(store: OutboxStore, callbacks: OutboxSelectorCallbacks, state: OutboxViewState) {
		super("Outbox", "omp.overlay.outbox");
		this.#store = store;
		this.#callbacks = callbacks;
		this.#state = state;
		this.refresh();
		this.#timer = setInterval(() => this.refresh(), 1000);
	}

	get jobs(): readonly OutboxJob[] {
		return this.#jobs;
	}

	get selectedIndex(): number {
		return this.#selectedIndex;
	}

	get selectedJob(): OutboxJob | undefined {
		return this.#jobs[this.#selectedIndex];
	}

	get isArmed(): boolean {
		return this.#isArmed;
	}

	get lastError(): string | undefined {
		return this.#actionError || this.#storeError;
	}

	get scope(): "current" | "all" {
		return this.#state.scope;
	}

	override dispose(): void {
		this.#disposed = true;
		if (this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
		super.dispose();
	}

	refresh(): void {
		if (this.#disposed || this.#editing) return;
		try {
			const allJobs = this.#store.list();
			const isArmed = this.#store.isArmed();
			const head = allJobs.find(job => job.state !== "completed" && job.state !== "cancelled");
			const snapshotList = this.#store.sessions();
			const snapshots = new Map(snapshotList.map(s => [s.sessionId, s]));

			const blockers = new Map<string, OutboxJob>();
			for (const job of allJobs) {
				const blocker = outboxJobBlocker(job, allJobs);
				if (blocker) blockers.set(job.id, blocker);
			}
			this.#allJobs = allJobs;
			this.#isArmed = isArmed;
			this.#head = head;
			this.#blockers = blockers;
			this.#snapshots = snapshots;
			this.#storeError = undefined;

			this.#jobs =
				this.#state.scope === "current"
					? this.#allJobs.filter(j => j.sessionId === this.#callbacks.currentSessionId)
					: this.#allJobs;

			if (this.#jobs.length === 0) {
				this.#selectedIndex = 0;
				this.#scrollOffset = 0;
				this.#state.selectedJobId = undefined;
			} else {
				const targetId = this.#state.selectedJobId;
				const idx = targetId !== undefined ? this.#jobs.findIndex(j => j.id === targetId) : -1;
				this.#selectedIndex = idx !== -1 ? idx : Math.min(this.#selectedIndex, this.#jobs.length - 1);

				const { selectedIndex, scrollOffset } = clampSelection(
					this.#selectedIndex,
					this.#scrollOffset,
					this.#jobs.length,
					MAX_VISIBLE_ROWS,
				);
				this.#selectedIndex = selectedIndex;
				this.#scrollOffset = scrollOffset;
				this.#state.selectedJobId = this.#jobs[this.#selectedIndex]?.id;
			}
		} catch (error) {
			this.#storeError = error instanceof Error ? error.message : String(error);
			this.#snapshots.clear();
		}

		this.title = `Outbox [${this.#isArmed ? "Armed" : "Paused"}]`;
		this.invalidate();
		this.#callbacks.requestRender?.();
	}

	#reason(job: OutboxJob): string {
		const blocker = this.#blockers.get(job.id);
		return blocker
			? `Blocked by #${blocker.position}: ${formatSessionName(blocker, this.#snapshots.get(blocker.sessionId))} [${blocker.state}]`
			: cleanText(job.reason);
	}

	async #runAction(fn: () => Promise<void> | void): Promise<void> {
		this.#actionError = undefined;
		try {
			await fn();
			this.refresh();
		} catch (error) {
			this.#actionError = error instanceof Error ? error.message : String(error);
			this.invalidate();
		}
		this.#callbacks.requestRender?.();
	}

	async #handleDestination(action: "onAdd" | "onResume"): Promise<void> {
		const targetSessionId = this.#state.scope === "current" ? this.#callbacks.currentSessionId : undefined;
		this.#editing = true;
		this.#actionError = undefined;
		try {
			await this.#callbacks[action](targetSessionId);
		} catch (error) {
			this.#actionError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#editing = false;
			this.refresh();
			this.#callbacks.requestRender?.();
		}
	}

	async #toggleRun(): Promise<void> {
		this.refresh();
		if (this.#storeError) return;
		if (!this.#head) {
			await this.#handleDestination("onResume");
			return;
		}
		await this.#runAction(async () => {
			if (this.#isArmed) pauseOutbox();
			else await startOutbox();
		});
	}

	async #editSelected(job: OutboxJob): Promise<void> {
		if (job.kind === "resume" || !this.#callbacks.onEdit) return;
		this.#editing = true;
		this.#actionError = undefined;
		try {
			await this.#callbacks.onEdit(job);
		} catch (error) {
			this.#actionError = error instanceof Error ? error.message : String(error);
		} finally {
			this.#editing = false;
			this.refresh();
			this.#callbacks.requestRender?.();
		}
	}

	async handleInput(data: string): Promise<void> {
		if (matchesSelectCancel(data) || matchesKey(data, "q") || matchesKey(data, "escape")) {
			this.dispose();
			this.#callbacks.onClose();
			return;
		}

		if (matchesKey(data, "tab") || matchesKey(data, "shift+tab")) {
			this.#state.scope = this.#state.scope === "current" ? "all" : "current";
			this.refresh();
			return;
		}

		if (matchesKey(data, "a") || matchesKey(data, "c")) {
			await this.#handleDestination(matchesKey(data, "c") ? "onResume" : "onAdd");
			return;
		}

		if (matchesSelectUp(data) || matchesKey(data, "k")) {
			if (this.#jobs.length > 0) {
				this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
				this.#state.selectedJobId = this.#jobs[this.#selectedIndex]?.id;
				this.refresh();
			}
			return;
		}

		if (matchesSelectDown(data) || matchesKey(data, "j")) {
			if (this.#jobs.length > 0) {
				this.#selectedIndex = Math.min(this.#jobs.length - 1, this.#selectedIndex + 1);
				this.#state.selectedJobId = this.#jobs[this.#selectedIndex]?.id;
				this.refresh();
			}
			return;
		}

		if (matchesKey(data, "pageUp")) {
			this.#selectedIndex = Math.max(0, this.#selectedIndex - MAX_VISIBLE_ROWS);
			this.#state.selectedJobId = this.#jobs[this.#selectedIndex]?.id;
			this.refresh();
			return;
		}

		if (matchesKey(data, "pageDown")) {
			this.#selectedIndex = Math.min(this.#jobs.length - 1, this.#selectedIndex + MAX_VISIBLE_ROWS);
			this.#state.selectedJobId = this.#jobs[this.#selectedIndex]?.id;
			this.refresh();
			return;
		}

		if (matchesKey(data, "home")) {
			this.#selectedIndex = 0;
			this.#state.selectedJobId = this.#jobs[this.#selectedIndex]?.id;
			this.refresh();
			return;
		}

		if (matchesKey(data, "end")) {
			this.#selectedIndex = Math.max(0, this.#jobs.length - 1);
			this.#state.selectedJobId = this.#jobs[this.#selectedIndex]?.id;
			this.refresh();
			return;
		}

		if (matchesKey(data, "space") || (matchesKey(data, "enter") && !this.#head)) {
			await this.#toggleRun();
			return;
		}

		const selected = this.#jobs[this.#selectedIndex];
		if (!selected) return;

		if (matchesKey(data, "x")) {
			await this.#runAction(() => this.#store.cancel(selected.id));
			return;
		}

		if (matchesKey(data, "delete")) {
			await this.#runAction(() => this.#store.remove(selected.id));
			return;
		}

		if (matchesKey(data, "r")) {
			await this.#runAction(() => this.#store.retry(selected.id));
			return;
		}

		if (matchesKey(data, "u") || matchesKey(data, "shift+up")) {
			await this.#runAction(() => {
				const target = Math.max(1, selected.position - 1);
				this.#store.move(selected.id, target);
			});
			return;
		}

		if (matchesKey(data, "d") || matchesKey(data, "shift+down")) {
			await this.#runAction(() => {
				const target = selected.position + 1;
				this.#store.move(selected.id, target);
			});
			return;
		}

		if (matchesKey(data, "e") || matchesKey(data, "enter")) {
			await this.#editSelected(selected);
			return;
		}
	}

	override describe(_cx: DescribeContext): NativeNode | null {
		const selected = this.#jobs[this.#selectedIndex];
		const now = Date.now();
		const err = this.lastError;

		const buttons: (NativeNode | null)[] = [
			actionButton("Add Message", "add", { keys: "a", tone: "accent" }),
			actionButton("Resume chat", "resume", { keys: "c" }),
			actionButton(this.#state.scope === "current" ? "● Current chat" : "Current chat", "scope-current", {
				tone: this.#state.scope === "current" ? "accent" : undefined,
			}),
			actionButton(this.#state.scope === "all" ? "● All chats" : "All chats", "scope-all", {
				tone: this.#state.scope === "all" ? "accent" : undefined,
			}),
			actionButton(!this.#head ? "Arm resume" : this.#isArmed ? "Pause" : "Run", "toggle-run", {
				keys: "space",
				tone: this.#isArmed ? undefined : "accent",
			}),
		];
		if (selected) {
			buttons.push(
				selected.kind === "resume" ? null : actionButton("Edit", "edit", { keys: "e" }),
				actionButton("Move Up", "move-up", { keys: "u" }),
				actionButton("Move Down", "move-down", { keys: "d" }),
				actionButton("Retry", "retry", { keys: "r" }),
				actionButton("Cancel", "cancel-job", { keys: "x", tone: "error" }),
				actionButton("Remove", "remove-job", { keys: "delete", tone: "error" }),
			);
		}
		buttons.push(null, actionButton("Close", "close", { keys: "escape" }));

		const headSpans: TspSpan[] = [
			span(this.#isArmed ? "● Armed" : "⏸ Paused", this.#isArmed ? "accent" : "warning"),
			span(
				this.#state.scope === "current"
					? ` · ${this.#jobs.length} shown / ${this.#allJobs.length} total`
					: ` · ${this.#jobs.length} jobs in queue`,
				"muted",
			),
			span(this.#state.scope === "current" ? " · [Current chat]" : " · [All chats]", "accent"),
		];

		const blocker = selected && this.#blockers.get(selected.id);
		if (this.#state.scope === "current" && blocker && blocker.sessionId !== this.#callbacks.currentSessionId) {
			headSpans.push(span(` · ${this.#reason(selected!)}`, "warning"));
		}

		if (err) {
			headSpans.push(span(` · Error: ${cleanText(err)}`, "error"));
		}

		const items: NativeChild[] = this.#jobs.map(job => {
			const snapshot = this.#snapshots.get(job.sessionId);
			const session = formatSessionName(job, snapshot);
			const project = getProjectName(job.cwd);
			const { queued, live } = formatModel(job, snapshot);
			const modelLabel = live ? `${queued} (live: ${live})` : queued;
			const activity = formatActivity(snapshot, now);
			const blocked = this.#blockers.has(job.id);
			const status = `${job.kind === "resume" ? "RESUME · " : ""}${blocked ? "BLOCKED" : job.state.toUpperCase()}`;
			const prompt = truncateToWidth(cleanText(job.text), 40);
			const countdown =
				!blocked && job.nextCheckAt ? ` · in ${Math.max(0, Math.ceil((job.nextCheckAt - now) / 1000))}s` : "";
			const reasonText = this.#reason(job);
			const reason = reasonText ? ` · ${reasonText}` : "";
			const tone = blocked ? "warning" : stateTone(job.state);

			return item(job.id, {
				label: compact([
					span(`#${job.position} `, "strong"),
					span(`[${status}] `, tone ?? "mono dim"),
					span(`${session} `),
					span(`[${project}] `, "dim"),
					span(`(${activity}) `, activity === "unavailable" ? "dim" : "accent"),
					span(`· ${modelLabel}: ${prompt}`),
				]),
				value: compact([reason !== "" && span(reason, "dim"), countdown !== "" && span(countdown, "warning")]),
				tone,
				title: `${job.text}\n${job.state} · #${job.position} · ${job.id}${reason}${countdown}`,
				aria: `Job ${job.position}, ${status}, ${session}, ${project}, ${activity}, ${modelLabel}${reason}`,
			});
		});

		const listNode = selectList("jobs", items, {
			selected: selected?.id,
			max: { lines: MAX_VISIBLE_ROWS },
		});

		let detailNode: NativeNode | null = null;
		if (selected) {
			const selectedSnapshot = this.#snapshots.get(selected.sessionId);
			const selectedSession = formatSessionName(selected, selectedSnapshot);
			const selectedProject = getProjectName(selected.cwd);
			const { queued, live } = formatModel(selected, selectedSnapshot);
			const modelLabel = live ? `${queued} (live: ${live})` : queued;
			const activity = formatActivity(selectedSnapshot, now);
			const blocked = this.#blockers.has(selected.id);
			const reason = this.#reason(selected);
			const countdown =
				!blocked && selected.nextCheckAt
					? `in ${Math.max(0, Math.ceil((selected.nextCheckAt - now) / 1000))}s`
					: "";
			const selectedPrompt = cleanText(selected.text);
			const queueTone = blocked ? "warning" : stateTone(selected.state);

			detailNode = col(
				compact([
					text([span("Selected: ", "strong"), span(selected.id, "accent")]),
					text([
						span("Chat: ", "dim"),
						span(selectedSession),
						span(` · ID: ${cleanText(selected.sessionId)}`, "dim"),
					]),
					text([
						span("Project: ", "dim"),
						span(selectedProject),
						span(` · CWD: ${cleanText(selected.cwd)}`, "dim"),
					]),
					text([
						span("Model: ", "dim"),
						span(modelLabel),
						span(" · Activity: ", "dim"),
						span(activity, activity === "unavailable" ? "dim" : "accent"),
						span(" · Queue: ", "dim"),
						span(
							`${selected.kind === "resume" ? "Resume · " : ""}${blocked ? "blocked" : selected.state}`,
							queueTone,
						),
					]),
					reason !== "" ? text([span(`Error / Reason: ${reason}`, "error")]) : null,
					countdown !== "" ? text([span(`Next check: ${countdown}`, "warning")]) : null,
					text([
						span(selected.kind === "resume" ? "Condition: " : "Prompt: ", "dim"),
						span(truncateToWidth(selectedPrompt, 120)),
					]),
				]),
				{ gap: "none" },
			);
		}

		const bodyChildren = [text(headSpans), listNode];
		if (!this.#head) bodyChildren.push(text("Resume existing work when quota returns · Space/Enter to arm resume"));
		if (detailNode) bodyChildren.push(detailNode);
		bodyChildren.push(actionBar(buttons));

		return overlayCard("omp.overlay.outbox", `Outbox [${this.#isArmed ? "Armed" : "Paused"}]`, [
			col(bodyChildren, { gap: "sm" }),
		]);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type === "select" || event.type === "activate") {
			const index = this.#jobs.findIndex(j => j.id === event.item);
			if (index !== -1) {
				this.#selectedIndex = index;
				this.#state.selectedJobId = event.item;
				this.refresh();
			}
			return;
		}
		if (event.type !== "action") return;

		switch (event.act) {
			case "close":
				this.dispose();
				this.#callbacks.onClose();
				return;
			case "scope-current":
				this.#state.scope = "current";
				this.refresh();
				return;
			case "scope-all":
				this.#state.scope = "all";
				this.refresh();
				return;
			case "add":
				void this.#handleDestination("onAdd");
				return;
			case "resume":
				void this.#handleDestination("onResume");
				return;
			case "toggle-run":
				void this.#toggleRun();
				return;
		}

		const selected = this.#jobs[this.#selectedIndex];
		if (!selected) return;

		switch (event.act) {
			case "edit":
				void this.#editSelected(selected);
				return;
			case "move-up":
				void this.#runAction(() => {
					const target = Math.max(1, selected.position - 1);
					this.#store.move(selected.id, target);
				});
				return;
			case "move-down":
				void this.#runAction(() => {
					const target = selected.position + 1;
					this.#store.move(selected.id, target);
				});
				return;
			case "retry":
				void this.#runAction(() => this.#store.retry(selected.id));
				return;
			case "cancel-job":
				void this.#runAction(() => this.#store.cancel(selected.id));
				return;
			case "remove-job":
				void this.#runAction(() => this.#store.remove(selected.id));
				return;
		}
	}

	override render(width: number): readonly string[] {
		width = Number.isFinite(width) ? Math.max(0, Math.trunc(width)) : 0;
		const innerWidth = Math.max(1, width - 4);
		const contentLines = this.#renderContent(innerWidth);
		const border = this.#isArmed ? "accent" : "warning";
		const title = `Outbox [${this.#isArmed ? "Armed" : "Paused"}]`;
		const result: string[] = [topBorder(width, title, border)];
		for (const line of contentLines) {
			result.push(row(line, width, border));
		}
		result.push(bottomBorder(width, border));
		return result;
	}

	#renderContent(width: number): string[] {
		const lines: string[] = [];
		const now = Date.now();
		const err = this.lastError;

		const statusText = this.#isArmed ? theme.fg("accent", "● ARMED") : theme.fg("warning", "⏸ PAUSED");
		const countText = theme.fg(
			"muted",
			this.#state.scope === "current"
				? `${this.#jobs.length} shown / ${this.#allJobs.length} total`
				: `${this.#allJobs.length} jobs in queue`,
		);
		const scopeToggleText =
			this.#state.scope === "current"
				? `${theme.bold(theme.fg("accent", "[Current chat]"))} ${theme.fg("dim", "All chats")}`
				: `${theme.fg("dim", "Current chat")} ${theme.bold(theme.fg("accent", "[All chats]"))}`;

		const statusLine = `${theme.bold(statusText)} · ${countText} · ${scopeToggleText}`;
		lines.push(statusLine);
		if (!this.#head) {
			lines.push(theme.fg("accent", "Resume existing work when quota returns · Space/Enter to arm resume"));
		}

		const selectedBlocker = this.selectedJob && this.#blockers.get(this.selectedJob.id);
		if (
			this.#state.scope === "current" &&
			selectedBlocker &&
			selectedBlocker.sessionId !== this.#callbacks.currentSessionId
		) {
			lines.push(theme.fg("warning", this.#reason(this.selectedJob!)));
		}

		if (err) {
			lines.push(theme.fg("error", `Error: ${cleanText(err)}`));
		}
		lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));

		if (this.#jobs.length === 0) {
			lines.push(
				theme.fg(
					"muted",
					err
						? "Unable to load outbox jobs due to an error."
						: this.#state.scope === "current"
							? "No messages for current chat. Press 'a' to add or Tab to view all chats."
							: "No messages in outbox. Queue drafts with /outbox add or press 'a'.",
				),
			);
		} else {
			const rowWidth = contentRowWidth(width, this.#jobs.length, MAX_VISIBLE_ROWS);
			const visibleSlice = this.#jobs.slice(this.#scrollOffset, this.#scrollOffset + MAX_VISIBLE_ROWS);

			const renderedRows: string[] = [];
			for (let i = 0; i < visibleSlice.length; i++) {
				const job = visibleSlice[i]!;
				const actualIndex = this.#scrollOffset + i;
				const isSelected = actualIndex === this.#selectedIndex;
				const cursor = isSelected ? theme.bold(theme.fg("accent", "▶ ")) : "  ";
				const pos = theme.bold(`#${job.position}`);
				const blocked = this.#blockers.has(job.id);
				const badgeColor = blocked ? "warning" : (stateTone(job.state) ?? "muted");
				const stateBadge = theme.fg(
					badgeColor,
					`[${job.kind === "resume" ? "resume · " : ""}${blocked ? "blocked" : job.state}]`,
				);
				const snapshot = this.#snapshots.get(job.sessionId);
				const sessionName = formatSessionName(job, snapshot);
				const project = getProjectName(job.cwd);
				const { queued, live } = formatModel(job, snapshot);
				const modelLabel = live ? `${queued} (live: ${live})` : queued;
				const activity = formatActivity(snapshot, now);
				const session = theme.fg("accent", sessionName);
				const projectBadge = theme.fg("dim", `[${project}]`);
				const activityBadge = theme.fg(activity === "unavailable" ? "dim" : "accent", `(${activity})`);
				const modelBadge = theme.fg("dim", modelLabel);
				const att = job.attachments?.length ? theme.fg("warning", ` [${job.attachments.length} img]`) : "";
				const countdown =
					!blocked && job.nextCheckAt
						? theme.fg("warning", ` (${Math.max(0, Math.ceil((job.nextCheckAt - now) / 1000))}s)`)
						: "";
				const reasonText = this.#reason(job);
				const reason = reasonText ? theme.fg("error", ` [${reasonText}]`) : "";
				const textPreview = truncateToWidth(cleanText(job.text), Math.max(10, rowWidth - 55));
				const rowStr = `${cursor}${pos} ${stateBadge} ${session} ${projectBadge} ${activityBadge} ${modelBadge}${reason}${countdown}${att} ${textPreview}`;
				renderedRows.push(isSelected ? theme.bold(rowStr) : rowStr);
			}

			const scrollable = renderScrollableList(renderedRows, {
				width,
				totalRows: this.#jobs.length,
				scrollOffset: this.#scrollOffset,
			});
			lines.push(...scrollable);

			const selected = this.#jobs[this.#selectedIndex];
			if (selected) {
				lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
				const selectedSnapshot = this.#snapshots.get(selected.sessionId);
				const selectedSession = formatSessionName(selected, selectedSnapshot);
				const selectedProject = getProjectName(selected.cwd);
				const { queued, live } = formatModel(selected, selectedSnapshot);
				const modelLabel = live ? `${queued} (live: ${live})` : queued;
				const selectedActivity = formatActivity(selectedSnapshot, now);
				const activityColor = selectedActivity === "unavailable" ? "dim" : "accent";
				const blocked = this.#blockers.has(selected.id);
				const queueColor = blocked ? "warning" : (stateTone(selected.state) ?? "muted");
				const stateBadge = theme.fg(
					queueColor,
					`${selected.kind === "resume" ? "Resume · " : ""}${blocked ? "blocked" : selected.state}`,
				);
				const countdownStr =
					!blocked && selected.nextCheckAt
						? theme.fg("warning", ` · check in ${Math.max(0, Math.ceil((selected.nextCheckAt - now) / 1000))}s`)
						: "";
				const reasonText = this.#reason(selected);
				const reasonStr = reasonText ? theme.fg("error", ` · ${reasonText}`) : "";

				lines.push(truncateToWidth(theme.bold("Selected: ") + theme.fg("accent", selected.id), width));
				lines.push(
					truncateToWidth(
						theme.fg("dim", "Chat: ") + selectedSession + theme.fg("dim", ` (${cleanText(selected.sessionId)})`),
						width,
					),
				);
				lines.push(
					truncateToWidth(
						theme.fg("dim", "Project: ") + selectedProject + theme.fg("dim", ` (${cleanText(selected.cwd)})`),
						width,
					),
				);
				lines.push(
					truncateToWidth(
						theme.fg("dim", "Model: ") +
							modelLabel +
							theme.fg("dim", " · Activity: ") +
							theme.fg(activityColor, selectedActivity) +
							theme.fg("dim", " · Queue: ") +
							stateBadge +
							countdownStr +
							reasonStr,
						width,
					),
				);
				lines.push(
					truncateToWidth(
						theme.fg("muted", selected.kind === "resume" ? "Condition: " : "Prompt: ") + cleanText(selected.text),
						width,
					),
				);
			}
		}

		lines.push(theme.fg("border", "─".repeat(Math.max(1, width))));
		lines.push(
			theme.fg(
				"dim",
				`↑/↓ select · a add · c Resume chat · Tab view${this.selectedJob?.kind === "resume" ? "" : " · e edit"} · u/d reorder · x cancel · Del remove · r retry · space ${this.#head ? "run/pause" : "Arm resume"} · Esc close`,
			),
		);
		return lines;
	}
}
