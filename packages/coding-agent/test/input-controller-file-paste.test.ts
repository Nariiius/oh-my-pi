/**
 * File-path paste hook (`InputController.handleFilePaste`): pasting or dropping a file path
 * into the composer must produce a file chip whose submit-time expansion embeds the file.
 *
 * Regression: the non-image branch previously replaced the path with a `[File: basename]`
 * label (SGR/OSC 8 styling stripped by the editor's paste sanitizer), so the buffer carried
 * no resolvable `@path` and the auto-read extractor never embedded the file — the model only
 * saw the label. The branch now stages a file chip whose atom expands to an `@`-mention,
 * riding the same embed-on-submit pipeline as the `@`-completion selector.
 */

import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { extractFileMentions, generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function createContext() {
	const insertTextAttachment = vi.fn<(content: string, expansion?: string) => void>();
	const editor = {
		pendingImages: [] as Array<{ type: string; data: string; mimeType: string }>,
		pendingImageLinks: [] as (string | undefined)[],
		pasteText: vi.fn(),
		imageLinks: undefined as (string | undefined)[] | undefined,
		insertTextAttachment,
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		ui: { getFocused: () => null, requestRender: vi.fn() },
		showStatus: vi.fn(),
		editor,
		sessionManager: {
			putBlob: async () => ({ displayPath: "file:///blob/1.png" }),
			putBlobSync: () => ({ displayPath: "file:///blob/1.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	return { controller, editor, insertTextAttachment };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InputController.handleFilePaste", () => {
	it("stages a non-image file as a chip whose expansion embeds the file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-"));
		const file = path.join(dir, "notes.ts");
		await fs.writeFile(file, "const answer = 42;\n");

		const { controller, insertTextAttachment } = createContext();
		const replacement = await controller.handleFilePaste(file);

		expect(replacement).toBe("");
		expect(insertTextAttachment).toHaveBeenCalledWith(file, `@${file}`);
		// The staged expansion round-trips through the submit-time auto-read pipeline.
		const mention = insertTextAttachment.mock.calls[0]![1];
		const mentions = extractFileMentions(`see ${mention} `);
		expect(mentions).toEqual([file]);
		const messages = await generateFileMentionMessages(mentions, dir);
		expect(messages).toHaveLength(1);
		const files = (messages[0] as { files: Array<{ path: string; content: string }> }).files;
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe(file);
		expect(files[0].content).toContain("const answer = 42;");

		await fs.rm(dir, { recursive: true, force: true });
	});

	it("quotes paths with spaces so the mention still embeds", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste space "));
		const file = path.join(dir, "my notes.md");
		await fs.writeFile(file, "# embedded\n");

		const { controller, insertTextAttachment } = createContext();
		const replacement = await controller.handleFilePaste(file);

		expect(replacement).toBe("");
		expect(insertTextAttachment).toHaveBeenCalledWith(file, `@"${file}"`);
		const mention = insertTextAttachment.mock.calls[0]![1];
		const mentions = extractFileMentions(`link ${mention} `);
		expect(mentions).toEqual([file]);
		const messages = await generateFileMentionMessages(mentions, dir);
		expect(messages).toHaveLength(1);
		const files = (messages[0] as { files: Array<{ path: string; content: string }> }).files;
		expect(files[0].content).toContain("# embedded");

		await fs.rm(dir, { recursive: true, force: true });
	});

	it("keeps raw text when the pasted path does not exist", async () => {
		const { controller, insertTextAttachment } = createContext();
		expect(await controller.handleFilePaste("/no/such/file-here.ts")).toBeUndefined();
		expect(insertTextAttachment).not.toHaveBeenCalled();
	});

	it("keeps raw text for empty or whitespace-only input", async () => {
		const { controller, insertTextAttachment } = createContext();
		expect(await controller.handleFilePaste("   ")).toBeUndefined();
		expect(insertTextAttachment).not.toHaveBeenCalled();
	});

	it("still stages image files as [Image #N] attachments", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-img-"));
		const file = path.join(dir, "pic.png");
		await fs.writeFile(file, TINY_PNG);

		const { controller, insertTextAttachment } = createContext();
		const replacement = await controller.handleFilePaste(file);

		expect(replacement).toBe("");
		expect(insertTextAttachment).not.toHaveBeenCalled();

		await fs.rm(dir, { recursive: true, force: true });
	});
});
