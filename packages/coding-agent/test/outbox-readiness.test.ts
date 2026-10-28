import { describe, expect, it } from "bun:test";
import type { ModelUsageHealth } from "@oh-my-pi/pi-ai";
import { checkOutboxReadiness, evaluateReadiness } from "../src/outbox/readiness";
import type { OutboxJob } from "../src/outbox/types";
import type { AgentSession } from "../src/session/agent-session";

describe("evaluateReadiness", () => {
	it("returns waiting when accounts are empty (unknown is not usable)", () => {
		const now = 10_000;
		const health: ModelUsageHealth = {
			state: "unknown",
			accounts: [],
		};
		const result = evaluateReadiness(health, {
			nowMs: now,
			retryDelayMs: 60_000,
		});
		expect(result).toEqual({
			state: "waiting",
			reason: "Quota status unknown; waiting for quota telemetry",
			nextCheckAt: 70_000,
		});
	});

	it("returns ready when any eligible account is healthy", () => {
		const health: ModelUsageHealth = {
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "depleted",
					resetsAt: 50_000,
					clearedAt: 100_000,
				},
				{
					credentialId: 2,
					credentialType: "oauth",
					state: "healthy",
					remainingFraction: 0.8,
				},
			],
		};
		const result = evaluateReadiness(health, { nowMs: 10_000 });
		expect(result).toEqual({ state: "ready" });
	});

	it("does not treat disallowed healthy sibling as usable when restricted", () => {
		const health: ModelUsageHealth = {
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "depleted",
					resetsAt: 50_000,
					clearedAt: 50_000,
				},
				{
					credentialId: 2,
					credentialType: "oauth",
					state: "healthy",
					remainingFraction: 0.9,
				},
			],
		};

		const isAccountEligible = (account: { credentialId: number }) => account.credentialId === 1;

		const result = evaluateReadiness(health, {
			nowMs: 10_000,
			isAccountEligible,
		});
		expect(result.state).toBe("waiting");
		if (result.state === "waiting") {
			expect(result.nextCheckAt).toBe(50_000);
		}
	});

	it("returns attention when all accounts are blocked by session restrictions", () => {
		const health: ModelUsageHealth = {
			state: "healthy",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "healthy",
				},
			],
		};

		const result = evaluateReadiness(health, {
			nowMs: 10_000,
			isAccountEligible: () => false,
		});
		expect(result).toEqual({
			state: "attention",
			reason: "No eligible accounts permitted by session restrictions",
		});
	});

	it("does not admit account with short reset when untimed permanent cap exists", () => {
		const now = 10_000;
		// Short reset exists at 20_000, but untimed permanent cap leaves clearedAt undefined
		const health: ModelUsageHealth = {
			state: "depleted",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "depleted",
					resetsAt: 20_000,
					clearedAt: undefined, // untimed window
				},
			],
		};

		const result = evaluateReadiness(health, {
			nowMs: now,
			retryDelayMs: 60_000,
		});
		expect(result.state).toBe("waiting");
		if (result.state === "waiting") {
			// Cannot admit on short window reset: falls back to telemetry retry delay
			expect(result.nextCheckAt).toBe(70_000);
		}
	});

	it("waits for weekly cap when every window is timed", () => {
		const now = 10_000;
		const health: ModelUsageHealth = {
			state: "depleted",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "depleted",
					resetsAt: 20_000,
					clearedAt: 100_000,
				},
			],
		};

		const result = evaluateReadiness(health, { nowMs: now });
		expect(result.state).toBe("waiting");
		if (result.state === "waiting") {
			expect(result.nextCheckAt).toBe(100_000);
		}
	});

	it("treats unknown account state conservatively and bounds retry", () => {
		const now = 10_000;
		const health: ModelUsageHealth = {
			state: "unknown",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "unknown",
				},
			],
		};

		const result = evaluateReadiness(health, {
			nowMs: now,
			retryDelayMs: 30_000,
		});
		expect(result).toEqual({
			state: "waiting",
			reason: "Quota status unknown; waiting for quota telemetry",
			nextCheckAt: 40_000,
		});
	});

	it("picks earliest clearable reset across multiple depleted accounts", () => {
		const now = 10_000;
		const health: ModelUsageHealth = {
			state: "depleted",
			accounts: [
				{
					credentialId: 1,
					credentialType: "oauth",
					state: "depleted",
					resetsAt: 80_000,
					clearedAt: 80_000,
				},
				{
					credentialId: 2,
					credentialType: "oauth",
					state: "depleted",
					resetsAt: 40_000,
					clearedAt: 40_000,
				},
			],
		};

		const result = evaluateReadiness(health, { nowMs: now });
		expect(result).toEqual({
			state: "waiting",
			reason: "Quota exhausted across all eligible accounts",
			nextCheckAt: 40_000,
		});
	});
});

describe("checkOutboxReadiness", () => {
	const sampleJob: OutboxJob = {
		kind: "message",
		id: "job-1",
		position: 1,
		createdAt: 1000,
		updatedAt: 1000,
		sessionId: "session-1",
		sessionFile: "/tmp/session-1.json",
		branchId: null,
		cwd: "/tmp",
		provider: "mock-provider",
		model: "mock-model",
		text: "Test prompt",
		attachments: [],
		state: "queued",
		cancelRequested: false,
	};

	it("fails with attention when model is not found in registry", async () => {
		const mockSession = {
			sessionId: "session-1",
			modelRegistry: {
				find: () => undefined,
			},
		} as unknown as AgentSession;

		const readiness = await checkOutboxReadiness(mockSession, sampleJob);
		expect(readiness).toEqual({
			state: "attention",
			reason: "Model mock-provider/mock-model not found in registry",
		});
	});

	it("fails with attention when model has no configured auth", async () => {
		const mockSession = {
			sessionId: "session-1",
			modelRegistry: {
				find: () => ({ id: "mock-model", provider: "mock-provider" }),
				hasConfiguredAuth: () => false,
			},
		} as unknown as AgentSession;

		const readiness = await checkOutboxReadiness(mockSession, sampleJob);
		expect(readiness).toEqual({
			state: "attention",
			reason: "No API key or credentials configured for mock-provider",
		});
	});

	it("checks auth health and invalidates usage cache before probe", async () => {
		let invalidated = false;
		const mockSession = {
			sessionId: "session-1",
			modelRegistry: {
				find: () => ({ id: "mock-model", provider: "mock-provider" }),
				hasConfiguredAuth: () => true,
				authStorage: {
					usage: {
						invalidate: async () => {
							invalidated = true;
						},
						providerFor: () => ({}),
					},
					sessions: {
						permits: () => true,
					},
					health: {
						model: async () => ({
							state: "healthy",
							accounts: [
								{
									credentialId: 1,
									credentialType: "oauth",
									state: "healthy",
								},
							],
						}),
					},
				},
			},
		} as unknown as AgentSession;

		const readiness = await checkOutboxReadiness(mockSession, sampleJob);
		expect(invalidated).toBe(true);
		expect(readiness).toEqual({ state: "ready" });
	});
	it("returns waiting when invalidate fails instead of falling through to stale health", async () => {
		const mockSession = {
			sessionId: "session-1",
			modelRegistry: {
				find: () => ({ id: "mock-model", provider: "mock-provider" }),
				hasConfiguredAuth: () => true,
				authStorage: {
					usage: {
						invalidate: async () => {
							throw new Error("Invalidate failed");
						},
						providerFor: () => ({}),
					},
					health: {
						model: async () => ({
							state: "healthy",
							accounts: [{ credentialId: 1, credentialType: "oauth", state: "healthy" }],
						}),
					},
				},
			},
		} as unknown as AgentSession;

		const readiness = await checkOutboxReadiness(mockSession, sampleJob);
		expect(readiness.state).toBe("waiting");
	});

	it("respects abort signal and throws if aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		const mockSession = {
			sessionId: "session-1",
			modelRegistry: {
				find: () => ({ id: "mock-model", provider: "mock-provider" }),
			},
		} as unknown as AgentSession;

		expect(checkOutboxReadiness(mockSession, sampleJob, controller.signal)).rejects.toThrow();
	});

	it("catches health errors and returns bounded waiting state", async () => {
		const mockSession = {
			sessionId: "session-1",
			modelRegistry: {
				find: () => ({ id: "mock-model", provider: "mock-provider" }),
				hasConfiguredAuth: () => true,
				authStorage: {
					usage: {
						providerFor: () => ({}),
					},
					sessions: {
						permits: () => true,
					},
					health: {
						model: async () => {
							throw new Error("Network timeout contacting usage endpoint");
						},
					},
				},
			},
		} as unknown as AgentSession;

		const readiness = await checkOutboxReadiness(mockSession, sampleJob);
		expect(readiness.state).toBe("waiting");
		if (readiness.state === "waiting") {
			expect(readiness.reason).toContain("Network timeout");
			expect(readiness.nextCheckAt).toBeGreaterThan(Date.now());
		}
	});
});
