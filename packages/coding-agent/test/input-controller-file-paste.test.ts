import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { getEditorTheme } from "@oh-my-pi/pi-tui/theme/tui-adapters";
import { InputController } from "@oh-my-pi/pi-coding-agent/modes/controllers/input-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { FileMentionMessage } from "@oh-my-pi/pi-coding-agent/session/messages";
import { extractFileMentions, generateFileMentionMessages } from "@oh-my-pi/pi-coding-agent/utils/file-mentions";

const directories: string[] = [];
const TINY_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

async function createDirectory(root = os.tmpdir()): Promise<string> {
	const directory = await fs.mkdtemp(path.join(root, "omp-file-paste-"));
	directories.push(directory);
	return directory;
}

function createContext(cwd: string, clipboardText = "", focused?: { pasteText(text: string): void }) {
	const editor = new CustomEditor(getEditorTheme());
	const ctx = {
		ui: { getFocused: () => focused ?? editor, requestRender: vi.fn() },
		showStatus: vi.fn(),
		editor,
		sessionManager: { getCwd: () => cwd },
	} as unknown as InteractiveModeContext;
	const controller = new InputController(ctx, {
		readImage: async () => null,
		readText: async () => clipboardText,
	});
	editor.onPasteFilePath = file => controller.handleFilePaste(file);
	return { controller, editor };
}

async function embeddedFiles(editor: CustomEditor, cwd: string): Promise<FileMentionMessage["files"]> {
	const messages = await generateFileMentionMessages(extractFileMentions(editor.getExpandedText()), cwd, {
		autoResizeImages: false,
	});
	return messages.flatMap(message => (message as FileMentionMessage).files);
}

afterEach(async () => {
	await Promise.all(directories.splice(0).map(directory => fs.rm(directory, { recursive: true, force: true })));
	vi.restoreAllMocks();
});

describe("InputController file-path paste", () => {
	it.each([
		"notes.ts",
		"my notes.md",
		"single'quote.txt",
		'double"quote.txt',
		"at@name.txt",
		"closing)name.txt",
		"closing]name.txt",
		"trailing!",
	])("stages %s without changing the buffer and embeds its content after insertion", async name => {
		const cwd = await createDirectory();
		const file = path.join(cwd, name);
		await Bun.write(file, "const answer = 42;\n");
		const { controller, editor } = createContext(cwd);
		editor.setText("see ");

		const replacement = controller.handleFilePaste(file);
		expect(editor.getText()).toBe("see ");
		expect(replacement).toBeDefined();
		editor.pasteText(replacement!);
		expect(editor.composerChips().map(chip => chip.kind)).toEqual(["file"]);
		expect(extractFileMentions(editor.getExpandedText())).toEqual([file]);
		const files = await embeddedFiles(editor, cwd);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe(file);
		expect(files[0].content).toContain("const answer = 42;");
	});

	it("uses the resolved path when shell escapes change the pasted spelling", async () => {
		const cwd = await createDirectory();
		const file = path.join(cwd, "escaped notes.txt");
		await Bun.write(file, "normalized file content\n");
		const { controller, editor } = createContext(cwd);
		editor.pasteText(controller.handleFilePaste(file.replaceAll(" ", "\\ "))!);
		expect(extractFileMentions(editor.getExpandedText())).toEqual([file]);
		expect(editor.pendingFiles[0].path).toBe(file);
		expect((await embeddedFiles(editor, cwd))[0].content).toContain("normalized file content");
	});

	it("resolves relative paths against the session cwd, not the process cwd", async () => {
		const cwd = await createDirectory();
		await Bun.write(path.join(cwd, "relative.txt"), "relative file content\n");
		const { controller, editor } = createContext(cwd);
		editor.pasteText(controller.handleFilePaste("./relative.txt")!);
		expect((await embeddedFiles(editor, cwd))[0].content).toContain("relative file content");
	});

	it("resolves home-relative paths through the existing read-path convention", async () => {
		const cwd = await createDirectory(os.homedir());
		const file = path.join(cwd, "home.txt");
		await Bun.write(file, "home file content\n");
		const pasted = `~/${path.relative(os.homedir(), file)}`;
		const { controller, editor } = createContext(os.tmpdir());
		editor.pasteText(controller.handleFilePaste(pasted)!);
		expect((await embeddedFiles(editor, os.tmpdir()))[0].content).toContain("home file content");
	});

	it("keeps missing files, directories, empty input, and unembeddable quote names as raw text", async () => {
		const cwd = await createDirectory();
		const bothQuotes = path.join(cwd, `both'and"quotes.txt`);
		await Bun.write(bothQuotes, "must not be staged\n");
		for (const raw of [path.join(cwd, "missing.txt"), cwd, "   ", bothQuotes]) {
			const { controller, editor } = createContext(cwd);
			const replacement = controller.handleFilePaste(raw);
			expect(replacement).toBeUndefined();
			editor.pasteText(replacement ?? raw);
			expect(editor.getText()).toBe(raw);
			expect(editor.composerChips()).toEqual([]);
			expect(await embeddedFiles(editor, cwd)).toEqual([]);
		}
	});

	it("deleting a file chip removes its submit-time file content", async () => {
		const cwd = await createDirectory();
		const file = path.join(cwd, "removed.txt");
		await Bun.write(file, "this must not be submitted\n");
		const { controller, editor } = createContext(cwd);
		editor.pasteText(controller.handleFilePaste(file)!);
		editor.handleInput("\x7f");
		expect(editor.getText()).toBe("");
		expect(editor.composerChips()).toEqual([]);
		expect(await embeddedFiles(editor, cwd)).toEqual([]);
	});

	it("bracketed paste followed by Enter submits an embeddable file mention", async () => {
		const cwd = await createDirectory();
		const file = path.join(cwd, "dropped notes.txt");
		await Bun.write(file, "bracketed-paste content\n");
		const { editor } = createContext(cwd);
		const { promise, resolve } = Promise.withResolvers<string>();
		editor.onSubmit = resolve;
		editor.handleInput(`\x1b[200~${file}\x1b[201~\r`);
		const submitted = await promise;
		const messages = await generateFileMentionMessages(extractFileMentions(submitted), cwd);
		expect((messages[0] as FileMentionMessage).files[0].content).toContain("bracketed-paste content");
	});

	it("guard draft paste preserves file ingestion and explicit submission", async () => {
		const cwd = await createDirectory();
		const file = path.join(cwd, "guard notes.txt");
		await Bun.write(file, "guard draft file content\n");
		const { editor } = createContext(cwd);
		const onSubmit = vi.fn();
		editor.onSubmit = onSubmit;
		editor.handleDraftEdit(`\x1b[200~${file}\x1b[201~`);
		expect(onSubmit).not.toHaveBeenCalled();
		expect(editor.composerChips().map(chip => chip.kind)).toEqual(["file"]);
		expect((await embeddedFiles(editor, cwd))[0].content).toContain("guard draft file content");
		editor.handleDraftEdit("\r");
		expect(extractFileMentions(onSubmit.mock.calls[0][0])).toEqual([file]);
	});

	it("the clipboard shortcut text fallback creates a file chip in the main editor", async () => {
		const cwd = await createDirectory();
		const file = path.join(cwd, "clipboard.txt");
		await Bun.write(file, "clipboard file content\n");
		const { controller, editor } = createContext(cwd, file);
		expect(await controller.handleImagePaste()).toBe(true);
		expect(editor.composerChips().map(chip => chip.kind)).toEqual(["file"]);
		expect((await embeddedFiles(editor, cwd))[0].content).toContain("clipboard file content");
	});

	it("the clipboard shortcut keeps file paths as plain text in a modal prompt", async () => {
		const cwd = await createDirectory();
		const file = path.join(cwd, "modal.txt");
		await Bun.write(file, "hidden main editor must stay unchanged\n");
		const pasteText = vi.fn();
		const { controller, editor } = createContext(cwd, file, { pasteText });
		expect(await controller.handleImagePaste()).toBe(true);
		expect(pasteText).toHaveBeenCalledWith(file);
		expect(editor.getText()).toBe("");
		expect(editor.composerChips()).toEqual([]);
	});

	it("generic image paths stage file tokens whose auto-read embeds image bytes", async () => {
		const cwd = await createDirectory();
		const file = path.join(cwd, "pic.png");
		await Bun.write(file, TINY_PNG);
		const { controller, editor } = createContext(cwd);
		editor.pasteText(controller.handleFilePaste(file)!);
		expect(editor.pendingImages).toEqual([]);
		expect(editor.composerChips().map(chip => chip.kind)).toEqual(["file"]);
		const files = await embeddedFiles(editor, cwd);
		expect(files[0].image).toEqual({ type: "image", mimeType: "image/png", data: TINY_PNG.toString("base64") });
	});
});
