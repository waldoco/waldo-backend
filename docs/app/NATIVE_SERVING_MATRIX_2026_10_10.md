# Native owner integration checkpoint — serving matrix

2026-10-10. This is a source checkpoint for the complete personal-agent build,
not full product acceptance. The commit containing this document supplies the
contract pin. A separate exact-object manifest records its Git objects, SHA-256
bytes, dependency closure and generated OpenAPI. No dirty source is a consumer
pin. All 27 procedures remain in scope.

## Release and evidence boundary

The last independently reported staging source is
`1206d7a8e7577fe23ed454c328007767507b9101`. It is a different source revision.
There is no reviewed candidate staging origin, runtime-flag receipt or invited
native test owner for this checkpoint. Parent coordinates those items and live
verification; Core alone merges. The #973 compute merge/activation hold and #987
ready-for-review hold remain unchanged. No production change, provider spending,
real third-party send or shared database reset is established by this receipt.

Local fixtures exercise actual serving classes with synthetic directory/provider
responses. They prove the named local behavior, not transport availability or
live provider behavior. Contracts and UI variants alone establish no producer.

## Canonical consumers and producers

All app requests authenticate using the issued app session. The server derives
the account and physical owner locator from signed directory authority and checks
current lifecycle/revision. Telegram identity is neither an app owner prerequisite
nor an authority substitute. See `identity/owner-runtime-authority.ts`,
`identity/app-session-authority.ts` and the actual `TelegramOwnerDO` call sites.

| Consumer / version | Path and actual producer | Confirmed source behavior | Configuration or unavailable boundary |
| --- | --- | --- | --- |
| Sign-in / `app.v1` | `/app/v1/auth/code`, `/auth/verify`, `/session`, `/auth/signout`; `app-api.ts`, console auth and signed directory RPC | Current-session admission; confirmed signout requires push registration revocation before session revocation; missing push RPC fails unavailable | Code delivery needs reviewed origin/configuration. Unknown verify issuance ACK has no canonical issuance identity/readback; app must retain unresolved revoke-only custody and cannot guess a credential |
| Main chat / `app.v1` | `/chat/main`, `/chat/main/messages`, `/chat/main/messages/{client_message_id}`; owner DO, AppInbox and delivery journal | Owner/conversation-bound same-ID receipt survives DO restart; unchanged replay cannot redispatch; foreign refs fail | Real model/provider journey unproven; health bodies are excluded from ordinary history |
| Threads / `threads.v1` | Thread list, detail, messages, receipt, event replay, cancel, archive and delete routes; AppThreads/AppInbox | Current session/thread checks before claim and during execution; preserved exact admitted envelope | Actual native restart/cancellation journey requires candidate configuration |
| Files and voice | File upload/content/revisions/operation routes and typed main/thread attachment/voice refs; workspace R2 host plus `app-turn-media.ts` | Existing immutable owned bytes reach actual model input; original voice bytes and the admitted reviewed transcript retain real custody; bounded loading and wrong-owner denial | Provider transcription and native picker/upload/live model consumption unproven; no invented transcript |
| Protected health replies | `/chat/protected-responses/{response_ref}`; `app-protected-response.ts` and actual owner serving path | Typed metadata retains no body in ordinary journal. Volatile body binds owner/session/conversation/source-purpose epochs, at most five minutes and 16 entries; expiration/restart returns 410; withdrawal immediately invalidates model-purpose readback | Existing explicit owner-requested `get_health` only. New autonomous health-to-model path was rejected and is absent |
| Access and onboarding | Profile, onboarding, catalog, accounts, connection, disconnection, session and operation routes; actual directory/Google books | Server-derived profile/first-value receipts; app Google consent and callback work without Telegram and fence originating session before exchange/publication | Reauthentication unavailable. Forget-derived receipt remains unconfirmed where full derived purge is unavailable; post-dispatch provider grant rollback is not claimed |
| Owner channels / `channels.v1` | `/channels`, `/channels/link`, `/channels/unlink`, `/channels/operations/{operation_id}`; directory RPC and `app-channels.ts` | CAS revision, current owner checks and idempotent receipts. Link/unlink preserves owner/browser/workspace; revocation removes surface authority | Telegram is optional. WhatsApp existing adapter needs configured transport and live proof. iMessage integration absent in this candidate |
| Work / `work.v1` | `/work`, `/work/tasks/{work_ref}`, `/work/operations`; actual owner books and signed RunLoopDO projection | Actual retained counts and canonical root read; exact queued request resume; immutable membership prevents unpublished/orphan execution; winning publication atomically clears predecessor; revoked pending payloads clear | Non-AppInbox canonical units/audit runs have unavailable controls until authoritative execution/checkpoint binding exists; no #973 activation |
| Approvals and effects / `work.v1` | `/work/approvals`, operation readback; existing approval desk/effect ledger | Exact frozen account/target/version/digest/audience/expiry; fresh authorized deciding surface; current delivery scope; unknown effects reconcile by readback and never blind replay | Live Google/mail/browser effect and undo receipts require separate authorization and testing |
| Browser / `work.v1` | `/work/browser`, `/open`, `/resume`, `/revoke`; canonical owner browser runtime/general browser adapter | App-only canonical owner allocation/control; same-owner read does not invalidate in-flight allocation; wrong owner fails; exact generation/handoff checks; generic bounded same-session readiness recovery and truthful cleanup | Local fake provider proves serving behavior. No real browser allocation, staging dining journey or provider-wide diagnosis established |
| Today/Brief / `personal.v1` | `/personal/day`; actual day-plan book and Google collection ports | Current events/tasks/proposed buffers, coverage and six authored moments with bodies in configured model fixtures; source digest/revision fences | Scheduled six-moment alarm/delivery and recovery factory are not wired at this checkpoint; GET authorship is not scheduled delivery |
| Memory / `memory-correction.v1` | Correction targets, correction action and operation readback; actual canonical owner store | Exact target/revision/payload CAS; owner-derived authority and durable readback; source epoch fences | Native/live correction acceptance unproven |
| Health raw/history | Consent/grant/withdraw/ingest/today/history/readings routes; signed health service and protected SQL plane | Actual origin metadata, revision/deletion, source/epoch/purpose fences and receipt-before-cursor semantics. See health engineering receipt | Health/demand SQL remain isolated promotion fixtures, not deployed canonical migrations; candidate origin/source ingestion remains unavailable until promotion |
| Recovery, Form, Weight, sleep debt, Slope | Versioned calculation/producer, owner adapter and health history contracts | Independently checked candidate formulas and eligibility, explicit coverage/gaps and native-source separation | Root factories are unconfigured. Numeric activation and historical Weight demand capture remain unavailable; no accepted Slope algorithm, clinical parity or native numeric acceptance |
| Rights and devices | Rights inventory/export/deletion operations and device registration/revoke routes; signed identity jobs plus rights byte custody | Exact operation receipts and export custody; deletion quiesces active work and tracks unconfirmed cleanup; installation/provider-token ownership and session revocation SQL | APNs/FCM sending/real device delivery is unavailable and must stay gated. Full live erasure and export acceptance unproven |
| Artifacts | Artifact list/detail/revisions/export and workspace/render routes; real workspace/artifact books | Source-backed immutable revisions, verified receipt/export identity; PDF/DOCX/Markdown producers and PDF export | Complete XLSX/PPTX/image-generation/editing bytes and render QA remain open; schema/UI is not a producer |

Paths above are relative to `/app/v1` where abbreviated. The exhaustive canonical
route registry is `packages/contracts/src/app/agent.ts`; generated artifact is
`packages/contracts/openapi/waldo-app-v1.json`. Consumers must import the committed
registry and its transitive schema dependencies, not select isolated dirty files.

## Local checks at the checkpoint

- Contracts: 106 files / 1,837 tests passed.
- Actual native OAuth, current approval audience, API and consent serving: four
  files / 38 tests passed; app-only fixtures have no Telegram subject/token.
- Final Work admission/publication/revocation batch: three files / 23 tests passed.
- Node proactivity/source collection: eight files / 88 tests passed.
- Browser lane: 146 Workers tests, 64 Node tests and five actual owner DO tests
  passed. Rights lane: 96 Workers tests plus focused owner custody/console checks.
- Health privacy source recheck: 68 tests passed including the original valid
  16,019-character ordinary-offload regression. Formula renewal: 82 tests and
  140 independently calculated oracle cases passed; clinical validation absent.
- Isolated SQL: 177 assertions passed across health, demand, push custody,
  erasure, canonical runtime owner and channel CAS. Container stopped with data
  preserved. This is not the full canonical migration/pgTAP gate.

Exact frozen-head review and applicable aggregate results accompany the external
manifest. The Linux PostgreSQL guard cannot run on this macOS host as configured;
it remains a required CI gate. Source, CI, merged, staged and live evidence must
remain separate.

## Full procedure ledger

Each row retains the full final-state goal. “Source” describes present components;
“open” names missing complete serving or acceptance evidence. No row claims live
completion at this checkpoint.

| # | Procedure | Source and remaining acceptance |
| --- | --- | --- |
| 1 | Day Brief | Authored current day and six moment views; scheduled delivery/recovery open |
| 2 | Meeting preparation | Google current collection and composed reads; real complete-source/native journey open |
| 3 | Inbox triage | Fully paged Gmail body and safe code quarantine; live owner/action proof open |
| 4 | Sourced research | General browsing/readiness and source refs; real multi-source journey open |
| 5 | Calendar and focus | Frozen reviewed Calendar writes/readback; live exact-account effect proof open |
| 6 | Project catch-up | Composed provider sources and responsibilities; full multi-provider context journey open |
| 7 | Weekly review | Day/history/context components; authored scheduled weekly journey open |
| 8 | Follow-up monitoring | Responsibility/proactivity books and collector; background runtime/delivery integration open |
| 9 | Logged-in browser | Owner browser session/takeover/control; live authenticated browser/MFA journey open |
| 10 | Flight workflow | General browser/effects approval components; real bounded provider workflow open |
| 11 | Dining workflow | Generic readiness/recovery and owner session receipts; staging empty-content recovery journey open |
| 12 | Ride workflow | General tools/browser/source composition; actual authorized provider journey open |
| 13 | Food workflow | General planning/browser/reviewed effects; actual provider journey open |
| 14 | Shopping workflow | Frozen effects/browser handoff; actual approved provider journey open |
| 15 | Reviewed message | Frozen target/audience/digest and effect/readback; real authorized correct-surface delivery open |
| 16 | Reminders and watches | Existing books and trusted scheduler admission helper; complete factory/alarm/delivery activation open |
| 17 | Signing preparation | Workspace/browser/approval tools; full document preparation and owner review journey open |
| 18 | Kennel engineering | Excluded implementation ownership; existing held compute integration preserved |
| 19 | Trusted coordination | Existing coordinator/run-loop and signed canonical reads; held execution activation and live orchestration open |
| 20 | Memory | Canonical memory/correction/source guards; real retention/correction/forget acceptance open |
| 21 | Health and meal planning | Explicit protected health serving source; numeric activation unavailable; autonomous new model flow rejected pending approval |
| 22 | Composed planning | Current day/model/source composition; autonomous health integration and complete providers open |
| 23 | Learning | Existing source/context/responsibility machinery; complete learning journey open |
| 24 | Structured artifacts | Real workspace/PDF/DOCX/Markdown paths; native spreadsheet/deck/image producers open |
| 25 | Visual QA | Existing render/browser components; complete artifact-specific visual acceptance open |
| 26 | Revision-safe delivery | Immutable artifact/file revisions, exact receipts and operation recovery; real native/provider delivery open |
| 27 | Native export | Actual export/source custody contracts and serving; reviewed candidate origin and native sharing journey open |

Cross-cutting full scope includes voice input/output, files/images, location,
MFA/takeover, standing grants, interruption, hosted work, complete connected
context, privacy/deletion and background synchronization. Voice output and
location event serving are absent here. Drive bodies beyond bounded Docs/plain
text remain incomplete; charts/quick replies/rich parts have no complete producer.
Slack/GitHub/Linear/Notion/MCP configured ports require actual provider journey
evidence. These gaps remain work, not exclusions introduced by this checkpoint.
