import assert from "node:assert/strict";
import * as path from "node:path";
import { getAgentDir } from "@oh-my-pi/pi-utils";
import { closeDaemonClients, daemonClientForGlobal } from "../../src/launch/client";
import { ensureOutboxWorker, getOutboxStore } from "../../src/outbox/service";
import { outboxDbPath } from "../../src/outbox/store";
import { runOutboxWorker } from "../../src/outbox/worker";

const root = process.argv[2]!;
assert(root && path.isAbsolute(root));
assert(getAgentDir().startsWith(root + path.sep));
const gate = path.join(root, "release-worker");
if (process.argv[3] === "worker") {
	while (!(await Bun.file(gate).exists())) await Bun.sleep(20);
	await runOutboxWorker();
} else if (process.argv[3] === "ensure") {
	try {
		await ensureOutboxWorker();
	} finally {
		await closeDaemonClients();
	}
} else {
	const store = getOutboxStore();
	assert.equal(store.isArmed(), false);
	assert.deepEqual(store.list(), []);
	const broker = await daemonClientForGlobal(`outbox-${Bun.hash(path.resolve(outboxDbPath())).toString(16)}`);
	let contender: Bun.Subprocess | undefined;
	let release: NodeJS.Timeout | undefined;
	try {
		const started = await broker.request({
			op: "start",
			awaitReady: false,
			spec: {
				name: "outbox",
				application: process.execPath,
				args: [import.meta.path, root, "worker"],
				env: process.env,
				cwd: root,
				pty: false,
				restart: "no",
				persist: true,
				detached: true,
				ready: { log: "outbox: ready protocol=2", timeoutMs: 5000 },
			},
		});
		assert.equal(started.op, "start");
		if (started.op !== "start") throw new Error("Missing worker launch");
		assert.equal(started.daemon.state, "starting");
		contender = Bun.spawn([process.execPath, import.meta.path, root, "ensure"], {
			cwd: root,
			env: process.env,
			stdout: "inherit",
			stderr: "inherit",
		});
		release = setTimeout(() => void Bun.write(gate, "ready"), 1000);
		await ensureOutboxWorker();
		assert.equal(await contender.exited, 0);
		for (let check = 0; check < 2; check++) {
			await ensureOutboxWorker();
			const observed = await broker.request({ op: "describe", name: "outbox" });
			if (observed.op !== "describe") throw new Error("Missing worker snapshot");
			assert.equal(observed.daemon.state, "ready");
			assert.equal(observed.daemon.id, started.daemon.id, "must adopt, not replace, the launching worker");
			assert.equal(observed.daemon.pid, started.daemon.pid);
			assert.equal(observed.daemon.readyMatch, "outbox: ready protocol=2");
		}
		assert.equal(store.isArmed(), false);
		assert.deepEqual(store.list(), []);
		console.log("outbox-startup-smoke: PASS");
	} finally {
		if (release) clearTimeout(release);
		if (contender?.exitCode === null) {
			contender.kill("SIGKILL");
			await contender.exited;
		}
		await broker.request({ op: "stop", name: "outbox", timeoutMs: 5000 });
		await broker.request({ op: "shutdown" });
		await closeDaemonClients();
		store.close();
	}
}
