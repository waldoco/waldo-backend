# Console parity and source reconciliation

Issue #658. Snapshot: beta-mvp 13ac09f plus #562 e93fb789 and #657 visual/fix patch equivalents. This is source/local evidence, not hosted parity. No release or legacy removal.

## Shared seams

- Signin: current beta download-resume preserved alongside narrow dashboard JSON 401/503/no-store responses. No OTP/session policy changes.
- Index: directory resolution must return an owner before forwarding, overwrites caller owner-routing header, preserves expired-download return_to. Missing/error directory is fail-closed.
- Owner DO: additive dashboard reads/actions and workspace JSON coexist with current runtime. Node forget covers conversation, output ledger, mail-followup and calendar-prep. Remaining copies or thrown cleanup yield incomplete; other cleanup still attempted. No provider calls.
- Signup: byte-identical to beta-mvp. Completion already exists there; the old snapshot's SMS/completion gap is stale. Dalda owns the requested removal of optional phone collection form.

## Preservation matrix

| Old route/action | Current new destination / handler | Local evidence | Remaining launch gate |
|---|---|---|---|
| /console GET/HEAD and old deep views | App Today and view links; dashboard-static, existing ticket/JSON path | static, worker and console-entry tests | same-origin staging assets/deep links; retire aliases only after below |
| /console?m notice | existing notice-bearing handler | console-entry preserves notice | migrate receipts into shell before deleting renderer |
| /console/waiting; approval.approve/skip/undo | Controls + Panels Waiting; narrow controls/action gateway | controls projection, action replay/CSRF tests | real eligible proposal and verified provider result; sends remain chat full review |
| /console/spots; confirm/dismiss/forget/retry | Memory + MemoryActions, memory-control gateway | memory action eligibility, revision/navigation tests | actual incomplete purge retry and two-owner isolation |
| /console/constellation; node.forget | Memory patterns/map/list; same server act | node cleanup success/fault test; receipts | failed node cleanup removes node first, so a fresh retry cannot find it; do not imply retry available |
| /console/memory; Profile/holds | Controls profile; partial-removal suppression | projection and UI tests | ensure withheld/private profile remains suppressed live |
| /console/day; today/pin/unpin/timezone/proactivity | DayControls and same validators/executor | UI and controls/action tests | real schedule/pin persistence; quiet-hours exception |
| /console/connections; Google connect/disconnect; Telegram link/unlink | ConnectionsControls, revision action gateway | scopes and replay/CSRF tests | OAuth denies/reconnect/right account; transport identity verification |
| session.signout/signout.all | Connections session controls, server session checks | controls and session tests retained | actual expiry/revoke/signout all; API provides count/until, not full per-session list |
| /console/setup | SetupControls recorded prerequisites | setup projection tests | guided activation still needs UI slice; no live-test claim from grants |
| /console/files; file.remove/open | FilesControls plus protected /console/file | source/UI tests retained | remove is reference removal, not Telegram byte purge |
| /console/workspace upload/remove/file/cursors | Workspace React + admitted server workspace handlers | immutable-revision downloads/MIME/isolation tests | live upload unknown-outcome retry, retained revision cleanup; no sharing |
| /console/usage | UsageControls estimate rows | source/UI projection tests | period/cost interpretation and responsive table |
| /console/activity; run details/cursors/ledger | ActivityControls; /console/runs remains | source projections and UI tests | React renders returned steps and ledger; technical-detail disclosure polish and hosted equivalence still needed; same-ms cursor issue remains |
| /console/invites; invite.member | OwnerControls invite view | quota/one-time receipt/action tests | actual invite create/revoke paths; member model has create/list, admin owns revoke |
| /console/admin; invite.create/revoke | AdminPanel existing owner gate | admin model/tests retained | migration present in deployment; non-admin server refusal, one-time code safety |
| /console/account; account.delete | OwnerControls typed DELETE confirmation | incomplete/uncertain/deleted receipts retained | real deletion probe; does not certify Telegram/provider copies purged |
| /console/signin/verify/signup/session links | current beta signin/signup templates and identity | focused auth/download tests; signup unchanged | Dalda phone-form removal, completion/consume invite, recovery and new/returning user hosted tests |
| Artifact export downloads (/console/artifacts/...) | existing owner-routed artifact endpoints | owner-routing preserved | authenticated same-owner download/expired session; not removed in shell migration |

## Outstanding parity, not UI bugs to conceal

1. Root notices still use old renderer. Before removal, route their server-produced receipts into React without trusting a client-supplied notice as an authoritative write receipt.
2. ActivityControls already exposes returned steps and raw ledger. Move these into an authorized technical-details disclosure without losing content; verify hosted equivalence before retirement. An older projection note described omissions and is stale.
3. Sessions projection supplies count and current expiry, not an individual session list. Do not draw fictional rows.
4. Node forget deletes the node before retained-copy cleanup. Incomplete result is now honest but durable retry custody is not established. Separate backend disposition needed before promising a retry UI.
5. Member invites and admin issuance are distinct. Sharing an invite does not share owner data.
6. Signup in current beta is completed via email plus optional unverified contact; earlier screenshots show stale source. Dalda owns removing phone collection, not this merge.

## Verification layers

Local merge tests preserve beta workspace MIME/download two-owner behavior, signin return targets, canonical route bindings, JSON failure headers, dashboard controls/CSRF/replay, and node-final-copy cleanup with injected KV failure. UI suite remains 14 files/156 tests. Typecheck requires higher local Node heap (default exhausted). Frozen lockfile install restores happy-dom; lockfile regenerated from beta with that existing dashboard dependency. No hosted auth, SMS, external mutation, provider outcome or deployment is proven here.
