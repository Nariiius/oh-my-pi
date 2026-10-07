import { describe, expect, it } from "bun:test";
import { buildAnthropicHeaders } from "../src/providers/anthropic";
import type { Model } from "../src/types";

function createMockModel(provider: string, baseUrl?: string): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4-5",
		name: "Claude Sonnet",
		api: "anthropic-messages",
		provider,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8192,
	};
}

describe("gateway WAF headers (custom fork feature)", () => {
	it("injects User-Agent: pi-code for agentrouter gateway", () => {
		const model = createMockModel("agentrouter", "https://agentrouter.org/v1");
		const headers = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://agentrouter.org/v1" }, model);
		expect(headers["User-Agent"]).toBe("pi-code");
	});

	it("injects User-Agent: pi-code for gorouter gateway", () => {
		const model = createMockModel("gorouter", "https://gorouter.app/v1");
		const headers = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://gorouter.app/v1" }, model);
		expect(headers["User-Agent"]).toBe("pi-code");
	});

	it("injects User-Agent: pi-code for tabitoken and tokenforge gateways", () => {
		const modelTabi = createMockModel("tabitoken", "https://tabitoken.com/v1");
		const headersTabi = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://tabitoken.com/v1" }, modelTabi);
		expect(headersTabi["User-Agent"]).toBe("pi-code");

		const modelForge = createMockModel("tokenforge", "https://tokenforge.ai.studio/v1");
		const headersForge = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://tokenforge.ai.studio/v1" }, modelForge);
		expect(headersForge["User-Agent"]).toBe("pi-code");
	});

	it("does not inject User-Agent: pi-code for standard official Anthropic API", () => {
		const model = createMockModel("anthropic", "https://api.anthropic.com");
		const headers = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" }, model);
		expect(headers["User-Agent"]).toBeUndefined();
	});
});
