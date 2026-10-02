# PDF export: owner DO registration seam (spec for Codex)

Status: spec only. Layer: SOURCE reading of beta-mvp; nothing deployed or tested live. Core edits no DO file. The exporter itself is built and tested in `packages/runtime/src/channels/`; only the DO wiring is missing.

## What exists (merged, unregistered)
- `artifact-export.ts`: `renderMarkdownPdf(markdown)` with pdf-lib (dependency `pdf-lib` 1.17.1 in `packages/runtime/package.json`). Latin text only; returns `unsupported_text`, `too_large` (over 200,000 chars) or `empty` instead of a bad PDF.
- `artifact-exports.ts`: `artifactExports(sql, book, bodies, binaries, clock, newId)` and `exportArtifactHandler(exporter)` (tool `export_artifact`, `mutates_state`, user_message allowlist from `TOOL_PERMISSIONS`). Binaries go to R2 under `artifacts/exports/by-owner/<owner>/<key>` through `r2ArtifactBinaries(bucket, ownerScope)`.
- `artifact-export-download.ts`: `artifactExportDownload(request, deps)` serves `GET /console/exports/<id>` as `application/pdf` with size, magic-byte and sha256 checks, behind `artifactReadAdmission` (rate limiter) and owner auth. Returns `null` for any other path so the host can fall through.
- `export_artifact` is already in `contracts/src/tools/permissions.ts`.

## Seam 1: register the tool, in `telegram-owner-do.ts` (Codex file)
Near line ~1222, where `artifacts = artifactBook(storage.sql, this.env.ARTIFACTS ? r2ArtifactBodies(...) : inMemoryArtifactBodies(), clock, ...)` is built and `...artifactHandlers(artifacts, artifactDelivery(...))` is spread into the handler list (~line 1274):
1. Build `binaries = this.env.ARTIFACTS ? r2ArtifactBinaries(this.env.ARTIFACTS, this.ctx.id.toString()) : inMemoryArtifactBinaries()` with the SAME owner scope string the book uses.
2. `const exporter = artifactExports(storage.sql, artifacts, <the same bodies object the book uses>, binaries, clock, <same newId>)`.
3. Add `exportArtifactHandler(exporter)` to the handler list next to `artifactHandlers(...)`.
Use the same bodies store instance as the book. Do not create a second one, or the exporter will not see the artifact bodies.

## Seam 2: serve the download, in the console routing (~line 533, next to the `ARTIFACT_PATH` block)
After the session check and before the artifact route, add: `const exported = await artifactExportDownload(request, { exports: <store with byId(id) over the exports table>, binaries, limiter: this.env.RESPONSIBILITY_RATE_LIMITER, ownerScope: this.ctx.id.toString() }); if (exported) return exported;`. The `exports` store is the `byId` of the `artifactExports` instance (check its table name in `artifact-exports.ts`; it must be the owner DO's own SQL). Same session/CSRF posture as the artifact page: no public URL, no new auth path.

## Open question (do not guess; needs main/Codex)
`exportArtifactHandler` returns `delivery: { status: 'saved_internal', url: null }`. Nothing yet gives the owner a verified link to `/console/exports/<id>`. Options: (a) extend `artifactDelivery` to mint the same kind of owner-authenticated link for an export id, (b) the model tells the owner the export is saved and to open it from the console. Choose before claiming "I sent you the PDF". Until then the model must not say it delivered a file.

## Tests (DO side, extend the existing artifact export tests)
- The tool appears only for user_message triggers and only when ARTIFACTS is bound.
- Export of a Latin artifact: receipt `status: 'exported'` with bytes and sha256; fetched bytes hash to the receipt and start with `%PDF-`.
- Non-Latin text returns the `unsupported_text` error and stores nothing; revision mismatch stores nothing.
- Wrong owner or no session gets 401 or 404 and no bytes; a missing limiter returns 503.
- Restart (new DO instance, same storage) still serves the export.

## Before merge of the DO change
- Build the Worker and record the real bundle size against the Workers limit (pdf-lib size is NOT measured; npm unpacked size does not predict it).
- Pixel check: render page 1 of an exported PDF to an image and inspect it. A byte count alone is not proof.
- Staging proof after release: ask for an export, fetch the link, confirm `application/pdf`, sha256 matches the receipt, page 1 shows the artifact text.

## Not covered
Non-Latin scripts (a later slice needs an embedded font and its own size review); public links; any spend.
