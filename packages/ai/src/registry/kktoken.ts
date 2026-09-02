import type { ProviderDefinition } from "./types";

export const kktokenProvider = {
	id: "kktoken",
	name: "KKtoken AI",
} as const satisfies ProviderDefinition;

export const kktokenAnthropicProvider = {
	id: "kktoken-anthropic",
	name: "KKtoken AI (Anthropic)",
} as const satisfies ProviderDefinition;
