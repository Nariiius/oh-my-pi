import { logger } from "@oh-my-pi/pi-utils";
import { SessionManager } from "../session/session-manager";
import { reconcileOutboxJob } from "./delivery";
import type { OutboxStore } from "./store";
import type { OutboxJob } from "./types";

export function outboxProcessAlive(pid: number | undefined): boolean {
	if (!pid || !Number.isSafeInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return !(error instanceof Error && "code" in error && error.code === "ESRCH");
	}
}

/** One coordinator dispatches independent chats; live adapters use the same atomic admission rules. */
export class OutboxCoordinator {
	#busy = false;
	#running = new Map<string, Promise<void>>();
	#failure: unknown;
	constructor(
		readonly store: OutboxStore,
		readonly runClosed: (job: OutboxJob) => Promise<void>,
	) {}

	async tick(): Promise<void> {
		if (this.#failure) throw this.#failure;
		if (this.#busy) return;
		this.#busy = true;
		try {
			const candidates = this.store.candidates();
			for (const job of this.store.list()) {
				if ((job.state === "running" || job.state === "dispatching") && !outboxProcessAlive(job.ownerPid)) {
					await this.#recover(job);
				}
			}
			if (!this.store.isArmed()) return;
			const snapshots = new Map(this.store.sessions().map(s => [s.sessionId, s]));
			const anyActive = this.store.list().some(job => job.state === "running" || job.state === "dispatching");
			for (const candidate of candidates) {
				if (
					this.#running.has(candidate.sessionId) ||
					candidate.state === "attention" ||
					candidate.state === "running" ||
					candidate.state === "dispatching" ||
					(candidate.nextCheckAt ?? 0) > Date.now()
				)
					continue;
				const snap = snapshots.get(candidate.sessionId);
				if (
					candidate.kind === "resume" &&
					candidate.state === "watching" &&
					snap?.lastUserEntryId &&
					snap.lastUserEntryId !== candidate.resumeUserEntryId
				) {
					this.store.retargetResume(candidate.id, {
						resumeUserEntryId: snap.lastUserEntryId,
						branchId: snap.lastUserEntryId,
					});
				}
				const owner = this.store.sessionOwner(candidate.sessionId);
				if (owner && outboxProcessAlive(owner.pid)) {
					const idle = !snap || snap.activity === "Idle" || snap.activity === "Quota limited";
					const head = this.store.head();
					const headSnap = head ? snapshots.get(head.sessionId) : undefined;
					const headBlockedOrBusy =
						head !== undefined &&
						head.id !== candidate.id &&
						head.state !== "running" &&
						head.state !== "dispatching" &&
						(head.state === "attention" ||
							(head.nextCheckAt ?? 0) > Date.now() ||
							head.kind === "message" ||
							(headSnap !== undefined && headSnap.activity !== "Idle" && headSnap.activity !== "Quota limited"));
					if (!anyActive && candidate.kind === "resume" && idle && headBlockedOrBusy) {
						this.store.move(candidate.id, 1);
					}
					continue;
				}
				if (owner) this.store.unregisterSession(candidate.sessionId, owner.pid);
				const claimed = this.store.claim(candidate.sessionId, process.pid);
				if (!claimed) continue;
				const task = this.#execute(claimed)
					.catch(error => {
						this.#failure = error;
					})
					.finally(() => this.#running.delete(claimed.sessionId));
				this.#running.set(claimed.sessionId, task);
			}
		} finally {
			this.#busy = false;
		}
	}

	/** Finish owned executors before their shared store and coordinator lease are closed. */
	async drain(): Promise<void> {
		await Promise.all(this.#running.values());
		if (this.#failure) throw this.#failure;
	}

	async #execute(job: OutboxJob): Promise<void> {
		try {
			await this.runClosed(job);
		} catch (error) {
			this.store.updateOwned(job.id, job.ownerToken!, {
				state: "attention",
				reason: String(error),
			});
		}
	}

	async #recover(job: OutboxJob): Promise<void> {
		if (!job.ownerToken) throw new Error(`Outbox job ${job.id} has no delivery owner; inspect the queue database.`);
		let manager: SessionManager | undefined;
		try {
			manager = await SessionManager.open(job.sessionFile, undefined, undefined, {
				throwIfMissing: true,
				suppressBreadcrumb: true,
			});
			if (manager.getSessionId() !== job.sessionId) throw new Error("Target chat identity changed during recovery.");
			const receipt = reconcileOutboxJob(manager, job);
			this.store.updateOwned(job.id, job.ownerToken, {
				state:
					receipt === "completed"
						? "completed"
						: job.cancelRequested
							? "cancelled"
							: receipt === "absent"
								? "queued"
								: "attention",
				reason:
					receipt === "accepted"
						? "Delivery was accepted before its process exited. Review the original chat before resuming; the prompt will not be resent."
						: undefined,
			});
		} catch (error) {
			this.store.updateOwned(job.id, job.ownerToken, {
				state: "attention",
				reason: `Recovery could not verify delivery: ${String(error)}`,
			});
			logger.warn("Outbox recovery needs attention", {
				jobId: job.id,
				error: String(error),
			});
		} finally {
			await manager?.close();
		}
	}
}
