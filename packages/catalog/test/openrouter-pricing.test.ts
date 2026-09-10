import { describe, expect, it } from "bun:test";
import { calculateCost, estimateProxyCacheUsage } from "../src/models";
import { getOpenRouterModelCost } from "../src/openrouter-pricing";
import type { Model, Usage } from "../src/types";

describe("OpenRouter live pricing resolution", () => {
	it("resolves direct API pricing for Claude Opus variants", () => {
		const opus46 = getOpenRouterModelCost("claude-4.6-opus-high");
		expect(opus46).not.toBeNull();
		expect(opus46?.input).toBe(5);
		expect(opus46?.output).toBe(25);
		expect(opus46?.cacheRead).toBe(0.5);
		expect(opus46?.cacheWrite).toBe(6.25);

		const opus47 = getOpenRouterModelCost("claude-opus-4-7-high");
		expect(opus47).not.toBeNull();
		expect(opus47?.input).toBe(5);
		expect(opus47?.output).toBe(25);

		const opus5 = getOpenRouterModelCost("claude-opus-5-high");
		expect(opus5).not.toBeNull();
		expect(opus5?.input).toBe(5);
		expect(opus5?.output).toBe(25);
	});

	it("resolves direct API pricing for Claude Sonnet variants", () => {
		const sonnet45 = getOpenRouterModelCost("claude-4.5-sonnet");
		expect(sonnet45).not.toBeNull();
		expect(sonnet45?.input).toBe(3);
		expect(sonnet45?.output).toBe(15);
		expect(sonnet45?.cacheRead).toBe(0.3);

		const sonnet46 = getOpenRouterModelCost("claude-4.6-sonnet-medium");
		expect(sonnet46).not.toBeNull();
		expect(sonnet46?.input).toBe(3);
		expect(sonnet46?.output).toBe(15);
	});

	it("resolves direct API pricing for OpenAI and Google models", () => {
		const gpt4o = getOpenRouterModelCost("gpt-4o");
		expect(gpt4o).not.toBeNull();
		expect(gpt4o?.input).toBe(2.5);
		expect(gpt4o?.output).toBe(10);

		const gemini = getOpenRouterModelCost("gemini-2.5-pro");
		expect(gemini).not.toBeNull();
		expect(gemini?.input).toBe(1.25);
		expect(gemini?.output).toBe(10);
	});

	it("falls back to OpenRouter pricing when model.cost is zero", () => {
		const zeroCostModel = {
			id: "claude-4.6-opus-high",
			name: "Claude Opus 4.6 1M",
			api: "cursor-agent",
			provider: "cursor",
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_000_000,
			maxTokens: 64_000,
			reasoning: true,
			input: ["text"],
		} as unknown as Model<"cursor-agent">;

		const usage: Usage = {
			input: 10_000,
			output: 2_000,
			cacheRead: 50_000,
			cacheWrite: 5_000,
			totalTokens: 67_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		};

		const computed = calculateCost(zeroCostModel, usage);
		expect(computed.input).toBeCloseTo(0.05, 5);
		expect(computed.output).toBeCloseTo(0.05, 5);
		expect(computed.cacheRead).toBeCloseTo(0.025, 5);
		expect(computed.cacheWrite).toBeCloseTo(0.03125, 5);
		expect(computed.total).toBeCloseTo(0.15625, 5);
	});

	describe("estimateProxyCacheUsage", () => {
		it("estimates cacheRead from previous turn prompt tokens on Claude models", () => {
			const model = { id: "claude-opus-5", provider: "gorouter" };
			const usage: Usage = {
				input: 55_000,
				output: 500,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 55_500,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			const triggered = estimateProxyCacheUsage(model, usage, 50_000);
			expect(triggered).toBe(true);
			expect(usage.cacheRead).toBe(50_000);
			expect(usage.input).toBe(5_000);
			expect(usage.input + usage.cacheRead).toBe(55_000);
		});

		it("accurately handles 800k+ long context turns without inflating cost", () => {
			const model = { id: "claude-opus-5", provider: "gorouter" } as unknown as Model<"openai-completions">;
			const usage: Usage = {
				input: 864_545,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 864_745,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			const triggered = estimateProxyCacheUsage(model, usage, 860_000);
			expect(triggered).toBe(true);
			expect(usage.cacheRead).toBe(860_000);
			expect(usage.input).toBe(4_545);

			const cost = calculateCost(model, usage);
			// input: 4,545 * $5/M = $0.022725
			// cacheRead: 860,000 * $0.50/M = $0.43
			// output: 200 * $25/M = $0.005
			// total = ~0.457725 instead of ~$4.32!
			expect(cost.total).toBeCloseTo(0.457725, 4);
		});

		it("skips estimation on the first turn or below the 1024-token threshold", () => {
			const model = { id: "claude-opus-5", provider: "gorouter" };
			const usage: Usage = {
				input: 500,
				output: 50,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 550,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(estimateProxyCacheUsage(model, usage, 0)).toBe(false);
			expect(usage.cacheRead).toBe(0);
			expect(usage.input).toBe(500);
		});

		it("does not override if provider already reported non-zero cacheRead", () => {
			const model = { id: "claude-opus-5", provider: "gorouter" };
			const usage: Usage = {
				input: 5_000,
				output: 200,
				cacheRead: 50_000,
				cacheWrite: 0,
				totalTokens: 55_200,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			};

			expect(estimateProxyCacheUsage(model, usage, 45_000)).toBe(false);
			expect(usage.cacheRead).toBe(50_000);
			expect(usage.input).toBe(5_000);
		});
	});
});
