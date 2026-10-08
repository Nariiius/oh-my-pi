import { describe, expect, it } from "bun:test";
import { buildAnthropicHeaders } from "../src/providers/anthropic";

describe("gateway WAF headers (custom fork feature)", () => {
	it("injects User-Agent: pi-code for agentrouter gateway", () => {
		const headers = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://agentrouter.org/v1" });
		expect(headers["User-Agent"]).toBe("pi-code");
	});

	it("injects User-Agent: pi-code for gorouter gateway", () => {
		const headers = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://gorouter.app/v1" });
		expect(headers["User-Agent"]).toBe("pi-code");
	});

	it("injects User-Agent: pi-code for tabitoken and tokenforge gateways", () => {
		const headersTabi = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://tabitoken.com/v1" });
		expect(headersTabi["User-Agent"]).toBe("pi-code");

		const headersForge = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://tokenforge.ai.studio/v1" });
		expect(headersForge["User-Agent"]).toBe("pi-code");
	});

	it("does not inject User-Agent: pi-code for standard official Anthropic API", () => {
		const headers = buildAnthropicHeaders({ apiKey: "test-key", baseUrl: "https://api.anthropic.com" });
		expect(headers["User-Agent"]).toBeUndefined();
	});
});
