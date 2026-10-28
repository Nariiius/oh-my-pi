import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { TempDir } from "@oh-my-pi/pi-utils";
import { refreshDirsFromEnv } from "@oh-my-pi/pi-utils/dirs";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { closeDaemonClients, daemonClientForGlobal } from "../src/launch/client";
import { describeDaemon } from "../src/launch/ensure";
import { armOutboxResume, getOutboxStore } from "../src/outbox/service";
import { outboxDbPath } from "../src/outbox/store";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

for (const blockedMessage of [false, true])
	it(`resumes another live chat after quota returns ${blockedMessage ? "past an interrupted message" : "from an empty outbox"}`, async () => {
		using root = TempDir.createSync("@omp-outbox-resume-runtime-");
		const previousDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = path.join(root.path(), "profile");
		refreshDirsFromEnv();
		const store = getOutboxStore();
		const auth = await AuthStorage.create(path.join(root.path(), "controller-auth.db"));
		const manager = SessionManager.create(root.path(), path.join(root.path(), "controller-sessions"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing fixture model");
		const controller = new AgentSession({
			agent: new Agent({
				initialState: { model, tools: [], messages: [], systemPrompt: [] },
				streamFn: createMockModel({
					handler: () => {
						throw new Error("Controller must not generate");
					},
				}).stream,
			}),
			sessionManager: manager,
			modelRegistry: new ModelRegistry(auth, path.join(root.path(), "models.yml")),
			settings: Settings.isolated({
				"retry.enabled": false,
				"todo.enabled": false,
				"compaction.enabled": false,
			}),
		});
		const child = Bun.spawn(
			[process.execPath, path.join(import.meta.dir, "fixtures/outbox-resume-actor.ts"), root.path()],
			{
				cwd: root.path(),
				env: {
					...process.env,
					HOME: path.join(root.path(), "home"),
					PI_TEST_SESSION_OWNERS_DIR: path.join(root.path(), "owners"),
				},
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
			},
		);
		const output = new Response(child.stdout).text();
		const errors = new Response(child.stderr).text();
		const deadline = setTimeout(() => child.kill("SIGKILL"), 45_000);
		async function until(predicate: () => boolean): Promise<void> {
			const expires = Date.now() + 20_000;
			while (!predicate()) {
				if (child.exitCode !== null) throw new Error(await errors);
				if (Date.now() > expires) throw new Error(`Timed out: ${JSON.stringify(store.list())}`);
				// This integration verifies real process heartbeats and supervised worker wakeups.
				await Bun.sleep(50);
			}
		}
		try {
			await until(() => store.sessions().some(snapshot => !!snapshot.lastUserEntryId));
			expect(store.list()).toEqual([]);
			const destination = store.sessions().find(snapshot => !!snapshot.lastUserEntryId);
			if (!destination) throw new Error("Missing actor destination");
			const legacyBroker = await daemonClientForGlobal(
				`outbox-${Bun.hash(path.resolve(outboxDbPath())).toString(16)}`,
			);
			const legacy = await legacyBroker.request({
				op: "start",
				spec: {
					name: "outbox",
					application: process.execPath,
					args: [
						"-e",
						'console.log("outbox: ready protocol=2"); setInterval(() => {}, 3600000); process.on("SIGTERM", () => process.exit(0));',
					],
					env: {},
					cwd: root.path(),
					pty: false,
					restart: "no",
					persist: true,
					detached: true,
					ready: { log: "outbox: ready protocol=2", timeoutMs: 5000 },
				},
			});
			expect(legacy.op === "start" && legacy.daemon.state === "ready").toBe(true);
			let blockedId: string | undefined;
			if (blockedMessage) {
				await manager.ensureOnDisk();
				const blocked = await store.add({
					sessionId: controller.sessionId,
					sessionFile: manager.getSessionFile()!,
					branchId: manager.getLeafId(),
					cwd: root.path(),
					provider: model.provider,
					model: model.id,
					text: "Previously interrupted work",
				});
				blockedId = blocked.id;
				store.setArmed(true);
				const claimed = store.claim(blocked.sessionId, process.pid)!;
				store.updateOwned(claimed.id, claimed.ownerToken!, {
					state: "attention",
					reason: "Execution aborted by manual operator interrupt (paused)",
				});
			}
			const job = await armOutboxResume(controller, destination);
			await until(() => store.get(job.id)?.nextCheckAt !== undefined);
			expect(store.get(job.id)).toMatchObject({
				kind: "resume",
				state: "watching",
				sessionId: destination.sessionId,
			});
			expect(Bun.JSONL.parse(fs.readFileSync(path.join(root.path(), "attempts.jsonl"), "utf8"))).toEqual([
				{ attempt: 1, userMessages: 1 },
			]);
			const duplicate = await armOutboxResume(controller, destination);
			expect(duplicate.id).toBe(job.id);
			child.stdin.write("reset\n");
			await until(() => store.get(job.id)?.state === "completed");
			expect(Bun.JSONL.parse(fs.readFileSync(path.join(root.path(), "attempts.jsonl"), "utf8"))).toEqual([
				{ attempt: 1, userMessages: 1 },
				{ attempt: 2, userMessages: 1 },
			]);
			expect(controller.messages).toEqual([]);
			if (blockedId) expect(store.get(blockedId)?.state).toBe("attention");
		} finally {
			clearTimeout(deadline);
			store.setArmed(false);
			child.stdin.write("quit\n");
			child.stdin.end();
			const kill = setTimeout(() => child.kill("SIGKILL"), 5000);
			try {
				await child.exited;
			} finally {
				clearTimeout(kill);
			}
			await output;
			await errors;
			const broker = await daemonClientForGlobal(`outbox-${Bun.hash(path.resolve(outboxDbPath())).toString(16)}`);
			try {
				const worker = await describeDaemon(broker, "outbox", "Outbox test cleanup");
				if (worker.status === "found") {
					await broker.request({ op: "stop", name: "outbox", id: worker.daemon.id, timeoutMs: 5000 });
				}
				await broker.request({ op: "shutdown" });
			} finally {
				await closeDaemonClients();
			}
			await controller.dispose();
			await manager.close();
			auth.close();
			store.close();
			if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousDir;
			refreshDirsFromEnv();
		}
	}, 60_000);
