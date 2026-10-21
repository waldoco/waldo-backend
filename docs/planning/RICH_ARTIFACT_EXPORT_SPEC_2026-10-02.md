# Rich artifact export: contract and first slice (design, no code)

Source review at beta-mvp. Today: `create_artifact`, `revise_artifact`, `list_artifacts`, `read_artifact` store model-composed markdown (src/channels/artifacts.ts); delivery returns an owner-authenticated viewing link or `saved_internal` (src/channels/artifact-delivery.ts). Bodies are strings, so there is no binary path, no exact-MIME download and no PDF/DOCX/PPTX/image renderer. The skill `rich-artifact-export` stays execution-blocked until this exists.

## Contract for the first slice: PDF from an existing markdown artifact
- Tool `export_artifact(artifact_id, expected_revision, format: 'pdf')`. Only formats the renderer actually supports are accepted; anything else returns a typed `unsupported_format` receipt, never a renamed text file.
- Input is an existing artifact at the stated revision. Mismatch returns the same conflict result as `revise_artifact`.
- Rendering is inert: markdown to a fixed trusted template. No scripts, no remote fetches, no model-supplied HTML or code.
- Output is stored as bytes beside the source (new binary body store, same owner scope and key rules as the text store) with `mime_type`, `byte_size`, `sha256`, `source_artifact_id`, `source_revision`.
- Delivery uses the existing owner-authenticated route: exact MIME and `content-disposition`, same rate limit and owner check as artifact reads. No public URL.
- Receipt returned to the model: `{status:'exported'|'unsupported_format'|'render_failed'|'too_large', artifact_id, bytes, mime_type, sha256, delivery}`. The model may say "exported" only from `status:'exported'`.
- Pixel check: the test harness renders page 1 to an image and the reviewer inspects it; a byte count alone is not proof.

## Renderer recommendation (2026-10-02, main-agent recommendation; not an owner decision)
Proposed: pdf-lib (MIT, pure JS, no filesystem or native code, runs in a Worker). Checked on npm 2026-10-02: pdf-lib 1.17.1 MIT, last published 2022-05-12 (stable, not actively maintained); pdfmake 0.3.11 MIT, published 2026-06-12; jspdf 4.2.1 MIT. Reasons for pdf-lib: smallest surface, no layout engine that could fetch or evaluate anything, we only need headings, paragraphs and lists from trusted markdown.
Known limits, stated up front:
- Built-in fonts cover Latin (WinAnsi) only. Text with other scripts (for example Devanagari) returns `unsupported_text`, not a garbled or blank PDF. Embedding a Unicode font (pdf-lib + fontkit, MIT) is a later slice and needs its own size review.
- Worker bundle size is NOT measured. npm unpacked sizes (pdf-lib about 19 MB, mostly non-runtime files) do not predict the bundled size. The code slice must build the Worker and record the real size against the Workers limit before merge.
- pdfmake is the fallback if hand layout proves too limited; it needs bundled fonts and has not been checked in a Worker.
- Not considered: Cloudflare Browser Rendering (paid per use; spend needs the owner).
Reversal: remove the tool registration and the dependency; text artifacts are untouched.

## Red-first tests for the code slice
unsupported format returns the typed receipt and writes nothing; revision mismatch writes nothing; hostile markdown (script tags, remote image URLs) produces no network call and no active content; wrong-owner read denied; oversize returns `too_large`; a render failure never yields an `exported` receipt.

## Live-proof test (staging, after build)
Ask Waldo to export a named artifact to PDF; fetch the returned owner link; confirm `application/pdf`, the sha256 matches the receipt, and page 1 shows the artifact text.
