import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { enqueueOutboxDestination, outboxDestinationLabel, outboxDestinations } from "../src/outbox/destinations";
import { getOutboxStore, snapshotOutboxSession } from "../src/outbox/service";
import type { OutboxStore } from "../src/outbox/store";
import type { OutboxSessionSnapshot } from "../src/outbox/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("outbox destination routing", () => {
	let root: TempDir;
	let auth: AuthStorage;
	let session: AgentSession;
	let manager: SessionManager;
	let store: OutboxStore;
	let previousDir: string | undefined;
	let providerRequests: number;
	beforeEach(async () => {
		root = TempDir.createSync("@omp-outbox-destinations-");
		previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = root.path();
		refreshDirsFromEnv();
		auth = await AuthStorage.create(path.join(root.path(), "auth.db"));
		auth.keys.setRuntime("anthropic", "local-test-key");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing test model");
		providerRequests = 0;
		const stream = createMockModel({
			handler: () => {
				providerRequests++;
				return { content: ["not expected"] };
			},
		});
		manager = SessionManager.create(root.path(), path.join(root.path(), "sessions"));
		manager.appendMessage({
			role: "user",
			content: "Current project discussion",
			timestamp: Date.now(),
		});
		await manager.ensureOnDisk();
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, messages: [], systemPrompt: [], tools: [] },
				streamFn: stream.stream,
			}),
			sessionManager: manager,
			modelRegistry: new ModelRegistry(auth, path.join(root.path(), "models.yml")),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
			}),
		});
		store = getOutboxStore();
	});
	afterEach(async () => {
		await session?.dispose();
		await manager?.close();
		store?.close();
		auth?.close();
		if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousDir;
		refreshDirsFromEnv();
		await root?.remove();
	});

	function otherSnapshot(): OutboxSessionSnapshot {
		return {
			...snapshotOutboxSession(session),
			sessionId: "remote-chat-id",
			sessionFile: path.join(root.path(), "other-chat.jsonl"),
			branchId: "remote-branch",
			sessionName: "Other project",
			activity: "Reading configuration",
			lastUserEntryId: "remote-original-user",
			provider: "openai-codex",
			model: "selected-model",
			updatedAt: Date.now(),
			pid: process.pid,
		};
	}

	it("lists live chats without queue entries and deduplicates recorded destinations", async () => {
		const other = otherSnapshot();
		await store.add({
			...other,
			text: "Earlier task",
			sessionName: "Old title",
		});
		store.publishSession(other);
		const destinations = outboxDestinations(session, store);
		expect(destinations.map(item => item.sessionId)).toEqual([session.sessionId, other.sessionId]);
		expect(destinations[1]?.sessionName).toBe(other.sessionName);
		expect(destinations[1]?.activity).toBe(other.activity);
		expect(destinations[1]?.live).toBe(true);
		store.unregisterSession(other.sessionId, process.pid);
		const closed = outboxDestinations(session, store).find(item => item.sessionId === other.sessionId);
		expect(closed?.live).toBe(false);
		expect(closed?.model).toBe(other.model);
	});

	it("captures the original request for resume without inferring it from queued messages", async () => {
		const other = otherSnapshot();
		await store.add({ ...other, text: "Future queued request" });
		store.publishSession(other);
		const destination = outboxDestinations(session, store).find(item => item.sessionId === other.sessionId);
		expect(destination?.lastUserEntryId).toBe("remote-original-user");
		store.publishSession({ ...other, lastUserEntryId: "newer-request" });
		expect(destination?.lastUserEntryId).toBe("remote-original-user");
		store.unregisterSession(other.sessionId, process.pid);
		const queuedOnly = outboxDestinations(session, store).find(item => item.sessionId === other.sessionId);
		expect(queuedOnly?.lastUserEntryId).toBeUndefined();
		expect(providerRequests).toBe(0);
	});

	it("adds to the selected other chat without switching, executing, or changing existing order", async () => {
		const existing = await store.add({
			...snapshotOutboxSession(session),
			text: "First in line",
		});
		const other = otherSnapshot();
		store.publishSession(other);
		const destination = outboxDestinations(session, store).find(item => item.sessionId === other.sessionId);
		if (!destination) throw new Error("Expected remote destination");
		store.publishSession({
			...other,
			model: "later-model",
			branchId: "later-branch",
		});
		const job = await enqueueOutboxDestination(session, store, destination, {
			text: "Next message for other project",
		});
		expect(job).toMatchObject({
			sessionId: other.sessionId,
			sessionFile: other.sessionFile,
			model: other.model,
			branchId: other.branchId,
		});
		expect(session.sessionId).toBe(manager.getSessionId());
		expect(store.list().map(item => item.id)).toEqual([existing.id, job.id]);
		expect(store.isArmed()).toBe(false);
		expect(providerRequests).toBe(0);
	});

	it("saves a current-chat message without changing the outer composer or starting execution", async () => {
		const destination = outboxDestinations(session, store).find(item => item.current);
		if (!destination) throw new Error("Expected current chat");
		const job = await enqueueOutboxDestination(session, store, destination, {
			text: "A future task",
		});
		expect(job.sessionId).toBe(session.sessionId);
		expect(job.text).toBe("A future task");
		expect(manager.getEntries().filter(entry => entry.type === "message").length).toBe(1);
		expect(providerRequests).toBe(0);
	});

	it("refuses to silently retarget a current-chat draft after its model changes", async () => {
		const destination = outboxDestinations(session, store).find(item => item.current);
		if (!destination) throw new Error("Expected current chat");
		const alternate = session.modelRegistry
			.getAll()
			.find(model => model.provider === "anthropic" && model.id !== destination.model);
		if (!alternate) throw new Error("Expected another test model");
		await session.setModelTemporary(alternate);
		await expect(
			enqueueOutboxDestination(session, store, destination, {
				text: "Keep my intended destination",
			}),
		).rejects.toThrow();
		expect(store.list()).toHaveLength(0);
		expect(providerRequests).toBe(0);
	});

	it("does not advertise stale activity as live or route to a disappeared destination", async () => {
		const other = otherSnapshot();
		store.publishSession({ ...other, updatedAt: Date.now() - 60_000 });
		const destination = outboxDestinations(session, store).find(item => item.sessionId === other.sessionId);
		if (!destination) throw new Error("Expected stale destination");
		expect(destination.live).toBe(false);
		expect(destination.activity).not.toBe(other.activity);
		store.unregisterSession(other.sessionId, process.pid);
		await expect(
			enqueueOutboxDestination(session, store, destination, {
				text: "Do not reroute",
			}),
		).rejects.toThrow();
		expect(store.list()).toHaveLength(0);
	});

	it("keeps identical titles selectable without terminal control injection", () => {
		const [current] = outboxDestinations(session, store);
		if (!current) throw new Error("Expected destination");
		const hostile = { ...current, sessionName: "same\u001b[2J\nname" };
		const one = outboxDestinationLabel(hostile, 0);
		const two = outboxDestinationLabel(hostile, 1);
		expect(one).not.toBe(two);
		expect(one.includes("\u001b") || one.includes("\n")).toBe(false);
	});
});
