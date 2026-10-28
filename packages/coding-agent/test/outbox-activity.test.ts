import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import { TempDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { isOutboxSessionLive, sanitizeActivityText, snapshotOutboxSession } from "../src/outbox/activity";
import type { OutboxSessionSnapshot } from "../src/outbox/types";
import { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";

describe("outbox activity metadata", () => {
	let root: TempDir;
	let manager: SessionManager;
	let auth: AuthStorage;
	let session: AgentSession;
	beforeEach(async () => {
		root = TempDir.createSync("@omp-outbox-activity-");
		manager = SessionManager.create(root.path(), path.join(root.path(), "sessions"));
		auth = await AuthStorage.create(path.join(root.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing fixture model");
		session = new AgentSession({
			agent: new Agent({
				initialState: { model, tools: [], messages: [], systemPrompt: [] },
				streamFn: createMockModel().stream,
			}),
			sessionManager: manager,
			modelRegistry: new ModelRegistry(auth, path.join(root.path(), "models.yml")),
			settings: Settings.isolated({
				"compaction.enabled": false,
				"todo.enabled": false,
			}),
		});
	});
	afterEach(async () => {
		await session.dispose();
		await manager.close();
		auth.close();
		await root.remove();
	});

	it("never represents dead, stale, or far-future reports as current activity", () => {
		const now = Date.now();
		const snapshot: OutboxSessionSnapshot = {
			...snapshotOutboxSession(session),
			updatedAt: now - 5000,
		};
		expect(isOutboxSessionLive(snapshot, now)).toBe(true);
		expect(isOutboxSessionLive({ ...snapshot, updatedAt: now - 16000 }, now)).toBe(false);
		expect(isOutboxSessionLive({ ...snapshot, pid: 99999999 }, now)).toBe(false);
		expect(isOutboxSessionLive({ ...snapshot, updatedAt: now + 2000 }, now)).toBe(true);
		expect(isOutboxSessionLive({ ...snapshot, updatedAt: now + 10000 }, now)).toBe(false);
	});

	it("keeps untrusted titles and intent descriptions on one bounded display row", () => {
		const clean = sanitizeActivityText(`\u001b[2J\u0000command\r\n\t${"配置".repeat(100)}`, 40);
		expect([...clean].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)).toBe(false);
		expect(visibleWidth(clean)).toBeLessThanOrEqual(40);
	});

	it("uses the conversation subject until an explicit live title is set", async () => {
		manager.appendMessage({
			role: "user",
			content: "Review authentication changes",
			timestamp: Date.now(),
		});
		const original = snapshotOutboxSession(session);
		expect(original.sessionName).toBe("Review authentication changes");
		await manager.setSessionName("Authentication review", "user");
		const renamed = snapshotOutboxSession(session);
		expect(renamed.sessionName).toBe("Authentication review");
		expect(renamed.sessionId).toBe(original.sessionId);
		expect(renamed.model).toBe(original.model);
	});
});
