import type { KnownProvider } from "@oh-my-pi/pi-catalog";
import { authProviders } from "@oh-my-pi/pi-catalog/compat/auth";
import type { AuthProviderId, LoginProviderId } from "@oh-my-pi/pi-catalog/compat/auth-ids";
import { agentrouterAnthropicProvider, agentrouterProvider } from "./agentrouter";
import { gorouterAnthropicProvider, gorouterProvider } from "./gorouter";
import {
	justdoworkAnthropicProvider,
	justdoworkProvider,
	justwokerAnthropicProvider,
	justwokerProvider,
} from "./justdowork";
import { kktokenAnthropicProvider, kktokenProvider } from "./kktoken";
import { tabitokenAnthropicProvider, tabitokenProvider } from "./tabitoken";
import { tokenforgeAnthropicProvider, tokenforgeProvider } from "./tokenforge";
import { amazonBedrockTransport } from "./amazon-bedrock";
import { bedrockMantleTransport } from "./bedrock-mantle";
import { buildProviderDefinition, type ProviderTransport } from "./build";
import { cloudflareAiGatewayTransport } from "./cloudflare-ai-gateway";
import { museCodeTransport } from "./muse-code";
import { snowflakeTransport } from "./snowflake";
import type { ProviderDefinition } from "./types";

/**
 * TypeScript-side request/model shaping for providers whose transport needs
 * code beside the KDL auth policy. Keyed by provider id; every other provider
 * is fully described by `rules/auth/<id>.kdl`.
 */
const TRANSPORTS: Record<string, ProviderTransport> = {
	"amazon-bedrock": amazonBedrockTransport,
	"bedrock-mantle": bedrockMantleTransport,
	"cloudflare-ai-gateway": cloudflareAiGatewayTransport,
	"muse-code": museCodeTransport,
	snowflake: snowflakeTransport,
};

const CUSTOM_PROVIDERS: readonly ProviderDefinition[] = [
	agentrouterProvider,
	agentrouterAnthropicProvider,
	justdoworkProvider,
	justdoworkAnthropicProvider,
	justwokerProvider,
	justwokerAnthropicProvider,
	tabitokenProvider,
	tabitokenAnthropicProvider,
	gorouterProvider,
	gorouterAnthropicProvider,
	kktokenProvider,
	kktokenAnthropicProvider,
	tokenforgeProvider,
	tokenforgeAnthropicProvider,
];

/**
 * The single per-provider list, derived from the compiled auth stratum
 * (`@oh-my-pi/pi-catalog` `rules/auth/*.kdl`) in `/login` display order.
 * Adding a provider = one new `auth/<id>.kdl` (plus a `TRANSPORTS` entry when
 * it shapes requests in code). Every legacy structure (`OAuthProvider` union,
 * env map, login list, refresh/login dispatch, CLI callback maps) derives
 * from this registry.
 */
export const PROVIDER_REGISTRY: readonly ProviderDefinition[] = [
	...CUSTOM_PROVIDERS,
	...authProviders().map(policy => buildProviderDefinition(policy, TRANSPORTS[policy.id])),
];

const BY_ID: Record<string, ProviderDefinition> = Object.fromEntries(PROVIDER_REGISTRY.map(p => [p.id, p]));

export function getProviderDefinition(id: string): ProviderDefinition | undefined {
	return BY_ID[id];
}

type CustomProviderId =
	| "agentrouter"
	| "agentrouter-anthropic"
	| "justdowork"
	| "justdowork-anthropic"
	| "justwoker"
	| "justwoker-anthropic"
	| "tabitoken"
	| "tabitoken-anthropic"
	| "gorouter"
	| "gorouter-anthropic"
	| "kktoken"
	| "kktoken-anthropic"
	| "tokenforge"
	| "tokenforge-anthropic";

/** Compile-time completeness: every catalog chat-model provider must have an auth policy. */
type _MissingCatalogProviders = Exclude<KnownProvider, AuthProviderId | CustomProviderId>;
type _CheckRegistryComplete = _MissingCatalogProviders extends never
	? true
	: ["auth rules are missing catalog providers", _MissingCatalogProviders];
true satisfies _CheckRegistryComplete;

/** Loginable providers (those whose auth policy declares a `login` flow). */
export type OAuthProviderUnion = LoginProviderId;
