import { describe, expect, it } from "bun:test";
import * as path from "node:path";

describe("guard extension redactUnknown binary preservation", () => {
	it("preserves Uint8Array, Buffer, and ArrayBuffer instances without converting to plain objects", async () => {
		// Dynamic import exercises external user extension file located outside the package tree.
		const guardPath = path.resolve(__dirname, "../../../../omp-setup/agent/extensions/guard.ts");
		const guardModule = await import(guardPath);

		// Emulate ExtensionAPI
		let beforeProviderHandler: ((event: { payload: unknown }) => Promise<unknown>) | undefined;
		const mockPi = {
			on: (event: string, handler: (event: { payload: unknown }) => Promise<unknown>) => {
				if (event === "before_provider_request") {
					beforeProviderHandler = handler;
				}
			},
			registerCommand: () => {},
			setLabel: () => {},
		};
		guardModule.default(mockPi as never);
		expect(beforeProviderHandler).toBeDefined();

		const originalBytes = new Uint8Array([10, 20, 30, 40]);
		const originalBuffer = Buffer.from([50, 60, 70]);
		const originalArrayBuffer = new Uint8Array([80, 90]).buffer;

		const payload = {
			conversationState: {
				rootPromptMessagesJson: [originalBytes],
				turns: [originalBytes],
			},
			bufferField: originalBuffer,
			arrayBufferField: originalArrayBuffer,
			secretField: ["gh", "p_123456789012345678901234567890"].join(""),
			normalText: "hello world",
		};

		const result = (await beforeProviderHandler!({ payload })) as typeof payload;

		// Binary types must be preserved
		expect(result.conversationState.rootPromptMessagesJson[0]).toBeInstanceOf(Uint8Array);
		expect(result.conversationState.rootPromptMessagesJson[0]).toEqual(originalBytes);
		expect(result.conversationState.turns[0]).toBeInstanceOf(Uint8Array);
		expect(result.bufferField).toBeInstanceOf(Uint8Array);
		expect(result.arrayBufferField).toBeInstanceOf(ArrayBuffer);

		// Secret must still be redacted
		expect(result.secretField).toContain("[REDACTED:GitHub Token]");
		expect(result.normalText).toBe("hello world");
	});
});
