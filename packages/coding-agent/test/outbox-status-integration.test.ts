import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { OutboxStore } from "../src/outbox/store";
import type { OutboxSessionSnapshot } from "../src/outbox/types";

it("reports live tool activity from another process and removes it on shutdown", async () => {
	using root = TempDir.createSync("@omp-outbox-status-");
	const profile = path.join(root.path(), "profile");
	const store = new OutboxStore(path.join(profile, "outbox", "outbox.db"));
	const child = Bun.spawn(
		[process.execPath, path.join(import.meta.dir, "fixtures/outbox-status-actor.ts"), root.path()],
		{
			cwd: root.path(),
			env: {
				...process.env,
				HOME: path.join(root.path(), "home"),
				PI_CODING_AGENT_DIR: profile,
				PI_TEST_SESSION_OWNERS_DIR: path.join(root.path(), "owners"),
			},
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const output = new Response(child.stdout).text();
	const errors = new Response(child.stderr).text();
	const deadline = setTimeout(() => child.kill("SIGKILL"), 20_000);
	async function until(
		predicate: (snapshot: OutboxSessionSnapshot | undefined) => boolean,
	): Promise<OutboxSessionSnapshot | undefined> {
		const stopAt = Date.now() + 8_000;
		while (Date.now() < stopAt) {
			const current = store.sessions()[0];
			if (predicate(current)) return current;
			if (child.exitCode !== null) throw new Error(await errors);
			// Exercise the cross-process heartbeat rather than replacing its platform timer.
			await Bun.sleep(50);
		}
		throw new Error(`Activity did not settle: ${JSON.stringify(store.sessions())}`);
	}
	try {
		const idle = await until(snapshot => snapshot?.sessionName === "Background review chat");
		expect(idle?.pid).toBe(child.pid);
		child.stdin.write("start\n");
		const busy = await until(snapshot => snapshot?.activity.includes("review_changes") === true);
		expect(busy?.sessionId).toBe(idle?.sessionId);
		expect(busy?.activity).not.toBe(idle?.activity);
		expect(store.list()[0]?.state).toBe("queued");
		child.stdin.write("finish\n");
		await until(
			snapshot =>
				snapshot?.activity === idle?.activity &&
				snapshot !== undefined &&
				snapshot.updatedAt >= (busy?.updatedAt ?? 0),
		);
		child.stdin.write("quit\n");
		child.stdin.end();
		expect(await child.exited).toBe(0);
		expect(store.sessions()).toEqual([]);
	} finally {
		clearTimeout(deadline);
		if (child.exitCode === null) {
			child.kill("SIGKILL");
			await child.exited;
		}
		await output;
		await errors;
		store.close();
	}
}, 25_000);
