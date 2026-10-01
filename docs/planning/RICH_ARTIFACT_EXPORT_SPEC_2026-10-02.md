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

## Open decision (blocks the code)
Which renderer runs inside a Cloudflare Worker or its container tier, and its license, size and cost. Candidates need checking against current docs before choice; I have not verified any. Until chosen, no dependency is added.

## Red-first tests for the code slice
unsupported format returns the typed receipt and writes nothing; revision mismatch writes nothing; hostile markdown (script tags, remote image URLs) produces no network call and no active content; wrong-owner read denied; oversize returns `too_large`; a render failure never yields an `exported` receipt.

## Live-proof test (staging, after build)
Ask Waldo to export a named artifact to PDF; fetch the returned owner link; confirm `application/pdf`, the sha256 matches the receipt, and page 1 shows the artifact text.
