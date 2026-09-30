# Retained owner workspace and guarded compute interface

September 30, 2026. Proposed design, docs only. No workspace tool, retained byte upload,
compute binding, sandbox isolation or provider selection is implemented by this document.
The step-1 smoke passed September 30 (run 36668847051); that releases the narrow
feature-merge gate, not public tenancy, workspace or live execution readiness. Paid
provider trials, external publication and arbitrary shell effects remain separate decisions.

## Current source and smallest useful outcome

Original source snapshot: beta-mvp e1c20143227174fd2947b16b41c6434afd1cb701.
Latest verified reference: beta-mvp 045e94a180c740b83b6b9091b73453cfa62adea2, fetched
September 30 10:34 IST, includes #400/#413 and #405. Current-state statements below
incorporate those merges; the original snapshot is not the latest base.

- `channels/artifacts.ts` retains named markdown bodies with four document kinds and
  revisions, metadata in owner SQLite and bodies in R2. Bodies are read on demand as
  external content, not injected as instructions. Its bucket adapter was owner-scoped in merged PR #400
  (7a8c40db7b5d244a8ebb04d874398ba3b360720e); this is not a byte workspace.
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
#405 already defines `waldo.owners.id` as the canonical internal owner UUID. Host supplies
an authenticated, server-derived binding `{ownerId, environment, namespace, doName, doId,
stateVersion}` plus owner-local transactional metadata, private R2 adapter, clock and full
random file/revision IDs. `ownerId` is the principal; doName/opaque DO ID are locators, not
identity. Telegram/WhatsApp subjects are changeable channel bindings. No scope field comes
from tool arguments, upload query strings or unauthenticated headers.

Before constructing a store, core must validate the directory's canonical owner and active
state, namespace/environment against the configured binding, actual `ctx.id` against the
expected locator, and the persisted immutable owner/doName/DO-ID map. Missing, stale,
conflicting or wrong-environment mapping returns unavailable/rejected with no R2 access.
There is no deploy-owner, channel-ID or fixture fallback. Repeat lifecycle/state admission
before finalize/export/delete; do not admit suspended or revoked work through cached context.
The existing #400 DO-ID prefix fixes body collisions, but does not establish canonical-owner
mapping or environment segregation; do not extend it blindly to workspace bytes.

Retain a host-controlled map `(environment, namespace, doName, doId) -> owners.id` and a
source-indexed manifest of every pending/ready/tombstoned body key, revision and digest.
This map must survive account/DO deletion and namespace/name relocation until export/purge
receipts and survivor scans complete. Privileged export/delete uses this retained map with
verified authority, never prefix guesses or a fresh client-supplied locator. Mapping changes
require explicit versioned relocation/rollback, not silent key changes or stranded bytes.

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

R2 key: `workspace/v1/<environment>/<encoded namespace>/<canonical owner UUID>/<opaque file ID>/<opaque blob ID>`.
Environment and namespace are host-validated segments, not caller input. The manifest
records the immutable doName/DO-ID binding and mapping version alongside this key.
Staging and production share waldo-artifacts today, so environment separation is mandatory;
the same owner/file/blob IDs in different environments must resolve to different keys.
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

Proposed implementation carve-out, pending main/core acceptance before any code edits:

- Step 3: new `packages/workspace/src/store.ts`, `r2.ts`, `handlers.ts`, `index.ts`;
  `packages/workspace/test/store.test.ts`, `r2.test.ts`, `handlers.test.ts`;
  new `packages/runtime/src/channels/console-workspace.ts` (pure presentation/response
  helpers only), `packages/runtime/test/console-workspace.test.ts`, and this design doc.
- Package/bootstrap owner: new `packages/workspace/package.json`, `tsconfig.json`,
  workspace dependency registration and lockfile changes. Not permission for step 3 to
  edit package/config files before a separate coordinated grant.
- Core: `packages/runtime/src/channels/telegram-owner-do.ts` for request routing, session/
  CSRF checks, canonical immutable binding, transactional metadata adapter, store construction
  and handler registration; `packages/runtime/src/identity/owner-directory.ts` plus a new
  reviewed SQL migration for authenticated owner mapping; exact integration tests in new
  `packages/runtime/test/workspace-owner-integration.test.ts`. Core decides final SQL path.
- Contracts lane: new `packages/contracts/src/tools/schemas/workspace.ts` and
  `workspace.test.ts`, plus reviewed exports/ToolName registration and existing
  `packages/contracts/src/tools/permissions.ts`, `handler.ts` and their tests.

Collision check against lane-7 prompt: it owns `packages/dashboard-app/src/**`, index.html,
README, preview/asset scripts, runtime `dashboard-overview.ts`/test, `console-invites.ts`/test
and CODEX_L7 docs. None overlaps the proposed step-3 paths above. Step 3 does not edit any
of those paths, dashboard preview/assets/overview/invites or their routes. Existing
`channels/console.ts` remains unchanged by this slice; workspace HTML lives only in the
new pure helper, called through core-owned routing. If dashboard integration is later
needed, hand a typed API/UI contract to lane 7 rather than touching its components.
Recheck live path ownership at implementation start; this docs-only collision check is not
an active implementation reservation or approval of the new paths. No second owner resolver,
runloop or memory system. No runner/grader/harness changes.

Proposed private routes under the existing authenticated console-owner routing:

- GET `/console/workspace`: paginated metadata for the session's owner only.
- POST `/console/workspace/upload`: session + CSRF + upload reservation/operation ID,
  stream bounded bytes into pending storage, finalize digest and ready metadata.
- GET `/console/workspace/file?id=...&revision=...`: session-owner lookup, exact immutable
  revision, private no-store attachment, nosniff and restrictive CSP; no public R2 URL.
- POST `/console/workspace/remove`: session + CSRF, exact ID/revision review, tombstone
  plus body cleanup receipt; pending/failed cleanup remains visible, never claim deletion.

Core owns request routing and auth; step 3 defines only the new console-workspace helper
and tests listed above. Connect upload/export to a reviewed real consumer before merging store
code. First delivery is authenticated console download. Sending a generated file to a
contact or channel needs a separate scoped approval and delivery receipt, not this export.

## Compute/provider section: still open

Start from research-only [PR #372](https://github.com/waldoco/waldo-backend/pull/372),
`ORGO_COMPUTER_BAKEOFF_2026-09-29.md` and `SANDBOX_TIER_SPEC_2026-09-27.md`.
Candidate list includes E2B, Modal and Daytona for external code execution, plus Orgo,
Maritime and Cloudflare Sandbox/Browser Run as other research candidates. Browserbase is separate.
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
CSRF; tombstone/partial cleanup and no accidental share; identical owner/file/blob IDs in
staging vs production; wrong canonical mapped owner despite valid DO locator; missing map;
wrong namespace/environment; relink without moving bytes; suspended finalize/export; retained
map after owner deletion; relocation rollback and survivor scans for old/new keys. Inspect console/upload/download UI
pixels before calling the visual surface ready.

Proof layers are separate: unit store tests, adapter tests, Worker integration, exact-head
CI, deployed feature readback and eventual live compute receipts. No shell, retained browser
login, public share, parity, production readiness or full workspace claim from this spec.
Rollback keeps existing artifact APIs and provider-upload list intact; disable new handlers
and routes without dropping ready metadata/body ownership. Open decisions: contracts lane
schedule, limits/retention, provider tier/budget and live test scope.


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
external receipt. Merged #413 (98ec95757a3250911037c688e9567b2e8ba19393) supplies
typed unverified/uncertain outcomes and truthful approval ledger/toast; #404 was superseded. Plan owner-scoped sessions only with
current provider documentation proving context and navigation state, bounded lifetimes,
cleanup/revocation and isolated auth. Final effect proof needs the exact approved
recipient/items/total/action plus provider or controlled-fixture receipt and response-loss
reconciliation, never an extraction summary or a Telegram delivery outbox.

The audit's six-host-ceiling claim needs exact live-policy wiring reconciliation: browser.ts
itself does not contain six hosts. Public egress policy and its configured roster are outside
this lane's ownership; core should verify the active bound policy before changing reach.
These are vendor-described features and source observations, not measured competitor/Waldo
outcomes, provider selection, spend approval or a new implementation commitment.


## September 30 decision: Kennel primary, external sandbox fallback

Architecture direction from the owner's September 30 10:21:52 conversation: heavy tasks
route through Kennel orchestration to specialist harnesses such as Codex/Claude Code on the
user's machine or Codex Cloud. DO + R2 remains the owner-scoped control plane and durable
file authority. E2B/Modal/Daytona are fallback execution candidates, not the default route.

The Kennel bridge is specified separately in `WALDO_KENNEL_BRIDGE_2026-09-24.md`,
`KENNEL_BRIDGE_BACKEND_2026-09-24.md` and `WALDO_KENNEL_BRIDGE_UPDATE_2026-09-26.md`;
v0.2.3 joint signature remains an owner gate. This document does not implement or claim a
working primary bridge. Core must verify current bridge readiness before any dispatched
job; unavailable does not mean permission to silently select a fallback service.

DO-only remains a tier for metadata, API orchestration and bounded text transforms, not a
Linux workspace. Route heavy tasks through the primary bridge when the requested harness,
owner machine/cloud availability, project scope and effect permissions are verified. Offer
a named external fallback when the primary route is unavailable or unsuitable, or when the
owner explicitly chooses it. A task sent to a user's machine still needs narrow input/output,
secret, file-mutation and recipient authority; local execution is not unlimited consent.
External services are candidates only: no approved connections, charges or data destinations.
No sandbox trial has run and no latency was measured.

### Price and startup comparison

Read September 30, 2026. USD, before credits/tax. Shared example: 600 seconds running,
2 vCPU-equivalent and 4 GiB RAM, CPU-only, then terminate. Session figures are calculated
resource estimates, not checkout totals. Exclude model/browser API usage, builds, transfers,
retained snapshots/volumes, account plan fees and Waldo's existing control plane unless
stated. Rates and limits must be rechecked before an approved trial.

| Option | Published rate and illustrative 10-minute cost | Startup evidence, not Waldo p50/p95 | Capability delta and caution |
|---|---|---|---|
| DO-native + R2 | DO paid overage $12.50/million GB-s at allocated 128 MB and $0.15/million requests [D1]. At vendor example convention 0.128 GB, 600 active seconds = $0.000960 duration equivalent, plus requests/storage. Actual bill uses included allocations and rounding, not per-session settlement. Not a 2 vCPU/4 GiB machine. R2 Standard $0.015/GB-month, $4.50/million writes, $0.36/million reads [D3]. | No verified numeric cold-start figure found. Current Waldo startup unmeasured. | Current runtime coordinates tools and stores markdown artifacts. Proposed byte workspace still needed. DO CPU is 30 seconds default, configurable to 5 minutes per invocation [D2]; no proposed Linux shell/process environment. Cheapest tier for orchestration is not full execution parity. |
| E2B | $0.000014/vCPU-s + $0.0000045/GiB-s, included sandbox storage [E1,E2]. `600*(2*0.000014+4*0.0000045)` = **$0.027600**. Hobby $0/month, Pro $150/month + usage, configurable resources and limits depend on plan. | ~150 ms reported by competing provider Beam, not independently measured here [X2]. Official pages fetched did not establish that numeric startup value. | Full Linux Firecracker microVM, shell/PTY, filesystem, Python/JS, full-state pause/resume, egress controls and R2 mounting described by vendor [E3,E4]. Fits untrusted code/data tasks. Do not mount an entire owner bucket or inject credentials; verify network deny and task-specific mounts. |
| Modal Sandboxes | Physical core (2 vCPU equivalent) $0.00003942/core-s + $0.00000667/GiB-s [M1]. `600*(0.00003942+4*0.00000667)` = **$0.039660** at 1 core/4 GiB. Billing is `max(request, actual)` [M2], so bursts can increase this estimate. | Vendor says <1 second for pre-cached containers [M3], not uncached image pull/build or request-to-first-command total. | Shell execution, custom images, volumes and snapshots [M1,M4]. Default lifetime 5 minutes must be raised to 10 for this example; max documented 24 hours [M4]. Strong candidate for custom Python/data workloads, but image/build cost and resource bursts need caps. |
| Daytona | Linux CPU/RAM rates were not exposed by fetched official pricing; page showed Windows $0.0858/vCPU-hour [T1]. Third-party MakerStack gives $0.000014/vCPU-s + $0.0000045/GiB-s + $0.00000003/GiB-s disk [X1]. **Provisional $0.027654** for 2 CPU/4 GiB/3 GiB disk over 600s ignoring free allowances; not approval-ready until Linux rates confirmed officially. | Vendor container startup <90 ms [T2]; image build/restore and full ready-to-command timing are not covered. Do not compare directly with Modal's cached figure. | Linux container default, separate VM tier for memory pause/resume; filesystem persists on stop, container archive moves bytes to storage [T2]. Stopped/paused disk stays billed; snapshots can stay billed after deletion [T3]. Container and VM costs/isolation must be tested separately. |

Do not select from a headline timing or cheap CPU rate alone. CompareSandboxes [X3]
reports Modal 800 ms and Daytona 90 ms, but its CPU-only hourly comparison omits Modal's
physical-core-to-vCPU distinction and RAM. Beam [X2] also conflicts with current E2B official
pages on self-hosting and Daytona lifecycle support. These are market context, not proof,
security certification or authority. Current official documentation takes precedence for
configuration; actual controlled trials decide runtime performance.

### What each tier enables

1. **Current Waldo:** named markdown artifact revisions, owner-local metadata and scoped
   R2 bodies (#400). Telegram references are not retained binary files. No byte filesystem,
   workspace materialization, shell, package install or file-generation pipeline is shipped.
2. **Proposed DO-native workspace:** private byte custody, explicit manifest/revision/quotas,
   binary upload/download and bounded text tools. Enables retained task inputs and outputs;
   cannot by itself run Pandoc, Python/pandas, LibreOffice, npm tests or persistent services.
3. **Primary heavy execution via Kennel:** dispatch a task-scoped job to the selected
   specialist harness on the owner machine or Codex Cloud, return outputs plus verification
   evidence, and admit files through the workspace manifest. Bridge handshake, project roots,
   artifact transport, cancellation and replay/response-loss proof belong to the bridge
   implementation and review. Neither the bridge nor harness execution is proved here.
4. **Fallback external ephemeral sandbox:** map a task to a fresh or resumed isolated cell,
   mount only approved immutable inputs, run bounded code, harvest digest-verified outputs
   back through workspace admission, then stop/delete with receipt. This addresses execution
   gaps without an always-on machine. Retained bytes, installed packages and running process
   continuity are separate acceptance dimensions.
5. **Optional persistent/desktop tier:** needed only for tasks whose process or environment
   must resume, GUI applications or browser continuity. Compare idle storage/compute billing,
   state deletion and recovery independently. Browser login custody is not a workspace grant.

### Decision and bakeoff gates

Before any service connection, obtain owner approval for the named provider, allowed private
input data, tier/resources, maximum total spend and undo/retained-storage cost. Free credits
are not permission to consume them. No warm pool, subscription or automatic top-up by default.
Pin image digest, SDK version, region and no-network policy before measuring. Keep provider
credentials host-side, use owner/run-specific cells, and preserve R2 as the authoritative
file store so provider changes do not migrate user identity or grants.

Proposed trial per approved provider: 20 sequential fresh starts and 10 resume starts at the
same requested resource shape, pinned image and region, followed by PDF/text rendering,
CSV-to-chart, and tiny repo test tasks. Record creation-to-first-command and first-useful-output
p50/p95, image cache/build status, actual billed resource seconds, pause/delete proof and
restart digest roundtrip. Distinguish CPU vs wall time and physical cores vs vCPUs. Provider
minimum resources may differ; report the difference instead of forcing false equivalence.
No measurements or pass verdict exist yet.

Reject a candidate if cross-owner mounts/keys leak, no-egress cannot be enforced, secrets
enter the cell/model logs, output quotas or wall deadlines cannot stop execution, or unknown
cleanup/billing remains. After isolation, rank by successful task output, cost per completed
task and time-to-useful-output, not boot time alone. E2B is a reasonable first **approval
candidate** for general code execution; Modal is the custom-image/data alternative; Daytona
is the persistence alternative once official Linux costs and exact runtime class are known.
This ranking applies only when choosing a fallback, never instead of Kennel by default.
No chosen service or default spend is established by this ranking.

### Sources and confidence

Official pages fetched September 30, rates are live-page observations with no published date:

- [D1] https://developers.cloudflare.com/durable-objects/platform/pricing/ - duration/request pricing, memory allocation and rounding.
- [D2] https://developers.cloudflare.com/durable-objects/platform/limits/ - CPU and storage limits.
- [D3] https://developers.cloudflare.com/r2/pricing/ - Standard storage/operation rates.
- [E1] https://www.e2b.dev/pricing - plan and resource rates.
- [E2] https://e2b.dev/pricing.md - included storage, default configuration and plan limits. Billing search excerpt described a different default RAM value; use the actual pinned template, not an assumed default.
- [E3] https://e2b.dev - microVM, filesystem, egress, lifecycle and region capabilities, vendor claims requiring trials.
- [E4] https://www.e2b.dev/docs/sandbox - lifecycle/pause and timeout limits.
- [M1] https://modal.com/products/sandboxes - core/RAM rates and volumes/snapshots.
- [M2] https://modal.com/docs/guide/sandbox-resources.md - max(request, actual) billing.
- [M3] https://modal.com/resources/code-sandbox - <1 second pre-cached startup claim only.
- [M4] https://modal.com/docs/guide/sandbox - shell API, lifecycle and timeout.
- [T1] https://www.daytona.io/pricing - pricing page fetch incomplete for Linux resource rates; Windows figure is not used for Linux calculation.
- [T2] https://www.daytona.io/docs/en/sandboxes/ - container/VM distinction, startup claim and lifecycle matrix.
- [T3] https://www.daytona.io/docs/en/billing.md - reserved-resource billing by state and delayed charges.

Fetched third-party context, lower confidence and not price approval evidence:

- [X1] https://makerstack.co/reviews/daytona-review/ - provisional Linux price model; not confirmed by official fetched page.
- [X2] https://www.beam.cloud/blog/best-e2b-alternatives - competing vendor article, June 17, 2026; ~150 ms E2B claim and caveats, conflicts noted above.
- [X3] https://comparesandboxes.com/compare/modal-vs-daytona/ - comparison site dated July 26, 2026; method not validated and units not comparable.
