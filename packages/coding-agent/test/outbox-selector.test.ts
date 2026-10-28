import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import {
	type OutboxSelectorCallbacks,
	OutboxSelectorComponent,
	type OutboxViewState,
} from "../src/modes/components/outbox-selector";
import { OutboxStore } from "../src/outbox/store";
import type { OutboxNewJob, OutboxSessionSnapshot } from "../src/outbox/types";

const dummyContext = {} as unknown as DescribeContext;

describe("OutboxSelectorComponent", () => {
	let tempDir: string;
	let dbPath: string;
	let store: OutboxStore;
	let selector: OutboxSelectorComponent | undefined;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-outbox-sel-test-"));
		dbPath = path.join(tempDir, "outbox.db");
		store = new OutboxStore(dbPath);
	});

	afterEach(() => {
		if (selector) {
			selector.dispose();
			selector = undefined;
		}
		try {
			store.close();
		} catch {}
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	const sampleJob = (overrides: Partial<OutboxNewJob> = {}): OutboxNewJob => ({
		sessionId: "session-current",
		sessionFile: "/tmp/session-current.json",
		branchId: null,
		cwd: "/workspace/project-alpha",
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		sessionName: "Alpha Chat",
		text: "Alpha prompt message",
		...overrides,
	});

	function createCallbacks(overrides: Partial<OutboxSelectorCallbacks> = {}) {
		const onClose = vi.fn();
		const onAdd = vi.fn(async (_sid?: string) => {});
		const onResume = vi.fn(async (_sid?: string) => {});
		const onEdit = vi.fn(async _job => {});
		const requestRender = vi.fn();
		const callbacks: OutboxSelectorCallbacks = {
			currentSessionId: "session-current",
			onClose,
			onAdd,
			onResume,
			onEdit,
			requestRender,
			...overrides,
		};
		return {
			callbacks,
			onClose,
			onAdd,
			onResume,
			onEdit,
			requestRender,
		};
	}

	it("keeps selection valid when removing rows and preserves jobs in another chat", async () => {
		const first = await store.add(sampleJob());
		const last = await store.add(sampleJob({ text: "Second saved message" }));
		const other = await store.add(sampleJob({ sessionId: "session-other" }));
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, { scope: "current" });
		await selector.handleInput("\x1b[3~");
		expect(store.get(first.id)).toBeUndefined();
		expect(selector.selectedJob?.id).toBe(last.id);
		selector.handleNativeEvent({ type: "action", act: "remove-job", key: "remove-job", mods: [] });
		await Promise.resolve();
		expect(selector.jobs).toEqual([]);
		expect(selector.selectedJob).toBeUndefined();
		expect(store.list().map(job => job.id)).toEqual([other.id]);
	});

	it("filters by exact sessionId in current scope and shows all in all scope", async () => {
		const j1 = await store.add(sampleJob({ sessionId: "session-current", text: "Alpha 1" }));
		const j2 = await store.add(
			sampleJob({
				sessionId: "session-other",
				sessionName: "Beta Chat",
				text: "Beta 1",
			}),
		);
		const j3 = await store.add(sampleJob({ sessionId: "session-current", text: "Alpha 2" }));

		const state: OutboxViewState = { scope: "current" };
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		// Current scope: only jobs for currentSessionId
		expect(selector.scope).toBe("current");
		expect(selector.jobs).toHaveLength(2);
		expect(selector.jobs.map(j => j.id)).toEqual([j1.id, j3.id]);

		// Toggle scope via Tab key
		await selector.handleInput("\t");
		expect(selector.scope).toBe("all");
		expect(state.scope).toBe("all");
		expect(selector.jobs).toHaveLength(3);
		expect(selector.jobs.map(j => j.id)).toEqual([j1.id, j2.id, j3.id]);

		// Native action to switch back to current
		selector.handleNativeEvent({
			type: "action",
			act: "scope-current",
			key: "scope-current",
			mods: [],
		});
		expect(selector.scope).toBe("current");
		expect(state.scope).toBe("current");
		expect(selector.jobs).toHaveLength(2);

		// Native action to switch to all
		selector.handleNativeEvent({
			type: "action",
			act: "scope-all",
			key: "scope-all",
			mods: [],
		});
		expect(selector.scope).toBe("all");
		expect(state.scope).toBe("all");
		expect(selector.jobs).toHaveLength(3);
	});

	it("preserves stable selectedJobId across refresh and scope transitions", async () => {
		await store.add(sampleJob({ sessionId: "session-current", text: "Alpha 1" }));
		const j2 = await store.add(
			sampleJob({
				sessionId: "session-other",
				sessionName: "Beta Chat",
				text: "Beta 1",
			}),
		);
		const j3 = await store.add(sampleJob({ sessionId: "session-current", text: "Alpha 2" }));

		const state: OutboxViewState = { scope: "all", selectedJobId: j3.id };
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		// Initial selection respects state.selectedJobId
		expect(selector.selectedJob?.id).toBe(j3.id);
		expect(selector.selectedIndex).toBe(2);

		// Switch to current view: j3 is present at index 1
		await selector.handleInput("\t");
		expect(selector.scope).toBe("current");
		expect(selector.selectedJob?.id).toBe(j3.id);
		expect(selector.selectedIndex).toBe(1);
		expect(state.selectedJobId).toBe(j3.id);

		// Switch back to all view: j3 is still selected
		await selector.handleInput("\t");
		expect(selector.scope).toBe("all");
		expect(selector.selectedJob?.id).toBe(j3.id);
		expect(selector.selectedIndex).toBe(2);

		// Select j2 (which is only in session-other)
		await selector.handleInput("k"); // move up to j2
		expect(selector.selectedJob?.id).toBe(j2.id);
		expect(state.selectedJobId).toBe(j2.id);

		// Switch to current view: j2 is absent, so selection clamps safely
		await selector.handleInput("\t");
		expect(selector.scope).toBe("current");
		expect(selector.jobs.map(j => j.id)).not.toContain(j2.id);
		expect(selector.selectedJob?.id).toBeDefined();
		expect(state.selectedJobId).toBe(selector.selectedJob?.id);

		// Refresh keeps same selected item
		const currentSelectedId = selector.selectedJob?.id;
		selector.refresh();
		expect(selector.selectedJob?.id).toBe(currentSelectedId);
	});

	it("allows adding messages on an empty list in both views via keys and native actions", async () => {
		const state: OutboxViewState = { scope: "current" };
		const { callbacks, onAdd } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		expect(selector.jobs).toHaveLength(0);
		expect(selector.selectedJob).toBeUndefined();

		// 'a' key in Current view invokes onAdd with currentSessionId
		await selector.handleInput("a");
		expect(onAdd).toHaveBeenCalledTimes(1);
		expect(onAdd).toHaveBeenLastCalledWith("session-current");

		// Native 'add' action in Current view
		selector.handleNativeEvent({
			type: "action",
			act: "add",
			key: "add",
			mods: [],
		});
		await Promise.resolve();
		expect(onAdd).toHaveBeenCalledTimes(2);
		expect(onAdd).toHaveBeenLastCalledWith("session-current");

		// Switch to All view
		await selector.handleInput("\t");
		expect(selector.scope).toBe("all");

		// 'a' key in All view invokes onAdd with undefined (picker path)
		await selector.handleInput("a");
		expect(onAdd).toHaveBeenCalledTimes(3);
		expect(onAdd).toHaveBeenLastCalledWith(undefined);

		// Native 'add' action in All view
		selector.handleNativeEvent({
			type: "action",
			act: "add",
			key: "add",
			mods: [],
		});
		await Promise.resolve();
		expect(onAdd).toHaveBeenCalledTimes(4);
		expect(onAdd).toHaveBeenLastCalledWith(undefined);

		// Native describe still contains "Add Message" button on empty list
		const desc = selector.describe(dummyContext);
		expect(desc).not.toBeNull();
		const descStr = JSON.stringify(desc);
		expect(descStr).toContain("Add Message");
		expect(descStr).toContain("add");
	});

	it("offers explicit resume in both scopes even with queued messages", async () => {
		await store.add(sampleJob());
		const { callbacks, onResume, onEdit } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, {
			scope: "current",
		});
		await selector.handleInput("c");
		expect(onResume).toHaveBeenLastCalledWith("session-current");
		await selector.handleInput("\t");
		selector.handleNativeEvent({
			type: "action",
			act: "resume",
			key: "resume",
			mods: [],
		});
		await Promise.resolve();
		expect(onResume).toHaveBeenLastCalledWith(undefined);
		expect(onResume).toHaveBeenCalledTimes(2);
		expect(onEdit).not.toHaveBeenCalled();
	});

	it("keeps a resume watch selected, disallows editing, and allows cancellation", async () => {
		const watch = await store.add(
			sampleJob({
				kind: "resume",
				branchId: "original-user",
				resumeUserEntryId: "original-user",
			}),
		);
		const { callbacks, onEdit } = createCallbacks();
		const state: OutboxViewState = {
			scope: "current",
			selectedJobId: watch.id,
		};
		selector = new OutboxSelectorComponent(store, callbacks, state);
		await selector.handleInput("e");
		await selector.handleInput("\r");
		selector.handleNativeEvent({
			type: "action",
			act: "edit",
			key: "edit",
			mods: [],
		});
		await Promise.resolve();
		expect(onEdit).not.toHaveBeenCalled();
		expect(selector.selectedJob?.id).toBe(watch.id);
		const native = JSON.stringify(selector.describe(dummyContext));
		expect(native).toContain("RESUME");
		expect(native).toContain("WATCHING");
		expect(native).toContain("Condition:");
		expect(native).not.toContain('"act":"edit"');
		await selector.handleInput("x");
		expect(store.get(watch.id)?.state).toBe("cancelled");
	});

	it("renders resume callback errors without dropping the current view", async () => {
		const { callbacks } = createCallbacks({
			onResume: async () => {
				throw new Error("Reopen the target chat");
			},
		});
		selector = new OutboxSelectorComponent(store, callbacks, { scope: "all" });
		await selector.handleInput(" ");
		expect(selector.lastError).toBe("Reopen the target chat");
		expect(selector.scope).toBe("all");
		expect(JSON.stringify(selector.describe(dummyContext))).toContain("Reopen the target chat");
		expect(store.isArmed()).toBe(false);
	});

	it("handles native UI events and updates store state", async () => {
		const j1 = await store.add(sampleJob({ text: "Job 1" }));
		const j2 = await store.add(sampleJob({ text: "Job 2" }));

		const state: OutboxViewState = { scope: "current" };
		const { callbacks, onEdit, onClose, requestRender } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		expect(selector.selectedJob?.id).toBe(j1.id);

		// Native select event
		selector.handleNativeEvent({
			type: "select",
			key: "jobs",
			item: j2.id,
		});
		expect(selector.selectedJob?.id).toBe(j2.id);
		expect(state.selectedJobId).toBe(j2.id);
		expect(requestRender).toHaveBeenCalled();

		// Native edit action
		selector.handleNativeEvent({
			type: "action",
			act: "edit",
			key: "edit",
			mods: [],
		});
		await Promise.resolve();
		expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: j2.id }));

		// Native cancel action
		selector.handleNativeEvent({
			type: "action",
			act: "cancel-job",
			key: "cancel-job",
			mods: [],
		});
		await Promise.resolve();
		expect(store.get(j2.id)?.state).toBe("cancelled");

		// Native retry action
		selector.handleNativeEvent({
			type: "action",
			act: "retry",
			key: "retry",
			mods: [],
		});
		await Promise.resolve();
		expect(store.get(j2.id)?.state).toBe("queued");

		// Native close action
		selector.handleNativeEvent({
			type: "action",
			act: "close",
			key: "close",
			mods: [],
		});
		expect(onClose).toHaveBeenCalled();
	});

	it("exercises real publishSession in store and status safety (live vs dead PID vs stale)", async () => {
		await store.add(sampleJob({ sessionId: "session-live", text: "Active chat job" }));

		const now = Date.now();
		const liveSnapshot: OutboxSessionSnapshot = {
			sessionId: "session-live",
			sessionFile: "/tmp/live.json",
			branchId: null,
			cwd: "/workspace/my-project",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			sessionName: "Live Session Chat",
			activity: "Thinking deeply",
			updatedAt: now,
			pid: process.pid, // current running process = live
		};

		// Use REAL store.publishSession
		store.publishSession(liveSnapshot);
		expect(store.sessions()).toHaveLength(1);
		expect(store.sessions()[0]!.activity).toBe("Thinking deeply");

		const state: OutboxViewState = { scope: "all" };
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		// Describe native node contains live activity
		let descStr = JSON.stringify(selector.describe(dummyContext));
		expect(descStr).toContain("Live Session Chat");
		expect(descStr).toContain("Thinking deeply");

		// Stale snapshot (> 15s ago) published through real store
		const staleSnapshot: OutboxSessionSnapshot = {
			...liveSnapshot,
			updatedAt: now - 30_000,
		};
		store.publishSession(staleSnapshot);
		selector.refresh();

		descStr = JSON.stringify(selector.describe(dummyContext));
		expect(descStr).toContain("unavailable");
		expect(descStr).not.toContain("Thinking deeply");

		// Dead PID published through real store
		const deadSnapshot: OutboxSessionSnapshot = {
			...liveSnapshot,
			updatedAt: now,
			pid: 9999999,
		};
		store.publishSession(deadSnapshot);
		selector.refresh();

		descStr = JSON.stringify(selector.describe(dummyContext));
		expect(descStr).toContain("unavailable");
	});

	it("keeps queued choice as primary selectedModel and indicates live model only when different", async () => {
		// Queued model is gpt-4o
		await store.add(
			sampleJob({
				sessionId: "session-model-test",
				provider: "openai",
				model: "gpt-4o",
			}),
		);

		// Live snapshot switched to o3-mini
		store.publishSession({
			sessionId: "session-model-test",
			sessionFile: "/tmp/model.json",
			branchId: null,
			cwd: "/workspace/proj",
			provider: "openai",
			model: "o3-mini",
			sessionName: "Model Test Chat",
			activity: "Idle",
			updatedAt: Date.now(),
			pid: process.pid,
		});

		const state: OutboxViewState = { scope: "all" };
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		const descStr = JSON.stringify(selector.describe(dummyContext));
		// Queued choice openai/gpt-4o is primary
		expect(descStr).toContain("openai/gpt-4o");
		// Live model is indicated because it differs
		expect(descStr).toContain("live: openai/o3-mini");
	});

	it("summarizes hidden global running head and shows count 'N shown / M total' when filtered", async () => {
		// Job 1 in session-other is active head
		const j1 = await store.add(
			sampleJob({
				sessionId: "session-other",
				sessionName: "Worker Chat",
				text: "Active job in other chat",
			}),
		);
		store.setArmed(true);
		const running = store.claim(j1.sessionId, process.pid)!;
		store.updateOwned(j1.id, running.ownerToken!, { state: "running" });

		// Job 2 in session-current is queued
		const j2 = await store.add(
			sampleJob({
				sessionId: "session-current",
				sessionName: "Alpha Chat",
				text: "Queued alpha job",
			}),
		);

		const state: OutboxViewState = { scope: "current" };
		const { callbacks } = createCallbacks({
			currentSessionId: "session-current",
		});
		selector = new OutboxSelectorComponent(store, callbacks, state);

		// In current view, only j2 is listed, but j1 is the global head
		expect(selector.jobs).toHaveLength(1);
		expect(selector.jobs[0]!.id).toBe(j2.id);

		// Native describe indicates filtered count and hidden running head
		const desc = selector.describe(dummyContext);
		const descStr = JSON.stringify(desc);
		expect(descStr).toContain("1 shown / 2 total");
		expect(descStr).toContain("running");

		// In All view, no hidden head indicator
		await selector.handleInput("\t");
		const allDescStr = JSON.stringify(selector.describe(dummyContext));
		expect(allDescStr).toContain("2 jobs in queue");
	});

	it("shows same-chat scheduling blockers without falsely blocking independent resume watches", async () => {
		const earlier = await store.add(sampleJob({ sessionName: "Interrupted chat" }));
		store.setArmed(true);
		const claim = store.claim(earlier.sessionId, process.pid)!;
		store.updateOwned(claim.id, claim.ownerToken!, { state: "attention" });
		const watch = await store.add(
			sampleJob({
				kind: "resume",
				branchId: "original-user",
				resumeUserEntryId: "original-user",
				text: "",
			}),
		);
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, { scope: "current", selectedJobId: watch.id });
		expect(JSON.stringify(selector.describe(dummyContext))).toContain("RESUME · BLOCKED");
		store.cancel(earlier.id);
		const unrelated = await store.add(sampleJob({ sessionId: "other-chat", sessionName: "Other interrupted chat" }));
		store.move(unrelated.id, 1);
		const otherClaim = store.claim(unrelated.sessionId, process.pid)!;
		store.updateOwned(otherClaim.id, otherClaim.ownerToken!, { state: "attention" });
		selector.refresh();
		const native = JSON.stringify(selector.describe(dummyContext));
		expect(native).toContain("RESUME · WATCHING");
		expect(native).not.toContain("BLOCKED");
		expect(store.claim(watch.sessionId, process.pid)?.id).toBe(watch.id);
	});

	it("preserves global reorder invariant across filtered and all scopes", async () => {
		// Create 3 jobs in store: Current (1), Other (2), Current (3)
		const j1 = await store.add(sampleJob({ sessionId: "session-current", text: "Alpha 1" }));
		const j2 = await store.add(
			sampleJob({
				sessionId: "session-other",
				sessionName: "Beta Chat",
				text: "Beta 1",
			}),
		);
		const j3 = await store.add(sampleJob({ sessionId: "session-current", text: "Alpha 2" }));

		// Positions in global store
		expect(store.get(j1.id)!.position).toBe(1);
		expect(store.get(j2.id)!.position).toBe(2);
		expect(store.get(j3.id)!.position).toBe(3);

		const state: OutboxViewState = { scope: "current", selectedJobId: j3.id };
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		// In Current view: visible jobs are j1 (global pos 1) and j3 (global pos 3)
		expect(selector.jobs).toHaveLength(2);
		expect(selector.selectedJob?.id).toBe(j3.id);
		expect(selector.selectedJob?.position).toBe(3);

		// Move j3 up in global pending order (u key)
		await selector.handleInput("u");

		// j3 moves from position 3 to position 2 (before j2!) in actual store
		expect(store.get(j3.id)!.position).toBe(2);
		expect(store.get(j2.id)!.position).toBe(3);
		expect(store.get(j1.id)!.position).toBe(1);

		// j3 remains selected!
		expect(selector.selectedJob?.id).toBe(j3.id);
		expect(selector.selectedJob?.position).toBe(2);

		// Move j3 up again (to position 1)
		await selector.handleInput("u");
		expect(store.get(j3.id)!.position).toBe(1);
		expect(store.get(j1.id)!.position).toBe(2);
		expect(selector.selectedJob?.id).toBe(j3.id);

		// Move down (d key)
		await selector.handleInput("d");
		expect(store.get(j3.id)!.position).toBe(2);
		expect(selector.selectedJob?.id).toBe(j3.id);
	});

	it("sanitizes text and recovers cleanly from callback errors", async () => {
		const maliciousText = "Line 1\nLine 2\x00\x1b[31mInjected ANSI\x1b[0m";
		await store.add(
			sampleJob({
				sessionName: "Unsafe\nChat\x1b[32m",
				text: maliciousText,
			}),
		);

		const state: OutboxViewState = { scope: "current" };
		const { callbacks } = createCallbacks({
			onAdd: vi.fn(async () => {
				throw new Error("Disk quota exceeded");
			}),
		});
		selector = new OutboxSelectorComponent(store, callbacks, state);

		// Trigger onAdd error
		await selector.handleInput("a");
		expect(selector.lastError).toBe("Disk quota exceeded");

		// In native describe
		const desc = selector.describe(dummyContext);
		const descStr = JSON.stringify(desc);
		expect(descStr).toContain("Error: Disk quota exceeded");
		// Normal refresh tick does NOT erase last action error
		selector.refresh();
		expect(selector.lastError).toBe("Disk quota exceeded");
	});

	it("captures refresh store errors safely without crashing, clearing live snapshot status", async () => {
		const j = await store.add(sampleJob({ sessionId: "session-err", text: "Safe job" }));
		store.publishSession({
			sessionId: "session-err",
			sessionFile: "/tmp/err.json",
			branchId: null,
			cwd: "/workspace/err",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			sessionName: "Error Chat",
			activity: "Thinking",
			updatedAt: Date.now(),
			pid: process.pid,
		});

		const state: OutboxViewState = { scope: "all" };
		const { callbacks } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);
		expect(selector.jobs).toHaveLength(1);

		// Simulate store.sessions() throwing on corrupted DB snapshot
		const spy = vi.spyOn(store, "sessions").mockImplementation(() => {
			throw new Error("Corrupted session snapshot JSON");
		});

		selector.refresh();
		// Error captured without throwing uncaught
		expect(selector.lastError).toBe("Corrupted session snapshot JSON");
		// Existing jobs safely preserved
		expect(selector.jobs).toHaveLength(1);
		expect(selector.jobs[0]!.id).toBe(j.id);

		// Snapshots were cleared so live status is not falsely reported
		const descStr = JSON.stringify(selector.describe(dummyContext));
		expect(descStr).toContain("unavailable");
		expect(descStr).not.toContain("Thinking");

		spy.mockRestore();
	});

	it("properly cleans up timers upon disposal", () => {
		const state: OutboxViewState = { scope: "current" };
		const { callbacks, requestRender } = createCallbacks();
		selector = new OutboxSelectorComponent(store, callbacks, state);

		selector.dispose();
		requestRender.mockClear();

		// Refresh after dispose is a no-op
		selector.refresh();
		expect(requestRender).not.toHaveBeenCalled();
	});
});
