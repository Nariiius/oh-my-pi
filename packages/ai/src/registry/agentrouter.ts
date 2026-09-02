import type { ProviderDefinition } from "./types";

export const agentrouterProvider = {
	id: "agentrouter",
	name: "AgentRouter",
} as const satisfies ProviderDefinition;

export const agentrouterAnthropicProvider = {
	id: "agentrouter-anthropic",
	name: "AgentRouter (Anthropic)",
} as const satisfies ProviderDefinition;
