import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { closeDaemonClients, daemonClientForGlobal } from "../../src/launch/client";
import { startOutbox } from "../../src/outbox/service";
import { OutboxStore, outboxDbPath } from "../../src/outbox/store";
import { SessionManager } from "../../src/session/session-manager";

const root = process.argv[2]!;
assert(root && path.isAbsolute(root), "Pass an isolated absolute smoke directory");
assert(getAgentDir().startsWith(root + path.sep), "PI_CODING_AGENT_DIR must be inside the smoke directory");
const store = new OutboxStore();
const children: Bun.Subprocess[] = [];
const ready: { jobId: string; sessionId: string; sessionFile: string }[] = [];
async function until(predicate: () => boolean, label: string, timeout = 30_000): Promise<void> {
	const deadline = Date.now() + timeout;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}; queue=${JSON.stringify(store.list())}`);
		await Bun.sleep(100);
	}
}
try {
	for (const label of ["A", "B", "C"]) {
		const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "outbox-live-agent.ts"), root, label], {
			cwd: root,
			env: process.env,
			stdout: "ignore",
			stderr: Bun.file(path.join(root, `${label}.stderr`)),
		});
		children.push(child);
		const file = path.join(root, `ready-${label}.json`);
		await until(() => fs.existsSync(file), `${label} register and enqueue`);
		ready.push(await Bun.file(file).json());
	}
	assert.equal(store.list().length, 3);
	store.move(ready[2]!.jobId, 1);
	await startOutbox();
	await until(() => store.get(ready[2]!.jobId)?.state === "waiting", "head blocked on quota");
	assert(!fs.existsSync(path.join(root, "execution.jsonl")), "No generation request is allowed while exhausted");
	assert.equal(store.get(ready[0]!.jobId)?.state, "queued");
	assert.equal(store.get(ready[1]!.jobId)?.state, "queued");
	await Bun.write(path.join(root, "quota-ready"), "available");
	await until(() => store.list().every(job => job.state === "completed"), "all messages finish", 60_000);
	const calls = Bun.JSONL.parse(await Bun.file(path.join(root, "execution.jsonl")).text()) as {
		label: string;
		request: unknown;
	}[];
	assert.deepEqual(
		calls.map(call => call.label),
		["C", "A", "B"],
	);
	for (const entry of ready) {
		const manager = await SessionManager.open(entry.sessionFile, undefined, undefined, {
			throwIfMissing: true,
			suppressBreadcrumb: true,
		});
		assert.equal(manager.getSessionId(), entry.sessionId);
		assert.equal(
			manager.getEntries().filter(item => item.type === "message" && item.message.role === "user").length,
			1,
		);
		await manager.close();
	}
	console.log(
		"outbox-live-smoke: PASS — 3 real processes; no sends while exhausted; C → A → B; original chats; one user message each",
	);
} catch (error) {
	console.error(error);
	throw error;
} finally {
	store.setArmed(false);
	for (const child of children) child.kill("SIGTERM");
	await Promise.all(
		children.map(async child => {
			const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
			try {
				await child.exited;
			} finally {
				clearTimeout(timer);
			}
		}),
	);
	const broker = await daemonClientForGlobal(`outbox-${Bun.hash(path.resolve(outboxDbPath())).toString(16)}`);
	try {
		await broker.request({ op: "stop", name: "outbox", timeoutMs: 5_000 });
		await broker.request({ op: "shutdown" });
	} catch (error) {
		console.error(`Isolated outbox broker cleanup failed: ${String(error)}`);
	}
	await closeDaemonClients();
	store.close();
}
