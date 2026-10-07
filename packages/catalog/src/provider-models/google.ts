import { reviewedCollapseTable } from "../compat/collapse";
import { classifyModel } from "../compat/taxonomy";
import { providerEntry } from "../compat/providers";
import { ANTIGRAVITY_PRIMARY_ENDPOINT, fetchAntigravityDiscoveryModels } from "../discovery/antigravity";
import { Effort } from "../effort";
import { fetchGeminiModels } from "../discovery/gemini";
import { fetchGeminiCliQuotaModels } from "../discovery/gemini-cli";
import type { ModelManagerOptions } from "../model-manager";
import type { FetchImpl, ModelSpec } from "../types";

export interface GoogleModelManagerConfig {
	apiKey?: string;
	fetch?: FetchImpl;
}

export interface GoogleVertexModelManagerConfig {
	apiKey?: string;
	project?: string;
	location?: string;
	signal?: AbortSignal;
	fetch?: FetchImpl;
}

export interface GoogleAntigravityModelManagerConfig {
	oauthToken?: string;
	endpoint?: string;
	fetch?: FetchImpl;
}

export interface GoogleGeminiCliModelManagerConfig {
	oauthToken?: string;
	/** GCP project id required by Workspace/Standard credentials for quota discovery. */
	projectId?: string;
	endpoint?: string;
	fetch?: FetchImpl;
}

const CLOUD_CODE_ASSIST_ENDPOINT = "https://cloudcode-pa.googleapis.com";
/** Rows whose cached effort ladder predates the native `minimal` drop (#10543). */
const GEMINI_FLASH_CACHE_MIGRATION_MODEL_IDS = ["gemini-3.7-flash", "gemini-3.8-flash"] as const;

/**
 * Curated fallback models for Google Antigravity.
 * These ensure that flagships (such as Claude Opus 5.5 / Sonnet 5.5 available on
 * paid Antigravity Pro/Ultra tiers) are always part of the catalog even when
 * generation is unauthenticated or uses an entitlement-limited account.
 */
export const ANTIGRAVITY_CURATED_FALLBACK_MODELS: readonly ModelSpec<"google-gemini-cli">[] = [
	{
		id: "claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
		requestModelId: "claude-opus-5-5-medium",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
	},
	{
		id: "claude-sonnet-5-5",
		name: "Claude Sonnet 5.5",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		requestModelId: "claude-sonnet-5-5-low",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
	},
	{
		id: "claude-opus-5",
		name: "Claude Opus 5",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		requestModelId: "claude-opus-5-thinking",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
	},
	{
		id: "claude-sonnet-5",
		name: "Claude Sonnet 5",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
		requestModelId: "claude-sonnet-5-thinking",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
	},
	{
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		requestModelId: "claude-opus-4-8-thinking",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
	},
	{
		id: "claude-opus-4-7",
		name: "Claude Opus 4.7",
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: ANTIGRAVITY_PRIMARY_ENDPOINT,
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 1_000_000,
		maxTokens: 64_000,
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		requestModelId: "claude-opus-4-7-thinking",
		thinking: {
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
		},
	},
];

function toDiscoveryFetch(fetchImpl: FetchImpl | undefined): typeof fetch | undefined {
	if (!fetchImpl) {
		return undefined;
	}
	return Object.assign(
		(input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => fetchImpl(input, init),
		{ preconnect: fetchImpl.preconnect ?? fetch.preconnect },
	);
}

export function googleModelManagerOptions(
	config?: GoogleModelManagerConfig,
): ModelManagerOptions<"google-generative-ai"> {
	const apiKey = config?.apiKey;
	return {
		providerId: "google",
		dropCachedModelIdsOnStaticMismatch: GEMINI_FLASH_CACHE_MIGRATION_MODEL_IDS,
		...(apiKey
			? { fetchDynamicModels: () => fetchGeminiModels({ apiKey, fetch: toDiscoveryFetch(config?.fetch) }) }
			: undefined),
	};
}

export function googleVertexModelManagerOptions(_config?: GoogleVertexModelManagerConfig): ModelManagerOptions {
	return {
		providerId: "google-vertex",
		dropCachedModelIdsOnStaticMismatch: GEMINI_FLASH_CACHE_MIGRATION_MODEL_IDS,
	};
}

export function googleAntigravityModelManagerOptions(
	config?: GoogleAntigravityModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	return {
		providerId: "google-antigravity",
		dynamicModelsAuthoritative: providerEntry("google-antigravity")?.dynamicModelsAuthoritative === true,
		...(token
			? {
					fetchDynamicModels: () =>
						fetchAntigravityDiscoveryModels({
							token,
							endpoint: config?.endpoint,
							fetcher: toDiscoveryFetch(config?.fetch),
						}),
				}
			: undefined),
	};
}

export function googleGeminiCliModelManagerOptions(
	config?: GoogleGeminiCliModelManagerConfig,
): ModelManagerOptions<"google-gemini-cli"> {
	const token = config?.oauthToken;
	const endpoint = config?.endpoint ?? CLOUD_CODE_ASSIST_ENDPOINT;
	return {
		providerId: "google-gemini-cli",
		...(token
			? {
					fetchDynamicModels: async () => {
						const fetcher = toDiscoveryFetch(config?.fetch);
						const collapseTable = reviewedCollapseTable("google-gemini-cli");
						if (collapseTable === undefined) {
							throw new Error("missing reviewed collapse table for google-gemini-cli");
						}
						const models = await fetchAntigravityDiscoveryModels({
							token,
							fetcher,
							collapseTable: collapseTable,
						});
						// Antigravity's fetchAvailableModels is unreachable for
						// credentials without Antigravity entitlement (Code Assist
						// Standard returns HTTP 403). Fall back to the account's own
						// retrieveUserQuota list on Cloud Code Assist.
						if (models === null) {
							return fetchGeminiCliQuotaModels({ token, projectId: config?.projectId, endpoint, fetcher });
						}
						return models
							.filter(m => classifyModel("google-gemini-cli", m.id, { lenient: true }).class === "gemini")
							.map(m => ({
								...m,
								provider: "google-gemini-cli" as const,
								baseUrl: endpoint,
							}));
					},
				}
			: undefined),
	};
}
