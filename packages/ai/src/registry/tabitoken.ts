import type { ProviderDefinition } from "./types";

export const tabitokenProvider = {
	id: "tabitoken",
	name: "TaBiAI",
} as const satisfies ProviderDefinition;

export const tabitokenAnthropicProvider = {
	id: "tabitoken-anthropic",
	name: "TaBiAI (Anthropic)",
} as const satisfies ProviderDefinition;
