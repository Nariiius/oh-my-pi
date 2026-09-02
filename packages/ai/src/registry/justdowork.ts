import type { ProviderDefinition } from "./types";

export const justdoworkProvider = {
	id: "justdowork",
	name: "JustDoWork",
} as const satisfies ProviderDefinition;

export const justdoworkAnthropicProvider = {
	id: "justdowork-anthropic",
	name: "JustDoWork (Anthropic)",
} as const satisfies ProviderDefinition;

export const justwokerProvider = {
	id: "justwoker",
	name: "JustWorker",
} as const satisfies ProviderDefinition;

export const justwokerAnthropicProvider = {
	id: "justwoker-anthropic",
	name: "JustWorker (Anthropic)",
} as const satisfies ProviderDefinition;
