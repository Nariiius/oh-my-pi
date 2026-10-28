import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, AgentBusyError, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockResponseSource } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { ExtensionRuntime } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { deliverOutboxJob, reconcileOutboxJob } from "../src/outbox/delivery";
import { OutboxStore } from "../src/outbox/store";
import type { OutboxNewJob } from "../src/outbox/types";
import { AgentSession, SessionBusyError } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { convertToLlm } from "../src/session/messages";
import { SessionManager, SessionOutboxClaimError } from "../src/session/session-manager";
import { FileSessionStorage } from "../src/session/session-storage";
import { cfgRetryBaseDelayMs, cfgRetryMaxDelayMs, cfgRetryMaxRetries } from "../src/session/settings";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

class ControlledSessionStorage extends FileSessionStorage {
	simulateHeldByOther = false;

	override claimSession(sessionId: string, sessionPath: string): (() => void) | null {
		if (this.simulateHeldByOther) {
			return null;
		}
		return super.claimSession(sessionId, sessionPath);
	}
}

describe("outbox delivery and session admission", () => {
	let tempDir: TempDir;
	let store: OutboxStore;
	let storage: ControlledSessionStorage;
	let sessionManager: SessionManager;
	let activeSession: AgentSession | undefined;
	const managersToClose: SessionManager[] = [];
	const authToClose: AuthStorage[] = [];

	const defaultModel: Model = getBundledModel("anthropic", "claude-sonnet-4-5")!;

	beforeEach(async () => {
		tempDir = TempDir.createSync("omp-outbox-delivery-test-");
		const dbPath = path.join(tempDir.path(), "outbox.db");
		store = new OutboxStore(dbPath);
		store.setArmed(true);

		storage = new ControlledSessionStorage();
		const sessionsDir = path.join(tempDir.path(), "sessions");
		sessionManager = SessionManager.create(tempDir.path(), sessionsDir, storage);
		managersToClose.push(sessionManager);
		await sessionManager.ensureOnDisk();
	});

	afterEach(async () => {
		if (activeSession) {
			await activeSession.dispose();
			activeSession = undefined;
		}
		store.close();
		for (const m of managersToClose.splice(0)) {
			await m.close();
		}
		for (const a of authToClose.splice(0)) {
			a.close();
		}
		tempDir.removeSync();
	});

	function createJobInput(overrides: Partial<OutboxNewJob> = {}): OutboxNewJob {
		return {
			sessionId: sessionManager.getSessionId(),
			sessionFile: sessionManager.getSessionFile()!,
			branchId: sessionManager.getLeafId(),
			cwd: tempDir.path(),
			provider: defaultModel.provider,
			model: defaultModel.id,
			text: "Real prompt delivering through outbox",
			...overrides,
		};
	}

	async function buildRealSession(
		manager: SessionManager,
		responses: MockResponseSource = [{ content: ["Real assistant completed response"] }],
		tools: AgentTool[] = [],
	): Promise<AgentSession> {
		const auth = await AuthStorage.create(
			path.join(tempDir.path(), `auth-${Date.now()}-${Math.random().toString(36).slice(2)}.db`),
		);
		authToClose.push(auth);
		auth.keys.setRuntime("anthropic", "isolated-test-key");
		auth.health.model = async () => ({
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "api_key",
					state: "healthy",
					resetsAt: Date.now() + 300,
					clearedAt: Date.now() + 300,
				},
			],
		});

		const registry = new ModelRegistry(auth, path.join(tempDir.path(), "models.yml"));
		const mock = createMockModel({ responses });
		const agent = new Agent({
			initialState: {
				model: defaultModel,
				systemPrompt: ["Test system prompt"],
				tools,
				messages: [],
			},
			getApiKey: () => "isolated-test-key",
			convertToLlm,
			streamFn: mock.stream,
		});

		const session = new AgentSession({
			agent,
			sessionManager: manager,
			modelRegistry: registry,
			extensionRunner: new ExtensionRunner([], new ExtensionRuntime(), manager.getCwd(), manager, registry),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
			}),
		});

		activeSession = session;
		return session;
	}

	describe("SessionManager strict outbox claim and no silent fork", () => {
		it("claimForOutbox throws SessionOutboxClaimError when storage reports lease held elsewhere", () => {
			const foreignStorage = new ControlledSessionStorage();
			foreignStorage.simulateHeldByOther = true;
			const contestedManager = SessionManager.create(
				tempDir.path(),
				path.join(tempDir.path(), "sessions"),
				foreignStorage,
			);
			managersToClose.push(contestedManager);

			expect(() => contestedManager.claimForOutbox()).toThrow(SessionOutboxClaimError);
		});

		it("refuses outbox delivery and chat switching while another process owns the destination", async () => {
			const destination = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "foreign"));
			destination.appendMessage({
				role: "user",
				content: "Existing chat",
				timestamp: Date.now(),
			});
			await destination.ensureOnDisk();
			const file = destination.getSessionFile()!;
			await destination.close();
			const source = path.resolve(import.meta.dir, "../src/session/session-manager.ts");
			const child = Bun.spawn(
				[
					process.execPath,
					"-e",
					`
				import {SessionManager} from ${JSON.stringify(source)};
				const manager = await SessionManager.open(${JSON.stringify(file)});
				manager.claimForOutbox();
				console.log(JSON.stringify({ id: manager.getSessionId(), owners: process.env.PI_TEST_SESSION_OWNERS_DIR }));
				await Bun.stdin.text();
				await manager.close();
			`,
				],
				{
					stdin: "pipe",
					stdout: "pipe",
					stderr: "inherit",
					env: { ...process.env },
				},
			);
			try {
				const reader = child.stdout.getReader();
				const signal = await reader.read();
				reader.releaseLock();
				const owner = JSON.parse(new TextDecoder().decode(signal.value).trim());
				expect(owner.id).toBe(destination.getSessionId());
				expect(owner.owners).toBe(process.env.PI_TEST_SESSION_OWNERS_DIR);
				const peer = await SessionManager.open(file);
				managersToClose.push(peer);
				expect(() => peer.claimForOutbox()).toThrow(SessionOutboxClaimError);
				expect(peer.getSessionFile()).toBe(file);
				const session = await buildRealSession(sessionManager);
				await expect(session.switchSession(file)).rejects.toThrow();
				expect(session.sessionId).toBe(sessionManager.getSessionId());
			} finally {
				child.stdin.end();
				await child.exited;
			}
		});

		it("uses the queued model even after the live chat switches models, then restores the live selection", async () => {
			const session = await buildRealSession(sessionManager);
			const savedModel = session.model!;
			const alternate = session.modelRegistry
				.getAll()
				.find(model => model.provider === savedModel.provider && model.id !== savedModel.id);
			expect(alternate).toBeDefined();
			await session.setModelTemporary(alternate!);
			const streamedModels: string[] = [];
			const stream = createMockModel({ handler: () => ({ content: ["Requested model answered"] }) }).stream;
			session.agent.streamFn = (model, context, options) => {
				streamedModels.push(`${model.provider}/${model.id}`);
				return stream(model, context, options);
			};
			const job = await store.add(createJobInput());
			await deliverOutboxJob(session, store, store.claim(session.sessionId, process.pid)!);
			expect(store.get(job.id)?.state).toBe("completed");
			expect(streamedModels).toEqual([`${savedModel.provider}/${savedModel.id}`]);
			expect(session.model?.id).toBe(alternate!.id);
		});
	});

	describe("reconcileOutboxJob", () => {
		it("returns 'absent' when no receipts exist for the job", async () => {
			const job = await store.add(createJobInput());
			const stage = reconcileOutboxJob(sessionManager, job);
			expect(stage).toBe("absent");
		});

		it("returns 'accepted' when outbox.delivery custom entry has stage 'accepted'", async () => {
			const job = await store.add(createJobInput());
			sessionManager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "accepted",
			});
			const stage = reconcileOutboxJob(sessionManager, job);
			expect(stage).toBe("accepted");
		});

		it("returns 'completed' when outbox.delivery custom entry has stage 'completed'", async () => {
			const job = await store.add(createJobInput());
			sessionManager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "accepted",
			});
			sessionManager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "completed",
			});
			const stage = reconcileOutboxJob(sessionManager, job);
			expect(stage).toBe("completed");
		});
	});

	describe("duplicate acceptance and crash boundaries", () => {
		it("completed receipt marks job completed in store without re-running agent", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;
			expect(claimed).toBeDefined();

			sessionManager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "completed",
			});

			const realSession = await buildRealSession(sessionManager, []);
			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("completed");
			expect(realSession.messages.length).toBe(0);
		});

		it("accepted receipt without completed stage moves job to attention to prevent duplicate prompt insertion", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			sessionManager.appendCustomEntry("outbox.delivery", {
				jobId: job.id,
				stage: "accepted",
			});

			const realSession = await buildRealSession(sessionManager, []);
			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("attention");
			expect(realSession.messages.length).toBe(0);
		});

		it("crash before acceptance allows safe retry, delivering with atomic accepted receipt and no duplicate user message", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			expect(reconcileOutboxJob(sessionManager, claimed)).toBe("absent");

			const realSession = await buildRealSession(sessionManager, [{ content: ["Answer from real model"] }]);
			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("completed");
			expect(reconcileOutboxJob(sessionManager, job)).toBe("completed");

			const branch = sessionManager.getBranch();
			const userMessages = branch.filter(e => e.type === "message" && e.message.role === "user");
			const assistantMessages = branch.filter(e => e.type === "message" && e.message.role === "assistant");
			const acceptedReceipts = branch.filter(
				e =>
					e.type === "custom" &&
					e.customType === "outbox.delivery" &&
					e.data &&
					typeof e.data === "object" &&
					"stage" in e.data &&
					e.data.stage === "accepted",
			);
			const completedReceipts = branch.filter(
				e =>
					e.type === "custom" &&
					e.customType === "outbox.delivery" &&
					e.data &&
					typeof e.data === "object" &&
					"stage" in e.data &&
					e.data.stage === "completed",
			);

			expect(userMessages.length).toBe(1);
			expect(assistantMessages.length).toBe(1);
			expect(acceptedReceipts.length).toBe(1);
			expect(completedReceipts.length).toBe(1);
		});

		it("real pipeline acceptance persistence: commits accepted receipt before model response, completed after", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			expect(reconcileOutboxJob(sessionManager, claimed)).toBe("absent");

			let sawAcceptedDuringExecution = false;
			const realSession = await buildRealSession(sessionManager, [
				() => {
					const currentReconcile = reconcileOutboxJob(sessionManager, claimed);
					if (currentReconcile === "accepted") {
						sawAcceptedDuringExecution = true;
					}
					return { content: ["Finished response"] };
				},
			]);

			await deliverOutboxJob(realSession, store, claimed);

			expect(sawAcceptedDuringExecution).toBe(true);
			const updated = store.get(job.id)!;
			expect(updated.state).toBe("completed");
			expect(reconcileOutboxJob(sessionManager, job)).toBe("completed");

			const entries = sessionManager.getEntries();
			const acceptedEntryIdx = entries.findIndex(
				e =>
					e.type === "custom" &&
					e.customType === "outbox.delivery" &&
					e.data &&
					typeof e.data === "object" &&
					"stage" in e.data &&
					e.data.stage === "accepted",
			);
			const userMsgIdx = entries.findIndex(e => e.type === "message" && e.message.role === "user");
			const assistantMsgIdx = entries.findIndex(e => e.type === "message" && e.message.role === "assistant");
			const completedEntryIdx = entries.findIndex(
				e =>
					e.type === "custom" &&
					e.customType === "outbox.delivery" &&
					e.data &&
					typeof e.data === "object" &&
					"stage" in e.data &&
					e.data.stage === "completed",
			);

			expect(acceptedEntryIdx).toBeGreaterThanOrEqual(0);
			expect(userMsgIdx).toBeGreaterThan(acceptedEntryIdx);
			expect(assistantMsgIdx).toBeGreaterThan(userMsgIdx);
			expect(completedEntryIdx).toBeGreaterThan(assistantMsgIdx);
		});
	});

	describe("branch mismatch", () => {
		it("refuses delivery and sets attention when job branchId is not in active ancestry", async () => {
			const job = await store.add(createJobInput({ branchId: "foreign-or-abandoned-branch-leaf" }));
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			const realSession = await buildRealSession(sessionManager, []);
			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("attention");
			expect(realSession.messages.length).toBe(0);
		});
	});

	describe("busy session and manual race protection", () => {
		it("releases job as waiting when session cannot admit outbox prompt", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			const realSession = await buildRealSession(sessionManager);
			const releaseManual = realSession.beginOutboxDelivery("another-running-job");

			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("waiting");
			expect(updated.ownerToken).toBeUndefined();

			releaseManual();
		});

		it("exclusive outbox admission blocks manual prompt, fork, and switch while executing", async () => {
			const realSession = await buildRealSession(sessionManager);

			const releaseAdmission = realSession.beginOutboxDelivery("outbox-active-job");
			expect(realSession.isOutboxDelivering).toBe(true);

			await expect(realSession.prompt("manual typed prompt")).rejects.toThrow(AgentBusyError);
			await expect(realSession.prompt("prompt", { outboxJobId: "wrong-id" })).rejects.toThrow(AgentBusyError);
			await expect(realSession.fork()).rejects.toThrow(SessionBusyError);
			await expect(realSession.switchSession("/some/path.jsonl")).rejects.toThrow(SessionBusyError);

			releaseAdmission();
			expect(realSession.isOutboxDelivering).toBe(false);
		});
	});

	describe("terminal outcomes", () => {
		it("successful delivery commits completed receipt and marks store job completed", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			const realSession = await buildRealSession(sessionManager, [{ content: ["Real response finished"] }]);
			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("completed");
			expect(reconcileOutboxJob(sessionManager, job)).toBe("completed");
		});

		it("multi-tool sequence selects the terminal assistant response and marks completed", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			let toolExecuted = false;
			const testTool: AgentTool = {
				name: "sample_tool",
				label: "Sample tool",
				description: "A test tool",
				parameters: { type: "object", properties: {} },
				execute: async () => {
					toolExecuted = true;
					return {
						content: [{ type: "text", text: "Tool output executed successfully" }],
					};
				},
			};

			const realSession = await buildRealSession(
				sessionManager,
				[
					{
						content: [
							{ type: "text", text: "Invoking tool first" },
							{
								type: "toolCall",
								id: "call_1",
								name: "sample_tool",
								arguments: {},
							},
						],
						stopReason: "toolUse",
					},
					{
						content: [{ type: "text", text: "Final answer after tool execution." }],
						stopReason: "stop",
					},
				],
				[testTool],
			);

			await deliverOutboxJob(realSession, store, claimed);

			expect(toolExecuted).toBe(true);
			const updated = store.get(job.id)!;
			expect(updated.state).toBe("completed");
			expect(reconcileOutboxJob(sessionManager, job)).toBe("completed");
		});

		it("model execution failure sets job to attention with error reason", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			const realSession = await buildRealSession(sessionManager, [
				() => {
					throw new Error("Provider request network reset");
				},
			]);

			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("attention");
		});

		it("manual operator interrupt (aborted) pauses outbox job to attention", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			const realSession = await buildRealSession(sessionManager, [
				async () => {
					await realSession.abort();
					return { content: [] };
				},
			]);

			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("attention");
		});

		it("retains the job across a quota reset without reinserting its prompt or advancing the queue", async () => {
			const job = await store.add(createJobInput({ text: "Complete across reset" }));
			const next = await store.add(
				createJobInput({
					text: "After reset job finishes",
					sessionId: "next-chat",
				}),
			);
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;
			const session = await buildRealSession(sessionManager, [
				{
					throw: "429 quota exceeded. Your limit will reset in 13 minutes. retry-after-ms=5000",
				},
				{ content: ["Recovered after quota reset"], stopReason: "stop" },
			]);
			cfgRetryBaseDelayMs.override(session.settings, 5);
			cfgRetryMaxDelayMs.override(session.settings, 100);
			cfgRetryMaxRetries.override(session.settings, 2);
			const delays: number[] = [];
			session.subscribe(event => {
				if (event.type === "auto_retry_start") {
					delays.push(event.delayMs);
					expect(store.head()?.id).toBe(job.id);
					expect(store.claim(next.sessionId, process.pid)).toBeUndefined();
				}
			});
			mockSchedulerWaitWithClock();
			try {
				await deliverOutboxJob(session, store, claimed);
				expect(delays).toEqual([13 * 60_000]);
				expect(store.get(job.id)?.state).toBe("completed");
				expect(store.get(next.id)?.state).toBe("queued");
				const users = sessionManager
					.getEntries()
					.filter(entry => entry.type === "message" && entry.message.role === "user");
				expect(users).toHaveLength(1);
				expect(reconcileOutboxJob(sessionManager, job)).toBe("completed");
			} finally {
				vi.restoreAllMocks();
			}
		});

		it("delivers multiple same-chat messages as separate ordered turns", async () => {
			const first = await store.add(createJobInput({ text: "First queued request" }));
			const second = await store.add(createJobInput({ text: "Second queued request" }));
			const session = await buildRealSession(sessionManager, [
				{ content: ["First answer"] },
				{ content: ["Second answer"] },
			]);
			await deliverOutboxJob(session, store, store.claim(session.sessionId, process.pid)!);
			expect(store.get(first.id)?.state).toBe("completed");
			expect(store.get(second.id)?.state).toBe("queued");
			await deliverOutboxJob(session, store, store.claim(session.sessionId, process.pid)!);
			expect(store.get(second.id)?.state).toBe("completed");
			const users = session.messages.filter(message => message.role === "user");
			expect(users.map(message => message.content)).toEqual([
				[{ type: "text", text: first.text }],
				[{ type: "text", text: second.text }],
			]);
		});

		it("cancellation before execution marks job cancelled without starting prompt", async () => {
			const job = await store.add(createJobInput());
			const claimed = store.claim(sessionManager.getSessionId(), process.pid)!;

			store.cancel(job.id);

			const realSession = await buildRealSession(sessionManager, []);
			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("cancelled");
			expect(realSession.messages.length).toBe(0);
		});

		it("identity mismatch transitions job to attention without mutating session", async () => {
			const job = await store.add(createJobInput({ sessionId: "foreign-session-uuid" }));
			const claimed = store.claim("foreign-session-uuid", process.pid)!;

			const realSession = await buildRealSession(sessionManager, []);
			await deliverOutboxJob(realSession, store, claimed);

			const updated = store.get(job.id)!;
			expect(updated.state).toBe("attention");
			expect(realSession.messages.length).toBe(0);
		});
	});
});
