/**
 * Wire-level verification that the model probe dispatches correctly through
 * every API family omp supports. Each case mocks the provider endpoint with a
 * `fetch` injected into `createModelProbe` and asserts the request shape a real
 * session would send (endpoint, auth header, model id, output-token cap), then
 * feeds back the provider's real wire format.
 *
 * Bedrock (`bedrock-converse-stream`) and Vertex (`google-vertex`) authenticate
 * via AWS SigV4 / Application Default Credentials instead of bearer keys, so
 * they are exercised by the same `completeSimple` dispatch as every other API
 * here — a probe without credentials surfaces a clear configuration error
 * rather than a protocol mismatch.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Api, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createModelProbe } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

function makeModel(api: Api, id: string, baseUrl: string, extra: Record<string, unknown> = {}): Model<Api> {
	return buildModel({
		id,
		name: id,
		api,
		provider: "mock-provider",
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 16_384,
		...extra,
	}) as Model<Api>;
}

/** Registry stand-in: the probe only resolves the API key through `resolver`. */
function fakeRegistry(): ModelRegistry {
	return { resolver: () => async () => "test-key" } as unknown as ModelRegistry;
}

function sseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

/** Anthropic's SDK stream uses `event:` + `data:` line pairs. */
function anthropicSseResponse(events: Array<{ type: string }>): Response {
	const payload = `${events
		.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join("")}event: message_stop\ndata: {}\n\n`;
	return new Response(payload, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function headerOf(init: RequestInit | undefined, name: string): string | null {
	return new Headers(init?.headers).get(name);
}

function bodyOf(init: RequestInit | undefined): Record<string, unknown> {
	return JSON.parse(String(init?.body)) as Record<string, unknown>;
}

const RESPONSES_EVENTS = [
	{ type: "response.created", response: { id: "resp_1", status: "in_progress" } },
	{
		type: "response.output_item.added",
		item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] },
	},
	{ type: "response.content_part.added", part: { type: "output_text", text: "" } },
	{ type: "response.output_text.delta", delta: "OK" },
	{
		type: "response.output_item.done",
		item: {
			type: "message",
			id: "msg_1",
			role: "assistant",
			status: "completed",
			content: [{ type: "output_text", text: "OK" }],
		},
	},
	{
		type: "response.completed",
		response: {
			id: "resp_1",
			status: "completed",
			usage: { input_tokens: 5, output_tokens: 1, total_tokens: 6, input_tokens_details: { cached_tokens: 0 } },
		},
	},
];

const ANTHROPIC_EVENTS = [
	{
		type: "message_start",
		message: {
			id: "msg_1",
			usage: { input_tokens: 5, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
		},
	},
	{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
	{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
	{ type: "content_block_stop", index: 0 },
	{
		type: "message_delta",
		delta: { stop_reason: "end_turn" },
		usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
	},
	{ type: "message_stop" },
];

describe("createModelProbe across every API family", () => {
	let tempDir = "";

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "models-probe-apis-"));
	});

	afterEach(async () => {
		await removeSyncWithRetries(tempDir);
	});

	async function probe(model: Model<Api>, fetch: FetchImpl): Promise<boolean> {
		const result = await createModelProbe(fakeRegistry(), 5_000, fetch)(model);
		return result.ok;
	}

	test("openai-completions hits /chat/completions with Bearer auth and max_completion_tokens", async () => {
		const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
		const fetch: FetchImpl = async (input, init) => {
			seen.push({
				url: String(input),
				body: bodyOf(init),
				auth: headerOf(init, "authorization"),
			});
			return sseResponse([
				{
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-completions",
					choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }],
				},
				{
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-completions",
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				{
					id: "chatcmpl-1",
					object: "chat.completion.chunk",
					created: 1,
					model: "mock-completions",
					choices: [],
					usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
				},
			]);
		};

		const ok = await probe(makeModel("openai-completions", "mock-completions", "http://127.0.0.1:9/v1"), fetch);

		expect(ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe("http://127.0.0.1:9/v1/chat/completions");
		expect(seen[0]!.auth).toBe("Bearer test-key");
		expect(seen[0]!.body.model).toBe("mock-completions");
		expect(seen[0]!.body.max_completion_tokens).toBe(16);
	});

	test("openai-responses hits /responses with Bearer auth and max_output_tokens", async () => {
		const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
		const fetch: FetchImpl = async (input, init) => {
			seen.push({ url: String(input), body: bodyOf(init), auth: headerOf(init, "authorization") });
			return sseResponse(RESPONSES_EVENTS);
		};

		const ok = await probe(makeModel("openai-responses", "mock-responses", "http://127.0.0.1:9/v1"), fetch);

		expect(ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe("http://127.0.0.1:9/v1/responses");
		expect(seen[0]!.auth).toBe("Bearer test-key");
		expect(seen[0]!.body.model).toBe("mock-responses");
		expect(seen[0]!.body.max_output_tokens).toBe(16);
	});

	test("anthropic-messages hits /v1/messages with Bearer auth and max_tokens", async () => {
		const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
		const fetch: FetchImpl = async (input, init) => {
			seen.push({ url: String(input), body: bodyOf(init), auth: headerOf(init, "authorization") });
			return anthropicSseResponse(ANTHROPIC_EVENTS);
		};

		const ok = await probe(makeModel("anthropic-messages", "mock-anthropic", "http://127.0.0.1:9"), fetch);

		expect(ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe("http://127.0.0.1:9/v1/messages");
		expect(seen[0]!.auth).toBe("Bearer test-key");
		expect(seen[0]!.body.model).toBe("mock-anthropic");
		expect(seen[0]!.body.max_tokens).toBe(16);
	});

	test("google-generative-ai hits :streamGenerateContent with x-goog-api-key and maxOutputTokens", async () => {
		const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
		const fetch: FetchImpl = async (input, init) => {
			seen.push({ url: String(input), body: bodyOf(init), auth: headerOf(init, "x-goog-api-key") });
			return sseResponse([
				{ candidates: [{ content: { role: "model", parts: [{ text: "OK" }] }, finishReason: "STOP" }] },
			]);
		};

		const ok = await probe(makeModel("google-generative-ai", "gemini-mock", "http://127.0.0.1:9/v1beta"), fetch);

		expect(ok).toBe(true);
		expect(seen).toHaveLength(1);
		const url = new URL(seen[0]!.url);
		expect(url.pathname).toBe("/v1beta/models/gemini-mock:streamGenerateContent");
		expect(url.searchParams.get("alt")).toBe("sse");
		expect(seen[0]!.auth).toBe("test-key");
		expect((seen[0]!.body.generationConfig as { maxOutputTokens?: number }).maxOutputTokens).toBe(16);
	});

	test("openai-codex-responses (HTTP transport) hits /responses and carries no sampling params", async () => {
		const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
		const fetch: FetchImpl = async (input, init) => {
			seen.push({ url: String(input), body: bodyOf(init), auth: headerOf(init, "authorization") });
			return sseResponse(RESPONSES_EVENTS);
		};

		const ok = await probe(
			makeModel("openai-codex-responses", "codex-mock", "http://127.0.0.1:9/backend-api/codex", {
				preferWebsockets: false,
			}),
			fetch,
		);

		expect(ok).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]!.url).toBe("http://127.0.0.1:9/backend-api/codex/responses");
		expect(seen[0]!.auth).toBe("Bearer test-key");
		expect(seen[0]!.body.model).toBe("codex-mock");
		// The Codex provider strips caller-supplied output caps (the backend
		// rejects them) and refuses sampling controls with 400s (#3117); the
		// probe must never send either.
		for (const key of [
			"max_output_tokens",
			"max_completion_tokens",
			"temperature",
			"top_p",
			"topP",
			"presence_penalty",
			"frequency_penalty",
		]) {
			expect(seen[0]!.body[key]).toBeUndefined();
		}
	});

	test("azure-openai-responses hits /responses?api-version= with api-key header", async () => {
		const seen: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
		const fetch: FetchImpl = async (input, init) => {
			seen.push({ url: String(input), body: bodyOf(init), auth: headerOf(init, "api-key") });
			return sseResponse(RESPONSES_EVENTS);
		};

		const ok = await probe(makeModel("azure-openai-responses", "azure-mock", "http://127.0.0.1:9/openai/v1"), fetch);

		expect(ok).toBe(true);
		expect(seen).toHaveLength(1);
		const url = new URL(seen[0]!.url);
		expect(url.pathname).toBe("/openai/v1/responses");
		expect(url.searchParams.get("api-version")).toBeTruthy();
		expect(seen[0]!.auth).toBe("test-key");
		expect(seen[0]!.body.model).toBe("azure-mock");
		expect(seen[0]!.body.max_output_tokens).toBe(16);
	});

	test("a provider that 404s surfaces the failure with its HTTP status", async () => {
		const fetch: FetchImpl = async () =>
			new Response(JSON.stringify({ error: { message: "model not found", type: "invalid_request_error" } }), {
				status: 404,
				headers: { "content-type": "application/json" },
			});

		const result = await createModelProbe(
			fakeRegistry(),
			5_000,
			fetch,
		)(makeModel("openai-completions", "missing-model", "http://127.0.0.1:9/v1"));

		expect(result.ok).toBe(false);
		expect(result.errorStatus).toBe(404);
		expect(result.error).toContain("model not found");
	});
});
