# Retained owner workspace and guarded compute interface

September 30, 2026. Proposed design, docs only. No workspace tool, retained byte upload,
compute binding, sandbox isolation or provider selection is implemented by this document.
Step-3 integration is reviewed after the runner lands and remains behind the step-1 smoke
merge gate. Owner requested capability parity and parallel work; that does not authorize
paid provider trials, external publication or arbitrary shell effects.

## Current source and smallest useful outcome

At beta-mvp e1c20143227174fd2947b16b41c6434afd1cb701:

- `channels/artifacts.ts` retains named markdown bodies with four document kinds and
  revisions, metadata in owner SQLite and bodies in R2. Bodies are read on demand as
  external content, not injected as instructions. Its unscoped bucket adapter is being
  fixed separately in #397 / PR #400.
- `channels/files.ts` retains Telegram file references, not workspace bytes. The console
  fetches bytes from the provider when opening a file. This is not restart-safe custody.
- `channels/telegram-owner-do.ts` constructs and registers artifact handlers. Core owns
  that wiring. `channels/console.ts` renders uploaded-file metadata, not a workspace.
- Artifact schemas accept `body_markdown`, max 100,000 characters. This is not a binary
  storage contract, file manifest, filesystem or shell.

Outcome for the first implementation: save a small named text file, list it, read a bounded
slice, revise against a known revision, upload a binary file privately and download it after
DO eviction. The same flow for a second owner must not see, overwrite or export the first
owner's file, including identical IDs. No public share or executable compute in this slice.

Hypotheses: extending artifact kinds alone might suffice for working documents; a byte
workspace is needed for uploaded PDFs, generated files and later explicit compute mounts.
A round-trip binary upload/export plus restart test falsifies the first hypothesis. Keep
existing artifact APIs stable; use a byte workspace store with explicit text-tool adapters.

## Store interface and manifest

Proposed new isolated `packages/workspace` package, with a concrete runtime consumer in
its implementation PR. Avoid creating it before contracts and registration are scheduled.
The package owns validation and operations, not authentication, grants or shell execution.
Host supplies the canonical internal user identity bound to the immutable owner DO, an
owner-local transactional metadata adapter, private R2
body adapter, clock and full random file/revision IDs. Never accept owner scope in tool args. Telegram IDs are channel bindings, never tenant IDs.
Every stored byte is owner-keyed. The core-owned tenancy model document will define the
canonical internal user ID and its DO mapping; reconcile this proposed key scheme against
that document before implementation. The current immutable DO-ID adapter in PR #400 is
the first scoped storage instance, not an independent identity resolver.

Each manifest row contains:

| Field | Contract |
|---|---|
| file_id | Opaque full random ID, not a user path or truncated run ID |
| path | Relative display path, max 240 UTF-8 bytes; no empty/dot/parent segments, absolute paths, backslashes or controls; reject ambiguous Unicode normalization rather than silently changing names |
| revision / blob_id | Positive revision and immutable random body revision ID |
| mime / byte_size / sha256 | Validated MIME metadata, observed byte count and body digest |
| provenance | Typed `owner_upload`, `agent_generated`, `provider_import`, `sandbox_output`; origin references are data, not authority |
| source_taint | Always external for any model-readable body in the initial slice |
| created_at / updated_at | Host injected clock |
| state | pending, ready, tombstoned; ready only after body write and metadata commit |

R2 key: `workspace/v1/<encoded immutable DO ID>/<opaque file ID>/<opaque blob ID>`.
Metadata never stores a key supplied by the model/provider. Body keys and signed URLs are
not model-visible. Logical paths are metadata only: no filesystem path joins at this tier.
Read only a ready revision recorded by the authenticated owner's metadata store.
Missing R2 binding fails `unavailable`, never success with volatile in-memory durability.
No legacy artifact import until an owner-scoped migration can prove the source body owner.

Operations: `list(cursor, limit, prefix?)`, `stat(file_id)`, `read(file_id, revision, offset,
length)`, `write(path, bytes, mime, expected_revision, provenance)` and host-only
`tombstone(file_id, expected_revision)`. Create requires expected_revision 0; updates
require current revision. A stale update returns conflict and the current revision with
no visible mutation. Explicit immutable-body write precedes one transactional revision
commit. Quota and revision reservation must be atomic across awaited storage writes;
response loss is reconciled by operation ID, never blind replay. Orphan pending bodies
are bounded, recorded and cleaned after a defined retention window.

Proposed initial limits, configuration in code rather than new environment variables:
10 MiB per file, 100 MiB live bytes per owner, 500 ready files, 256 KiB text-tool writes,
8 KiB text read output, 50 list rows, 1 active upload per owner, 60-second upload timeout.
Use UTF-8 byte counts, not character counts. Reserve incoming bytes before streaming;
enforce actual streamed count even when Content-Length is absent or false. Revision
retention and cleanup bytes count toward quota until deleted; no unlimited old revisions.
Numbers are proposed product defaults, not measured vendor limits or owner-approved spend.

## Model tool schemas and ACL

Proposed additions, all strict objects; IDs/revisions are required as indicated:

| Tool | Arguments | Result |
|---|---|---|
| workspace_list | prefix?: string; cursor?: opaque; limit: 1..50 default 20 | Metadata, next_cursor, count in page, no bodies or keys |
| workspace_read | file_id; revision: positive int; offset: nonnegative byte int default 0; length: 1..8192 default 4096 | Text only for verified UTF-8, total_bytes, next_offset, revision, external taint; binary says use structured export |
| workspace_write | path; text; mime fixed text/plain or text/markdown; expected_revision: nonnegative int; operation_id | Private mutation ack, file_id/revision/bytes/digest; no body echo |

Binary upload/export is a channel operation, not base64 stuffed into model arguments.
Read ranges cannot silently split UTF-8: return complete codepoints within the byte limit,
with next_offset naming the next raw byte. Invalid UTF-8 is binary, not replacement text.
Write permissions: `user_message` and `handoff_act`, scoped to private task work; same ceiling
as current artifact writes, never authority to send/share/delete. Read/list permissions:
`user_message`, `handoff_act`, `handoff_explore`. No heartbeat/brief access by default.
Register `workspace_read` in EXTERNAL_ORIGIN_TOOLS, on success and failure. List metadata
is bounded untrusted data too; names/provenance never become privileged instructions.
A destructive model tool and public sharing are deliberately absent. Console delete requires
owner session, CSRF, exact file/revision review and a durable deletion receipt.

## Exact integration seams and ownership

Contracts lane supplies additive schemas under `packages/contracts/src/tools/schemas/`,
exports/registry entries and ToolName updates, TOOL_PERMISSIONS entries in `tools/permissions.ts`,
EXTERNAL_ORIGIN_TOOLS entry in `tools/handler.ts`, and direct contract/ACL tests. Inspect the
actual registry export graph before editing rather than assuming a schema file registers it.
Do not rename existing artifact tool fields or change current read offsets.

Step-3 lane supplies isolated workspace store/handlers, R2 adapter, adversarial tests and
console display changes only in the confirmed owned paths. Core supplies owner-local
metadata adapter, binding validation and construction alongside the existing artifactBook
near line 886 of `channels/telegram-owner-do.ts`, then adds handlers beside artifactHandlers
near line 932. The line numbers describe this base, not a patch to apply blindly after drift.
No second owner resolver, runloop or memory system. No runner/grader/harness modifications.

Proposed private routes under the existing authenticated console-owner routing:

- GET `/console/workspace`: paginated metadata for the session's owner only.
- POST `/console/workspace/upload`: session + CSRF + upload reservation/operation ID,
  stream bounded bytes into pending storage, finalize digest and ready metadata.
- GET `/console/workspace/file?id=...&revision=...`: session-owner lookup, exact immutable
  revision, private no-store attachment, nosniff and restrictive CSP; no public R2 URL.
- POST `/console/workspace/remove`: session + CSRF, exact ID/revision review, tombstone
  plus body cleanup receipt; pending/failed cleanup remains visible, never claim deletion.

Core owns request routing and auth; step-3 defines response helpers/console UI and exact
handed-off patches. Connect upload/export to a reviewed real consumer before merging store
code. First delivery is authenticated console download. Sending a generated file to a
contact or channel needs a separate scoped approval and delivery receipt, not this export.

## Compute/provider section: still open

Start from research-only [PR #372](https://github.com/waldoco/waldo-backend/pull/372),
`ORGO_COMPUTER_BAKEOFF_2026-09-29.md` and `SANDBOX_TIER_SPEC_2026-09-27.md`.
Candidate list is Orgo, E2B, Maritime, Cloudflare Sandbox/Browser Run and Browserbase.
Vendor claims are not measurements; none is selected here. Browserbase is a browser
candidate, not proof of general Linux compute. Existing sandbox spec is a draft, not
permission to instantiate paid cells or relax its no-secret/no-network boundary.

Needed before implementation: provider/account/budget choice, pinned image and SDK,
Worker binding and authenticated host adapter, wall/output/CPU/storage caps, owner-run
mapping and cleanup, immutable explicit input mounts, output harvest admission, receipt
schema and outside-cell effect broker. A persistent desktop and the draft ephemeral
no-network sandbox are different tiers, not interchangeable labels.

Live no-egress test design: in a fresh real cell, attempt DNS and TCP/HTTP/HTTPS to
controlled public test endpoints plus metadata/private/loopback routes where appropriate;
include IPv4/IPv6 and proxy/environment bypass attempts. Expected: no unauthorized network,
no host credentials/files, no other owner's mounts, bounded timeout and receipt. Provider
network isolation must prevent it, not a model refusal or shell-string blacklist. Use only
controlled endpoints and test identities; do not probe arbitrary infrastructure. If the
provider cannot supply isolation, stop and propose a separate explicit-network tier rather
than claiming S1. Test credentials stay host-side; no secrets in mounts, commands or logs.
Provider billing, creation and deletion proof are part of the receipt. Live trials remain
blocked until the owner-approved budget and test scope exist.

## Acceptance and claims

Implementation must show benign and adverse cases: binary byte/digest roundtrip; named text
create/read/revise; multibyte limits; duplicate operation id; stale revisions; simultaneous
quota reservations; response-loss recovery; restart; same IDs across two owners; other-owner
file ID rejected; path traversal/encoded path rejected; false/missing size headers; R2 failure;
missing binding; taint on every body read; hostile content remains data; private download auth;
CSRF; tombstone/partial cleanup and no accidental share. Inspect console/upload/download UI
pixels before calling the visual surface ready.

Proof layers are separate: unit store tests, adapter tests, Worker integration, exact-head
CI, deployed feature readback and eventual live compute receipts. No shell, retained browser
login, public share, parity, production readiness or full workspace claim from this spec.
Rollback keeps existing artifact APIs and provider-upload list intact; disable new handlers
and routes without dropping ready metadata/body ownership. Open decisions: contracts lane
schedule, limits/retention, legacy artifact recovery, provider tier/budget and live test scope.


## September 30 static-audit comparison: Manus and browser continuity

A supplied static audit identifies retained files/compute and browser session continuity as
remaining gaps, not verified features. Its artifact/binding findings match the independently
reproduced #397/#395 bugs. This document does not adopt the audit as permission.

Official Manus references read September 30:

- [Cloud Computer](https://help.manus.im/en/articles/15392111-what-is-the-cloud-computer)
  describes a dedicated persistent Ubuntu VM with retained files, installed tools and running
  processes between sessions, distinct from a temporary task sandbox. Delta: the proposed
  Waldo workspace retains bytes, not processes, services or installed tools. A complete parity
  comparison must separately test file durability, installed-environment persistence, process
  continuity, idle billing and stop/resume. No need to add always-on compute to the first file
  slice; one bounded explicit consumer and isolation receipts precede any broader tier.
- [Browser Operator](https://manus.im/docs/features/browser-operator) describes a local
  desktop browser extension using existing logins, per-session owner authorization and stop
  by closing the tab. It separately describes a cloud browser requiring login in that session.
  Delta: existing-login local browser access is not the same feature as a persistent cloud VM.
  Do not label a hosted provider context as local browser-session parity.
- [Cloud Browser login management](https://help.manus.im/en/articles/11711226-how-can-i-manage-the-login-information-that-manus-stores)
  describes owner takeover for login/challenges, confirmation before saving login state,
  global disable and per-site management. Add to any later browser plan: explicit opt-in to
  persistence, owner/site-keyed context custody, revocation/reset, takeover/OTP recovery,
  expiration and a truthful resume/relogin receipt. No cookies or secrets in model/workspace.

For Waldo browser depth, all current handlers start/end a session per call; approval replay
uses a new session. `browser.ts` act acknowledgments do not include an authoritative final
external receipt. #404 is a wording prerequisite only; approval ledger/toast still needs the
core-owned typed outcome mapping reported separately. Plan owner-scoped sessions only with
current provider documentation proving context and navigation state, bounded lifetimes,
cleanup/revocation and isolated auth. Final effect proof needs the exact approved
recipient/items/total/action plus provider or controlled-fixture receipt and response-loss
reconciliation, never an extraction summary or a Telegram delivery outbox.

The audit's six-host-ceiling claim needs exact live-policy wiring reconciliation: browser.ts
itself does not contain six hosts. Public egress policy and its configured roster are outside
this lane's ownership; core should verify the active bound policy before changing reach.
These are vendor-described features and source observations, not measured competitor/Waldo
outcomes, provider selection, spend approval or a new implementation commitment.
