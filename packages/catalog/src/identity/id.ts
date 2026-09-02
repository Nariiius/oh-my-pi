const LEADING_BRACKETED_AFFIX_PATTERN = /^(?:\s*(?:\[|【)[^\]】]+(?:\]|】)\s*)+/u;
const TRAILING_BRACKETED_AFFIX_PATTERN = /(?:\s*(?:\[|【)[^\]】]+(?:\]|】)\s*)+$/u;
const MODEL_ID_SEGMENT_PATTERN = /[a-z0-9.:-]+/g;
const MODEL_FAMILY_PREFIX_PATTERN =
	/^(claude|gemini|gpt|grok|glm|qwen|deepseek|kimi|mimo|doubao|ernie|gpt-oss|gemma|minimax|step|command|jamba|llama|o[1345])/i;

function normalizeModelIdWhitespace(value: string): string {
	return value.trim().replace(/\s+/g, " ");
}

/** Ordering for model-like segments: longest first, ties broken lexicographically. */
function compareSegmentPreference(left: string, right: string): number {
	return left.length !== right.length ? right.length - left.length : left.localeCompare(right);
}

export function getModelLikeIdSegments(modelId: string): string[] {
	const matches = normalizeModelIdWhitespace(modelId).toLowerCase().match(MODEL_ID_SEGMENT_PATTERN);
	if (!matches) return [];
	const segments = new Set<string>();
	for (const segment of matches) {
		if (MODEL_FAMILY_PREFIX_PATTERN.test(segment) && /\d/.test(segment)) segments.add(segment);
	}
	return [...segments].sort(compareSegmentPreference);
}

export function getLongestModelLikeIdSegment(modelId: string): string | undefined {
	const matches = normalizeModelIdWhitespace(modelId).toLowerCase().match(MODEL_ID_SEGMENT_PATTERN);
	if (!matches) return undefined;
	let best: string | undefined;
	for (const segment of matches) {
		if (
			MODEL_FAMILY_PREFIX_PATTERN.test(segment) &&
			/\d/.test(segment) &&
			(best === undefined || compareSegmentPreference(segment, best) < 0)
		) {
			best = segment;
		}
	}
	return best;
}

function hasBracketAffixMarker(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code === 91 || code === 93 || code === 0x3010 || code === 0x3011) {
			return true;
		}
	}
	return false;
}

/**
 * Strip reseller / wrapper tags that are injected as bracketed affixes around an
 * upstream model id, e.g.
 *   "[Kiro] claude-opus-4-8"                -> "claude-opus-4-8"
 *   "[gcli转] gemini-3.1-pro-preview [假流]" -> "gemini-3.1-pro-preview"
 *
 * Candidates are returned most-stripped first: both ends, then leading-only, then trailing-only.
 */
export function getBracketStrippedModelIdCandidates(modelId: string): string[] {
	if (!hasBracketAffixMarker(modelId)) return [];
	const normalized = normalizeModelIdWhitespace(modelId);
	if (!normalized) return [];

	const strippedLeading = normalized.replace(LEADING_BRACKETED_AFFIX_PATTERN, "");
	const withoutLeading = normalizeModelIdWhitespace(strippedLeading);
	const withoutTrailing = normalizeModelIdWhitespace(normalized.replace(TRAILING_BRACKETED_AFFIX_PATTERN, ""));
	const withoutBoth = normalizeModelIdWhitespace(strippedLeading.replace(TRAILING_BRACKETED_AFFIX_PATTERN, ""));

	const candidates = new Set<string>();
	for (const candidate of [withoutBoth, withoutLeading, withoutTrailing]) {
		if (candidate && candidate !== normalized) {
			candidates.add(candidate);
		}
	}
	return [...candidates];
}

export function stripBracketedModelIdAffixes(modelId: string): string | undefined {
	return getBracketStrippedModelIdCandidates(modelId)[0];
}

const THINKING_EFFORT_ORDER: Record<string, number> = {
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6,
};

const THINKING_SUFFIX_RE = /[-:](minimal|low|medium|high|xhigh|max)(?:[-:](fast|preview))?$/i;

/**
 * Compare model IDs, ensuring thinking level variants for the same base model
 * always sort in strict effort progression:
 * base -> minimal -> low -> medium -> high -> xhigh -> max
 * instead of alphabetical order (which would erroneously sort high -> low -> max -> medium -> xhigh).
 */
export function compareModelIdsWithThinkingEffort(idA: string, idB: string): number {
	if (idA === idB) return 0;
	const matchA = idA.match(THINKING_SUFFIX_RE);
	const matchB = idB.match(THINKING_SUFFIX_RE);

	if (matchA || matchB) {
		const baseA = matchA ? idA.slice(0, matchA.index) : idA;
		const baseB = matchB ? idB.slice(0, matchB.index) : idB;
		if (baseA === baseB) {
			const effortA = matchA ? (THINKING_EFFORT_ORDER[matchA[1]!.toLowerCase()] ?? 0) : 0;
			const effortB = matchB ? (THINKING_EFFORT_ORDER[matchB[1]!.toLowerCase()] ?? 0) : 0;
			if (effortA !== effortB) {
				return effortA - effortB;
			}
			const qualA = matchA?.[2] ?? "";
			const qualB = matchB?.[2] ?? "";
			if (qualA !== qualB) return qualA.localeCompare(qualB);
		}
	}

	return idA.localeCompare(idB);
}
