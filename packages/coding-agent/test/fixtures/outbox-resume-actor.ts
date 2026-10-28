import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { attachOutboxSession } from "../../src/outbox/service";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("Pass an isolated absolute fixture directory");
const auth = await AuthStorage.create(path.join(root, "actor-auth.db"));
auth.keys.setRuntime("anthropic", "local-resume-key");
auth.health.model = async () => {
	const available = fs.existsSync(path.join(root, "quota-restored"));
	return {
		state: available ? "healthy" : "depleted",
		accounts: [
			{
				credentialId: 1,
				credentialType: "api_key",
				state: available ? "healthy" : "depleted",
				clearedAt: Date.now() + 2000,
				resetsAt: Date.now() + 2000,
			},
		],
	};
};
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Missing fixture model");
let attempts = 0;
const provider = createMockModel({
	handler: context => {
		attempts++;
		fs.appendFileSync(
			path.join(root, "attempts.jsonl"),
			`${JSON.stringify({ attempt: attempts, userMessages: context.messages.filter(message => message.role === "user").length })}\n`,
		);
		return attempts === 1
			? {
					throw: "429 usage limit reached. Your limit will reset in 13 minutes. retry-after-ms=780000",
				}
			: {
					content: ["The earlier task resumed and finished."],
					stopReason: "stop",
				};
	},
});
const manager = SessionManager.create(root, path.join(root, "sessions"));
await manager.setSessionName("Quota interrupted chat", "user");
const session = new AgentSession({
	agent: new Agent({
		initialState: { model, systemPrompt: [], tools: [], messages: [] },
		getApiKey: () => "local-resume-key",
		streamFn: provider.stream,
	}),
	sessionManager: manager,
	modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
	settings: Settings.isolated({
		"retry.enabled": false,
		"retry.modelFallback": false,
		"retry.usageAwareFallback": false,
		"compaction.enabled": false,
		"todo.enabled": false,
	}),
});
await session.prompt("Finish the task I started before the quota limit.");
attachOutboxSession(session);
await Bun.write(
	path.join(root, "actor-ready.json"),
	JSON.stringify({
		sessionId: session.sessionId,
		sessionFile: manager.getSessionFile(),
	}),
);
console.log(`resume-actor: ready ${session.sessionId}; native retry disabled`);
const input = readline.createInterface({ input: process.stdin });
try {
	for await (const line of input) {
		if (line === "reset") await Bun.write(path.join(root, "quota-restored"), "available");
		if (line === "quit") break;
	}
} finally {
	input.close();
	await session.dispose();
	await manager.close();
	auth.close();
}
