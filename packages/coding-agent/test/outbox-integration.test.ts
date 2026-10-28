import { expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";

for (const [fixture, outcome] of [
	["outbox-live-smoke.ts", "outbox-live-smoke: PASS"],
	["outbox-closed-smoke.ts", "outbox-closed-smoke: PASS"],
	["outbox-startup-smoke.ts", "outbox-startup-smoke: PASS"],
] as const) {
	it(`exercises real outbox runtime: ${fixture}`, async () => {
		using root = TempDir.createSync("@omp-outbox-runtime-");
		const processHandle = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures", fixture), root.path()],
			{
				cwd: root.path(),
				env: {
					...process.env,
					HOME: path.join(root.path(), "home"),
					PI_CODING_AGENT_DIR: path.join(root.path(), "profile"),
					PI_TEST_SESSION_OWNERS_DIR: path.join(root.path(), "owners"),
				},
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const timer = setTimeout(() => processHandle.kill("SIGKILL"), 100_000);
		try {
			const [code, stdout, stderr] = await Promise.all([
				processHandle.exited,
				new Response(processHandle.stdout).text(),
				new Response(processHandle.stderr).text(),
			]);
			expect({ code, stderr: code === 0 ? "" : stderr }).toEqual({
				code: 0,
				stderr: "",
			});
			// Each process fixture asserts destination identity, single input persistence and execution ordering.
			expect(stdout).toContain(outcome);
		} finally {
			clearTimeout(timer);
			if (processHandle.exitCode === null) {
				processHandle.kill("SIGKILL");
				await processHandle.exited;
			}
		}
	}, 110_000);
}
