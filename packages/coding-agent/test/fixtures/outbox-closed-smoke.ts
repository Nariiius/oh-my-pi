import assert from "node:assert/strict";
import * as path from "node:path";
import { CredentialHealth } from "@oh-my-pi/pi-ai/auth/health";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { OutboxStore } from "../../src/outbox/store";
import type { OutboxJob } from "../../src/outbox/types";
import { runOutboxWorker } from "../../src/outbox/worker";
import { SessionManager } from "../../src/session/session-manager";

const root = process.argv[2]!;
assert(root && path.isAbsolute(root));
assert(getAgentDir().startsWith(root + path.sep));
// Only quota telemetry is substituted; generation uses the real SDK and a loopback HTTP server.
CredentialHealth.prototype.model = async () => ({
	state: "healthy",
	accounts: [{ credentialId: 1, credentialType: "api_key", state: "healthy" }],
});
const calls: string[] = [];
const releaseSlow = Promise.withResolvers<void>();
let slowStarted = false;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		if (request.method === "GET") return Response.json({ data: [{ id: "queue", object: "model" }] });
		const body = await request.json();
		assert(body !== null && typeof body === "object" && "messages" in body && Array.isArray(body.messages));
		calls.push(
			JSON.stringify(
				body.messages.findLast(
					(message: unknown) =>
						message !== null && typeof message === "object" && "role" in message && message.role === "user",
				)?.content,
			),
		);
		const requestIndex = calls.length;
		if (calls[requestIndex - 1]!.includes("Resume slow")) {
			slowStarted = true;
			await releaseSlow.promise;
		}
		const base = {
			id: `smoke-${requestIndex}`,
			object: "chat.completion.chunk",
			model: "queue",
			created: Math.floor(Date.now() / 1000),
		};
		return new Response(
			[
				`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Closed chat task completed." }, finish_reason: null }] })}\n\n`,
				`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
				"data: [DONE]\n\n",
			].join(""),
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});
await Bun.write(
	path.join(getAgentDir(), "models.yml"),
	JSON.stringify({
		providers: {
			"outbox-smoke": {
				api: "openai-completions",
				baseUrl: `http://127.0.0.1:${server.port}/v1`,
				apiKey: "isolated-test-key",
				models: [
					{
						id: "queue",
						name: "Queue smoke",
						contextWindow: 200000,
						maxTokens: 8192,
						input: ["text"],
						reasoning: false,
					},
				],
			},
		},
	}),
);
const store = new OutboxStore();
const originalIds: string[] = [];
for (const label of ["A", "B"]) {
	const manager = SessionManager.create(root, path.join(root, "sessions"));
	manager.appendMessage({
		role: "user",
		content: `Original context ${label}`,
		timestamp: Date.now(),
	});
	await manager.ensureOnDisk();
	originalIds.push(manager.getSessionId());
	await store.add({
		text: `Closed task ${label}`,
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile()!,
		branchId: manager.getLeafId(),
		cwd: root,
		provider: "outbox-smoke",
		model: "queue",
		approvalMode: "always-ask",
	});
	await manager.close();
}
store.setArmed(true);
const stopWorker = new AbortController();
const worker = runOutboxWorker(stopWorker.signal);
try {
	const deadline = Date.now() + 60_000;
	while (!store.list().every(job => job.state === "completed")) {
		assert(!store.list().some(job => job.state === "attention"), JSON.stringify(store.list()));
		assert(Date.now() < deadline, `Closed worker timed out: ${JSON.stringify(store.list())}`);
		// Real worker and network integration: the coordinator's platform timer is intentionally exercised.
		await Bun.sleep(100);
	}
	assert.equal(calls.length, 2);
	assert(calls[0]!.includes("Closed task A") && calls[1]!.includes("Closed task B"));
	const jobs = store.list();
	for (let i = 0; i < jobs.length; i++) {
		const manager = await SessionManager.open(jobs[i]!.sessionFile, undefined, undefined, { throwIfMissing: true });
		assert.equal(manager.getSessionId(), originalIds[i]);
		assert.equal(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").length,
			2,
		);
		await manager.close();
	}
	store.setArmed(false);
	const blockedManager = SessionManager.create(root, path.join(root, "sessions"));
	await blockedManager.ensureOnDisk();
	const blocked = await store.add({
		text: "Previously interrupted message",
		sessionId: blockedManager.getSessionId(),
		sessionFile: blockedManager.getSessionFile()!,
		branchId: blockedManager.getLeafId(),
		cwd: root,
		provider: "outbox-smoke",
		model: "queue",
	});
	await blockedManager.close();
	store.setArmed(true);
	const blockedClaim = store.claim(blocked.sessionId, process.pid)!;
	store.updateOwned(blocked.id, blockedClaim.ownerToken!, { state: "attention", reason: "Manual interrupt" });
	store.setArmed(false);
	const watches: OutboxJob[] = [];
	for (const label of ["slow", "fast"]) {
		const manager = SessionManager.create(root, path.join(root, "sessions"));
		const userId = manager.appendMessage({ role: "user", content: `Resume ${label}`, timestamp: Date.now() });
		manager.appendMessage({
			role: "assistant",
			api: "openai-completions",
			provider: "outbox-smoke",
			model: "queue",
			content: [],
			stopReason: "error",
			errorMessage: "429 usage limit reached",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		});
		await manager.ensureOnDisk();
		watches.push(
			await store.add({
				kind: "resume",
				resumeUserEntryId: userId,
				branchId: userId,
				text: "",
				sessionId: manager.getSessionId(),
				sessionFile: manager.getSessionFile()!,
				cwd: root,
				provider: "outbox-smoke",
				model: "queue",
				approvalMode: "always-ask",
			}),
		);
		await manager.close();
	}
	const [slow, fast] = watches;
	assert(slow && fast);
	store.setArmed(true);
	const resumeDeadline = Date.now() + 60_000;
	while (store.get(fast.id)?.state !== "completed") {
		assert(!watches.some(job => store.get(job.id)?.state === "attention"), JSON.stringify(store.list()));
		assert(Date.now() < resumeDeadline, `Independent closed resume timed out: ${JSON.stringify(store.list())}`);
		await Bun.sleep(50);
	}
	assert(slowStarted, "Both closed chats must start without waiting for the other to finish");
	assert.equal(store.get(slow.id)?.state, "running");
	assert.equal(store.get(blocked.id)?.state, "attention");
	releaseSlow.resolve();
	while (store.get(slow.id)?.state !== "completed") {
		assert(Date.now() < resumeDeadline, "Slow resume failed to complete");
		await Bun.sleep(50);
	}
	assert.equal(calls.length, 4);
	for (const watch of watches) {
		const manager = await SessionManager.open(watch.sessionFile, undefined, undefined, { throwIfMissing: true });
		assert.equal(manager.getSessionId(), watch.sessionId);
		assert.equal(
			manager.getEntries().filter(entry => entry.type === "message" && entry.message.role === "user").length,
			1,
		);
		await manager.close();
	}
	console.log(
		"outbox-closed-smoke: PASS — ordered messages plus concurrent closed-chat resumes past an interrupted head; original IDs and single input preserved",
	);
} finally {
	releaseSlow.resolve();
	store.setArmed(false);
	stopWorker.abort();
	await worker;
	server.stop(true);
	store.close();
}
