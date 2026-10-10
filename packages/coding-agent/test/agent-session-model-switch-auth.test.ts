import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model, type OAuthCredential } from "@oh-my-pi/pi-ai";
import { registerOAuthProvider, unregisterOAuthProviders } from "@oh-my-pi/pi-ai/oauth";
import type { OAuthProviderId } from "@oh-my-pi/pi-ai/oauth/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// API-key switches stay deferred; OAuth switches select the account before redraw.
describe("AgentSession model switch auth pre-flight", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;
	const spies: Array<{ mockRestore: () => void }> = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-model-switch-auth-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		registry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		for (const spy of spies.splice(0)) spy.mockRestore();
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	function modelOrThrow(id: string): Model<Api> {
		const model = getBundledModel("anthropic", id);
		if (!model) throw new Error(`Expected anthropic model ${id} to exist`);
		return model;
	}

	function makeSession(initialModel: Model<Api>, roles?: Record<string, string>): AgentSession {
		const settings = Settings.isolated();
		if (roles) {
			for (const role in roles) settings.setModelRole(role, roles[role]);
		}
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		return session;
	}

	it("switches the active model via the synchronous auth check, not the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth");
		spies.push(getApiKeySpy, hasAuthSpy);

		await s.setModel(to);

		expect(s.model?.id).toBe(to.id);
		expect(hasAuthSpy).toHaveBeenCalled();
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("cycles role models without invoking the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const slow = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from, {
			default: `${from.provider}/${from.id}`,
			slow: `${slow.provider}/${slow.id}`,
		});

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		const result = await s.cycleRoleModels(["default", "slow"]);

		expect(result?.role).toBe("slow");
		expect(result?.model?.id).toBe(slow.id);
		expect(s.model?.id).toBe(slow.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("temporary switch also avoids the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		spies.push(getApiKeySpy);

		await s.setModelTemporary(to);

		expect(s.model?.id).toBe(to.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("rejects the switch synchronously when no credential is configured, without calling the resolver", async () => {
		const from = modelOrThrow("claude-sonnet-4-5");
		const to = modelOrThrow("claude-sonnet-4-6");
		const s = makeSession(from);

		const getApiKeySpy = spyOn(registry, "getApiKey");
		const hasAuthSpy = spyOn(registry, "hasConfiguredAuth").mockReturnValue(false);
		spies.push(getApiKeySpy, hasAuthSpy);

		await expect(s.setModel(to)).rejects.toThrow(/No API key/);
		expect(s.model?.id).toBe(from.id);
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});
});

const OAUTH_SWITCH_SOURCE = "agent-session-model-switch-auth";
const OAUTH_SWITCH_PROVIDER = "model-switch-oauth" as OAuthProviderId;

function oauthCredential(accountId: string): OAuthCredential {
	return {
		type: "oauth",
		access: `${accountId}-access`,
		refresh: `${accountId}-refresh`,
		expires: Date.now() + 3_600_000,
		accountId,
		email: `${accountId}@example.test`,
	};
}

function oauthModel(id: string, accountId: string): Model<Api> {
	const base = getBundledModel("anthropic", "claude-sonnet-4-6");
	if (!base) throw new Error("Expected bundled anthropic model");
	return {
		...base,
		provider: OAUTH_SWITCH_PROVIDER,
		id,
		name: id,
		accountAccess: { [accountId]: {} },
	};
}

describe("AgentSession OAuth account refresh on model switch", () => {
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		registerOAuthProvider({
			id: OAUTH_SWITCH_PROVIDER,
			name: OAUTH_SWITCH_PROVIDER,
			sourceId: OAUTH_SWITCH_SOURCE,
			async login() {
				throw new Error("login is not used");
			},
			getApiKey: credential => credential.access,
		});
		authStorage = await AuthStorage.create(":memory:");
		await authStorage.credentials.set(OAUTH_SWITCH_PROVIDER, [
			oauthCredential("account-a"),
			oauthCredential("account-b"),
		]);
		registry = new ModelRegistry(authStorage, undefined, { ignoreLocalModelConfig: true });
	});

	afterAll(() => {
		unregisterOAuthProviders(OAUTH_SWITCH_SOURCE);
		authStorage.close();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
			session = undefined;
		}
	});

	function makeSession(initialModel: Model<Api>): AgentSession {
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: registry,
		});
		return session;
	}

	it("selects the account that serves the new model before the status line reads it", async () => {
		const from = oauthModel("model-a", "account-a");
		const to = oauthModel("model-b", "account-b");
		const s = makeSession(from);
		const getApiKeySpy = spyOn(registry, "getApiKey");

		await authStorage.oauth.access(OAUTH_SWITCH_PROVIDER, s.sessionId, {
			modelId: from.id,
			accountIds: ["account-a"],
		});
		expect(authStorage.oauth.identity(OAUTH_SWITCH_PROVIDER, s.sessionId)?.accountId).toBe("account-a");

		let identityAtModelChange: string | undefined;
		const unsubscribe = s.subscribe(event => {
			if (event.type !== "model_changed") return;
			identityAtModelChange = authStorage.oauth.identity(OAUTH_SWITCH_PROVIDER, s.sessionId)?.accountId;
		});
		try {
			await s.setModel(to);
		} finally {
			unsubscribe();
			getApiKeySpy.mockRestore();
		}

		expect(s.model?.id).toBe(to.id);
		expect(identityAtModelChange).toBe("account-b");
		expect(authStorage.oauth.identity(OAUTH_SWITCH_PROVIDER, s.sessionId)?.accountId).toBe("account-b");
		expect(getApiKeySpy).not.toHaveBeenCalled();
	});

	it("keeps the current model when OAuth account selection fails", async () => {
		const from = oauthModel("model-a", "account-a");
		const to = oauthModel("model-b", "account-b");
		const s = makeSession(from);
		await authStorage.oauth.access(OAUTH_SWITCH_PROVIDER, s.sessionId, {
			modelId: from.id,
			accountIds: ["account-a"],
		});
		const accessSpy = spyOn(authStorage.oauth, "access").mockRejectedValue(new Error("oauth selection failed"));

		try {
			await expect(s.setModel(to)).rejects.toThrow("oauth selection failed");
		} finally {
			accessSpy.mockRestore();
		}

		expect(s.model?.id).toBe(from.id);
		expect(authStorage.oauth.identity(OAUTH_SWITCH_PROVIDER, s.sessionId)?.accountId).toBe("account-a");
	});
});
