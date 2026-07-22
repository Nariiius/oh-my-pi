import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import { type BlobPutResult, blobExtensionForImageMimeType } from "../session/blob-store";
import { fileHyperlink } from "../tui/hyperlink";

/** Probed pixel dimensions riding on the draft image object itself; `null` records a failed
 *  probe so the chips band never re-decodes a corrupt header every frame. */
const kImageDims = Symbol("omp.imageDimensions");

interface ImageContentWithDims extends ImageContent {
	[kImageDims]?: { width: number; height: number } | null;
}

/** Cached probe result for a draft image: dimensions, `null` (probe failed), or `undefined`
 *  (never probed). */
export function cachedImageDimensions(image: ImageContent): { width: number; height: number } | null | undefined {
	return (image as ImageContentWithDims)[kImageDims];
}

/** Record a probe result for a draft image (see {@link cachedImageDimensions}). */
export function setCachedImageDimensions(image: ImageContent, dims: { width: number; height: number } | null): void {
	(image as ImageContentWithDims)[kImageDims] = dims;
}

/** Matches `[Image #N]` / `[Image #N, WxH]` markers. Global: reset before reuse.
 *  Paste markers are left untouched by renumbering: their numbering is owned by
 *  the editor's paste store, not by the pending-image buffer. */
const IMAGE_MARKER_REGEX = /\[Image #([1-9]\d*)((?:,[^\]\n]*)?)\]/g;

/** Collect every 1-based `[Image #N]` / `[Image #N, WxH]` index referenced in `text`. */
export function collectReferencedImageIndexes(text: string): Set<number> {
	const refs = new Set<number>();
	IMAGE_MARKER_REGEX.lastIndex = 0;
	for (const match of text.matchAll(IMAGE_MARKER_REGEX)) {
		refs.add(Number.parseInt(match[1], 10));
	}
	return refs;
}

/** Remap `[Image #N]` markers through `indexMap` (old → new), preserving any `, WxH` tail.
 *  Markers whose old index is absent from the map are left unchanged. */
export function remapImageMarkers(text: string, indexMap: ReadonlyMap<number, number>): string {
	if (indexMap.size === 0) return text;
	IMAGE_MARKER_REGEX.lastIndex = 0;
	return text.replace(IMAGE_MARKER_REGEX, (match, idx: string, tail: string) => {
		const next = indexMap.get(Number(idx));
		return next === undefined ? match : `[Image #${next}${tail}]`;
	});
}

/**
 * Keep only pending images still referenced by markers in `text`, then collapse
 * gaps so markers are contiguous from 1. Returns the filtered images and the
 * (possibly renumbered) text. Used on submit so deleting `[Image #N, WxH]` from
 * the draft also drops the corresponding pending image bytes.
 */
export function filterAndRenumberReferencedImages<T>(
	text: string,
	images: readonly T[],
): { text: string; images: T[]; refs: Set<number> } {
	const refs = collectReferencedImageIndexes(text);
	const filtered = images.filter((_, i) => refs.has(i + 1));
	const sorted = [...refs].sort((a, b) => a - b);
	if (sorted.some((n, i) => n !== i + 1)) {
		const map = new Map(sorted.map((orig, i) => [orig, i + 1]));
		return { text: remapImageMarkers(text, map), images: filtered, refs };
	}
	return { text, images: filtered, refs };
}

/** Renumber every `[Image #N]` marker in `text` by `offset` (added to the
 *  existing index), preserving the optional `, WxH` tail. Paste markers are
 *  left untouched. Used when restoring queued image-messages back into a draft
 *  that already holds pending images so the merged text's positional markers
 *  still line up with `pendingImages`. */
export function shiftImageMarkers(text: string, offset: number): string {
	if (offset === 0) return text;
	IMAGE_MARKER_REGEX.lastIndex = 0;
	return text.replace(
		IMAGE_MARKER_REGEX,
		(_match, idx: string, tail: string) => `[Image #${Number(idx) + offset}${tail}]`,
	);
}

type ImageBlobWriter = (data: Buffer, options?: { extension?: string }) => Promise<BlobPutResult>;
type ImageBlobWriterSync = (data: Buffer, options?: { extension?: string }) => BlobPutResult;

export function imageReferenceHyperlink(
	label: string,
	index: number,
	imageLinks: readonly (string | undefined)[] | undefined,
	renderLabel: (text: string) => string,
): string {
	const rendered = renderLabel(label);
	const target = imageLinks?.[index - 1];
	return target ? fileHyperlink(target, rendered) : rendered;
}

async function materializeImageReferenceLinkAsync(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriter,
): Promise<string | undefined> {
	try {
		const result = await putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

function materializeImageReferenceLink(
	image: ImageContent,
	index: number,
	putBlob: ImageBlobWriterSync,
): string | undefined {
	try {
		const result = putBlob(Buffer.from(image.data, "base64"), {
			extension: blobExtensionForImageMimeType(image.mimeType),
		});
		return result.displayPath;
	} catch (error) {
		logger.warn("Failed to write image reference blob", {
			index,
			mimeType: image.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return undefined;
	}
}

export async function materializeImageReferenceLinks(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriter,
): Promise<(string | undefined)[] | undefined> {
	if (!images || images.length === 0) return undefined;
	const links = await Promise.all(
		images.map((image, index) => materializeImageReferenceLinkAsync(image, index + 1, putBlob)),
	);
	return links.some(link => link !== undefined) ? links : undefined;
}

export function materializeImageReferenceLinksSync(
	images: readonly ImageContent[] | undefined,
	putBlob: ImageBlobWriterSync,
): (string | undefined)[] | undefined {
	if (!images || images.length === 0) return undefined;
	const links = images.map((image, index) => materializeImageReferenceLink(image, index + 1, putBlob));
	return links.some(link => link !== undefined) ? links : undefined;
}
