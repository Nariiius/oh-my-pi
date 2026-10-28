import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { attachOutboxSession, enqueueOutbox } from "../../src/outbox/service";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const root = process.argv[2]!;
const label = process.argv[3]!;
const auth = await AuthStorage.create(path.join(root, `auth-${label}.db`));
auth.keys.setRuntime("anthropic", "isolated-test-key");
// The quota endpoint and generation stream are the only scripted boundaries.
auth.health.model = async () => {
	const ready = fs.existsSync(path.join(root, "quota-ready"));
	return {
		state: ready ? "healthy" : "depleted",
		accounts: [
			{
				credentialId: 1,
				credentialType: "api_key",
				state: ready ? "healthy" : "depleted",
				resetsAt: Date.now() + 300,
				clearedAt: Date.now() + 300,
			},
		],
	};
};
const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
const mock = createMockModel({
	handler: context => {
		const request = context.messages.findLast(message => message.role === "user");
		fs.appendFileSync(
			path.join(root, "execution.jsonl"),
			`${JSON.stringify({ label, request: request?.content, at: Date.now() })}\n`,
		);
		return { content: [`Completed in chat ${label}.`], delayMs: 250 };
	},
});
const manager = SessionManager.create(root, path.join(root, "sessions"));
const agent = new Agent({
	getApiKey: () => "isolated-test-key",
	initialState: {
		model,
		systemPrompt: ["Local deterministic outbox exercise."],
		tools: [],
	},
	streamFn: mock.stream,
});
const session = new AgentSession({
	agent,
	sessionManager: manager,
	modelRegistry: registry,
	settings: Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
		"retry.modelFallback": false,
	}),
});
await manager.ensureOnDisk();
attachOutboxSession(session);
const job = await enqueueOutbox(session, {
	text: `Task ${label}: perform the queued action.`,
});
fs.writeFileSync(
	path.join(root, `ready-${label}.json`),
	JSON.stringify({
		jobId: job.id,
		sessionId: manager.getSessionId(),
		sessionFile: manager.getSessionFile(),
	}),
);
const keepalive = setInterval(() => {}, 1000);
const stop = async (): Promise<void> => {
	clearInterval(keepalive);
	await session.dispose();
	await manager.close();
	auth.close();
	process.exit(0);
};
process.on("SIGTERM", () => void stop());
process.on("SIGINT", () => void stop());
