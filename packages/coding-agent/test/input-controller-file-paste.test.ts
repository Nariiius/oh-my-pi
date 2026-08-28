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
import {
	extractFileMentions,
	generateFileMentionMessages,
} from "@oh-my-pi/pi-coding-agent/utils/file-mentions";

const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

function createContext() {
	const insertFileAttachment = vi.fn<(path: string, expansion: string, size?: number) => void>();
	const editor = {
		pendingImages: [] as Array<{ type: string; data: string; mimeType: string }>,
		pendingImageLinks: [] as (string | undefined)[],
		imageLinks: undefined as (string | undefined)[] | undefined,
		insertFileAttachment,
	} as unknown as InteractiveModeContext["editor"];
	const ctx = {
		editor,
		sessionManager: {
			putBlobSync: () => ({ displayPath: "file:///blob/1.png" }),
		} as unknown as InteractiveModeContext["sessionManager"],
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx);
	return { controller, editor, insertFileAttachment };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("InputController.handleFilePaste", () => {
	it("stages a non-image file as a chip whose expansion embeds the file", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-"));
		const file = path.join(dir, "notes.ts");
		await fs.writeFile(file, "const answer = 42;\n");

		const { controller, insertFileAttachment } = createContext();
		const replacement = controller.handleFilePaste(file);

		expect(replacement).toBe("");
		expect(insertFileAttachment).toHaveBeenCalledWith(file, `@${file}`, "const answer = 42;\n".length);
		// The staged expansion round-trips through the submit-time auto-read pipeline.
		const mention = insertFileAttachment.mock.calls[0]![1];
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

		const { controller, insertFileAttachment } = createContext();
		const replacement = controller.handleFilePaste(file);

		expect(replacement).toBe("");
		expect(insertFileAttachment).toHaveBeenCalledWith(file, `@"${file}"`, "# embedded\n".length);
		const mention = insertFileAttachment.mock.calls[0]![1];
		const mentions = extractFileMentions(`link ${mention} `);
		expect(mentions).toEqual([file]);
		const messages = await generateFileMentionMessages(mentions, dir);
		expect(messages).toHaveLength(1);
		const files = (messages[0] as { files: Array<{ path: string; content: string }> }).files;
		expect(files[0].content).toContain("# embedded");

		await fs.rm(dir, { recursive: true, force: true });
	});

	it("keeps raw text when the pasted path does not exist", () => {
		const { controller, insertFileAttachment } = createContext();
		expect(controller.handleFilePaste("/no/such/file-here.ts")).toBeUndefined();
		expect(insertFileAttachment).not.toHaveBeenCalled();
	});

	it("keeps raw text for empty or whitespace-only input", () => {
		const { controller, insertFileAttachment } = createContext();
		expect(controller.handleFilePaste("   ")).toBeUndefined();
		expect(insertFileAttachment).not.toHaveBeenCalled();
	});

	it("still stages image files as [Image #N] attachments", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-paste-img-"));
		const file = path.join(dir, "pic.png");
		await fs.writeFile(file, TINY_PNG);

		const { controller, editor, insertFileAttachment } = createContext();
		const replacement = controller.handleFilePaste(file);

		expect(replacement).toBe("[Image #1] ");
		expect(insertFileAttachment).not.toHaveBeenCalled();
		expect(editor.pendingImages).toHaveLength(1);
		expect((editor.pendingImages[0] as { mimeType: string }).mimeType).toBe("image/png");
		expect(editor.pendingImageLinks).toEqual(["file:///blob/1.png"]);

		await fs.rm(dir, { recursive: true, force: true });
	});
});
