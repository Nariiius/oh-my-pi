import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { snapshotOutboxSession } from "../src/outbox/activity";
import { deliverOutboxJob, reconcileOutboxJob } from "../src/outbox/delivery";
import { observeOutboxResume, outboxResumeCondition } from "../src/outbox/resume";
import { OutboxStore } from "../src/outbox/store";
import type { OutboxJob } from "../src/outbox/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { cfgRetryEnabled, cfgRetryMaxDelayMs, cfgRetryWaitForUsageReset } from "../src/session/settings";

const quotaError = "429 usage limit reached. Your limit will reset in 13 minutes. retry-after-ms=780000";

describe("durable quota resume", () => {
	let root: TempDir;
	let manager: SessionManager;
	let auth: AuthStorage;
	let store: OutboxStore;
	let session: AgentSession;
	let available: boolean;
	beforeEach(async () => {
		root = TempDir.createSync("@omp-outbox-resume-");
		manager = SessionManager.create(root.path(), path.join(root.path(), "sessions"));
		auth = await AuthStorage.create(path.join(root.path(), "auth.db"));
		auth.keys.setRuntime("anthropic", "local-test-key");
		available = false;
		auth.health.model = async () => ({
			state: available ? "healthy" : "depleted",
			accounts: [
				{
					credentialId: 1,
					credentialType: "api_key",
					state: available ? "healthy" : "depleted",
					clearedAt: Date.now() + 1000,
					resetsAt: Date.now() + 1000,
				},
			],
		});
		store = new OutboxStore(path.join(root.path(), "outbox.db"));
		store.setArmed(true);
	});
	afterEach(async () => {
		vi.restoreAllMocks();
		await session?.dispose();
		await manager.close();
		auth.close();
		store.close();
		await root.remove();
	});
	function createSession(responses: MockResponseSource, tools: AgentTool[] = []): void {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing model fixture");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, systemPrompt: [], tools, messages: [] },
				getApiKey: () => "local-test-key",
				streamFn: createMockModel({ responses }).stream,
			}),
			sessionManager: manager,
			modelRegistry: new ModelRegistry(auth, path.join(root.path(), "models.yml")),
			settings: Settings.isolated({
				"retry.enabled": false,
				"retry.modelFallback": false,
				"retry.usageAwareFallback": false,
				"compaction.enabled": false,
				"todo.enabled": false,
			}),
		});
	}
	async function watch(): Promise<OutboxJob> {
		const snapshot = snapshotOutboxSession(session);
		if (!snapshot.lastUserEntryId) throw new Error("No original user turn");
		await manager.ensureOnDisk();
		return store.add({
			...snapshot,
			kind: "resume",
			branchId: snapshot.lastUserEntryId,
			resumeUserEntryId: snapshot.lastUserEntryId,
			text: "",
		});
	}
	async function dispatch(job: OutboxJob): Promise<void> {
		const claimed = store.claim(job.sessionId, process.pid);
		if (!claimed) throw new Error(`Could not claim: ${JSON.stringify(store.get(job.id))}`);
		await deliverOutboxJob(session, store, claimed);
	}

	it("resumes the original failed turn with native retry disabled and adds no user message", async () => {
		createSession([{ throw: quotaError }, { content: ["Original work finished"] }]);
		await session.prompt("Complete the existing work");
		expect(snapshotOutboxSession(session).activity).toBe("Quota limited");
		const job = await watch();
		expect(session.autoRetryEnabled).toBe(false);
		await dispatch(job);
		expect(store.get(job.id)?.state).toBe("watching");
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);
		available = true;
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 2000);
		try {
			await dispatch(job);
		} finally {
			clock.mockRestore();
		}
		expect(store.get(job.id)?.state).toBe("completed");
		expect(session.getLastAssistantText()).toBe("Original work finished");
		expect(snapshotOutboxSession(session).activity).toBe("Idle");
		expect(session.autoRetryEnabled).toBe(false);
		expect(reconcileOutboxJob(manager, job)).toBe("completed");
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);
	});

	it("does not deadlock resume behind an already-held follow-up queue", async () => {
		createSession([{ throw: quotaError }, { content: ["Recovered and drained pending work"] }]);
		await session.prompt("Original request before the limit");
		const job = await watch();
		session.agent.followUp({
			role: "user",
			content: [{ type: "text", text: "Previously queued follow-up" }],
			timestamp: Date.now(),
		});
		available = true;
		expect(observeOutboxResume(session, store, job)).toBe(true);
		await dispatch(job);
		expect(store.get(job.id)?.state).toBe("completed");
		expect(session.agent.hasQueuedMessages()).toBe(false);
		const users = manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user");
		expect(users).toHaveLength(2);
	});

	it("keeps the watch after another quota rejection, then retries the same turn without duplicating input", async () => {
		createSession([{ throw: quotaError }, { throw: quotaError }, { content: ["Completed on next quota window"] }]);
		await session.prompt("Continue my task after reset");
		const job = await watch();
		available = true;
		await dispatch(job);
		expect(store.get(job.id)?.state).toBe("watching");
		expect(reconcileOutboxJob(manager, job)).toBe("absent");
		const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 61000);
		try {
			await dispatch(job);
		} finally {
			clock.mockRestore();
		}
		expect(store.get(job.id)?.state).toBe("completed");
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);
	});

	it("watches already-running work and completes without an extra continuation when it finishes normally", async () => {
		const entered = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		const tool: AgentTool = {
			name: "controlled_work",
			label: "Controlled work",
			description: "Fixture work",
			parameters: { type: "object", properties: {} },
			execute: async () => {
				entered.resolve();
				await finish.promise;
				return { content: [{ type: "text", text: "done" }] };
			},
		};
		createSession(
			[
				{
					content: [{ type: "toolCall", id: "work", name: tool.name, arguments: {} }],
					stopReason: "toolUse",
				},
				{ content: ["Completed without hitting quota"] },
			],
			[tool],
		);
		const running = session.prompt("Work that is currently running");
		try {
			await entered.promise;
			const job = await watch();
			expect(observeOutboxResume(session, store, job)).toBe(false);
			expect(session.agent.state.isStreaming).toBe(true);
			finish.resolve();
			await running;
			await dispatch(job);
			expect(store.get(job.id)?.state).toBe("completed");
			expect(session.getLastAssistantText()).toBe("Completed without hitting quota");
			expect(
				manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(1);
		} finally {
			finish.resolve();
			await running;
		}
	});

	it("does not retry unrelated errors or supersede a newer manual request", async () => {
		createSession([{ throw: "Invalid request schema" }, { content: ["New task completed"] }]);
		await session.prompt("Old task failed for another reason");
		const job = await watch();
		available = true;
		await dispatch(job);
		expect(store.get(job.id)?.state).toBe("attention");
		store.retry(job.id);
		await session.prompt("New manual task");
		await dispatch(job);
		expect(store.get(job.id)?.state).toBe("completed");
		expect(session.getLastAssistantText()).toBe("New task completed");
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(2);
	});

	it("takes ownership of only the native quota backoff and then uses the outbox deadline", async () => {
		createSession([{ throw: quotaError }, { content: ["Outbox resumed native wait"] }]);
		cfgRetryEnabled.override(session.settings, true);
		cfgRetryWaitForUsageReset.override(session.settings, true);
		cfgRetryMaxDelayMs.override(session.settings, 100);
		const waiting = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_retry_start") waiting.resolve();
		});
		const running = session.prompt("Existing request sleeping in native retry");
		try {
			await waiting.promise;
			const job = await watch();
			expect(outboxResumeCondition(session, job).state).toBe("quota");
			observeOutboxResume(session, store, job);
			await running;
			expect(store.get(job.id)?.state).toBe("watching");
			available = true;
			await dispatch(job);
			expect(store.get(job.id)?.state).toBe("completed");
			expect(session.getLastAssistantText()).toBe("Outbox resumed native wait");
			expect(
				manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
			).toHaveLength(1);
		} finally {
			session.abortRetry();
			await running;
		}
	});

	it("requires attention for an accepted attempt with no durable result", async () => {
		createSession([{ throw: quotaError }, { content: ["Must not be called"] }]);
		await session.prompt("Interrupted attempt");
		const job = await watch();
		await manager.appendEntriesAtomically(() =>
			manager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "accepted",
				kind: "resume",
			}),
		);
		available = true;
		await dispatch(job);
		expect(store.get(job.id)?.state).toBe("attention");
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(1);
	});

	it("resumes a newer quota-failed turn on the same branch when an earlier watch never fired", async () => {
		createSession([{ throw: quotaError }, { throw: quotaError }, { content: ["Resumed newer quota-blocked turn"] }]);
		await session.prompt("Earlier turn that hit quota");
		const job = await watch();
		await session.prompt("Newer turn in same chat that also hit quota");
		vi.spyOn(session, "activeToolExecutionUpdates").mockReturnValue([
			{
				type: "tool_execution_update",
				toolCallId: "bg_19",
				toolName: "bash",
				args: {},
				partialResult: { content: [{ type: "text", text: "cached background frame" }] },
			},
		]);
		expect(outboxResumeCondition(session, job).state).toBe("quota");
		available = true;
		await dispatch(job);
		expect(store.get(job.id)?.state).toBe("completed");
		expect(session.getLastAssistantText()).toBe("Resumed newer quota-blocked turn");
		expect(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
		).toHaveLength(2);
	});
});
