import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { beforeAll, describe, expect, it, spyOn } from "bun:test";
import { AttachmentChipsBand } from "@oh-my-pi/pi-tui/prompt/attachment-chips";
import { CustomEditor } from "@oh-my-pi/pi-tui/prompt/custom-editor";
import { chipLabel } from "@oh-my-pi/pi-tui/prompt/composer-attachments";
import { getEditorTheme, initTheme } from "@oh-my-pi/pi-tui/theme";
import { ImageBudget } from "@oh-my-pi/pi-tui";
import { setKittyGraphics } from "@oh-my-pi/pi-tui/kitty-graphics";
import { getCellDimensions, ImageProtocol, setCellDimensions, TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { visibleWidth } from "@oh-my-pi/pi-tui/utils";
import type { DescribeContext } from "@oh-my-pi/pi-tui/native/node";
import { applyHyperlinkSetting } from "@oh-my-pi/pi-tui/render/hyperlink";
import { theme } from "@oh-my-pi/pi-tui/theme/theme";

const nativeContext: DescribeContext = {
	cols: 80,
	reduceMotion: false,
	dark: true,
	supports: () => true,
	feature: () => false,
};

// 2x2 red PNG — real header so the band's dimension probe decodes 2x2.
const TINY_PNG =
	"iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEklEQVR4nGP8z8DwnwEKmBhQAAA9+AQBHYLp7wAAAABJRU5ErkJggg==";

function makeBand(): { editor: CustomEditor; band: AttachmentChipsBand } {
	const editor = new CustomEditor(getEditorTheme());
	return { editor, band: new AttachmentChipsBand(editor, new ImageBudget(8), () => {}) };
}

beforeAll(async () => {
	await initTheme(false);
});

describe("AttachmentChipsBand", () => {
	it("renders nothing while no attachment is staged", () => {
		const { band } = makeBand();
		expect(band.render(80)).toEqual([]);
	});

	it("renders a 6-row card with the chip token caption and paste line caption", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("line1\nline2\nline3");
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows).toHaveLength(6);
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[5]).toContain("+3 lines");
		// Snippet: leading content rows inside the border rails.
		expect(rows[1]).toContain("line1");
		expect(rows[2]).toContain("line2");
	});

	it("renders a file basename and path caption, hiding it after its token is deleted", () => {
		const { editor, band } = makeBand();
		const label = editor.stageFileAttachment("/tmp/a.ts", "@/tmp/a.ts");
		editor.insertText(label);
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows).toHaveLength(6);
		expect(rows[0]).toContain(label);
		expect(rows[1]).toContain("a.ts");
		expect(rows[5]).toContain("/tmp/a.ts");
		for (const row of rows) expect(visibleWidth(row)).toBe(14);
		editor.setText("no token here");
		expect(band.render(80)).toEqual([]);
		expect(band.describe(nativeContext)).toMatchObject({ p: { hidden: true }, c: [] });
	});

	it("describes a native file card with its identity, basename, shortened caption and encoded links", () => {
		const { editor, band } = makeBand();
		const filePath = path.join(os.homedir(), "notes", "a #1.ts");
		const label = editor.stageFileAttachment(filePath, `@${filePath}`);
		editor.insertText(label);
		const href = url.pathToFileURL(filePath).href;
		expect(band.describe(nativeContext)).toMatchObject({
			k: "row",
			p: { role: "omp.composer.chips", hidden: false },
			c: [
				{
					k: "card",
					key: "file:1",
					p: { role: "omp.composer.chip", head: [{ t: label, href }] },
					c: [
						{ k: "text", p: { spans: [{ t: "a #1.ts" }] } },
						{ k: "text", p: { spans: [{ t: "~/notes/a #1.ts", href }] } },
					],
				},
			],
		});
	});

	it("keeps unsafe filename controls out of both file card renderers without changing the link target", () => {
		const { editor, band } = makeBand();
		const filePath = "/tmp/\x1b[31mnote\n\x07.txt";
		const label = editor.stageFileAttachment(filePath, `@${filePath}`);
		editor.insertText(label);
		applyHyperlinkSetting("always");
		try {
			const ansiRows = band.render(80);
			expect(ansiRows[0]).toContain(url.pathToFileURL(filePath).href);
			expect(ansiRows[5]).toContain(url.pathToFileURL(filePath).href);
			expect(ansiRows.join("")).not.toContain("\x1b[31m");
			expect(ansiRows.join("")).not.toContain("\x07");
			expect(Bun.stripANSI(ansiRows[1])).toContain("note .txt");
			for (const row of ansiRows) {
				expect(row).not.toContain("\n");
				expect(visibleWidth(row)).toBe(14);
			}
			expect(band.describe(nativeContext)).toMatchObject({
				c: [
					{
						key: "file:1",
						c: [
							{ k: "text", p: { spans: [{ t: "note .txt" }] } },
							{ k: "text", p: { spans: [{ t: "/tmp/note .txt", href: url.pathToFileURL(filePath).href }] } },
						],
					},
				],
			});
		} finally {
			applyHyperlinkSetting("auto");
		}
	});

	it("shows file #10 without treating it as a reference to file #1", () => {
		const { editor, band } = makeBand();
		let label = "";
		for (let n = 1; n <= 10; n++) label = editor.stageFileAttachment(`/tmp/${n}.ts`, `@/tmp/${n}.ts`);
		editor.insertText(label);
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows[0]).toContain(chipLabel("file", 10));
		expect(rows[1]).toContain("10.ts");
		for (const row of rows) expect(visibleWidth(row)).toBe(14);
		expect(band.describe(nativeContext)).toMatchObject({ c: [{ key: "file:10" }] });
	});

	it("keeps a recorded file identity when a theme override uses another attachment glyph", () => {
		const { editor, band } = makeBand();
		const symbol = theme.symbol.bind(theme);
		const override = spyOn(theme, "symbol").mockImplementation(key => (key === "chip.file" ? "img" : symbol(key)));
		let label: string;
		try {
			label = editor.stageFileAttachment("/tmp/a.ts", "@/tmp/a.ts");
		} finally {
			override.mockRestore();
		}
		editor.insertText(label);
		expect(Bun.stripANSI(band.render(80)[0])).toContain("img #1");
		expect(band.describe(nativeContext)).toMatchObject({
			c: [
				{
					key: "file:1",
					p: { head: [{ t: "img #1" }] },
					c: [{ p: { spans: [{ t: "a.ts" }] } }, { p: { spans: [{ t: "/tmp/a.ts" }] } }],
				},
			],
		});
	});

	it("captions a single-line paste with its character count", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("x".repeat(42));
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows[5]).toContain("42 chars");
	});

	it("hides the card once its inline token is deleted from the buffer", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("line1\nline2");
		expect(band.render(80)).toHaveLength(6);
		editor.setText("no token here");
		expect(band.render(80)).toEqual([]);
	});

	it("captions an image card with probed pixel dimensions and shows both cards side by side", () => {
		const { editor, band } = makeBand();
		editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
		editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
		editor.insertTextAttachment("hello");
		const rows = band.render(80).map(Bun.stripANSI);
		expect(rows).toHaveLength(6);
		expect(rows[0]).toContain(chipLabel("image", 1));
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[5]).toContain("2x2");
		expect(rows[5]).toContain("5 chars");
	});

	it("renders a contact-sheet preview under a distinct video chip", () => {
		const { editor, band } = makeBand();
		editor.pendingImages.push({ type: "image", data: TINY_PNG, mimeType: "image/png" });
		editor.pendingImageLinks.push("/tmp/launch.mp4");
		editor.insertAtom(chipLabel("video", 1), "[Video #1, 2x2]");

		const rows = band.render(80).map(Bun.stripANSI);

		expect(rows[0]).toContain(chipLabel("video", 1));
		expect(rows[0]).not.toContain(chipLabel("image", 1));
		expect(rows[5]).toContain("2x2");
	});

	it("omits cards that do not fit the terminal width instead of wrapping", () => {
		const { editor, band } = makeBand();
		editor.insertTextAttachment("first");
		editor.insertTextAttachment("second");
		// 14 cols per card + 2 gap: at width 20 only the first card fits.
		const rows = band.render(20).map(Bun.stripANSI);
		expect(rows[0]).toContain(chipLabel("paste", 1));
		expect(rows[0]).not.toContain(chipLabel("paste", 2));
	});
});

describe("AttachmentChipsBand — Kitty placeholder thumbnails", () => {
	it("keeps every card row exactly card-width so the borders align", () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		mutable.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			// Real PNG header for 560x502 so the probe yields a >1-column grid.
			const header = Buffer.alloc(33);
			header.write("\x89PNG\r\n\x1a\n", 0, "binary");
			header.writeUInt32BE(13, 8);
			header.write("IHDR", 12);
			header.writeUInt32BE(560, 16);
			header.writeUInt32BE(502, 20);
			const { editor, band } = makeBand();
			editor.pendingImages.push({ type: "image", data: header.toString("base64"), mimeType: "image/png" });
			editor.insertAtom(chipLabel("image", 1), "[Image #1, 560x502]");
			const rows = band.render(80);
			expect(rows).toHaveLength(6);
			// Thumbnail path actually engaged: the placement APC rides row 1.
			expect(rows[1]).toContain("\x1b_Ga=p,U=1");
			// Regression: the placement APC was counted as visible width, which
			// dropped row 1's centering pad and painted its right border 3 cells
			// inside the card. Every row must measure exactly the card width.
			for (const row of rows) {
				expect(visibleWidth(row)).toBe(14);
			}
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});
	it("converts a non-PNG attachment before the Kitty transmit (f=100 accepts only PNG)", async () => {
		const mutable = TERMINAL as unknown as { imageProtocol: ImageProtocol | null };
		const originalProtocol = TERMINAL.imageProtocol;
		const originalCellDims = { ...getCellDimensions() };
		mutable.imageProtocol = ImageProtocol.Kitty;
		setKittyGraphics({ unicodePlaceholders: true });
		setCellDimensions({ widthPx: 10, heightPx: 21 });
		try {
			// Regression: pasted images are re-encoded JPEG/WebP; transmitting those raw
			// bytes as f=100 made Ghostty reject the data (EINVAL) and render blank cells.
			const jpeg = await new Bun.Image(Buffer.from(TINY_PNG, "base64")).jpeg().toBase64();
			const editor = new CustomEditor(getEditorTheme());
			const budget = new ImageBudget(8);
			const repaint = Promise.withResolvers<void>();
			const band = new AttachmentChipsBand(editor, budget, () => repaint.resolve());
			editor.pendingImages.push({ type: "image", data: jpeg, mimeType: "image/jpeg" });
			editor.insertAtom(chipLabel("image", 1), "[Image #1, 2x2]");
			// Conversion in flight: icon fallback, nothing transmitted yet.
			band.render(80);
			expect(budget.hasPendingTransmits()).toBe(false);
			await repaint.promise;
			const rows = band.render(80);
			expect(rows.some(row => row.includes("\x1b_Ga=p,U=1"))).toBe(true);
			const transmits = budget.takeTransmits();
			expect(transmits).toHaveLength(1);
			const payload = transmits[0]!.slice(transmits[0]!.indexOf(";") + 1);
			expect(payload.startsWith("iVBOR")).toBe(true);
		} finally {
			mutable.imageProtocol = originalProtocol;
			setKittyGraphics({ unicodePlaceholders: false });
			setCellDimensions(originalCellDims);
		}
	});
});
