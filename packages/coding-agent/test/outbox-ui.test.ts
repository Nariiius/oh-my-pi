import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";
import { Settings } from "../src/config/settings";
import * as launchClient from "../src/launch/client";
import { OutboxSelectorComponent } from "../src/modes/components/outbox-selector";
import { InputController } from "../src/modes/controllers/input-controller";
import type { InteractiveModeContext } from "../src/modes/types";
import * as outboxService from "../src/outbox/service";
import type { OutboxStore } from "../src/outbox/store";
import {
	BUILTIN_OUTBOX_SLASH_COMMANDS,
	executeOutboxMutation,
	resolveJobById,
} from "../src/slash-commands/builtin-outbox";
import type { TuiSlashCommandRuntime } from "../src/slash-commands/types";

describe("Outbox UI & Input Controller", () => {
	let tempDir: string;
	let store: OutboxStore;
	let originalAgentDir: string | undefined;
	const disposers: (() => void)[] = [];

	beforeEach(() => {
		const canonicalTmp = fs.realpathSync(os.tmpdir());
		tempDir = fs.mkdtempSync(path.join(canonicalTmp, "omp-outbox-ui-test-"));
		originalAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tempDir;
		refreshDirsFromEnv();
		store = outboxService.getOutboxStore();
	});

	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
		vi.restoreAllMocks();
		if (originalAgentDir !== undefined) {
			process.env.PI_CODING_AGENT_DIR = originalAgentDir;
		} else {
			delete process.env.PI_CODING_AGENT_DIR;
		}
		refreshDirsFromEnv();
		try {
			store.close();
		} catch {}
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	function createMockContext(opts: {
		initialText?: string;
		expandedText?: string;
		pendingImages?: ImageContent[];
		pendingImageLinks?: (string | undefined)[];
	}) {
		let editorText = opts.initialText ?? "";
		const customHandlers = new Map<string, () => void>();
		const actionKeys = new Map<string, string[]>();

		const editor = {
			pendingImages: opts.pendingImages ? [...opts.pendingImages] : [],
			pendingImageLinks: opts.pendingImageLinks
				? [...opts.pendingImageLinks]
				: (opts.pendingImages ?? []).map(() => undefined),
			imageLinks: undefined as unknown,
			onQueueForReset: undefined as (() => void) | undefined,
			onDequeue: undefined as (() => void) | undefined,
			onRetry: undefined as (() => void) | undefined,
			setText(t: string) {
				editorText = t;
			},
			getText() {
				return editorText;
			},
			getExpandedText() {
				return opts.expandedText ?? editorText;
			},
			setCollapsedText(t: string) {
				editorText = t;
			},
			clearDraft() {
				editorText = "";
				this.pendingImages = [];
				this.pendingImageLinks = [];
				this.imageLinks = undefined;
			},
			setActionKeys(action: string, keys: string[]) {
				actionKeys.set(action, keys);
			},
			setCustomKeyHandler(key: string, handler: () => void) {
				customHandlers.set(key, handler);
			},
			clearCustomKeyHandlers() {
				customHandlers.clear();
			},
		};

		const showStatus = vi.fn();
		const showWarning = vi.fn();
		const showError = vi.fn();
		const requestRender = vi.fn();
		const showHookEditor = vi.fn(async () => undefined);
		const showOutboxSelector = vi.fn(async () => {});

		const keybindings = {
			getKeys: vi.fn((name: string) => {
				if (name === "app.message.outbox") return ["ctrl+alt+q"];
				return [];
			}),
			matches: vi.fn(() => false),
		};

		const sessionFile = path.join(tempDir, "chat.jsonl");
		fs.writeFileSync(sessionFile, "");

		const sessionManager = {
			getSessionId: () => "sess-1234",
			getSessionFile: () => sessionFile,
			getLeafId: () => "leaf-1",
			getCwd: () => tempDir,
			getSessionName: () => "My Chat",
			getHeader: () => ({ timestamp: new Date().toISOString() }),
			getEntries: () => [],
			getBranchView: () => [],
			onSessionNameChanged: () => () => {},
			claimForOutbox: vi.fn(),
			ensureOnDisk: vi.fn(async () => {}),
		};

		const session = {
			sessionManager,
			model: { provider: "anthropic", id: "claude-3-7-sonnet" },
			settings: Settings.isolated(),
			configuredThinkingLevel: () => undefined,
			isDisposed: false,
			getLastAssistantMessage: () => undefined,
			isStreaming: false,
			isRetrying: false,
			isCompacting: false,
			agent: { state: { messages: [] }, hasQueuedMessages: () => false },
			subscribe: () => () => {},
			subscribeRunState: () => () => {},
			activeToolExecutionUpdates: () => [],
			registerSessionChangeCallback: () => () => {},
			addDisposer: (dispose: () => void) => disposers.push(dispose),
		};

		const ctx = {
			editor,
			session,
			sessionManager,
			keybindings,
			showStatus,
			showWarning,
			showError,
			showHookEditor,
			showOutboxSelector,
			handleOutboxAddCommand: vi.fn(async (msg, detached) => {
				const controller = new InputController(ctx);
				await controller.handleQueueForReset(msg, detached);
			}),
			ui: {
				requestRender,
				addInputListener: vi.fn(),
				addStartListener: vi.fn(),
				getFocused: vi.fn(),
				hasOverlay: vi.fn(() => false),
				setFocus: vi.fn(),
			},
			collabGuest: false,
		} as unknown as InteractiveModeContext;

		return {
			ctx,
			editor,
			showStatus,
			showWarning,
			showError,
			customHandlers,
			actionKeys,
		};
	}

	describe("Draft losslessness and paste expansion", () => {
		it("captures expanded paste markers and images losslessly into outbox", async () => {
			const image: ImageContent = {
				type: "image",
				data: Buffer.from("fake-png-bytes").toString("base64"),
				mimeType: "image/png",
			};
			const h = createMockContext({
				initialText: "Look at [Paste #1, +5 lines] and [Image #1]",
				expandedText: "Look at function test() { return 42; } and [Image #1]",
				pendingImages: [image],
				pendingImageLinks: ["local://image.png"],
			});

			const controller = new InputController(h.ctx);
			await controller.handleQueueForReset();

			const jobs = store.list();
			expect(jobs).toHaveLength(1);
			expect(jobs[0].text).toContain("function test() { return 42; }");
			expect(jobs[0].attachments).toHaveLength(1);
			expect(jobs[0].imageLinks).toEqual(["local://image.png"]);
			expect(h.editor.getText()).toBe("");
			expect(h.editor.pendingImages).toHaveLength(0);
		});
	});

	describe("Failed save preservation and in-flight typing", () => {
		it("preserves draft in editor when enqueueOutbox fails", async () => {
			const h = createMockContext({
				initialText: "My draft that will fail",
			});
			vi.spyOn(outboxService, "enqueueOutbox").mockRejectedValueOnce(new Error("Disk quota exhausted"));

			const controller = new InputController(h.ctx);
			await controller.handleQueueForReset();

			expect(h.showError).toHaveBeenCalledWith("Disk quota exhausted");
			expect(h.editor.getText()).toBe("My draft that will fail");
			expect(store.list()).toHaveLength(0);
		});

		it("preserves new typing during async save when save succeeds", async () => {
			const { promise: enqueueStarted, resolve: markStarted } = Promise.withResolvers<void>();
			const { promise: enqueueRelease, resolve: releaseEnqueue } = Promise.withResolvers<void>();

			const h = createMockContext({
				initialText: "Initial draft text",
			});

			const realEnqueue = outboxService.enqueueOutbox;
			vi.spyOn(outboxService, "enqueueOutbox").mockImplementationOnce(async (session, draft) => {
				markStarted();
				await enqueueRelease;
				return realEnqueue(session, draft);
			});

			const controller = new InputController(h.ctx);
			const queuePromise = controller.handleQueueForReset();

			await enqueueStarted;
			h.editor.setText("Initial draft text\n\nNew typing while saving");
			releaseEnqueue();
			await queuePromise;

			const jobs = store.list();
			expect(jobs).toHaveLength(1);
			expect(jobs[0].text).toBe("Initial draft text");
			expect(h.editor.getText()).toBe("New typing while saving");
		});

		it("preserves both original draft and in-flight typing when save fails", async () => {
			const { promise: enqueueStarted, resolve: markStarted } = Promise.withResolvers<void>();
			const { promise: enqueueRelease, resolve: releaseEnqueue } = Promise.withResolvers<void>();

			const h = createMockContext({
				initialText: "Draft text",
			});

			vi.spyOn(outboxService, "enqueueOutbox").mockImplementationOnce(async () => {
				markStarted();
				await enqueueRelease;
				throw new Error("Save error");
			});

			const controller = new InputController(h.ctx);
			const queuePromise = controller.handleQueueForReset();

			await enqueueStarted;
			h.editor.setText("Draft text and more typing");
			releaseEnqueue();
			await queuePromise;

			expect(h.showError).toHaveBeenCalledWith("Save error");
			expect(h.editor.getText()).toBe("Draft text and more typing");
			expect(store.list()).toHaveLength(0);
		});
	});

	describe("/outbox Slash Command", () => {
		const outboxCommand = BUILTIN_OUTBOX_SLASH_COMMANDS[0]!;

		it("refuses empty add without enqueuing literal '/outbox add'", async () => {
			const h = createMockContext({
				initialText: "",
			});
			const runtime = {
				ctx: h.ctx,
				draftDetached: true,
			} as unknown as TuiSlashCommandRuntime;

			await outboxCommand.handleTui!({ name: "outbox", args: "add", text: "/outbox add" }, runtime);

			expect(h.showWarning).toHaveBeenCalledWith("Usage: /outbox add <message>");
			expect(h.editor.getText()).toBe("/outbox add");
			expect(store.list()).toHaveLength(0);
		});

		it("preserves draft on subcommand parse error", async () => {
			const h = createMockContext({
				initialText: "",
			});
			const runtime = {
				ctx: h.ctx,
				draftDetached: true,
			} as unknown as TuiSlashCommandRuntime;

			await outboxCommand.handleTui!(
				{
					name: "outbox",
					args: "move bad-args",
					text: "/outbox move bad-args",
				},
				runtime,
			);

			expect(h.showWarning).toHaveBeenCalled();
			expect(h.editor.getText()).toBe("/outbox move bad-args");
			expect(store.list()).toHaveLength(0);
		});

		it("rejects non-integer position e.g. 2abc in move mutation", async () => {
			const job = await store.add({
				sessionId: "sess-1",
				sessionFile: path.join(tempDir, "1.jsonl"),
				branchId: null,
				cwd: tempDir,
				provider: "openai",
				model: "gpt-4o",
				text: "Job to move",
			});

			const res = await executeOutboxMutation("move", `${job.id} 2abc`, store);
			expect(res.ok).toBe(false);
			expect(store.get(job.id)?.position).toBe(job.position);
		});

		it("resolves exact and unique prefix id, but fails on ambiguous prefix", async () => {
			const j1 = await store.add({
				sessionId: "sess-1",
				sessionFile: path.join(tempDir, "1.jsonl"),
				branchId: null,
				cwd: tempDir,
				provider: "openai",
				model: "gpt-4o",
				text: "Job 1",
			});

			// Exact match
			const exact = resolveJobById(store, j1.id);
			expect(exact.job?.id).toBe(j1.id);

			// Unique prefix
			const prefix = j1.id.slice(0, 8);
			const unique = resolveJobById(store, prefix);
			expect(unique.job?.id).toBe(j1.id);

			// Ambiguous prefix with mock store listing
			const mockStore = {
				get: () => undefined,
				list: () => [{ id: "abc-1" }, { id: "abc-2" }],
			} as unknown as OutboxStore;
			const ambiguous = resolveJobById(mockStore, "abc");
			expect(ambiguous.job).toBeUndefined();
		});

		it("supports pause, cancel, and retry mutations in store", async () => {
			const job = await store.add({
				sessionId: "sess-1",
				sessionFile: path.join(tempDir, "1.jsonl"),
				branchId: null,
				cwd: tempDir,
				provider: "openai",
				model: "gpt-4o",
				text: "Job",
			});

			// Cancel
			const cancelRes = await executeOutboxMutation("cancel", job.id, store);
			expect(cancelRes.ok).toBe(true);
			expect(store.get(job.id)!.state).toBe("cancelled");

			// Retry
			const retryRes = await executeOutboxMutation("retry", job.id, store);
			expect(retryRes.ok).toBe(true);
			expect(store.get(job.id)!.state).toBe("queued");

			// Pause
			const pauseRes = await executeOutboxMutation("pause", "", store);
			expect(pauseRes.ok).toBe(true);
			expect(store.isArmed()).toBe(false);
		});
	});

	describe("OutboxSelectorComponent", () => {
		it("arms resume rather than a blind empty queue for Space, Enter, and native Run", async () => {
			const supervisor = vi
				.spyOn(launchClient, "daemonClientForGlobal")
				.mockRejectedValue(new Error("Unexpected worker"));
			const onResume = vi.fn(async (_sessionId?: string) => {});
			const onEdit = vi.fn();
			const selector = new OutboxSelectorComponent(
				store,
				{
					currentSessionId: "sess-1",
					onClose: () => {},
					onAdd: () => {},
					onResume,
					onEdit,
				},
				{ scope: "current" },
			);
			disposers.push(() => selector.dispose());
			await selector.handleInput(" ");
			expect(onResume).toHaveBeenLastCalledWith("sess-1");
			await selector.handleInput("\r");
			expect(onResume).toHaveBeenCalledTimes(2);
			await selector.handleInput("\t");
			selector.handleNativeEvent({
				type: "action",
				act: "toggle-run",
				key: "toggle-run",
				mods: [],
			});
			await Promise.resolve();
			expect(onResume).toHaveBeenLastCalledWith(undefined);
			expect(onResume).toHaveBeenCalledTimes(3);
			expect(supervisor).not.toHaveBeenCalled();
			expect(onEdit).not.toHaveBeenCalled();
			expect(store.isArmed()).toBe(false);
		});

		it("arms resume with only completed history instead of editing old work", async () => {
			const job = await store.add({
				sessionId: "sess-1",
				sessionFile: path.join(tempDir, "1.jsonl"),
				branchId: null,
				cwd: tempDir,
				provider: "anthropic",
				model: "claude-3-7-sonnet",
				text: "Finished task",
			});
			store.setArmed(true);
			const claimed = store.claim(job.sessionId, process.pid)!;
			store.updateOwned(job.id, claimed.ownerToken!, { state: "completed" });
			const onResume = vi.fn();
			const onEdit = vi.fn();
			const selector = new OutboxSelectorComponent(
				store,
				{
					currentSessionId: "sess-1",
					onClose: () => {},
					onAdd: () => {},
					onResume,
					onEdit,
				},
				{ scope: "current" },
			);
			disposers.push(() => selector.dispose());
			await selector.handleInput("\r");
			expect(onResume).toHaveBeenCalledWith("sess-1");
			expect(onEdit).not.toHaveBeenCalled();
		});

		it("preserves global Run and Pause when the current chat hides the unresolved head", async () => {
			await store.add({
				sessionId: "other-chat",
				sessionFile: path.join(tempDir, "other.jsonl"),
				branchId: null,
				cwd: tempDir,
				provider: "anthropic",
				model: "claude-3-7-sonnet",
				text: "Hidden work",
			});
			store.setArmed(true);
			const supervisor = vi
				.spyOn(launchClient, "daemonClientForGlobal")
				.mockRejectedValue(new Error("Worker unavailable"));
			const onResume = vi.fn();
			const selector = new OutboxSelectorComponent(
				store,
				{
					currentSessionId: "sess-1",
					onClose: () => {},
					onAdd: () => {},
					onResume,
				},
				{ scope: "current" },
			);
			disposers.push(() => selector.dispose());
			expect(selector.jobs).toHaveLength(0);
			await selector.handleInput(" ");
			expect(store.isArmed()).toBe(false);
			await selector.handleInput(" ");
			expect(supervisor).toHaveBeenCalledTimes(1);
			expect(onResume).not.toHaveBeenCalled();
			expect(selector.lastError).toBe("Worker unavailable");
			expect(store.isArmed()).toBe(false);
		});

		it("mutates store on native actions and dispatches selection", async () => {
			const job = await store.add({
				sessionId: "sess-1",
				sessionFile: path.join(tempDir, "1.jsonl"),
				branchId: null,
				cwd: tempDir,
				provider: "anthropic",
				model: "claude-3-7-sonnet",
				sessionName: "Test Chat",
				text: "Test content",
			});

			const onClose = vi.fn();
			const onEdit = vi.fn(async () => {});
			const selector = new OutboxSelectorComponent(
				store,
				{
					currentSessionId: "sess-1",
					onClose,
					onEdit,
					onAdd: () => {},
					onResume: () => {},
				},
				{ scope: "all" },
			);

			// Initial state
			expect(selector.jobs).toHaveLength(1);
			expect(selector.selectedIndex).toBe(0);

			// Native select event
			selector.handleNativeEvent({
				type: "select",
				key: "jobs",
				item: job.id,
			});
			expect(selector.selectedIndex).toBe(0);

			// Native cancel-job action
			selector.handleNativeEvent({
				type: "action",
				act: "cancel-job",
				key: "cancel-job",
				mods: [],
			});
			await Promise.resolve();
			expect(store.get(job.id)!.state).toBe("cancelled");

			// Native retry action
			selector.handleNativeEvent({
				type: "action",
				act: "retry",
				key: "retry",
				mods: [],
			});
			await Promise.resolve();
			expect(store.get(job.id)!.state).toBe("queued");

			// Native edit action
			selector.handleNativeEvent({
				type: "action",
				act: "edit",
				key: "edit",
				mods: [],
			});
			await Promise.resolve();
			expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));

			// Native close action
			selector.handleNativeEvent({
				type: "action",
				act: "close",
				key: "close",
				mods: [],
			});
			expect(onClose).toHaveBeenCalled();

			selector.dispose();
		});

		it("catches and renders error in view without unhandled rejection", async () => {
			await store.add({
				sessionId: "sess-1",
				sessionFile: path.join(tempDir, "1.jsonl"),
				branchId: null,
				cwd: tempDir,
				provider: "anthropic",
				model: "claude-3-7-sonnet",
				text: "Test",
			});

			const selector = new OutboxSelectorComponent(
				store,
				{
					currentSessionId: "sess-1",
					onClose: () => {},
					onAdd: () => {},
					onResume: () => {},
				},
				{ scope: "all" },
			);
			vi.spyOn(store, "move").mockImplementationOnce(() => {
				throw new Error("Invalid move position");
			});

			await selector.handleInput("u");
			expect(selector.lastError).toBe("Invalid move position");

			selector.dispose();
		});
	});
});
