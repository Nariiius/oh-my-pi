import * as path from "node:path";
import * as readline from "node:readline";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { attachOutboxSession, enqueueOutbox } from "../../src/outbox/service";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";

const root = process.argv[2];
if (!root || !path.isAbsolute(root)) throw new Error("Expected isolated root directory");
const auth = await AuthStorage.create(path.join(root, "status-actor-auth.db"));
auth.keys.setRuntime("anthropic", "local-status-key");
const model = getBundledModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Missing fixture model");
const releaseTool = Promise.withResolvers<void>();
const tool: AgentTool = {
	name: "review_changes",
	label: "Review changes",
	description: "Local controlled activity fixture",
	parameters: { type: "object", properties: {} },
	execute: async (_id, _args, signal) => {
		console.log("status-actor: tool running");
		const abort = () => releaseTool.resolve();
		signal?.addEventListener("abort", abort, { once: true });
		try {
			await releaseTool.promise;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
		return { content: [{ type: "text", text: "Review complete" }] };
	},
};
const provider = createMockModel({
	responses: [
		{
			content: [{ type: "toolCall", id: "status-tool", name: tool.name, arguments: {} }],
			stopReason: "toolUse",
		},
		{ content: ["Finished local review"], stopReason: "stop" },
	],
});
const manager = SessionManager.create(root, path.join(root, "sessions"));
await manager.setSessionName("Background review chat", "user");
await manager.ensureOnDisk();
const session = new AgentSession({
	agent: new Agent({
		initialState: { model, tools: [tool], messages: [], systemPrompt: [] },
		getApiKey: () => "local-status-key",
		streamFn: provider.stream,
	}),
	sessionManager: manager,
	modelRegistry: new ModelRegistry(auth, path.join(root, "models.yml")),
	settings: Settings.isolated({
		"compaction.enabled": false,
		"todo.enabled": false,
		"retry.enabled": false,
	}),
});
attachOutboxSession(session);
await enqueueOutbox(session, {
	text: "Queued follow-up for the background review",
});
console.log(`status-actor: ready ${session.sessionId}`);
const input = readline.createInterface({ input: process.stdin });
let running: Promise<void> | undefined;
try {
	for await (const line of input) {
		if (line === "start" && !running)
			running = session.prompt("Run the controlled review").then(() => {
				console.log("status-actor: idle");
			});
		else if (line === "finish") releaseTool.resolve();
		else if (line === "quit") break;
	}
} finally {
	releaseTool.resolve();
	await running;
	input.close();
	await session.dispose();
	await manager.close();
	auth.close();
}
