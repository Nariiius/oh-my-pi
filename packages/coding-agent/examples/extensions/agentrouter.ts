/**
 * AgentRouter WAF handshake for Oh My Pi.
 *
 * agentrouter.org rejects clients whose first system/root prompt is not the
 * canonical Pi coding-agent header (401 unauthorized_client). OMP's default
 * prompt does not start with that sentence, so this extension prepends it
 * on AgentRouter routes only.
 *
 * Official Pi plugin: @madgagarin/pi-agentrouter
 */
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const CANONICAL_PI_HEADER =
	"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const PI_HEADER_RE = /(?:You are [^\n\r]*operating inside pi[^\n\r]*\n?|You are (?:pi|Pi)[^\n\r]*\n?)/i;

function isAgentRouter(provider?: string, baseUrl?: string): boolean {
	if (provider?.toLowerCase().includes("agentrouter")) return true;
	if (baseUrl?.toLowerCase().includes("agentrouter.org")) return true;
	return false;
}

function enforceCanonicalRootPrompt(systemPrompt: unknown): unknown {
	if (systemPrompt == null) return CANONICAL_PI_HEADER;

	if (typeof systemPrompt === "string") {
		const text = systemPrompt.trim();
		const match = text.match(PI_HEADER_RE);
		if (match && match.index !== undefined) {
			if (match.index > 0) {
				const header = match[0].trim();
				const prefix = text.slice(0, match.index).trim();
				const rest = text.slice(match.index + match[0].length).trim();
				return `${header}\n\n${prefix}${rest ? "\n\n" + rest : ""}`;
			}
			return text;
		}
		return `${CANONICAL_PI_HEADER}\n\n${text}`;
	}

	if (Array.isArray(systemPrompt)) {
		if (systemPrompt.length === 0) return [{ type: "text", text: CANONICAL_PI_HEADER }];
		const first = systemPrompt[0];
		if (first && typeof first === "object" && "text" in first && typeof first.text === "string") {
			first.text = enforceCanonicalRootPrompt(first.text) as string;
		}
		return systemPrompt;
	}

	return systemPrompt;
}

export default function (pi: ExtensionAPI) {
	pi.on("before_agent_start", async (event, ctx) => {
		const model = ctx.model;
		const provider =
			model && typeof model === "object" && "provider" in model && typeof model.provider === "string"
				? model.provider
				: undefined;
		const baseUrl =
			model && typeof model === "object" && "baseUrl" in model && typeof model.baseUrl === "string"
				? model.baseUrl
				: undefined;
		if (!isAgentRouter(provider, baseUrl)) return;
		const current = event.systemPrompt ?? [];
		const joined = current.join("\n");
		const enforced = enforceCanonicalRootPrompt(joined);
		if (typeof enforced === "string" && enforced !== joined) {
			return { systemPrompt: [enforced] };
		}
		return undefined;
	});

	pi.on("before_provider_request", async (event, ctx) => {
		const model = ctx.model;
		const provider =
			model && typeof model === "object" && "provider" in model && typeof model.provider === "string"
				? model.provider
				: undefined;
		const baseUrl =
			model && typeof model === "object" && "baseUrl" in model && typeof model.baseUrl === "string"
				? model.baseUrl
				: undefined;
		if (!isAgentRouter(provider, baseUrl)) return event.payload;

		const payload = event.payload;
		if (!payload || typeof payload !== "object") return event.payload;

		if ("system" in payload && payload.system !== undefined) {
			(payload as Record<string, unknown>).system = enforceCanonicalRootPrompt(payload.system);
		}
		if ("messages" in payload && Array.isArray(payload.messages) && payload.messages.length > 0) {
			for (const msg of payload.messages) {
				if (msg && typeof msg === "object" && "role" in msg && msg.role === "developer") {
					msg.role = "system";
				}
			}
			const first = payload.messages[0];
			if (
				first &&
				typeof first === "object" &&
				"role" in first &&
				(first.role === "system" || first.role === "developer")
			) {
				first.role = "system";
				if ("content" in first) {
					first.content = enforceCanonicalRootPrompt(first.content);
				}
			}
		}
		return payload;
	});
}
