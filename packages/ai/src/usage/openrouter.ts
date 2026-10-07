import type {
	UsageAmount,
	UsageFetchContext,
	UsageFetchParams,
	UsageLimit,
	UsageProvider,
	UsageReport,
} from "../usage";
import { isRecord } from "../utils";

interface OpenRouterKeyResponse {
	data?: {
		label?: string;
		usage?: number;
		limit?: number | null;
		is_free_tier?: boolean;
		rate_limit?: {
			requests?: number;
			interval?: string;
		};
	};
}

export async function fetchOpenRouterUsage(
	params: UsageFetchParams,
	ctx: UsageFetchContext,
): Promise<UsageReport | null> {
	const apiKey = params.credential.type === "api_key" ? params.credential.apiKey : params.credential.accessToken;
	if (!apiKey) return null;

	try {
		const response = await ctx.fetch("https://openrouter.ai/api/v1/auth/key", {
			headers: {
				Authorization: `Bearer ${apiKey}`,
			},
			signal: params.signal,
		});

		if (!response.ok) {
			return null;
		}

		const json = (await response.json()) as OpenRouterKeyResponse;
		if (!isRecord(json) || !isRecord(json.data)) return null;

		const data = json.data;
		const usage = typeof data.usage === "number" ? data.usage : 0;
		const limit = typeof data.limit === "number" && data.limit > 0 ? data.limit : undefined;
		const label = data.label || "API Key";

		const limits: UsageLimit[] = [];
		const amount: UsageAmount = {
			used: usage,
			limit,
			remaining: limit !== undefined ? Math.max(0, limit - usage) : undefined,
			usedFraction: limit !== undefined && limit > 0 ? usage / limit : undefined,
			remainingFraction: limit !== undefined && limit > 0 ? Math.max(0, 1 - usage / limit) : undefined,
			unit: "usd",
		};

		limits.push({
			id: "openrouter:credits",
			label:
				limit !== undefined
					? `Credits ($${usage.toFixed(2)} / $${limit.toFixed(2)})`
					: `Spend ($${usage.toFixed(2)})`,
			scope: { provider: "openrouter" },
			amount,
			status: amount.usedFraction !== undefined && amount.usedFraction >= 0.9 ? "warning" : "ok",
		});

		const notes: string[] = [];
		const rateLimit = isRecord(data.rate_limit) ? data.rate_limit : undefined;
		if (rateLimit?.requests && rateLimit?.interval) {
			notes.push(`Rate limit: ${String(rateLimit.requests)} req / ${String(rateLimit.interval)}`);
		}
		if (data.is_free_tier) {
			notes.push("Free tier");
		}

		return {
			provider: "openrouter",
			fetchedAt: Date.now(),
			limits,
			notes: notes.length > 0 ? notes : undefined,
			metadata: {
				label,
				accountId: label,
			},
		};
	} catch (error) {
		ctx.logger?.warn("OpenRouter usage fetch failed", { error: String(error) });
		return null;
	}
}

export const openrouterUsageProvider: UsageProvider = {
	id: "openrouter",
	fetchUsage: fetchOpenRouterUsage,
	supports: params => params.provider === "openrouter",
};
