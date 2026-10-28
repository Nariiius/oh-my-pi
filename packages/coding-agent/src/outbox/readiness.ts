import type { ModelUsageAccountHealth, ModelUsageHealth } from "@oh-my-pi/pi-ai";
import type { AgentSession } from "../session/agent-session";
import type { OutboxJob, OutboxReadiness } from "./types";

export const DEFAULT_READINESS_RETRY_DELAY_MS = 60_000;

export interface EvaluateReadinessOptions {
	nowMs?: number;
	retryDelayMs?: number;
	isAccountEligible?: (account: ModelUsageAccountHealth) => boolean;
}

/**
 * Pure decision function to determine readiness from model usage health.
 * Respects all applicable exhausted windows, session restrictions, and multi-account state.
 */
export function evaluateReadiness(health: ModelUsageHealth, options: EvaluateReadinessOptions = {}): OutboxReadiness {
	const nowMs = options.nowMs ?? Date.now();
	const retryDelayMs = options.retryDelayMs ?? DEFAULT_READINESS_RETRY_DELAY_MS;

	const allAccounts = health.accounts ?? [];

	// Unknown or missing account snapshots are never usable
	if (allAccounts.length === 0) {
		return {
			state: "waiting",
			reason: "Quota status unknown; waiting for quota telemetry",
			nextCheckAt: nowMs + retryDelayMs,
		};
	}

	const eligibleAccounts = options.isAccountEligible ? allAccounts.filter(options.isAccountEligible) : allAccounts;

	if (eligibleAccounts.length === 0) {
		return {
			state: "attention",
			reason: "No eligible accounts permitted by session restrictions",
		};
	}

	// Any eligible account with healthy quota makes the model ready
	const hasHealthyAccount = eligibleAccounts.some(account => account.state === "healthy");
	if (hasHealthyAccount) {
		return { state: "ready" };
	}

	// Any account with unknown status prevents admission
	const hasUnknownAccount = eligibleAccounts.some(account => account.state === "unknown");

	// An account can only clear if every exhausted window was timed (clearedAt is defined).
	// Accounts with permanent/unclocked caps have clearedAt === undefined and cannot admit on timer.
	const clearableResets: number[] = [];
	for (const account of eligibleAccounts) {
		if (account.state === "depleted" && account.clearedAt !== undefined && account.clearedAt > nowMs) {
			clearableResets.push(account.clearedAt);
		}
	}

	const nextCheckAt = clearableResets.length > 0 ? Math.min(...clearableResets) : nowMs + retryDelayMs;

	const reason =
		hasUnknownAccount && clearableResets.length === 0
			? "Quota status unknown; waiting for quota telemetry"
			: "Quota exhausted across all eligible accounts";

	return {
		state: "waiting",
		reason,
		nextCheckAt,
	};
}

/**
 * Check quota readiness for an outbox job without spending generation quota.
 */
export async function checkOutboxReadiness(
	session: AgentSession,
	job: OutboxJob,
	signal?: AbortSignal,
): Promise<OutboxReadiness> {
	signal?.throwIfAborted();

	const model = session.modelRegistry.find(job.provider, job.model);
	if (!model) {
		return {
			state: "attention",
			reason: `Model ${job.provider}/${job.model} not found in registry`,
		};
	}

	if (!session.modelRegistry.hasConfiguredAuth(model)) {
		return {
			state: "attention",
			reason: `No API key or credentials configured for ${job.provider}`,
		};
	}

	await session.modelRegistry.authStorage?.credentials?.reload?.();
	// Invalidate cached reports so probe reconciles fresh usage at reset instead of reading stale cache
	const usageApi = session.modelRegistry.authStorage.usage;
	if (usageApi?.invalidate) {
		try {
			await usageApi.invalidate(model.provider, signal);
		} catch (error: unknown) {
			if (signal?.aborted) throw error;
			return {
				state: "waiting",
				reason: `Failed to refresh quota telemetry: ${error instanceof Error ? error.message : String(error)}`,
				nextCheckAt: Date.now() + DEFAULT_READINESS_RETRY_DELAY_MS,
			};
		}
	}

	let health: ModelUsageHealth;
	try {
		health = await session.modelRegistry.authStorage.health.model(model.provider, {
			modelId: model.id,
			sessionId: session.sessionId,
			baseUrl: model.baseUrl,
			signal,
			reserveFraction: 0,
		});
	} catch (error: unknown) {
		if (signal?.aborted) throw error;
		return {
			state: "waiting",
			reason: `Failed to check quota health: ${error instanceof Error ? error.message : String(error)}`,
			nextCheckAt: Date.now() + DEFAULT_READINESS_RETRY_DELAY_MS,
		};
	}

	const sessionsApi = session.modelRegistry.authStorage.sessions;
	const isAccountEligible = sessionsApi
		? (account: ModelUsageAccountHealth): boolean =>
				sessionsApi.permits(model.provider, job.sessionId, account.credentialId)
		: undefined;

	return evaluateReadiness(health, {
		nowMs: Date.now(),
		retryDelayMs: DEFAULT_READINESS_RETRY_DELAY_MS,
		isAccountEligible,
	});
}
