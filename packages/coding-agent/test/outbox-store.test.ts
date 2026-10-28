import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@oh-my-pi/pi-ai";
import { OutboxStore } from "../src/outbox/store";
import type { OutboxNewJob, OutboxSessionSnapshot } from "../src/outbox/types";

describe("OutboxStore", () => {
	let tempDir: string;
	let dbPath: string;
	let store: OutboxStore;

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-outbox-store-test-"));
		dbPath = path.join(tempDir, "outbox.db");
		store = new OutboxStore(dbPath);
	});

	afterEach(() => {
		try {
			store.close();
		} catch {}
		try {
			fs.rmSync(tempDir, { recursive: true, force: true });
		} catch {}
	});

	const sampleJobInput = (overrides: Partial<OutboxNewJob> = {}): OutboxNewJob => ({
		sessionId: "session-1",
		sessionFile: "/tmp/session-1.json",
		branchId: null,
		cwd: "/tmp",
		provider: "anthropic",
		model: "claude-3-7-sonnet",
		text: "Initial message",
		...overrides,
	});

	const resumeJobInput = (overrides: Partial<OutboxNewJob> = {}): OutboxNewJob =>
		sampleJobInput({
			kind: "resume",
			resumeUserEntryId: "user-turn-1",
			branchId: "user-turn-1",
			text: "",
			...overrides,
		});

	it("permanently removes a saved job and only its own image copies", async () => {
		const sessionFile = path.join(tempDir, "chat.jsonl");
		fs.writeFileSync(sessionFile, "existing chat history");
		const image: ImageContent = { type: "image", mimeType: "image/png", data: Buffer.from("image").toString("base64") };
		const removed = await store.add(sampleJobInput({ sessionFile, images: [image] }));
		const retained = await store.add(sampleJobInput({ images: [image] }));
		store.remove(removed.id);
		store.close();
		store = new OutboxStore(dbPath);
		expect(store.get(removed.id)).toBeUndefined();
		expect(store.list().map(job => job.id)).toEqual([retained.id]);
		expect(fs.existsSync(removed.attachments[0]!.path)).toBe(false);
		expect(fs.readFileSync(retained.attachments[0]!.path, "utf8")).toBe("image");
		expect(fs.readFileSync(sessionFile, "utf8")).toBe("existing chat history");
		expect(() => store.remove(removed.id)).toThrow("Job not found");
	});

	it("does not erase an active claim even after cancellation is requested", async () => {
		const job = await store.add(sampleJobInput());
		store.setArmed(true);
		const claim = store.claim(job.sessionId, process.pid)!;
		const other = new OutboxStore(dbPath);
		try {
			expect(() => other.remove(job.id)).toThrow("Cancel it first");
			expect(store.get(job.id)?.ownerToken).toBe(claim.ownerToken);
			store.updateOwned(job.id, claim.ownerToken!, { state: "running" });
			other.cancel(job.id);
			expect(() => other.remove(job.id)).toThrow("Cancel it first");
			expect(store.get(job.id)?.cancelRequested).toBe(true);
			store.updateOwned(job.id, claim.ownerToken!, { state: "cancelled" });
			other.remove(job.id);
			expect(store.get(job.id)).toBeUndefined();
		} finally {
			other.close();
		}
	});

	it("removes a resume barrier without resuming it and allows the same turn to be rearmed", async () => {
		const watch = await store.add(resumeJobInput());
		const next = await store.add(sampleJobInput());
		store.setArmed(true);
		store.remove(watch.id);
		expect(store.claim(next.sessionId, process.pid)?.id).toBe(next.id);
		const replacement = await store.add(resumeJobInput());
		expect(replacement.id).not.toBe(watch.id);
		expect(replacement.state).toBe("watching");
	});

	it("refuses attachment paths belonging to another job", async () => {
		const victim = await store.add(sampleJobInput({
			images: [{ type: "image", mimeType: "image/png", data: Buffer.from("keep").toString("base64") }],
		}));
		const corrupted = await store.add(sampleJobInput());
		const db = new Database(dbPath);
		try {
			db.run("UPDATE outbox SET attachments = ? WHERE id = ?", [JSON.stringify(victim.attachments), corrupted.id]);
		} finally {
			db.close();
		}
		expect(() => store.remove(corrupted.id)).toThrow("outside this job's saved files");
		expect(store.get(corrupted.id)?.id).toBe(corrupted.id);
		expect(fs.readFileSync(victim.attachments[0]!.path, "utf8")).toBe("keep");
	});

	it("upgrades legacy rows and snapshots without changing their schema version or message delivery", async () => {
		const original = await store.add(sampleJobInput());
		const snapshot: OutboxSessionSnapshot = {
			sessionId: original.sessionId,
			sessionFile: original.sessionFile,
			branchId: original.branchId,
			cwd: original.cwd,
			provider: original.provider,
			model: original.model,
			sessionName: "Legacy chat",
			activity: "Working",
			updatedAt: Date.now(),
			pid: process.pid,
		};
		store.publishSession(snapshot);
		store.setArmed(true);
		store.close();
		const legacy = new Database(dbPath);
		try {
			legacy.run("DROP TRIGGER outbox_resume_pending");
			legacy.run("DROP INDEX idx_outbox_resume_watch");
			legacy.run("ALTER TABLE outbox DROP COLUMN kind");
			legacy.run("ALTER TABLE outbox DROP COLUMN resume_user_entry_id");
			legacy.run("PRAGMA user_version = 1");
		} finally {
			legacy.close();
		}
		store = new OutboxStore(dbPath);
		expect(store.get(original.id)).toEqual(original);
		expect(store.sessions()).toEqual([snapshot]);
		expect(store.sessions()[0]?.lastUserEntryId).toBeUndefined();
		expect(store.claim(original.sessionId, process.pid)?.id).toBe(original.id);
		const oldClient = new Database(dbPath);
		try {
			expect(oldClient.query("PRAGMA user_version").get()).toEqual({
				user_version: 1,
			});
			expect(oldClient.query("SELECT version FROM schema_version").get()).toEqual({ version: 1 });
			oldClient.run(
				`INSERT INTO outbox
				(id, position, created_at, updated_at, session_id, session_file, cwd, provider, model, text, attachments, state)
				VALUES ('legacy-insert', 2, 1, 1, 'session-1', '/tmp/session-1.json', '/tmp', 'anthropic', 'model', 'Next', '[]', 'queued')`,
			);
			expect(store.get("legacy-insert")?.kind).toBe("message");
		} finally {
			oldClient.close();
		}
	});

	it("deduplicates unfinished watches across connections and refuses conflicting legacy retry", async () => {
		const other = new OutboxStore(dbPath);
		try {
			const [first, duplicate] = await Promise.all([store.add(resumeJobInput()), other.add(resumeJobInput())]);
			expect(duplicate.id).toBe(first.id);
			expect(store.list()).toHaveLength(1);
			store.setArmed(true);
			const claimed = store.claim(first.sessionId, process.pid)!;
			expect((await other.add(resumeJobInput())).id).toBe(first.id);
			store.updateOwned(first.id, claimed.ownerToken!, { state: "attention" });
			expect((await other.add(resumeJobInput())).id).toBe(first.id);
			store.cancel(first.id);
			const replacement = await other.add(resumeJobInput());
			expect(replacement.id).not.toBe(first.id);
			expect(() => store.retry(first.id)).toThrow();
			expect(store.get(first.id)?.state).toBe("cancelled");
			const oldClient = new Database(dbPath);
			try {
				expect(() => oldClient.run("UPDATE outbox SET state = 'queued' WHERE id = ?", [first.id])).toThrow();
			} finally {
				oldClient.close();
			}
			expect(store.get(replacement.id)?.state).toBe("watching");
			const differentTurn = await store.add(
				resumeJobInput({
					resumeUserEntryId: "user-turn-2",
					branchId: "user-turn-2",
				}),
			);
			const differentSession = await store.add(resumeJobInput({ sessionId: "session-2" }));
			expect(new Set([replacement.id, differentTurn.id, differentSession.id]).size).toBe(3);
		} finally {
			other.close();
		}
	});

	it("keeps legacy queued and waiting updates unclaimable without letting later prompts bypass the watch", async () => {
		const watch = await store.add(resumeJobInput());
		const message = await store.add(sampleJobInput());
		store.setArmed(true);
		const oldClient = new Database(dbPath);
		try {
			const legacyClaim = oldClient.query(
				`UPDATE outbox SET state = 'dispatching', owner_pid = 123, owner_token = 'legacy'
				WHERE id = (SELECT id FROM outbox WHERE state NOT IN ('completed', 'cancelled')
					ORDER BY position, created_at LIMIT 1)
				AND state IN ('queued', 'waiting') RETURNING id`,
			);
			oldClient.run("UPDATE outbox SET state = 'queued' WHERE id = ?", [watch.id]);
			expect(store.get(watch.id)?.state).toBe("watching");
			expect(legacyClaim.get()).toBeNull();
			oldClient.run("UPDATE outbox SET state = 'waiting', reason = 'Quota', next_check_at = 42 WHERE id = ?", [
				watch.id,
			]);
			expect(store.get(watch.id)).toMatchObject({
				state: "watching",
				reason: "Quota",
				nextCheckAt: 42,
			});
			expect(legacyClaim.get()).toBeNull();
			expect(store.get(message.id)?.state).toBe("queued");
			store.cancel(watch.id);
			expect(legacyClaim.get()).toEqual({ id: message.id });
		} finally {
			oldClient.close();
		}
	});

	it("claims due watches exclusively and releases them back to watching without losing quota timing", async () => {
		const watch = await store.add(resumeJobInput());
		const message = await store.add(sampleJobInput());
		store.setArmed(true);
		const nextCheckAt = Date.now() + 60_000;
		store.watch(watch.id, { reason: "Working", nextCheckAt });
		store.watch(watch.id, { reason: "Still working" });
		expect(store.get(watch.id)).toMatchObject({
			state: "watching",
			reason: "Still working",
			nextCheckAt,
		});
		expect(store.claim(watch.sessionId, process.pid)).toBeUndefined();
		expect(store.claim(message.sessionId, process.pid)).toBeUndefined();
		store.watch(watch.id, { reason: "Quota returned", nextCheckAt: 0 });
		const claimed = store.claim(watch.sessionId, process.pid)!;
		expect(claimed).toMatchObject({
			id: watch.id,
			kind: "resume",
			state: "dispatching",
		});
		store.watch(watch.id, { reason: "Stale observer", nextCheckAt });
		expect(store.get(watch.id)?.reason).toBe("Quota returned");
		expect(store.claim(watch.sessionId, process.pid)).toBeUndefined();
		expect(store.updateOwned(watch.id, "wrong-owner", { state: "completed" })).toBe(false);
		store.updateOwned(watch.id, claimed.ownerToken!, {
			state: "waiting",
			reason: "Quota",
			nextCheckAt,
		});
		expect(store.get(watch.id)).toMatchObject({
			state: "watching",
			reason: "Quota",
			nextCheckAt,
		});
		expect(store.get(watch.id)?.ownerToken).toBeUndefined();
		expect(store.get(watch.id)?.ownerPid).toBeUndefined();
		store.watch(watch.id, { reason: "Retry now", nextCheckAt: 0 });
		const retry = store.claim(watch.sessionId, process.pid)!;
		store.updateOwned(watch.id, retry.ownerToken!, { state: "queued" });
		expect(store.get(watch.id)?.state).toBe("watching");
		expect(store.get(watch.id)?.ownerToken).toBeUndefined();
		const last = store.claim(watch.sessionId, process.pid)!;
		store.updateOwned(watch.id, last.ownerToken!, { state: "completed" });
		expect(store.claim(message.sessionId, process.pid)?.id).toBe(message.id);
	});

	it("lets other chats progress past waiting watches while retaining message order and exclusive chat ownership", async () => {
		const sleeping = await store.add(resumeJobInput());
		const message = await store.add(sampleJobInput({ sessionId: "message-chat" }));
		const watch = await store.add(resumeJobInput({ sessionId: "resume-chat" }));
		const laterMessage = await store.add(sampleJobInput({ sessionId: "later-message-chat" }));
		const laterWatch = await store.add(
			resumeJobInput({
				sessionId: watch.sessionId,
				branchId: "next-user",
				resumeUserEntryId: "next-user",
			}),
		);
		store.watch(sleeping.id, { reason: "Quota", nextCheckAt: Date.now() + 60_000 });
		store.setArmed(true);
		const peer = new OutboxStore(dbPath);
		try {
			const messageClaim = store.claim(message.sessionId, process.pid)!;
			const watchClaim = peer.claim(watch.sessionId, process.pid)!;
			expect(messageClaim.id).toBe(message.id);
			expect(watchClaim.id).toBe(watch.id);
			expect(store.claim(watch.sessionId, process.pid)).toBeUndefined();
			expect(peer.claim(laterMessage.sessionId, process.pid)).toBeUndefined();
			store.setArmed(false);
			peer.updateOwned(watch.id, watchClaim.ownerToken!, { state: "completed" });
			expect(peer.claim(watch.sessionId, process.pid)).toBeUndefined();
			store.setArmed(true);
			expect(store.claim(watch.sessionId, process.pid)?.id).toBe(laterWatch.id);
			store.updateOwned(message.id, messageClaim.ownerToken!, { state: "completed" });
			expect(peer.claim(laterMessage.sessionId, process.pid)?.id).toBe(laterMessage.id);
		} finally {
			peer.close();
		}
	});

	it("cancels passive and active watches without allowing stale observation to revive them", async () => {
		const watch = await store.add(resumeJobInput());
		const message = await store.add(sampleJobInput());
		store.watch(message.id, { reason: "Not a watch", nextCheckAt: 123 });
		expect(store.get(message.id)).toEqual(message);
		store.cancel(watch.id);
		store.watch(watch.id, { reason: "Stale observer", nextCheckAt: 123 });
		expect(store.get(watch.id)?.state).toBe("cancelled");
		expect(store.get(watch.id)?.reason).toBeUndefined();
		store.retry(watch.id);
		expect(store.get(watch.id)?.state).toBe("watching");
		store.setArmed(true);
		const claimed = store.claim(watch.sessionId, process.pid)!;
		store.cancel(watch.id);
		expect(store.get(watch.id)?.cancelRequested).toBe(true);
		store.updateOwned(watch.id, claimed.ownerToken!, {
			state: "watching",
			reason: "Busy",
		});
		expect(store.get(watch.id)?.state).toBe("cancelled");
		expect(store.get(watch.id)?.ownerToken).toBeUndefined();
		expect(store.claim(message.sessionId, process.pid)?.id).toBe(message.id);
	});

	it("rejects unsafe resume anchors, attachments and edits while allowing pending reorder", async () => {
		await expect(store.add(resumeJobInput({ resumeUserEntryId: undefined }))).rejects.toThrow(/resumeUserEntryId/);
		await expect(store.add(resumeJobInput({ resumeUserEntryId: " " }))).rejects.toThrow(/resumeUserEntryId/);
		await expect(store.add(resumeJobInput({ branchId: "error-assistant" }))).rejects.toThrow(/branch/);
		await expect(
			store.add(
				resumeJobInput({
					images: [{ type: "image", mimeType: "image/png", data: "dGVzdA==" }],
				}),
			),
		).rejects.toThrow(/attachments/);
		await expect(store.add(resumeJobInput({ imageLinks: ["/tmp/image.png"] }))).rejects.toThrow(/attachments/);
		expect(store.list()).toEqual([]);
		const message = await store.add(sampleJobInput());
		const watch = await store.add(resumeJobInput());
		expect(() => store.edit(watch.id, { text: "Send this instead" })).toThrow(/resume watch/);
		expect(() => store.edit(watch.id, { provider: "openai", model: "other" })).toThrow();
		store.move(watch.id, 1);
		expect(store.head()?.id).toBe(watch.id);
		store.setArmed(true);
		const claimed = store.claim(watch.sessionId, process.pid)!;
		expect(() => store.move(message.id, 1)).toThrow(/active head/);
		store.updateOwned(watch.id, claimed.ownerToken!, { state: "attention" });
		store.retry(watch.id);
		expect(store.get(watch.id)?.state).toBe("watching");
	});

	it("initializes with private file permissions and FULL sync", () => {
		const stat = fs.statSync(dbPath);
		if (process.platform !== "win32") {
			expect(stat.mode & 0o777).toBe(0o600);
			const dirStat = fs.statSync(tempDir);
			expect(dirStat.mode & 0o777).toBe(0o700);
		}

		expect(store.isArmed()).toBe(false);
		store.setArmed(true);
		expect(store.isArmed()).toBe(true);
		store.setArmed(false);
		expect(store.isArmed()).toBe(false);
	});

	it("validates input and rejects empty text without attachments", async () => {
		await expect(store.add(sampleJobInput({ text: "   " }))).rejects.toThrow("empty text without attachments");

		const image: ImageContent = {
			type: "image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==",
			mimeType: "image/png",
		};
		const jobWithImage = await store.add(sampleJobInput({ text: "", images: [image] }));
		expect(jobWithImage.id).toBeDefined();
		expect(jobWithImage.attachments.length).toBe(1);
	});

	it("stores attachments durably and reads them back faithfully", async () => {
		const img1: ImageContent = {
			type: "image",
			data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==",
			mimeType: "image/png",
		};
		const img2: ImageContent = {
			type: "image",
			data: "dGVzdC1qcGVnLWRhdGE=",
			mimeType: "image/jpeg",
		};

		const job = await store.add(sampleJobInput({ text: "With 2 images", images: [img1, img2] }));
		expect(job.attachments).toHaveLength(2);

		for (const att of job.attachments) {
			expect(fs.existsSync(att.path)).toBe(true);
			if (process.platform !== "win32") {
				expect(fs.statSync(att.path).mode & 0o777).toBe(0o600);
			}
		}

		const images = await store.readImages(job);
		expect(images).toHaveLength(2);
		expect(images[0]).toEqual(img1);
		expect(images[1]).toEqual(img2);
	});

	it("preserves data across store close and reopen", async () => {
		store.setArmed(true);
		const job1 = await store.add(sampleJobInput({ text: "Task 1" }));
		const job2 = await store.add(sampleJobInput({ text: "Task 2" }));
		store.registerSession("session-1", "/tmp/session-1.json", process.pid);

		store.close();

		const reopened = new OutboxStore(dbPath);
		try {
			expect(reopened.isArmed()).toBe(true);
			const list = reopened.list();
			expect(list).toHaveLength(2);
			expect(list[0]?.id).toBe(job1.id);
			expect(list[1]?.id).toBe(job2.id);
			expect(reopened.sessionOwner("session-1")?.pid).toBe(process.pid);
		} finally {
			reopened.close();
		}
	});

	it("throws on corrupted database without destructive reset", () => {
		store.close();
		fs.writeFileSync(dbPath, "NOT A VALID SQLITE DATABASE HEADER DATA AT ALL");

		expect(() => new OutboxStore(dbPath)).toThrow();
		const content = fs.readFileSync(dbPath, "utf-8");
		expect(content).toBe("NOT A VALID SQLITE DATABASE HEADER DATA AT ALL");
	});

	it("refuses unsupported future schema versions (> 1)", () => {
		store.close();

		const rawDb = new Database(dbPath);
		rawDb.run("UPDATE schema_version SET version = 2");
		rawDb.close();

		expect(() => new OutboxStore(dbPath)).toThrow(/Unsupported schema version/);
	});

	it("implements atomic FIFO single claim", async () => {
		const job1 = await store.add(sampleJobInput({ text: "First", sessionId: "session-1" }));
		await store.add(sampleJobInput({ text: "Second", sessionId: "session-1" }));

		expect(store.claim("session-1", 1234)).toBeUndefined();

		store.setArmed(true);

		expect(store.claim("session-2", 1234)).toBeUndefined();

		const claimed = store.claim("session-1", 1234);
		expect(claimed).toBeDefined();
		expect(claimed?.id).toBe(job1.id);
		expect(claimed?.state).toBe("dispatching");
		expect(claimed?.ownerPid).toBe(1234);
		expect(claimed?.ownerToken).toBeDefined();

		expect(store.claim("session-1", 1234)).toBeUndefined();
	});

	it("holds queue when head is in attention state or due in the future", async () => {
		store.setArmed(true);
		const job1 = await store.add(sampleJobInput({ text: "Head" }));
		await store.add(sampleJobInput({ text: "Second" }));

		const claimed = store.claim("session-1", 1234)!;
		store.updateOwned(job1.id, claimed.ownerToken!, {
			state: "attention",
			reason: "Rate limited",
		});

		expect(store.claim("session-1", 1234)).toBeUndefined();

		store.retry(job1.id);
		expect(store.get(job1.id)?.state).toBe("queued");

		const claimed2 = store.claim("session-1", 1234)!;
		store.updateOwned(job1.id, claimed2.ownerToken!, {
			state: "waiting",
			nextCheckAt: Date.now() + 100_000,
		});

		expect(store.claim("session-1", 1234)).toBeUndefined();
	});

	it("enforces conditional ownership on updateOwned", async () => {
		store.setArmed(true);
		const job = await store.add(sampleJobInput({ text: "Task" }));
		const claimed = store.claim("session-1", 1234)!;

		const badUpdate = store.updateOwned(job.id, "wrong-token", {
			state: "running",
		});
		expect(badUpdate).toBe(false);

		const runUpdate = store.updateOwned(job.id, claimed.ownerToken!, {
			state: "running",
		});
		expect(runUpdate).toBe(true);
		const runningJob = store.get(job.id)!;
		expect(runningJob.state).toBe("running");
		expect(runningJob.ownerPid).toBe(1234);
		expect(runningJob.ownerToken).toBe(claimed.ownerToken);

		const waitUpdate = store.updateOwned(job.id, claimed.ownerToken!, {
			state: "waiting",
			reason: "Exhausted",
			nextCheckAt: 5000,
		});
		expect(waitUpdate).toBe(true);
		const waitingJob = store.get(job.id)!;
		expect(waitingJob.state).toBe("waiting");
		expect(waitingJob.ownerPid).toBeUndefined();
		expect(waitingJob.ownerToken).toBeUndefined();
		expect(waitingJob.reason).toBe("Exhausted");
		expect(waitingJob.nextCheckAt).toBe(5000);

		// Transition to queued releases owner for crash recovery
		const claimed2 = store.claim("session-1", 1234)!;
		expect(claimed2).toBeDefined();
		const queueUpdate = store.updateOwned(job.id, claimed2.ownerToken!, {
			state: "queued",
		});
		expect(queueUpdate).toBe(true);
		const queuedJob = store.get(job.id)!;
		expect(queuedJob.state).toBe("queued");
		expect(queuedJob.ownerPid).toBeUndefined();
		expect(queuedJob.ownerToken).toBeUndefined();
	});

	it("allows safe edit and reorder without displacing active head", async () => {
		store.setArmed(true);
		const job1 = await store.add(sampleJobInput({ text: "Job 1" }));
		const job2 = await store.add(sampleJobInput({ text: "Job 2" }));
		const job3 = await store.add(sampleJobInput({ text: "Job 3" }));

		store.edit(job2.id, { text: "Edited Job 2", model: "claude-3-5-haiku" });
		const edited = store.get(job2.id)!;
		expect(edited.text).toBe("Edited Job 2");
		expect(edited.model).toBe("claude-3-5-haiku");

		expect(() => store.edit(job2.id, { provider: "  " })).toThrow(/Provider cannot be empty/);
		expect(() => store.edit(job2.id, { model: "" })).toThrow(/Model cannot be empty/);

		store.move(job3.id, 1);
		expect(store.head()?.id).toBe(job3.id);
		const list = store.list();
		expect(list[0]?.id).toBe(job3.id);
		expect(list[1]?.id).toBe(job1.id);
		expect(list[2]?.id).toBe(job2.id);

		store.claim("session-1", 1234);

		expect(() => store.edit(job3.id, { text: "Cannot edit active" })).toThrow(/Cannot edit active/);
		expect(() => store.move(job3.id, 2)).toThrow(/Cannot move active/);
		expect(() => store.move(job1.id, 1)).toThrow(/Cannot move job to or before active head/);

		// Terminal jobs cannot be edited
		store.cancel(job2.id);
		expect(() => store.edit(job2.id, { text: "new text" })).toThrow(/Cannot edit terminal job/);
	});

	it("handles cancellation and retry lifecycle", async () => {
		store.setArmed(true);
		const job1 = await store.add(sampleJobInput({ text: "Pending job" }));
		const job2 = await store.add(sampleJobInput({ text: "Active job" }));

		store.cancel(job1.id);
		expect(store.get(job1.id)?.state).toBe("cancelled");

		store.retry(job1.id);
		expect(store.get(job1.id)?.state).toBe("queued");

		const claimed = store.claim("session-1", 1234)!;
		store.cancel(claimed.id);
		const activeJob = store.get(claimed.id)!;
		expect(activeJob.state).toBe("dispatching");
		expect(activeJob.cancelRequested).toBe(true);
		expect(activeJob.ownerPid).toBe(1234);
		store.updateOwned(claimed.id, claimed.ownerToken!, {
			state: "waiting",
			nextCheckAt: Date.now() + 86400_000,
		});
		expect(store.get(claimed.id)?.state).toBe("cancelled");
		expect(store.get(claimed.id)?.ownerToken).toBeUndefined();
		store.cancel(job2.id);

		// Cancel on completed job preserves completed
		const job3 = await store.add(sampleJobInput({ text: "Done job" }));
		const claimed3 = store.claim("session-1", 1234)!;
		store.updateOwned(job3.id, claimed3.ownerToken!, { state: "completed" });
		store.cancel(job3.id);
		expect(store.get(job3.id)?.state).toBe("completed");

		// Completed job cannot be retried
		expect(() => store.retry(job3.id)).toThrow(/Cannot retry completed job/);
	});

	it("manages advisory session registry and prevents clobbering live PIDs", () => {
		store.registerSession("session-1", "/tmp/session-1.json", process.pid);
		expect(store.sessionOwner("session-1")?.pid).toBe(process.pid);

		store.registerSession("session-1", "/tmp/session-1-renamed.json", process.pid);
		expect(store.sessionOwner("session-1")?.sessionFile).toBe("/tmp/session-1-renamed.json");

		store.registerSession("session-1", "/tmp/clobber.json", process.ppid);
		expect(store.sessionOwner("session-1")?.pid).toBe(process.pid);

		store.unregisterSession("session-1", process.pid);
		store.registerSession("session-1", "/tmp/dead.json", 9999999);
		store.registerSession("session-1", "/tmp/alive.json", process.pid);
		expect(store.sessionOwner("session-1")?.pid).toBe(process.pid);

		store.unregisterSession("session-1", process.pid);
		expect(store.sessionOwner("session-1")).toBeUndefined();
	});

	it("supports concurrent access from multiple store connections", async () => {
		const store2 = new OutboxStore(dbPath);
		try {
			store.setArmed(true);
			await store.add(sampleJobInput({ text: "Shared task" }));

			expect(store2.list()).toHaveLength(1);

			const claim1 = store.claim("session-1", 100);
			const claim2 = store2.claim("session-1", 200);

			expect(claim1).toBeDefined();
			expect(claim2).toBeUndefined();
		} finally {
			store2.close();
		}
	});

	it("publishes and queries session snapshots across multiple store connections", () => {
		const snapshot: OutboxSessionSnapshot = {
			sessionId: "session-snap-1",
			sessionFile: "/tmp/session-snap-1.jsonl",
			branchId: "branch-root",
			cwd: "/work/project-a",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			approvalMode: "write",
			sessionName: "Fix login button styling",
			activity: "Working",
			updatedAt: Date.now(),
			pid: process.pid,
		};

		store.publishSession(snapshot);

		// Immediate readback from same connection
		const sessions1 = store.sessions();
		expect(sessions1).toHaveLength(1);
		expect(sessions1[0]?.sessionId).toBe("session-snap-1");
		expect(sessions1[0]?.sessionName).toBe("Fix login button styling");
		expect(sessions1[0]?.activity).toBe("Working");
		expect(sessions1[0]?.pid).toBe(process.pid);
		expect(store.sessionOwner("session-snap-1")?.pid).toBe(process.pid);

		// Second connection sees same snapshot
		const store2 = new OutboxStore(dbPath);
		try {
			const sessions2 = store2.sessions();
			expect(sessions2).toHaveLength(1);
			expect(sessions2[0]?.sessionId).toBe("session-snap-1");
			expect(sessions2[0]?.activity).toBe("Working");

			// Update snapshot activity
			const updated = {
				...snapshot,
				activity: "read: Finding config",
				updatedAt: Date.now() + 100,
			};
			store2.publishSession(updated);

			const refreshed = store.sessions();
			expect(refreshed[0]?.activity).toBe("read: Finding config");
		} finally {
			store2.close();
		}

		// Unregister removes both registry and snapshot
		store.unregisterSession("session-snap-1", process.pid);
		expect(store.sessions()).toHaveLength(0);
		expect(store.sessionOwner("session-snap-1")).toBeUndefined();
	});

	it("preserves snapshot metadata across periodic registerSession calls", () => {
		const snapshot: OutboxSessionSnapshot = {
			sessionId: "session-keep-meta",
			sessionFile: "/tmp/session-keep-meta.jsonl",
			branchId: null,
			cwd: "/work/repo",
			provider: "openai",
			model: "gpt-4o",
			sessionName: "Active chat with title",
			activity: "Responding",
			updatedAt: Date.now(),
			pid: process.pid,
		};

		store.publishSession(snapshot);

		// Legacy 1s tick calls registerSession
		store.registerSession("session-keep-meta", "/tmp/session-keep-meta.jsonl", process.pid);

		const sessions = store.sessions();
		expect(sessions).toHaveLength(1);
		expect(sessions[0]?.sessionName).toBe("Active chat with title");
		expect(sessions[0]?.activity).toBe("Responding");
	});

	it("prevents stale or competing PIDs from clobbering live owner snapshot", () => {
		const liveSnapshot: OutboxSessionSnapshot = {
			sessionId: "session-pid-guard",
			sessionFile: "/tmp/session-pid-guard.jsonl",
			branchId: null,
			cwd: "/work/repo",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			sessionName: "Live Owner Chat",
			activity: "Idle",
			updatedAt: Date.now(),
			pid: process.pid,
		};
		store.publishSession(liveSnapshot);

		// Another PID (simulated via ppid or different PID) tries to publish for same sessionId
		const stalePid = process.ppid || 1;
		if (stalePid !== process.pid) {
			const competingSnapshot: OutboxSessionSnapshot = {
				...liveSnapshot,
				sessionName: "Intruder Chat",
				pid: stalePid,
			};
			store.publishSession(competingSnapshot);

			// Live owner snapshot must remain untouched
			const sessions = store.sessions();
			expect(sessions).toHaveLength(1);
			expect(sessions[0]?.sessionName).toBe("Live Owner Chat");
			expect(sessions[0]?.pid).toBe(process.pid);
		}

		// Dead PID overwrites when old owner PID is dead
		store.unregisterSession("session-pid-guard", process.pid);
		const deadSnapshot: OutboxSessionSnapshot = {
			...liveSnapshot,
			pid: 9999999,
		};
		store.publishSession(deadSnapshot);
		expect(store.sessions()[0]?.pid).toBe(9999999);

		// Live PID now reclaims it from dead PID
		store.publishSession(liveSnapshot);
		expect(store.sessions()[0]?.pid).toBe(process.pid);
		expect(store.sessions()).toHaveLength(1);
	});

	it("does not invent live metadata for legacy registrations or hide corrupt active reports", () => {
		store.publishSession({
			sessionId: "valid-session",
			sessionFile: "/tmp/valid.jsonl",
			branchId: null,
			cwd: "/work/valid",
			provider: "anthropic",
			model: "claude-3-7-sonnet",
			sessionName: "Valid Session",
			activity: "Idle",
			updatedAt: Date.now(),
			pid: process.pid,
		});

		// A process without telemetry must not appear idle or acquire fabricated model/cwd fields.
		store.registerSession("legacy-session", "/tmp/legacy-chat.jsonl", process.pid);
		expect(store.sessions().map(snapshot => snapshot.sessionId)).toEqual(["valid-session"]);
		store.registerSession("corrupt-session", "/tmp/corrupt.jsonl", process.pid);

		// Inject corrupted JSON directly into session_snapshots
		const rawDb = new Database(dbPath);
		try {
			rawDb.run("INSERT INTO session_snapshots (session_id, pid, updated_at, snapshot_json) VALUES (?, ?, ?, ?)", [
				"corrupt-session",
				process.pid,
				Date.now() + 50,
				"{not-valid-json!",
			]);
		} finally {
			rawDb.close();
		}

		expect(() => store.sessions()).toThrow();
	});
});
