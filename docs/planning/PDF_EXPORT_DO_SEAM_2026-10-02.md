# PDF export: owner DO registration seam (spec for Codex)

Status: spec only. Layer: SOURCE reading of beta-mvp; nothing deployed or tested live. Core edits no DO file. The exporter itself is built and tested in `packages/runtime/src/channels/`; only the DO wiring is missing.

## What exists (merged, unregistered)
- `artifact-export.ts`: `renderMarkdownPdf(markdown)` with pdf-lib (dependency `pdf-lib` 1.17.1 in `packages/runtime/package.json`). Latin text only; returns `unsupported_text`, `too_large` (over 200,000 chars) or `empty` instead of a bad PDF.
- `artifact-exports.ts`: `artifactExports(sql, book, bodies, binaries, clock, newId)` and `exportArtifactHandler(exporter)` (tool `export_artifact`, `mutates_state`, user_message allowlist from `TOOL_PERMISSIONS`). Binaries go to R2 under `artifacts/exports/by-owner/<owner>/<key>` through `r2ArtifactBinaries(bucket, ownerScope)`.
- `artifact-export-download.ts`: `artifactExportDownload(request, deps)` serves `GET /console/exports/<id>` as `application/pdf` with size, magic-byte and sha256 checks, behind `artifactReadAdmission` (rate limiter) and owner auth. Returns `null` for any other path so the host can fall through.
- `export_artifact` is already in `contracts/src/tools/permissions.ts`.

## Seam 1: register the tool, in `telegram-owner-do.ts` (Codex file)
Near line ~1222, where `artifacts = artifactBook(storage.sql, this.env.ARTIFACTS ? r2ArtifactBodies(...) : inMemoryArtifactBodies(), clock, ...)` is built and `...artifactHandlers(artifacts, artifactDelivery(...))` is spread into the handler list (~line 1274):
0. One rule: register `export_artifact` and serve `/console/exports` ONLY when `env.ARTIFACTS` is bound. No in-memory fallback in the DO (an in-memory export would vanish on restart and break the download link). Without the binding the tool is simply absent.
1. Build `binaries = r2ArtifactBinaries(this.env.ARTIFACTS, this.ctx.id.toString())` with the SAME owner scope string the book uses.
2. `const exporter = artifactExports(storage.sql, artifacts, <the same bodies object the book uses>, binaries, clock, <export id generator, see below>)`.
3. Add `exportArtifactHandler(exporter)` to the handler list next to `artifactHandlers(...)`.
Use the same bodies store instance as the book. Do not create a second one, or the exporter will not see the artifact bodies.

## Seam 2: serve the download, in the console routing (~line 533, next to the `ARTIFACT_PATH` block)
After the session check and before the artifact route, add: `const exported = await artifactExportDownload(request, { exports: <store with byId(id) over the exports table>, binaries, limiter: this.env.RESPONSIBILITY_RATE_LIMITER, ownerScope: this.ctx.id.toString() }); if (exported) return exported;`. The `exports` store is the `byId` of the `artifactExports` instance (check its table name in `artifact-exports.ts`; it must be the owner DO's own SQL). Same session/CSRF posture as the artifact page: no public URL, no new auth path.

## Delivery wording (main'"'"'s decision under the owner'"'"'s overnight delegation)
`exportArtifactHandler` returns `delivery: { status: 'saved_internal', url: null }`. Until `artifactDelivery` mints a verified owner-authenticated link for an export id, the model says the PDF is saved and points the owner to the console. It never claims it sent or delivered a file. Minting the link is a later slice.

## Export ids
The download route accepts only `/^exp:[A-Za-z0-9_-]{1,128}$/`. The exporter builds the id as `exp:${newId()}`, so the generator passed to `artifactExports` must return URL-safe characters only (letters, digits, `_`, `-`). Do not reuse the 8-char run-id slice the book uses: that is a collision risk for stored exports. Use a longer random id, for example 22+ chars of base64url from `crypto.getRandomValues` (16 random bytes), and test that every generated id matches the route pattern.

## Tests (DO side, extend the existing artifact export tests)
- The tool appears only for user_message triggers and only when ARTIFACTS is bound; with no binding it is absent and `/console/exports/...` returns 404.
- Generated export ids match `/^exp:[A-Za-z0-9_-]{1,128}$/`.
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
