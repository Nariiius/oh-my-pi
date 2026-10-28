import type { PowerAssertion } from "@oh-my-pi/pi-natives";
import { logger, tryAcquireFileLock } from "@oh-my-pi/pi-utils";
import { OUTBOX_WORKER_READY } from "../cli/worker-selectors";
import { createAgentSession } from "../sdk";
import type { AgentSession } from "../session/agent-session";
import { startPowerAssertion } from "../session/power-assertion-backend";
import { SessionManager, SessionOutboxClaimError } from "../session/session-manager";
import { OutboxCoordinator } from "./coordinator";
import { deliverOutboxJob } from "./delivery";
import { startOutboxPresence } from "./service";
import { OutboxStore, outboxDbPath } from "./store";
import type { OutboxJob } from "./types";
export async function runOutboxWorker(signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const dbPath = process.env.OMP_OUTBOX_DB ?? outboxDbPath();
	const store = new OutboxStore(dbPath);
	const lease = tryAcquireFileLock(`${dbPath}.coordinator`);
	if (!lease) {
		store.close();
		throw new Error("Another outbox coordinator already owns this profile.");
	}
	let stopped = false;
	const activeSessions = new Set<AgentSession>();
	let assertion: PowerAssertion | undefined;
	const stop = (): void => {
		stopped = true;
		for (const session of activeSessions) {
			void session.abort().catch(error => logger.warn("Outbox shutdown abort failed", { error: String(error) }));
		}
	};
	signal?.addEventListener("abort", stop, { once: true });
	process.on("SIGTERM", stop);
	process.on("SIGINT", stop);
	const runClosed = async (job: OutboxJob): Promise<void> => {
		let manager: SessionManager | undefined;
		let activeSession: AgentSession | undefined;
		let deliveryStarted = false;
		try {
			manager = await SessionManager.open(job.sessionFile, undefined, undefined, {
				throwIfMissing: true,
				suppressBreadcrumb: true,
			});
			if (manager.getSessionId() !== job.sessionId || manager.getCwd() !== job.cwd) {
				throw new Error("The queued chat or its working directory changed; review its destination.");
			}
			manager.claimForOutbox();
			if (stopped) return;
			const created = await createAgentSession({
				cwd: job.cwd,
				agentId: `outbox-${job.sessionId}`,
				sessionManager: manager,
				modelPattern: `${job.provider}/${job.model}`,
				outbox: false,
				hasUI: false,
				interactivePrompts: false,
				allowSessionModelFallback: false,
				autoApprove: false,
			});
			activeSession = created.session;
			activeSessions.add(activeSession);
			if (stopped) return;
			const stopPresence = startOutboxPresence(activeSession, store);
			try {
				deliveryStarted = true;
				await deliverOutboxJob(activeSession, store, job);
			} finally {
				stopPresence();
			}
		} catch (error) {
			if (error instanceof SessionOutboxClaimError) {
				store.updateOwned(job.id, job.ownerToken!, {
					state: "waiting",
					reason:
						"Chat is open in another process. Reload that chat with outbox support, or close it to allow safe background delivery.",
					nextCheckAt: Date.now() + 10_000,
				});
			} else {
				throw error;
			}
		} finally {
			try {
				await activeSession?.dispose();
			} finally {
				if (activeSession) activeSessions.delete(activeSession);
				try {
					await manager?.close();
				} finally {
					if (stopped && !deliveryStarted) {
						store.updateOwned(job.id, job.ownerToken!, {
							state: "waiting",
							reason: "Worker stopped before delivery.",
						});
					}
				}
			}
		}
	};
	const coordinator = new OutboxCoordinator(store, runClosed);
	// A standalone worker's stdout is captured by the supervisor, never by the TUI.
	process.stdout.write(`outbox: ready protocol=2 ${OUTBOX_WORKER_READY}\n`);
	try {
		while (!stopped) {
			const keepAwake = store.isArmed() && store.candidates().some(job => job.state !== "attention");
			if (keepAwake && !assertion)
				assertion = startPowerAssertion({
					reason: "omp overnight outbox",
					idle: true,
				});
			if (!keepAwake && assertion) {
				assertion.stop();
				assertion = undefined;
			}
			await coordinator.tick();
			if (!stopped) {
				const wakeAt = store.nextWakeAt();
				const sleepMs = wakeAt !== undefined ? Math.max(1_000, Math.min(wakeAt - Date.now(), 30_000)) : 1_000;
				await Bun.sleep(sleepMs);
			}
		}
	} finally {
		stop();
		try {
			await coordinator.drain();
		} finally {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
			signal?.removeEventListener("abort", stop);
			assertion?.stop();
			lease.release();
			store.close();
		}
	}
}
