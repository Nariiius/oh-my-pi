Inspects any file via a multimodal-capable model; returns compact text analysis.

<instruction>
- Use for file understanding: images (OCR, UI/screenshot debugging, scene questions), PDFs, Office documents (DOCX/PPTX/XLSX), code/text files, or any other format.
- `path`: local file path | local `.svg`/`.svgz` path with `:img` | `Image #N` attachment label | `attachment://N` URI.
- `question` specific: inspection target; constraints (e.g. "quote visible text verbatim", "only report confirmed findings"); output format (bullets/table/JSON/short answer).
- Ground `question` in observable evidence; request uncertainty for unclear details.
- For semantic analysis of file content, use over `read`.
</instruction>

<how-it-works>
- Image files (PNG, JPEG, GIF, WEBP, BMP, TIFF, SVG, HEIC, ICO) are sent directly to the vision model
- PDFs are first converted to text via document extraction; for image-heavy PDFs with sparse text, the model receives the raw content for best-effort analysis
- Office documents (DOCX, PPTX, XLSX, RTF, EPUB, ODT) are converted to markdown text before analysis
- Text/code files are sent as-is
- Binary files receive a hex preview for identification
</how-it-works>

<examples>
# OCR with strict formatting
`{"path":"screenshots/error.png","question":"Extract all visible text verbatim. Return as bullet list in reading order."}`
# Screenshot debugging
`{"path":"screenshots/settings.png","question":"Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence."}`
# Scene/object question
`{"path":"photos/shelf.jpg","question":"List all clearly visible product labels and their shelf positions (top/middle/bottom). If unreadable, say unreadable."}`
# PDF analysis
`{"path":"reports/q3-financials.pdf","question":"Extract the Q3 revenue and profit numbers. Return as JSON with keys revenue and profit."}`
# Document analysis
`{"path":"proposals/architecture.docx","question":"What are the three main architecture decisions proposed? List each with a one-sentence summary."}`
# Inline image reference from history
`{"path":"[Image #1]","question":"Describe the visual contents of this image."}`
</examples>

<output>
- Multimodal-model text-only analysis.
- Tool output: no file/image content blocks.
</output>

<critical>
- Parameters strict: only `path` and `question`.
- Settings-blocked image submission → actionable error.
- Image path + non-vision resolved model → configure a vision-capable model role before retrying.
</critical>
