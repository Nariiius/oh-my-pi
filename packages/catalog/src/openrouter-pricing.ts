/**
 * Live model pricing fetched from the OpenRouter Models API (GET https://openrouter.ai/api/v1/models).
 * Provides universal, provider-agnostic token pricing per million tokens
 * (prompt, completion, cache-read, cache-write) for 400+ models.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getModelDbPath, logger } from "@oh-my-pi/pi-utils";
import snapshotPricing from "./openrouter-pricing-snapshot.json";
import type { ModelCost } from "./types";

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface OpenRouterPricingIndex {
	byExact: Map<string, ModelCost>;
	bySlug: Map<string, ModelCost>;
	loadedAt: number;
}

let currentIndex: OpenRouterPricingIndex | null = null;
let backgroundRefreshPromise: Promise<boolean> | null = null;

function getCacheFilePath(): string {
	try {
		const dbPath = getModelDbPath();
		return path.join(path.dirname(dbPath), "openrouter-pricing.json");
	} catch {
		return path.join(process.cwd(), ".openrouter-pricing-cache.json");
	}
}

function buildIndexFromRecord(data: Record<string, ModelCost>): OpenRouterPricingIndex {
	const byExact = new Map<string, ModelCost>();
	const bySlug = new Map<string, ModelCost>();

	for (const [id, cost] of Object.entries(data)) {
		if (!cost || (cost.input <= 0 && cost.output <= 0)) continue;
		const normId = id.toLowerCase().trim();
		byExact.set(normId, cost);

		const slug = normId.split("/").pop();
		if (slug && !bySlug.has(slug)) {
			bySlug.set(slug, cost);
		}
	}

	return { byExact, bySlug, loadedAt: Date.now() };
}

function loadFromDisk(): { data: Record<string, ModelCost>; mtime: number } | null {
	try {
		const filePath = getCacheFilePath();
		if (!fs.existsSync(filePath)) return null;
		const stat = fs.statSync(filePath);
		const raw = fs.readFileSync(filePath, "utf-8");
		const data = JSON.parse(raw);
		if (data && typeof data === "object" && Object.keys(data).length > 0) {
			return { data, mtime: stat.mtimeMs };
		}
	} catch {
		// Ignore corrupt or unreadable cache file
	}
	return null;
}

function saveToDisk(data: Record<string, ModelCost>): void {
	try {
		const filePath = getCacheFilePath();
		const dir = path.dirname(filePath);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmp = `${filePath}.tmp.${Date.now()}`;
		fs.writeFileSync(tmp, JSON.stringify(data), "utf-8");
		fs.renameSync(tmp, filePath);
	} catch (err) {
		logger.warn?.(`Failed to cache OpenRouter pricing to disk: ${err}`);
	}
}

/** Ensure the pricing index is initialized in memory synchronously. */
export function ensureOpenRouterPricingIndex(): OpenRouterPricingIndex {
	if (currentIndex) return currentIndex;

	const disk = loadFromDisk();
	if (disk) {
		currentIndex = buildIndexFromRecord(disk.data);
		// If cache is stale, trigger background refresh
		if (Date.now() - disk.mtime > CACHE_TTL_MS) {
			void refreshOpenRouterPricing();
		}
		return currentIndex;
	}

	// Initialize from bundled snapshot
	currentIndex = buildIndexFromRecord(snapshotPricing as Record<string, ModelCost>);
	// Trigger initial background refresh to pull freshest live rates
	void refreshOpenRouterPricing();
	return currentIndex;
}

/**
 * Refresh pricing from OpenRouter live API in the background.
 * Safe: never throws, logs warning on network error.
 */
export async function refreshOpenRouterPricing(options?: { timeoutMs?: number }): Promise<boolean> {
	if (backgroundRefreshPromise) return backgroundRefreshPromise;

	backgroundRefreshPromise = (async () => {
		try {
			const timeoutMs = options?.timeoutMs ?? 5_000;
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), timeoutMs);

			const response = await fetch(OPENROUTER_MODELS_URL, {
				signal: controller.signal,
				headers: { Accept: "application/json" },
			});
			clearTimeout(timeout);

			if (!response.ok) return false;
			const payload = (await response.json()) as { data?: unknown[] };
			if (!Array.isArray(payload?.data)) return false;

			const newRecord: Record<string, ModelCost> = {};
			for (const raw of payload.data) {
				if (!raw || typeof raw !== "object") continue;
				const entry = raw as { id?: string; pricing?: Record<string, unknown> };
				if (typeof entry.id !== "string" || !entry.pricing) continue;

				const prompt = parseFloat(String(entry.pricing.prompt ?? "0")) * 1_000_000;
				const completion = parseFloat(String(entry.pricing.completion ?? "0")) * 1_000_000;
				const cacheRead = parseFloat(String(entry.pricing.input_cache_read ?? "0")) * 1_000_000;
				const cacheWrite = parseFloat(String(entry.pricing.input_cache_write ?? "0")) * 1_000_000;

				if (prompt > 0 || completion > 0) {
					newRecord[entry.id.toLowerCase()] = {
						input: prompt,
						output: completion,
						cacheRead,
						cacheWrite,
					};
				}
			}

			if (Object.keys(newRecord).length > 0) {
				currentIndex = buildIndexFromRecord(newRecord);
				saveToDisk(newRecord);
				return true;
			}
			return false;
		} catch {
			return false;
		} finally {
			backgroundRefreshPromise = null;
		}
	})();

	return backgroundRefreshPromise;
}

/**
 * Resolve a model ID to its direct API token cost from OpenRouter's live rate card.
 * Normalizes model names, stripping wrapper prefixes, thinking/effort tiers,
 * and handles version separators / inversions (e.g. `claude-4.6-opus-high` -> `anthropic/claude-opus-4.6`).
 */
export function getOpenRouterModelCost(modelId: string): ModelCost | null {
	if (!modelId) return null;
	const index = ensureOpenRouterPricingIndex();
	const norm = modelId.toLowerCase().trim();

	// 1. Exact ID or slug match
	const direct = index.byExact.get(norm) ?? index.bySlug.get(norm);
	if (direct) return direct;

	// 2. Strip wrapper prefixes (e.g. cursor-, duo-chat-, etc.)
	const withoutPrefix = norm.replace(/^(?:cursor|duo-chat|tab)-/, "");
	if (withoutPrefix !== norm) {
		const matchPrefix = index.byExact.get(withoutPrefix) ?? index.bySlug.get(withoutPrefix);
		if (matchPrefix) return matchPrefix;
	}

	// 3. Repeatedly strip effort/thinking/flavor suffixes
	// (e.g. -high, -low, -medium, -max, -xhigh, -fast, -thinking, :cloud, :free, etc.)
	const stripped = withoutPrefix
		.replace(/(?:-(?:high|low|medium|max|xhigh|fast|thinking))+$/gi, "")
		.replace(/:(?:free|extended|preview)$/i, "");

	if (stripped !== withoutPrefix) {
		const matchStripped = index.byExact.get(stripped) ?? index.bySlug.get(stripped);
		if (matchStripped) return matchStripped;
	}

	// 4. Inverted Claude format: claude-4.6-opus -> claude-opus-4.6
	const claudeMatch = stripped.match(/^claude-(\d+(?:[\.-]\d+)?)-([a-z]+)/);
	if (claudeMatch) {
		const [, ver, fam] = claudeMatch;
		const dottedVer = ver.replace(/-/g, ".");
		const dashedVer = ver.replace(/\./g, "-");
		const candDotted = `claude-${fam}-${dottedVer}`;
		const candDashed = `claude-${fam}-${dashedVer}`;
		const matchClaude = index.bySlug.get(candDotted) ?? index.bySlug.get(candDashed);
		if (matchClaude) return matchClaude;
	}

	// 5. Version separator translation: dash to dot (claude-opus-4-6 -> claude-opus-4.6)
	const dotVer = stripped.replace(/-(\d+)-(\d+)/, "-$1.$2");
	if (dotVer !== stripped) {
		const matchDot = index.bySlug.get(dotVer);
		if (matchDot) return matchDot;
	}

	// 6. Dot to dash (gpt-4.5 -> gpt-4-5)
	const dashVer = stripped.replace(/\./g, "-");
	if (dashVer !== stripped) {
		const matchDash = index.bySlug.get(dashVer);
		if (matchDash) return matchDash;
	}

	// 7. Suffix alias with -preview if omitted (e.g. gemini-3-flash -> gemini-3-flash-preview)
	const previewCandidate = `${stripped}-preview`;
	const matchPreview = index.bySlug.get(previewCandidate);
	if (matchPreview) return matchPreview;

	return null;
}
