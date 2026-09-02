import type { ProviderDefinition } from "./types";

export const gorouterProvider = {
	id: "gorouter",
	name: "GoRouter",
} as const satisfies ProviderDefinition;

export const gorouterAnthropicProvider = {
	id: "gorouter-anthropic",
	name: "GoRouter (Anthropic)",
} as const satisfies ProviderDefinition;
