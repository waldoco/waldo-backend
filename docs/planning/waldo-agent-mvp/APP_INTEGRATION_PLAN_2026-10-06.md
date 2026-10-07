# Waldo app ↔ owner agent integration plan (revised 2026-10-07)

**Status.** This is a plan only and a candidate roadmap (see `CLAUDE.md`). It authorizes no code, migrations, deployment, hosted SQL, provider spend, secret handling or ownership transfer. Future work runs under a bounded task, its owning issue and the existing sole-writer ownership.

**Revision.** This revision supersedes the 2026-10-06 draft, which chose an "A-or-B" architecture and proposed "convergence later". Both are withdrawn. The draft was pinned at `a43a4152`, before the common owner lifecycle (`common-owner-host.ts`, signed common ingress and execution requests) existed in source. The 7 October review is incorporated.

**Pins.**
- Backend `beta-mvp` `bb9b6705` (waldoco/waldo-backend). Claims below cite this pin unless marked `@a43a4152`.
- App `895ed6e4` (Pin4sf/waldo-app `main`).
- Device-bridge PRs #771 `b7d1cdfd` and #772 `3e7a750c`: open drafts, compatibility refresh pending.

**Labels.** Only these four are used:
- **SOURCE**: read in source at the pins. ✓ marks claims the plan author re-read.
- **CI**: exact-head CI.
- **STAGING**: observed on staging.
- **UNVERIFIED**: not observed.

The plan author ran no tests, CI, device builds, database inspection or app staging turn. The CI and staging observations below come from the 7 October review, and are labelled as reported there.

---

## (a) Current state

### Backend (`bb9b6705`)

- **The common owner lifecycle exists in source, staging-gated and off.**
  - `commonOwnerHost` returns `undefined` unless `COMMON_OWNER_TASKS==='1'` and `WALDO_ENVIRONMENT==='staging'` (`channels/common-owner-host.ts:14`). SOURCE ✓
  - `TelegramOwnerDO` signs source custody and execution (begin/check/provider/tool/final) to the canonical `RunLoopDO`/`WaldoCoordinator` lifecycle (`channels/telegram-owner-do.ts:259-308`, `signCommonMessageIngress`, `signCommonExecutionRequest`). SOURCE ✓
  - The review reports that `COMMON_OWNER_TASKS` and `BROWSER` are absent in the deployed version. STAGING, as reported by the review.
  - Physical separation of `TelegramOwnerDO` (host: presentation, queue, channel state) and `RunLoopDO` (canonical root) remains. They are no longer two unrelated agents.
- **Canonical context deliberately excludes legacy bytes.** Common-host recall returns `status:'failed'` with "Legacy recall is not admitted to canonical owner context". `health:null`, skills are empty, and the ledger is not loaded (`common-owner-host.ts:11-12,32-45`). SOURCE ✓
  - Consequence: a Telegram legacy memory claim is **not** canonical context, so it cannot be used as a cross-surface memory acceptance test.
- **Common ingress is Telegram/WhatsApp-only.**
  - `verifyCommonMessageIngress` admits `provider ∈ {telegram, whatsapp}` with a numeric `subject` (`identity/common-message-ingress.ts:15`). SOURCE ✓
  - `PresenceProvider = 'telegram' | 'whatsapp'` (`identity/owner-directory.ts:15`). SOURCE ✓
  - The host source is Telegram-specific: the environment id is `telegram_common_owner_host`.
  - An app's Supabase UUID has no admitted path. Impersonating a Telegram subject is forbidden.
- **A safe config diagnostic exists.**
  - `commonRuntimeDiagnostic` sits behind the owner-console session (`telegram-owner-do.ts:988`). It is staging-only and rate-limited.
  - It returns `project_matches_expected` (whether the URL host is `togdshayyxycitzckpqv.supabase.co`) plus configuration booleans, with `scope:'configuration_only_not_rpc_acl_or_secret_equality'` (`channels/common-runtime-diagnostic.ts`). SOURCE ✓
  - It does not prove RPC ACLs, secret equality, table state or JWT signing mode. No live receipt was read for this plan. UNVERIFIED
- **No app route or push adapter.** There is no `/app/v1` route in `runtime/src/index.ts`, and no APNs/Expo sender. SOURCE ✓ The review reports the same for the deployed version.
- **Release identity on staging.**
  - The review reports exact-head and post-beta CI passing at `bb9b6705` (actions runs 37633423379 and 37634634752). CI, as reported by the review.
  - The review reports staging `/healthz` serving `bb9b670`. That shows which release is deployed, not that the app integration works. STAGING, as reported by the review.
- **Health read has no consent predicate.** `waldo.health_context_read` joins `waldo.owners.auth_user_id` to `public.health_context_daily.user_id` with no consent predicate (`supabase/migrations/20260928160000_waldo_health_context.sql`: 0 occurrences of "consent"). SOURCE ✓
- **Two consent schemas disagree.**
  - The backend migration history has `user_consents.health_data_consent` (`0001_identity.sql:68`; `0002_health.sql:68`; relaxed in `reconcile_contract_spine.sql:6`). SOURCE ✓
  - The app migrations and `health-sync` use `consent_kind` / `granted` (app `0002_health_and_connectors.sql:120`; `health-sync/index.ts:135-148`). SOURCE ✓
  - Matching table names do not prove matching schemas. The deployed schema is UNVERIFIED.
- **Approvals desk.**
  - Read check at `channels/approvals.ts:197`. SOURCE ✓
  - Atomic `open → uncertain` claim for `task_sources` / `browser_submit` (`:214-215`, `:229-231`). SOURCE ✓
  - Other kinds rely on per-kind reconciliation: email Message-ID, calendar etag, message idempotency key (`@a43a4152`, not re-read).
  - `serial()` plus a read check is not crash-safe compare-and-claim evidence.
- **Telegram durable inbox is Telegram-shaped.** `admit` pins `telegram_subject` (`telegram-owner-inbox.ts:39-49`). SOURCE ✓
- **`FORGET_INTENT` regex** (`memory/claims.ts`, `@a43a4152`) conflicts with the no-regex-judgment rule. Route it to `post-mvp-cleanup`; it is outside this plan.

### App (`895ed6e4`)

The current app instructions (`CLAUDE.md`) already require backend-owned execution, generated public contracts, optional health consent and per-account isolation. Preserve them.

- **Preserve:** app PR #12's honest error (`src/chat/useChat.ts:65-68`) and owner-scoped thread lookup (`supabase/functions/agent/chat.ts:66-74`). They do not establish account isolation, consent or safe provider egress. SOURCE
- **Health defaults and consent.**
  - `syncPrefs.ts` defaults sync **ON**, and also returns ON when the SecureStore read fails (`:13,15`). SOURCE
  - `health-sync` creates granted consent on first ingest (`index.ts:127-150`). SOURCE ✓
- **Freshness is hardcoded by the client.** `buildHealthUpload.ts:159` sets `freshness:'fresh'`, and the server stores the client value (`health-sync/index.ts:91,107`). SOURCE ✓ This corrects the 10-06 draft, which put the literal on the server.
- **Legacy chat** formats numeric health scores into OpenAI context and persists chat messages (`agent/chat.ts:21-29,127-134`). SOURCE
- **Account isolation.**
  - `signOut` only calls Supabase `signOut`. Nothing purges local stores, callbacks, drafts, the watermark, SQLCipher, the query cache or push state (`src/supabase/auth.ts:83-85`). SOURCE
  - The app route layout has no auth guard. SOURCE
- **KAIROS.** The legacy worker selects a DO from the caller-supplied `userId` before authentication (`runtime/waldo-worker/src/index.ts:20-23`). It is contained; do not enable it as the replacement. SOURCE
- **Push.** `expo-notifications` is installed. There is no token registration, approvals UI, Activity view or streaming. SOURCE

### Unverified live prerequisites

These are prerequisites, not owner homework. Collect them with the available authenticated checks and report only the smallest real access gap.

- Supabase project mapping for the app's users. The diagnostic receipt above proves configuration equality only.
- The deployed consent schema.
- JWT issuer and signing mode.
- RPC ACLs.
- Native push and background behavior. No device or provider evidence exists.

---

## (b) Architecture: one canonical owner lifecycle

The app is a surface of the same canonical owner lifecycle. It is not a second agent inside either Durable Object.

1. **Authentication.** The app authenticates with its Supabase session against a backend public API. The backend derives owner and install authority and never trusts a caller-selected owner, tenant, DO name or model.
2. **Additive app ingress.** An additive app identity/ingress adapter, next to the Telegram/WhatsApp common ingress, creates the authenticated occurrence and the frozen owner/source/context binding for the **same** canonical execution lifecycle.
3. **Physical host role.** The physical host may keep presentation, queue and channel state. It must not own a competing task state machine, provider loop or terminal decision.
4. **Canonical execution seams.** Provider and tool attempts, cancellation, deadlines (persisted, shared alarm arbitration), uncertain effects and final settlement go through the existing canonical seams.
5. **Committed reads.** The app reads committed projections and receipts through generated, versioned contracts. These states stay distinct:
   - `admitted` (202)
   - `result verified`
   - `published`
   - `provider accepted` (push)
   - `seen`

**Explicitly rejected:**
- "TelegramOwnerDO only now, converge later."
- Bypassing the coordinator to reach the legacy conversation store.
- Treating a generalized queue as common execution.
- Reusing the device bridge's pairing, heartbeat or capabilities as app authority. App Supabase login stays distinct from Mac bridge signing and presence.

**Channel plug-in interface.** The cleanest interface for WhatsApp and iMessage owners is the common ingress/occurrence and committed-projection contract above. Telegram, WhatsApp and the app become adapters at the same seam. Defining that seam is part of the boundary specification (slice 1). Do not extract it from Telegram internals.

---

## (c) Answers

**1. Identity.**
- **How an install is bound.**
  - The Supabase session is verified server-side against the supported issuer.
  - The owner comes from the existing directory mapping of `auth_user_id`, never from the request.
  - No owner, or an inactive owner, gives a typed refusal, and no DO is created.
  - Owners are never silently created, and an existing presence is never displaced. Provisioning and multiple installs are bounded product/schema decisions for the slice that needs them.
- **Per-install record.** Revocation needs a per-install record. It is a new aggregate, so its schema, single writer and contract go through explicit review before implementation.
- **Revocation** fences current generations, callbacks, effects and uncertain outbox rows:
  - Unclaimed queued work is quarantined.
  - Running work fences through canonical cancellation.
  - Pending pushes are blocked.
  - Approvals remain owner-level.
- **What is not reused.** The console cookie and the Mac bridge contract are not reused.

**2. Transport.**
- Authenticated HTTP commands with client idempotency keys, plus committed-projection reads by cursor or snapshot. There are no sockets: the bridge shows the heartbeat-socket model is not app authority, and iOS background behavior is UNVERIFIED.
- Sessions end in the Worker for authentication and owner resolution. The host re-checks inside its serialized path.
- Order across surfaces comes from the canonical lifecycle's admission order, not from a host-local queue alone.
- A new app event or projection aggregate needs schema/writer/contract review first.

**3. One agent.**
- **Minimal path:** app ingress adapter → canonical lifecycle (same root, same provider seam, single terminal settlement) → committed reply projection read back by the app.
- **Cut-over order:**
  1. Chat.
  2. Approvals (existing actions).
  3. Push.
  4. Calendar reads.
  5. Propose/commit.
- **Server-enforced containment:** the legacy app engine refuses a migrated owner, including old app builds. There is no silent fallback, dual execution or automatic retry into the legacy provider.
- **Rollback** fences generations, callbacks, effects and uncertain rows first. It never automatically resumes the legacy engine after an ambiguous effect just because a flag flipped.

**4. Approvals.**
- Reuse the canonical effect/approval path and existing backend actions, with final-recipient and content review. Do not build a separate app approvals engine.
- Keep cross-surface race and crash tests. Before prescribing any universal claim-status patch, review per-kind reconciliation (email Message-ID, calendar etag, message idempotency).
- Do not widen send approval from the app through this plan. Console parity is a proposed release cut.
- `task_sources` confirmation changes private read and disclosure scope. Keep it, and review its capability boundary separately from sends and spend.

**5. Notifications.**
- **Role.** Push is a content-free hint. Authenticated projection readback is the truth.
- **States.** APNs acceptance means `provider accepted`, not delivered or seen.
- **Outbox.** A push outbox is a new aggregate: review it, with no duplicate retry or terminal owners.
- **Timing.** Copy, environment and credentials belong to the later push slice. Verify the environment from current provider documentation and account configuration. Persistent credentials come only through the approved secret channel.
- **Evidence.** Native and background behavior needs real device and provider evidence (none yet).

**6. Health.**
- **Start with what the owner tells Waldo.** First value is user-stated energy and context in conversation.
- **Before HealthKit-derived data reaches any agent path:**
  1. Cloud consent is explicit, purpose-bound and separate from OS permission. Missing, unavailable or revoked consent fails closed.
  2. Sync defaults **OFF**, including when the local read fails.
  3. Gate ingestion **and every backend health read**, `health_context_read` included. A healthy table or a signed router request is not consent.
  4. Compute freshness from verified source/window timestamps and the owner timezone. Never trust the client constant, and never invent readiness when data is stale.
  5. Apply ADR-0081 destination rules before numeric scores, raw data or sensitive chat reach providers, transcripts, memory or logs. Being derived does not make data unrestricted.
  6. Apply ADR-0082 account/consent epochs, per-account encryption and purge to SQLCipher, Query/Zustand, SecureStore, drafts, watermarks, callbacks, background jobs, push and provider/session state.
  7. Reverify the deployed consent schema (`health_data_consent` vs `consent_kind`/`granted`) before any migration. Do not blindly extend it, and do not add a second consent store.
- **Stays on device:** raw HealthKit samples and intraday IBI/HR. A new consent purpose needs explicit review.
- **Health logs.** The numeric policy for `health_logs` goes through the bounded ADR review, not an invented numeric filter.

**7. Isolation tests** (red first; two owners A and B):
- **Sessions:** forged, expired, wrong-issuer and revoked sessions are rejected.
- **Owners:** an inactive or unprovisioned owner is refused. A wrong install, session or generation is rejected, and no wrong-owner DO is created.
- **Cross-owner references:** A and B each attempt the other's message, thread, cursor, approval, install and operation refs; none resolve.
- **Delivery:**
  - Duplicate client message ids are deduplicated.
  - Interleaved channels keep their order.
  - Work recovers durably.
  - Revocation during work fences it.
- **Lineage:** the same canonical owner/task/source/context lineage holds across host and root. There is no second provider loop and no independent terminal settlement.
- **Deadlines and cancellation:**
  - Deadlines are persisted with shared alarm arbitration.
  - Cancellation works before and after provider or tool preparation.
  - Crash-before-registration and ambiguous final delivery are covered.
- **Reply readback:** the committed reply is read back and verified by the server. A 202 is admission only.
- **Legacy refusal:** the legacy engine refuses a migrated owner, including an old build.
- **Device:** on account switch, nothing from A remains in any local store or push binding.
- **Cross-surface memory:** test it only after a reviewed, purpose-bound owner projection with custody and revocation rules exists. Never copy legacy bytes or switch to the legacy host to pass the test.

**8. Offline and background.** The app shows only states the server committed: not sent, admitted, working, published reply, failed, or outcome unknown. Drafts resend with the same idempotency key. There is no synthesized reply text. The existing app fix stays.

**9. Observability.**
- **Trace key:** `app-<client_message_id>`.
- **Fields:**
  - `channel/surface=app`
  - owner identity (existing redaction)
  - an install hash
  - `WALDO_RELEASE`
  - app version/build
  - contract version
  - canonical run/occurrence refs
  - settlement state
  - push state
- **Metric labels:** bounded enums only; production text capture stays off.

**10. Slicing.** See (d).

**11. Top five risks and the cheapest experiment for each.**

| # | Risk | Cheapest experiment |
|---|---|---|
| 1 | Project mapping, issuer or signing mode differs from assumptions | Read the console-gated staging diagnostic receipt (configuration equality only); check the issuer mode through an authenticated config read; report the smallest access gap |
| 2 | The deployed consent schema differs between app and backend | A read-only schema check of `user_consents` on the target project before any migration design |
| 3 | The common lifecycle cannot admit a non-numeric app subject without weakening ingress | Write the additive app-ingress contract first, with valid/invalid fixtures; prove existing Telegram/WhatsApp ingress fixtures are byte-unchanged |
| 4 | No reviewed canonical memory projection exists, so "one memory" cannot be shown | Specify the purpose-bound owner projection with custody/revocation rules before any cross-surface memory test |
| 5 | Cross-surface approval crash leaves a double effect | A red test, per kind, of a crash mid-await followed by a decision from a second surface, run against existing reconciliation before any patch |

---

## (d) Delivery order

Existing sole-writer ownership stands; this document assigns no new owner. Coordinate file boundaries so no two writers edit the same files concurrently. Each step publishes these results separately as PASS / FAIL / NOT RUN:
- source
- local tests
- exact-head CI
- staging
- native device
- real external effect

1. **Containment, privacy and account fixes + common app boundary specification.**
   - App:
     - sync default OFF, including on read failure
     - no auto-consent
     - no client freshness authority
     - full sign-out/account purge
     - route guard
     - KAIROS stays contained
   - Backend: a consent-gated `health_context_read`, after schema reverification.
   - Spec: the app identity/ingress boundary on the common lifecycle, naming the existing single writer and exact files and aggregates.
2. **Additive versioned contract + authenticated common-lifecycle tracer**, with legacy refusal wired alongside cut-over.
   - Preserve historical released protocol bytes.
   - Acceptance: the Q7 tests plus server-verified committed reply readback on staging, with staging deploy authorization granted separately.
3. **Owner-bound projections, recovery and approval acceptance.** Then install registry, push outbox and native work, each in its reviewed dependency order with schema/writer/contract review before implementation.

Out of scope: payments, automatic spending, plan changes, bridge edits, iOS expansion of the bridge, WhatsApp/iMessage implementation, and the `FORGET_INTENT` cleanup.

---

## (e) Former decisions D1–D12, resolved by the 7 October review

- **D1:** Replaced. The direction is one root and the common lifecycle; physical host placement is an implementation question within it.
- **D2:** Collect the safe authenticated project/config receipt. Separately verify the deployed schema and issuer mode. Never copy secrets to chat.
- **D3/D4:** Multiple installs and provisioning are bounded decisions for the slice that needs them. No silent owner creation or presence displacement.
- **D5:** Shared authority and memory does not mean broadcasting all threads or health to all surfaces. Expose only reviewed projections with audience restrictions.
- **D6:** Reuse existing actions and content review. No widening of app send approval here. Console parity is a proposed release cut.
- **D7/D8:** Belong to the push slice. Credentials only through the approved secret channel.
- **D9:** App identity stays separate from the Mac bridge. No bridge edits.
- **D10:** Bounded ADR-0081 review. No invented numeric filter.
- **D11:** Existing sole-writer ownership stands.
- **D12:** Keep `task_sources` confirmation. Review its capability boundary separately.

Remaining open question for the owner:
- Who authorizes the staging deploy for the step-2 tracer when it is ready?
