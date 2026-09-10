import type { ProviderDefinition } from "./types";

export const tokenforgeProvider = {
	id: "tokenforge",
	name: "TokenForge",
} as const satisfies ProviderDefinition;

export const tokenforgeAnthropicProvider = {
	id: "tokenforge-anthropic",
	name: "TokenForge (Anthropic)",
} as const satisfies ProviderDefinition;
