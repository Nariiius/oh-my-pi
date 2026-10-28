import * as path from "node:path";
import { getAgentDir, logger, postmortem } from "@oh-my-pi/pi-utils";
import { OUTBOX_WORKER_ARG, OUTBOX_WORKER_READY } from "../cli/worker-selectors";
import { type DaemonBrokerClient, daemonClientForGlobal } from "../launch/client";
import { describeQuietly, waitReady } from "../launch/ensure";
import type { DaemonSnapshot } from "../launch/protocol";
import type { AgentSession } from "../session/agent-session";
import type { SessionManager } from "../session/session-manager";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { snapshotOutboxSession, startOutboxPresence } from "./activity";
import { deliverOutboxJob } from "./delivery";
import { observeOutboxResume } from "./resume";
import { OutboxStore, outboxDbPath } from "./store";
import type { OutboxDraft, OutboxJob, OutboxResumeDestination } from "./types";

export { snapshotOutboxSession, startOutboxPresence } from "./activity";

const stores = new Map<string, OutboxStore>();
const starting = new Map<string, Promise<void>>();
const attached = new WeakSet<AgentSession>();
let cleanupRegistered = false;

export function getOutboxStore(): OutboxStore {
	const file = outboxDbPath();
	let store = stores.get(file);
	if (!store) {
		store = new OutboxStore(file);
		stores.set(file, store);
	}
	if (!cleanupRegistered) {
		cleanupRegistered = true;
		postmortem.register("outbox-stores", () => {
			for (const open of stores.values()) open.close();
			stores.clear();
		});
	}
	return store;
}

/** Protect a queued chat before SDK initialization can write model or workspace entries. */
export function prepareOutboxSession(manager: SessionManager): () => void {
	const store = getOutboxStore();
	const id = manager.getSessionId();
	const file = manager.getSessionFile();
	if (!file) return () => {};
	if (store.list().some(job => job.sessionId === id && job.state !== "completed" && job.state !== "cancelled")) {
		manager.claimForOutbox();
	}
	store.registerSession(id, file, process.pid);
	return () => store.unregisterSession(id, process.pid);
}

export async function enqueueOutbox(session: AgentSession, draft: OutboxDraft): Promise<OutboxJob> {
	const manager = session.sessionManager;
	const sessionId = manager.getSessionId();
	const sessionFile = manager.getSessionFile();
	const model = session.model;
	if (!sessionFile)
		throw new Error("Outbox requires a saved chat; ephemeral sessions cannot receive queued messages.");
	if (!model) throw new Error("Select a model before queueing a message.");
	const sessionSnapshot = snapshotOutboxSession(session);
	const snapshot = {
		...draft,
		sessionId,
		sessionFile,
		branchId: sessionSnapshot.branchId,
		cwd: sessionSnapshot.cwd,
		provider: sessionSnapshot.provider,
		model: sessionSnapshot.model,
		thinkingLevel: sessionSnapshot.thinkingLevel,
		approvalMode: sessionSnapshot.approvalMode,
		sessionName: sessionSnapshot.sessionName,
	};
	manager.claimForOutbox();
	await manager.ensureOnDisk();
	if (manager.getSessionId() !== sessionId || manager.getSessionFile() !== sessionFile) {
		throw new Error("Chat changed while saving the outbox message; the draft was not queued.");
	}
	const store = getOutboxStore();
	const job = await store.add(snapshot);
	attachOutboxSession(session, store);
	return job;
}

export async function armOutboxResume(
	session: AgentSession,
	destination: OutboxResumeDestination = snapshotOutboxSession(session),
): Promise<OutboxJob> {
	const store = getOutboxStore();
	const current = destination.sessionId === session.sessionId;
	if (!destination.lastUserEntryId) {
		throw new Error(
			"No existing request is available to resume. Open the intended chat and arm its request, or add a new message.",
		);
	}
	if (current) {
		const snapshot = snapshotOutboxSession(session);
		if (
			snapshot.sessionFile !== destination.sessionFile ||
			snapshot.lastUserEntryId !== destination.lastUserEntryId
		) {
			throw new Error(
				"The original request changed while selecting its chat. Select it again before arming resume.",
			);
		}
		session.sessionManager.claimForOutbox();
		await session.sessionManager.ensureOnDisk();
		if (
			snapshotOutboxSession(session).lastUserEntryId !== destination.lastUserEntryId ||
			session.sessionId !== destination.sessionId
		) {
			throw new Error("The chat changed while saving its resume watch. No watch was armed.");
		}
	} else if (
		!store
			.sessions()
			.some(
				snapshot =>
					snapshot.sessionId === destination.sessionId &&
					snapshot.sessionFile === destination.sessionFile &&
					snapshot.lastUserEntryId === destination.lastUserEntryId,
			)
	) {
		throw new Error("This chat needs fresh resume metadata. Open or reload it, then choose it again.");
	}
	await ensureOutboxWorker();
	const existingWatches = store
		.list()
		.filter(
			job =>
				job.kind === "resume" &&
				job.sessionId === destination.sessionId &&
				job.state !== "completed" &&
				job.state !== "cancelled" &&
				job.state !== "running" &&
				job.state !== "dispatching",
		);
	for (const duplicate of existingWatches.slice(1)) {
		store.cancel(duplicate.id);
	}
	const reused = existingWatches[0]
		? store.retargetResume(existingWatches[0].id, {
				resumeUserEntryId: destination.lastUserEntryId,
				branchId: destination.lastUserEntryId,
				provider: destination.provider,
				model: destination.model,
				thinkingLevel: destination.thinkingLevel,
				approvalMode: destination.approvalMode,
				sessionName: destination.sessionName,
				state: "watching",
			})
		: undefined;
	const job =
		reused ??
		(await store.add({
			...destination,
			kind: "resume",
			resumeUserEntryId: destination.lastUserEntryId,
			branchId: destination.lastUserEntryId,
			text: "Resume when quota returns",
		}));
	if (current) attachOutboxSession(session, store);
	store.setArmed(true);
	return job;
}

/** Only this profile's worker is adopted, even though the process supervisor is machine-global. */
export function ensureOutboxWorker(): Promise<void> {
	const db = outboxDbPath();
	const existing = starting.get(db);
	if (existing) return existing;
	const pending = startWorker(db).finally(() => starting.delete(db));
	starting.set(db, pending);
	return pending;
}

async function isCurrentWorker(broker: DaemonBrokerClient, current: DaemonSnapshot | undefined): Promise<boolean> {
	if (current?.state !== "ready") return false;
	if (current.readyMatch === OUTBOX_WORKER_READY) return true;
	// readyMatch is the launcher's regex match, not the worker's protocol advertisement.
	const output = await broker.request({
		op: "logs",
		name: "outbox",
		lines: 20,
		head: true,
		follow: false,
		timeoutMs: 0,
	});
	if (output.op !== "logs" || !output.text.includes(OUTBOX_WORKER_READY)) return false;
	const observed = await describeQuietly(broker, "outbox", "Outbox");
	return observed?.id === current.id && observed.state === "ready";
}

async function startWorker(db: string): Promise<void> {
	const broker = await daemonClientForGlobal(`outbox-${Bun.hash(path.resolve(db)).toString(16)}`);
	await broker.request({ op: "ping" });
	let current = await describeQuietly(broker, "outbox", "Outbox");
	if (current?.state === "starting" || current?.state === "restarting") {
		// Only consider replacing a stalled launch after its readiness window expires.
		await broker.request({ op: "wait", name: "outbox", for: "ready", timeoutMs: 30_000 });
		current = await describeQuietly(broker, "outbox", "Outbox");
	}
	if (await isCurrentWorker(broker, current)) return;
	if (current?.state === "ready" || current?.state === "starting") {
		const store = getOutboxStore();
		const head = store.head();
		const active = store.list().some(job => job.state === "running" || job.state === "dispatching");
		const safeToUpgrade =
			!active &&
			(!store.isArmed() ||
				current.state === "starting" ||
				!head ||
				head.state === "attention" ||
				(head.kind === "resume" && head.state === "watching"));
		if (!safeToUpgrade)
			throw new Error(
				"The outbox worker needs an update. Let its active turn finish, pause the queue, then Run or Arm resume again.",
			);
		await broker.request({ op: "stop", name: "outbox", id: current.id, timeoutMs: 5000 });
		current = await describeQuietly(broker, "outbox", "Outbox");
	}
	if (current?.state === "stopping") {
		await broker.request({ op: "wait", name: "outbox", for: "exit", timeoutMs: 5000 });
		current = await describeQuietly(broker, "outbox", "Outbox");
	}
	if (current?.state === "starting" || current?.state === "restarting") {
		await waitReady(broker, "outbox", "Outbox");
		current = await describeQuietly(broker, "outbox", "Outbox");
	}
	if (await isCurrentWorker(broker, current)) return;
	if (current && current.state !== "exited" && current.state !== "failed") {
		throw new Error(`Outbox worker is ${current.state}, not ready. Retry once its startup or shutdown completes.`);
	}
	const spawn = resolveWorkerSpawnCmd(OUTBOX_WORKER_ARG);
	try {
		const result = await broker.request({
			op: "start",
			spec: {
				name: "outbox",
				application: spawn.cmd[0]!,
				args: spawn.cmd.slice(1),
				env: workerEnvFromParent({
					PI_CODING_AGENT_DIR: getAgentDir(),
					OMP_OUTBOX_DB: db,
				}),
				cwd: spawn.cwd ?? getAgentDir(),
				pty: false,
				ready: { log: OUTBOX_WORKER_READY, timeoutMs: 30_000 },
				restart: "on-failure",
				persist: true,
				detached: true,
			},
		});
		if (result.op !== "start" || result.readyTimedOut || result.daemon.state !== "ready") {
			throw new Error("Outbox worker did not become ready; the queue was not armed.");
		}
	} catch (error) {
		let winner = await describeQuietly(broker, "outbox", "Outbox");
		if (winner?.state === "starting" || winner?.state === "restarting") {
			await waitReady(broker, "outbox", "Outbox");
			winner = await describeQuietly(broker, "outbox", "Outbox");
		}
		if (!(await isCurrentWorker(broker, winner))) throw error;
	}
}

export async function startOutbox(): Promise<void> {
	const store = getOutboxStore();
	// A failed worker launch must not leave a newly armed queue with no supervisor.
	await ensureOutboxWorker();
	store.setArmed(true);
}

export function pauseOutbox(): void {
	getOutboxStore().setArmed(false);
}

/** Polling the durable inbox avoids adding a second local prompt-control protocol. */
export function attachOutboxSession(session: AgentSession, store = getOutboxStore()): void {
	if (attached.has(session)) return;
	attached.add(session);
	const stopPresence = startOutboxPresence(session, store);
	let registeredId: string | undefined;
	let stopped = false;
	let busy = false;
	let nextWorkerCheck = 0;
	const register = (): void => {
		const id = session.sessionManager.getSessionId();
		const file = session.sessionManager.getSessionFile();
		if (registeredId && registeredId !== id) store.unregisterSession(registeredId, process.pid);
		registeredId = file ? id : undefined;
		if (file) store.registerSession(id, file, process.pid);
	};
	const tick = async (): Promise<void> => {
		if (stopped || busy || session.isDisposed) return;
		busy = true;
		let claimed: OutboxJob | undefined;
		try {
			register();
			if (!registeredId || !store.isArmed()) return;
			if (Date.now() >= nextWorkerCheck) {
				nextWorkerCheck = Date.now() + 30_000;
				void ensureOutboxWorker().catch(error =>
					session.emitNotice("error", `Outbox worker: ${String(error)}`, "outbox"),
				);
			}
			const candidate = store.candidates(registeredId)[0];
			if (!candidate) return;
			if (candidate.kind === "resume" && candidate.state === "watching") {
				if (!observeOutboxResume(session, store, candidate)) return;
			}
			if (session.isBusyForSnapshot || (candidate.kind !== "resume" && session.agent.hasQueuedMessages())) return;
			claimed = store.claim(registeredId, process.pid);
			if (claimed) await deliverOutboxJob(session, store, claimed);
		} catch (error) {
			if (claimed?.ownerToken) {
				store.updateOwned(claimed.id, claimed.ownerToken, {
					state: "attention",
					reason: String(error),
				});
			}
			logger.warn("Outbox session pump failed", {
				error: String(error),
				sessionId: registeredId,
			});
			session.emitNotice("error", `Outbox: ${String(error)}`, "outbox");
		} finally {
			busy = false;
		}
	};
	register();
	const timer = setInterval(() => void tick(), 1_000);
	timer.unref();
	const unregisterSwitch = session.registerSessionChangeCallback(register);
	session.addDisposer(() => {
		stopped = true;
		clearInterval(timer);
		unregisterSwitch();
		stopPresence();
		if (registeredId) store.unregisterSession(registeredId, process.pid);
		attached.delete(session);
	});
}
