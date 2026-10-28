import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { OutboxCoordinator } from "../src/outbox/coordinator";
import { OutboxStore } from "../src/outbox/store";
import type { OutboxJob } from "../src/outbox/types";
import { SessionManager } from "../src/session/session-manager";

const roots: TempDir[] = [];
const stores: OutboxStore[] = [];
const managers: SessionManager[] = [];
afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.close();
	for (const store of stores.splice(0)) store.close();
	for (const root of roots.splice(0)) root.removeSync();
});

async function fixture() {
	const root = TempDir.createSync("@omp-outbox-coordinator-");
	roots.push(root);
	const db = path.join(root.path(), "outbox.db");
	const store = new OutboxStore(db);
	stores.push(store);
	async function add(
		text: string,
		kind: OutboxJob["kind"] = "message",
	): Promise<{ job: OutboxJob; manager: SessionManager }> {
		const manager = SessionManager.create(root.path(), path.join(root.path(), "sessions"));
		managers.push(manager);
		const resumeUserEntryId =
			kind === "resume" ? manager.appendMessage({ role: "user", content: text, timestamp: Date.now() }) : undefined;
		await manager.ensureOnDisk();
		const job = await store.add({
			kind,
			resumeUserEntryId,
			text,
			sessionId: manager.getSessionId(),
			sessionFile: manager.getSessionFile()!,
			branchId: manager.getLeafId(),
			cwd: root.path(),
			provider: "openai",
			model: "test-outbox",
		});
		return { job, manager };
	}
	return { store, db, add };
}

describe("outbox coordinator", () => {
	it("serializes two coordinators across chats and waits for completion before the next dispatch", async () => {
		const { store, db, add } = await fixture();
		const a = await add("first");
		const b = await add("second");
		store.setArmed(true);
		const peer = new OutboxStore(db);
		stores.push(peer);
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const deliveries: string[] = [];
		const first = new OutboxCoordinator(store, async job => {
			deliveries.push(job.id);
			started.resolve();
			await release.promise;
			store.updateOwned(job.id, job.ownerToken!, { state: "completed" });
		});
		const second = new OutboxCoordinator(peer, async job => {
			deliveries.push(job.id);
			peer.updateOwned(job.id, job.ownerToken!, { state: "completed" });
		});
		const pending = first.tick();
		await started.promise;
		await second.tick();
		expect(deliveries).toEqual([a.job.id]);
		expect(store.get(b.job.id)?.state).toBe("queued");
		release.resolve();
		await pending;
		await first.drain();
		await second.tick();
		await second.drain();
		expect(deliveries).toEqual([a.job.id, b.job.id]);
	});

	it("does not launch a second executor for a registered live chat", async () => {
		const { store, add } = await fixture();
		const { job } = await add("live owner only");
		store.registerSession(job.sessionId, job.sessionFile, process.pid);
		store.setArmed(true);
		const coordinator = new OutboxCoordinator(store, async () => {
			throw new Error("must not resume a live chat");
		});
		await coordinator.tick();
		expect(store.get(job.id)?.state).toBe("queued");
		expect(store.claim(job.sessionId, process.pid)?.id).toBe(job.id);
	});

	it("keeps a failed head blocking later messages until explicitly cancelled", async () => {
		const { store, add } = await fixture();
		const a = await add("blocked");
		const b = await add("must wait");
		store.setArmed(true);
		const coordinator = new OutboxCoordinator(store, async job => {
			if (job.id === a.job.id) throw new Error("authentication requires attention");
			store.updateOwned(job.id, job.ownerToken!, { state: "completed" });
		});
		await coordinator.tick();
		await coordinator.drain();
		await coordinator.tick();
		await coordinator.drain();
		expect(store.get(a.job.id)?.state).toBe("attention");
		expect(store.get(b.job.id)?.state).toBe("queued");
		store.cancel(a.job.id);
		await coordinator.tick();
		await coordinator.drain();
		expect(store.get(b.job.id)?.state).toBe("completed");
	});

	it("resumes independent closed chats past an interrupted message without waiting for another chat's executor", async () => {
		const { store, add } = await fixture();
		const blocked = await add("Interrupted message");
		const slow = await add("First resume", "resume");
		const fast = await add("Independent resume", "resume");
		const laterMessage = await add("Must retain message order");
		store.setArmed(true);
		const old = store.claim(blocked.job.sessionId, process.pid)!;
		store.updateOwned(old.id, old.ownerToken!, { state: "attention", reason: "Manual interrupt" });
		const started = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const completed = Promise.withResolvers<void>();
		const delivered: string[] = [];
		const coordinator = new OutboxCoordinator(store, async job => {
			delivered.push(job.id);
			if (job.id === slow.job.id) {
				started.resolve();
				await release.promise;
			}
			store.updateOwned(job.id, job.ownerToken!, { state: "completed" });
			if (job.id === fast.job.id) completed.resolve();
		});
		try {
			await coordinator.tick();
			await started.promise;
			await completed.promise;
			await coordinator.tick();
			expect(delivered).toEqual([slow.job.id, fast.job.id]);
			expect(store.get(blocked.job.id)?.state).toBe("attention");
			expect(store.get(laterMessage.job.id)?.state).toBe("queued");
			expect(store.get(slow.job.id)?.state).toBe("dispatching");
		} finally {
			release.resolve();
			await coordinator.drain();
		}
		expect(store.get(slow.job.id)?.state).toBe("completed");
	});

	it("recovers a dead resume owner even when an unrelated message needs attention", async () => {
		const { store, add } = await fixture();
		const blocked = await add("Interrupted message");
		const watch = await add("Resume after process exit", "resume");
		store.setArmed(true);
		const old = store.claim(blocked.job.sessionId, process.pid)!;
		store.updateOwned(old.id, old.ownerToken!, { state: "attention" });
		const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
		await child.exited;
		expect(store.claim(watch.job.sessionId, child.pid)?.id).toBe(watch.job.id);
		const coordinator = new OutboxCoordinator(store, async () => {
			throw new Error("Recovery must not redispatch in the same tick");
		});
		await coordinator.tick();
		await coordinator.drain();
		expect(store.get(watch.job.id)?.state).toBe("watching");
		expect(store.get(watch.job.id)?.ownerToken).toBeUndefined();
		expect(store.get(blocked.job.id)?.state).toBe("attention");
	});

	it("retargets and promotes a live session resume watch past an interrupted head", async () => {
		const { store, add } = await fixture();
		const blocked = await add("Interrupted message");
		const watch = await add("Initial watched request", "resume");
		store.setArmed(true);
		const old = store.claim(blocked.job.sessionId, process.pid)!;
		store.updateOwned(old.id, old.ownerToken!, { state: "attention" });
		const newerUser = watch.manager.appendMessage({
			role: "user",
			content: "Newer quota-blocked request",
			timestamp: Date.now(),
		});
		store.publishSession({
			sessionId: watch.job.sessionId,
			sessionFile: watch.job.sessionFile,
			branchId: newerUser,
			lastUserEntryId: newerUser,
			cwd: watch.job.cwd,
			provider: watch.job.provider,
			model: watch.job.model,
			sessionName: "Live watched chat",
			activity: "Idle",
			updatedAt: Date.now(),
			pid: process.pid,
		});
		const coordinator = new OutboxCoordinator(store, async () => {});
		await coordinator.tick();
		await coordinator.drain();
		const head = store.head();
		expect(head?.id).toBe(watch.job.id);
		expect(head?.resumeUserEntryId).toBe(newerUser);
	});

	for (const stage of ["absent", "accepted", "completed"] as const) {
		it(`reconciles a dead owner with ${stage} receipt without redispatching its input`, async () => {
			const { store, add } = await fixture();
			const { job, manager } = await add("persist this request only once");
			const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], {
				stdout: "ignore",
				stderr: "ignore",
			});
			await child.exited;
			store.setArmed(true);
			const claimed = store.claim(job.sessionId, child.pid)!;
			if (stage !== "absent") {
				await manager.appendEntriesAtomically(() => {
					manager.appendMessage({
						role: "user",
						content: job.text,
						timestamp: Date.now(),
					});
					manager.appendCustomEntry("outbox.delivery", {
						jobId: job.id,
						stage,
					});
				});
			}
			const coordinator = new OutboxCoordinator(store, async () => {
				throw new Error("reconciliation must not dispatch");
			});
			await coordinator.tick();
			expect(store.get(job.id)?.state).toBe(
				stage === "absent" ? "queued" : stage === "completed" ? "completed" : "attention",
			);
			expect(store.get(job.id)?.ownerToken).not.toBe(claimed.ownerToken);
			if (stage !== "absent") {
				await coordinator.tick();
				expect(
					manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user"),
				).toHaveLength(1);
			}
		});
	}
});
