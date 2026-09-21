# Implementation contracts retained from PR #138

Updated 21 September 2026. These detailed contracts support the [canonical build plan](../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md). They preserve reviewed recovery and authority boundaries; they do not reintroduce the previous release breadth. Main-plan scope and newer explicit decisions control: Calendar S0/S2, Gmail S3, channels C, optional Drive/People/Tasks and document writes later. A provider scope is never a product permission.

The original source is [PR #138 at 10e48fb](https://github.com/Pin4sf/waldo-backend/blob/10e48fb979f8c775491d0121dbafa18b8624006c/docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md). Read only the contract for your slice. Before final assistant-output staging, a bounded inference retry may regenerate a response while preserving completed tool results and operation IDs; after staging, publish the exact frozen bytes. External effects with uncertain outcomes are reconciled, never blindly repeated. This distinction overrides the original interrupted-turn wording below.

## Conversation publication and deletion protocol

The authenticated backend `ConversationPublicationService` is the only service allowed to create or transition conversation-content rows and materialize visible ordering from the DO reservation. Supabase remains the canonical human-visible graph; the owner DO remains execution truth and the order allocator. There is deliberately no claimed cross-store transaction. Idempotent states and reconciliation make partial progress visible and recoverable.

The content lifecycle is `staged -> reserved -> committed`, with terminal `expired`, `revoked`, or `deleted` states. Every stage binds owner, thread, client idempotency key, exact content digest, admission/deletion generations, expiry, and an opaque staging reference. Staged rows are inaccessible to the normal transcript projection and prompt assembly, but participate in RLS, retention, export, deletion, and content-log suppression. This is one Supabase content lifecycle and writer, not a second transcript.

For an inbound user command:

1. authenticate the owner and bind the thread before accepting the body into an in-memory quarantine whose request logs, traces, analytics, and error reporting cannot capture content;
2. apply deterministic local Scribe/DLP classification before any generic transcript, event, queue, or log write;
3. for raw health or another protected field, require the exact purpose and current consent, store the value only in its protected plane (or process it transiently without retention), and reduce the generic form to a non-reconstructive display marker plus opaque reference; use a keyed, rotating digest where low-entropy values could otherwise be guessed, never a plain digest of the protected value;
4. canonicalize the admitted ordinary bytes or protected marker/reference and idempotently write a hidden `staged_input` through the publication service, bound to the owner/thread, client key, exact digest, current admission/deletion generations, and short expiry; reuse of the key with changed bytes is rejected;
5. submit only the opaque staging reference, digest, and generation metadata to the owner DO; it dedupes and returns a reservation containing the server message ID, owner-wide `command_seq`, per-thread `turn_seq`, and parent/cancellation generation without storing the body; the publication service then compare-and-sets the staged row to `reserved` with that reservation;
6. compare-and-set the same Supabase row to visible `committed`, carrying the frozen IDs/sequences; `visible_order` is derived from the DO-assigned turn and message phase, never independently allocated by Supabase;
7. only a confirmed canonical commit releases exactly one DO run bound to that immutable message ID/digest; and
8. acknowledge durable acceptance only after both the staged payload and recoverable DO reservation exist. Before that point the input is explicitly unaccepted and may require the same-key resubmission. After it, restart reconciliation uses the exact staged bytes and frozen identifiers rather than reconstructing content from a digest or rerunning the user.

The protected write must be confirmed before its non-reconstructive transcript reference becomes visible. A crash after the protected write but before reference publication leaves a quarantined, idempotently recoverable record with a short cleanup deadline; it does not leak the value into the transcript. Consent revocation or deletion between the two steps cancels publication and purges/tombstones the protected record. Missing purpose/consent fails closed and retains no exact value. Crash tests cover every protected-store/reference boundary, log and error capture, low-entropy digest guessing, late revocation, retry, orphan cleanup, and deletion/reindex replay.

For launch, one thread executes turns serially. A concurrent inbound message is either queued at its frozen next `turn_seq` or explicitly steers/cancels the active turn under one deterministic policy; it never starts an unordered parallel reply. A canonical assistant row carries its input parent ID and the same turn sequence with the assistant phase. Tests race app/channel callbacks, retries, cancellation, publication timeout, and restart and assert that owner command order, transcript order, response parentage, execution order, and visible cancellation outcome agree.

For assistant output:

1. provisional stream events remain noncanonical and cannot claim an effect;
2. after final schema/policy validation, the publication service writes the exact final body as a hidden `staged_output`, keyed by server message/run identity and bound to its digest, parent, owner/thread, admission/deletion generations, and expiry;
3. only after staging succeeds does the DO freeze the opaque reference/digest and enqueue a restart-resumable publication intent; a model rerun never reconstructs an already-frozen answer;
4. the publication service compare-and-sets that same row to visible `committed` with the frozen order;
5. only a confirmed Supabase commit emits `message.committed`, advances the DO outbox, and becomes visible to later prompt assembly; and
6. a timeout remains `publication_pending` until read-back proves commit or retry safely completes it. A failure before staging is an interrupted inference attempt, not a recoverable exact answer. The canonical plan permits bounded regeneration with a new inference-attempt ID, accurate cost accounting and reuse of persisted completed tool results/operation IDs; it cannot reissue uncertain external effects. Exhaustion becomes a truthful failed turn.

Missing, expired, revoked, or deleted staged payloads become visible terminal execution states where appropriate and release their reserved turn so later turns remain live. Orphan cleanup is deadline-bound and idempotent. Consent revocation, message/thread deletion, and account deletion advance the governing generation before purge, preventing a late promotion. S1 kills the process after input stage, reservation, input commit, output stage, publication intent, and output commit, then restarts without client retry. It also tests same-key changed bytes, revoke/delete between every boundary, orphan expiry/purge, and next-turn liveness, asserting no duplicate visible message, regenerated staged/frozen answer, wedged sequence, or second canonical transcript.

Logs, journal metadata, and unrelated DO events never duplicate conversation bodies. Raw health samples or protected health fields typed into chat are handled through the pre-persistence quarantine and accepted health destination matrix; exact values remain transient or in the protected health plane, while the generic transcript contains only the non-reconstructive marker/reference.

Deletion first makes the canonical Supabase message/thread unavailable to normal RLS reads and advances a deletion/revocation generation consumed by prompt assembly. The DO then invalidates run references, summaries, caches, schedules, and derived/search projections idempotently. R2 is included only after the ADR-0077 staged-delivery amendment admits that projection. The user sees a deletion receipt or honest `deletion_pending` status. Tests crash/restart between every boundary and cover duplicate callbacks, digest mismatch, missing rows, deletion during streaming, stale-index retrieval, consent change, and cross-owner substitution.

## Multi-presence identity and channel binding

`IdentityPresenceModule` remains each owner's sole permission writer, but its one-Presence-per-owner invariant becomes one owner with multiple independently revocable `PresenceBinding` records. Each binding carries channel/provider, stable provider subject or normalized phone identity, verified-at, status, binding and revocation generations, capabilities, and last provider event cursor. Because independent owner DOs cannot atomically enforce cross-owner uniqueness, a protected `PresenceClaimRegistry` is the sole writer for reservation, activation, expiry, and revoke generation of `(provider namespace, provider subject)`. It owns no conversation, memory, or per-owner permission. A provider identity becomes active for at most one owner; partial reservations are recoverable and recycled identities require explicit step-up before relink.

Linking starts only from a freshly authenticated Waldo app session. The server issues a short-lived, one-use challenge bound to owner, intended channel/provider account, app presence, and redirect/callback. The channel callback proves possession and provider signature before activation. Never join by display name, profile photo, address-book similarity, or phone-number resemblance. A recycled/reassigned number requires re-verification and explicit relink after the prior binding is revoked/quarantined; it never inherits the old owner's memory, threads, pending actions, or delivery state.

Every inbound callback and resumed run rechecks provider signature, provider subject, owner/account status, binding generation, revocation generation, capability, and event/message dedupe key. The owner DO assigns cross-surface command order. Provider message IDs and Waldo origin markers suppress duplicates and outbound echo loops. Revocation/account deletion advances the generation before asynchronous provider cleanup, so a late webhook fails closed.

Conformance tests cover challenge replay and owner/provider substitution; one phone claimed by two owners; recycled-number relink; a late webhook after revoke/account deletion; simultaneous app and channel turns; provider retry/reordering; outbound echo loops; and unlink/relink while a response is in flight.


## Normal agent-turn protocol

1. authenticate the owner and bind the presence server-side;
2. normalize and classify the inbound message, including sensitivity and external-text taint;
3. load current turn/thread state, relevant Profile Claims, Open Loops, relationship state, and purpose-allowed health view;
4. resolve the smallest per-turn capability manifest from request, connected services, grants, risk, budget, and expiry;
5. compose minimal context with provenance and explicit exclusions;
6. call one primary model with schema-bound answer/tool proposals;
7. validate output against capability, data, policy, and semantic rules;
8. answer directly for informational work, or create a proposal/intent for an effect;
9. persist frozen intent, digest, idempotency and reconciliation key before I/O;
10. execute through the connector/browser adapter;
11. read back or reconcile from the source of record;
12. store observation/evidence/receipt, update the relevant Open Loop, and render truthful status.

Untrusted mail, documents, web pages, meeting text, and counterparty messages may supply observations but may not grant authority, choose or change an effect destination, widen a capability, or provide executable parameters without independent typed validation. They can cause Waldo to propose an action; only owner intent or a pre-existing typed grant may authorize it. A prompt instruction such as “ignore this text” is not the control boundary.

Ordinary conversation does not require a Mission or Outcome graph. Promote only a promise, scheduled action, waiting dependency, multi-step responsibility, or user-declared outcome into durable responsibility state.

Streaming is provisional. Chunks are untrusted, incrementally output-sanitized UI events; they are not canonical assistant content, receipts, or effect claims and cannot trigger a tool. Only the final schema/policy-validated body and digest enter the publication protocol. Cancellation, policy rejection, provider loss, or restart ends the provisional stream as `interrupted`/`failed`; the UI never preserves it as a successful assistant turn. S1 tests include cancellation and restart between chunks, an unsafe late chunk, a tool claim in prose, final-digest mismatch, and reconnect without duplicate publication.

Prompt caches and continuation identity bind the owner, purpose, exact admitted-context/source digest, consent and source revisions, policy version, frozen capability/tool-manifest digest, model/provider transform version, and deletion/revocation generation. Provider-native reasoning or tool artifacts are not replayed across models unless a versioned transformation has explicit tests; a lossy transform is admitted as new untrusted context, never treated as preserved reasoning truth.

## Capability resolution replaces the broad global tool surface

**[Observed]** The current `user_message` trigger can see 29 of 30 named tools. Deny-first ACLs are useful, but this is too broad for launch.

**[Decision]** Retain the global vocabulary for compatibility, but derive a signed/hashed per-turn manifest containing only the tools and connector operations required for the declared purpose. A Calendar question should not expose memory writes, generic MCP, message deletion, sheets, browser writes, or task execution.

The manifest and tool schemas are frozen for the full model turn and every retry within it. Lazy discovery may reduce what is rendered into context, but it may not add, remove, or redefine a callable tool mid-turn. A resumed continuation creates a newly authorized manifest revision after reconciling prior effects; it never silently inherits a wider runtime surface.

Capability admission binds:

- owner and authenticated presence;
- purpose and affected resource;
- exact operations and parameter ceilings;
- source and destination data classes;
- confirmation/effect class;
- expiry and revocation generation;
- monetary/token/browser budget;
- idempotency and reconciliation policy; and
- adapter availability/version.

## Model-provider data-processing gate

Every model/gateway route is default-deny by data class, not merely “an approved model.” A versioned `ModelEgressPolicy` binds provider, model/route, region, DPA/subprocessor status, training use, retention/ZDR status, gateway/provider payload logging, allowed source/destination classes, consent/purpose, fallback ladder, and configuration digest. At minimum distinguish public text, ordinary user chat, Profile Claims, Calendar metadata/body, Gmail metadata/body, meeting notes/transcript excerpts, protected derived-health context, raw health, credentials, and other-owner data. Raw health, credentials, and unadmitted other-owner data are forbidden on every route.

Before a route can receive mail, meeting, or derived-health content, its processor/DPA and retention posture must be documented and accepted for that class. Cloudflare AI Gateway payload logging is default-off in configuration and the trusted proxy explicitly sends `cf-aig-collect-log: false` (or the verified current equivalent) on every sensitive request, including fallbacks; omitting or overriding that control fails closed. Metadata-only logging, when separately justified, uses `cf-aig-collect-log-payload: false` and content-minimized identifiers. A conformance test verifies both configuration and request paths, while a synthetic canary proves only that prompts/tool output are absent from the capture paths it exercised. If no-training/ZDR/region or log suppression cannot be established, that route receives only the lower data classes its evidence permits.

Fallback is a fresh policy decision. It may narrow or refuse content but cannot widen data egress, retention, region, or logging. Each provider attempt re-renders the prompt for its route, filters context to that route's admitted classes, and records a content-minimized policy/config digest. Tests force every fallback rung, revoke consent/Connection mid-turn, misconfigure payload logging, inspect logs/traces/analytics, and verify that a blocked data class fails closed without silently retrying through a less private provider.


## Common connector contract

Every connector separates:

1. connection/authentication;
2. source admission and data scope;
3. read capabilities;
4. proposal capabilities;
5. effects requiring approval;
6. idempotency and source-of-record reconciliation;
7. revocation/deletion; and
8. conformance/staging evidence.

The connector never owns Waldo memory, authority, Outcome truth, or Acceptance. Connector results are untrusted observations until admitted. Every adapter result has three bounded representations: the raw/provider observation in the protected source plane, a minimal typed projection eligible for model context, and a richer redacted UI/evidence receipt. Raw provider payloads are never copied into model context merely because the connector returned them, and model-minimized output does not replace the source-of-record evidence needed for verification.

## Canonical connection lifecycle

`ConnectionModule` is the sole writer of a per-owner `Connection` aggregate. A Connection binds the provider, immutable provider account/tenant identity, purpose, admitted data classes, granted scopes and their revision, opaque token handle/generation, adapter version, consent epoch, and lifecycle status (`connecting`, `active`, `reauthorization_required`, `revoked`, `deleting`, `deleted`, or `error`). Multiple provider accounts remain distinct Connections; a callback never silently replaces one account with another.

OAuth start stores a short-lived, one-use, owner/presence-bound state record and PKCE verifier, plus nonce/issuer/redirect binding where the provider protocol supports them. The callback verifies those bindings before a server-side code exchange, retrieves the provider's stable account identity, detects cross-owner/account substitution, and activates the Connection with an atomic scope revision. Secrets, refresh tokens, and provider bearer tokens remain inside Supabase Vault and a trusted connector Edge Function/proxy; Waldo's DO records only opaque connection/credential generations and never durable raw credentials.

The proxy does not expose “fetch any URL with this token.” It accepts a signed owner-bound operation envelope containing the frozen per-turn capability-manifest digest, exact typed operation, affected resource, approval/effect class, parameters/digests, credential and revocation generations, idempotency key, expiry, and expected response class. It re-verifies those bindings, constructs the provider method/path itself from an allowlist, executes, sanitizes the response, and returns bounded observation/evidence. Google OAuth scope is only an outer permission ceiling; Waldo's proxy and dispatch policy enforce the narrower operation boundary. Draft creation, draft deletion, and send are distinct operations even where one Google scope permits all three.

Every effect and resume rechecks Connection status, exact scopes, provider account, token generation, and revocation generation. Revocation invalidates capability first, then revokes/deletes provider credentials and retained derivatives through a visible deletion state machine. Conformance tests include CSRF/state replay, authorization-code replay, PKCE failure, token/account substitution, cross-owner callback, unrequested scope widening, scope downgrade, refresh rotation/failure, concurrent callbacks, mid-run revoke, and partial deletion.

The current Supabase `oauth_tokens` and `one_time_tokens` tables and every deployed Edge Function/caller must be inventoried and reconciled to the amended ADR-0075. S0/S2 has one credential boundary: Supabase Vault plus the trusted typed connector proxy. Do not return provider bearer tokens to the DO, dual-write refresh tokens, or introduce a managed broker in the founder-alpha path. A future broker requires a new accepted custody ADR, account-bound handle migration/reconnect plan, deletion parity, cutover/rollback criteria, and read-path proof before any legacy secret path is retired.

Credential-boundary tests include token-exfiltration attempts, wrong method/path, arbitrary-host/SSRF input, recipient/calendar/resource substitution, stale or replayed operation envelopes, manifest-digest mismatch, approval substitution, callback/account substitution, refresh rotation/failure, and a revoke or account deletion racing an in-flight provider call.

## Google Workspace — P0

Use official Google APIs. Supabase Vault and the typed connector proxy custody and use credentials; Waldo owns grants, purpose, capability resolution, receipts, and data retention. Google's Workspace MCP servers are in Developer Preview as of this review; they are useful for prototypes but cannot be the public production dependency until their terms and availability permit it.

Incremental scope order:

| Increment | Capability | Minimum provider scope / caveat | User control |
|---|---|---|---|
| G-Cal-1 | primary-calendar free/busy and bounded event reads | `calendar.freebusy` + `calendar.events.owned.readonly`; proxy restricts to `primary` | connect Calendar read |
| G-Cal-2 | propose event create/update/delete | no added provider scope; no provider write yet | local proposal only |
| G-Cal-3 | apply exact approved diff, read back, reconcile | `calendar.events.owned`; provider scope reaches owned calendars, proxy restricts alpha to `primary` | separate Calendar write grant |
| Gmail-1 | Gmail-query search and bounded metadata projection | `gmail.readonly`; `gmail.metadata` cannot use `messages.list?q=...`, so the bearer ceiling is broader than the returned operation | exact source/time/query limits |
| Gmail-2 | read selected threads/bodies | `gmail.readonly`; same scope as search, newly admitted typed operation and retention purpose | explicit mail-content explanation and retention policy |
| Gmail-3 | prepare/review Waldo-local draft | no added provider scope | editable draft; no send authority |
| Gmail-later | provider draft create/update/delete | deferred; `gmail.compose` also permits send and needs separate typed operations | do not request for S3; exact destructive approval if added later |
| Gmail-4 | send exact approved message snapshot | `gmail.send`; proxy freezes approved RFC 5322/MIME bytes and sends through `users.messages.send`, never mutable draft ID | fresh approval bound to every byte at the irreversible edge |
| Drive-1 | user-selected files through Picker | `drive.file` where the workflow permits it | no all-Drive default |
| People-1 | user-selected contact lookup for an invite or recipient | deferred; exact `contacts.readonly` need and minimization must be justified before request | no full address-book ingestion |
| Tasks-1 | read/create/update selected task lists | exact Tasks scope selected by read/write operation at adapter contract | enable only when the workflow is used |
| Docs/Sheets/Slides | document workflows | exact per-file/read-or-write scopes selected later | not onboarding scope |

Do not copy Instinct's all-at-once Google grant. Use incremental authorization and show what each active connection lets Waldo do.

Google classifies Gmail scopes that read/manage message metadata, headers, or bodies—including `gmail.metadata`, `gmail.readonly`, and `gmail.compose`—as restricted. `gmail.compose` is not a draft-only security boundary; it can authorize `drafts.send`. If Waldo's server stores or transmits restricted data, production use requires Limited Use compliance, restricted-scope OAuth verification, and ordinarily an annual Google-approved security assessment. Begin scope justification, verified-domain/privacy materials, processor/data-flow inventory, test-user plan, and CASA readiness in S0. Founder/test-user corridors do not prove public verification, and Gmail must not enter external beta until the applicable approval is complete.

Keep the first Calendar effect class deliberately narrow: the authenticated owner's primary calendar; non-recurring, owner-only events; no attendee or conference mutation; and `sendUpdates=none`. For create, validate and persist a permitted client-chosen Google event ID before I/O and reconcile that exact ID after response loss; retrying the same insert must not create a second event. Treat duplicate/collision responses such as `409` according to the exact provider operation and never assume they prove that Waldo created the found event. For update/delete, bind the approved version/etag, timezone, and resolved instant and dispatch with `If-Match`; a provider `412` invalidates the approval and creates a fresh proposal rather than silently rebasing or overwriting. Then read back from Google. Additional owner-selected calendars, recurring-series/instance edits, attendee notifications, conference creation, organizer transfer, and imported invitations are later distinct effects with their own approval and reconciliation rules. Test custom-ID validation/collision, duplicate create, DST boundaries, timezone changes, stale etag/`412`, external edit/delete/move, ambiguous absence, and timeout after provider commit; ambiguous absence remains indeterminate until the operation-specific reconciliation budget is exhausted.

Gmail send has its own TOCTOU boundary, and Google does not document atomic compare-and-send for a mutable draft. Fresh approval therefore binds deterministically canonicalized raw RFC 5322/MIME bytes and their digest, every envelope/header recipient, subject, attachment bytes/digests, thread intent, owner/provider account, approval generation, expiry, and a Waldo-owned idempotency/reconciliation reference. The typed proxy sends exactly those immutable bytes through `users.messages.send`; it does not call `drafts.send` by mutable provider draft ID. S3 uses a Waldo-local review draft and creates no Gmail draft dependency. If a later feature imports a provider draft, that provider draft remains intact, including concurrent external edits, and is surfaced as independently changed/still present; its cleanup is a separate visible operation with separate approval. A timeout after send is indeterminate: reconcile source-of-record message state before reporting or offering another send—never blindly resend. S3 tests cover canonicalization/digest stability, edits after approval invalidating that approval, MIME/header/recipient/attachment substitution, revocation during dispatch and provider success followed by response loss. If provider drafts are added later, also prove concurrent external draft edits remain intact and never change the approved bytes.

Waiting-reply tracking in S3 uses the bounded exact-thread scheduled-read contract in the canonical build plan’s selected-thread monitoring section. Search/read scopes alone do not imply mailbox surveillance. A future Gmail watch stream must separately specify `users.watch`, Pub/Sub authentication, history cursor storage, renewal, dedupe/order, expired-history and gap recovery, reauthorization, revoke, deletion, and self-event suppression before it can replace polling.

Current contract gaps to fix:

- Calendar is proposal-only; add apply, get/read-back, reconcile, and revoke behavior.
- Email lacks bounded Gmail thread search/read; add it without weakening explicit send confirmation.
- No production adapter exists behind either port.
