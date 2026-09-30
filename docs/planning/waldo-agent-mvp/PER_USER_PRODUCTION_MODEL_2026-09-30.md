# Each user has their own Waldo: production tenancy model and audit

30 September 2026. Source audit at 6a3b4a3f86c1c9a97fe15fe8aafebc7e29fd626e. Docs-only proposal, not a completed migration or live multi-user certification. Owner's 08:28 audio and 08:31 channel transcript require multi-user identity, storage and operations from day one, not a step-7 bolt-on. The architecture already has substantial tenant support; saying the whole system was built for one Telegram user would be inaccurate. The gaps below are implementation drift and incomplete integration.

## Canonical identity, not a Telegram bot identity

Use the existing `waldo.owners.id` UUID as the canonical internal Waldo owner ID. Do not generate another competing UUID. `auth.users.id` is authentication identity, `waldo.owners.auth_user_id` maps it to Waldo, and `waldo.presences(provider,subject)` is the verified channel binding. Telegram numeric ID and WhatsApp phone are destinations/credentials, never the tenant key. Keep channel bindings changeable without moving the user's data.

Current code uses three different identity spaces:

- `waldo.owners.id` and separate unique `do_name` with `auth_user_id`: owner migrations and signed directory RPCs.
- Legacy `public.users.id` with `auth_id`: July schema and its child-table `user_id` keys. These are not automatically equal to `waldo.owners.id`.
- The companion app health context uses `auth.users.id`, via `health_context_read` mapping. Do not rewrite those foreign keys as if they already use the Waldo UUID.

Proposed typed runtime route: `{ ownerId, doName, channelProvider, channelSubject, timezone, stateVersion }`. Only authenticated server routing supplies it. `OwnerRoute` currently returns only doName/subject/timezone (`identity/owner-directory.ts:1,19,60-69`), so canonical owner identity is lost at that boundary. Add the UUID to signed route results and runtime admission; validate an immutable owner/doName binding inside the DO before handling requests. Keep one audited mapping for legacy/app IDs, never join by email or Telegram ID. Migration must preserve ownership and have conflict checks, backup and rollback; no data moves in this PR.

### DO identity and #400's R2 namespace

Current provisioning generates a random `owner-<uuid>` doName separately from owners.id (`20260925130000_waldo_open_signup.sql:57`). Webhook resolves `idFromName(route.doName)`. The resulting opaque `ctx.id.toString()` is stable for that namespace/name and is the proposed #400 R2 prefix. It is a storage locator, not the canonical Waldo UUID and not equal to auth_user_id. Record an explicit map `(environment, DO namespace, doName, DO id) -> owners.id` before using it for administration, export or deletion. Changing DO namespace/environment or doName must not silently strand blobs. #400 is pending and smoke-gated; its new keys cannot yet be described as deployed.

Longer-term options: retain the existing doName with a durable mapping (least disruptive), or migrate to names derived from canonical UUID with a controlled relocation. Prefer retaining names first. R2 keys also need environment/namespace scoping because staging and production currently share `waldo-artifacts` (`wrangler.jsonc`). Opaque DO ID alone has not been proven here as an environment segregation contract. Never treat a locator supplied by a tool/user as trusted owner scope.

## Provisioning: invite to an independent Waldo

Target flow:

1. Invite chain validates an unused invite and intended verified account. Signed auth attempt is throttled by email/IP; verification binds auth_user_id.
2. One transaction creates or finds canonical owners.id, stable doName and owner_settings. No duplicate tenant on retry. No admin role inherited from an inviter.
3. First authenticated request resolves the route and creates/starts that owner's DO lazily. Initialize owner UUID/name/state binding, isolated SQLite/KV state and schedule book. There is one runtime per owner, not one bot deployment per owner.
4. Link Telegram/WhatsApp as verified presences. Enforce one active provider+subject binding; unlink/relink changes routing, not tenant identity. Provider OAuth accounts belong to owners.id through connections; never fall back to the deploy owner's account.
5. Enable tools only for that user's connected permissions, caps and lifecycle state. Share Worker code, provider service infrastructure and database/bucket capacity; never share owner memory, secrets, effects, session state or quotas.

Current support: owners/auth uniqueness, settings transaction, active presence routing, one-use link codes, signed RPC and per-owner DO routing already exist. `owner_for_auth` currently has an OPEN-signup fallback and `signin_allowed` returns true for any signed caller in `20260925130000_waldo_open_signup.sql`; invites provide attribution rather than a gate. This conflicts with the owner's controlled invite-cohort goal. The target invite-required flow is NOT complete merely because invite tables/buttons exist. Fix that entry path before external cohort rollout, and test expired/revoked/wrong-account invites and concurrent first verifies.

## Store inventory: current ownership and required disposition

This inventory covers tables declared in this repository, runtime bindings and inspected paths. It is not a live database introspection or an exhaustive inventory of the companion app/provider stores. Each newly discovered store must be added before an "all data exported/deleted" claim.

| Store / surface | Current key and boundary | Production disposition / test |
| --- | --- | --- |
| `waldo.owners` | UUID id; unique auth_user_id and do_name; active/suspended. | Canonical owner. Map all operational IDs here; reject mismatched immutable binding. |
| `waldo.presences`, `owner_settings`, `link_codes`, `connections`, `connect_sessions`, `console_sessions`, `health_logs` | owner_id -> owners.id; signed RPCs/forced RLS in migrations. Connections link vault secret IDs. | Keep owner-bound access. Pair every privileged service-role path with owner verification and tests. Never disclose secrets to DO/model. |
| `waldo.proxy_idempotency` | `(owner_id, connection, pkey)` primary key, owner FK. | Keep effect claims per owner/connection; suspend/revoke must gate dispatch and retries. |
| `waldo.invites` | code hash, used_by owner; later attribution/admin fields must be preserved. | Invite is onboarding authority, not a tenant. Track inviter/audience without inheriting permissions; restore invite-required gate. |
| `waldo.console_auth_attempts` | `(key,bucket)` email/IP throttle, not owner FK. | Shared abuse-control data. Retention policy separate from tenant data; never call it canonical per-user runtime quota. |
| `public.users` | own UUID, auth_id -> auth.users.id; Telegram field is legacy binding. | Explicit mapping to owners.id, no assumption of equal UUIDs. Plan migration/retirement with app compatibility. |
| `user_consents`, `health_daily`, `crs_scores`, `user_baselines`, `spots`, `patrol_entries`, `feedback_signals`, `agent_logs`, `chat_threads`, `chat_messages`, `notification_log`, `user_devices`, `oauth_tokens`, `subscriptions` | user_id -> public.users.id; RLS via app_user_id. chat_messages also composite thread/user FK. | Existing multi-user schema, not single-tenant. Map legacy identity and inspect privileged EF paths before unification. Preserve health/privacy constraints. |
| `one_time_tokens` | nullable user_id -> public.users.id, plus token semantics. | Treat unbound tokens as onboarding records, not another user's data. Expiry/single-use/identity checks. |
| companion `public.health_context_daily` | read by auth_user_id mapping in `20260928160000_waldo_health_context.sql`. | Companion-owned schema; coordinate mapping and lifecycle there. A backend-only purge cannot claim it removed app data. |
| Owner DO SQLite/KV | private per routed `TelegramOwnerDO`; memory/claims/conversation/tools/ledger/files/episodes/schedules/traces. Some tables do not repeat owner_id because DO is the boundary. | Preserve private storage; verify route and immutable owner binding. Do not add owner columns mechanically to every private table. Test wrong route, restart and two users. |
| `RUN_LOOP_DO`, `TRACER_DO`, `RUNTIME_DO` | additional namespaces; responsibility path derives RunLoop root from context.ownerId (`index.ts:246-253`); tracer schema has user_id in several tables. | Audit every caller's owner authority and name derivation. RuntimeProbeDO is test-only. Do not infer tenancy from column comments alone. |
| R2 `ARTIFACTS` bodies | base uses unscoped random logical keys; #400 proposes DO-ID prefix, required namespace, encoded key, no legacy fallback. Metadata is DO-local. | Apply reviewed patch only after smoke gate. Map prefix to canonical owner+environment; design explicit legacy recovery, listing/export/delete and orphan accounting. No silent legacy import. |
| Vectorize `waldo-recall`, Workers AI | configured shared bindings, runtime consumer ownership not proven by this audit. | Before enabling shared index reads/writes, require owner namespace/filter at both boundaries and adversarial tests. Inventory IDs and deletion paths. Do not claim deployed use from a binding alone. |
| Model prompt cache / responder context | `telegram-turn.ts:108-115` derives invocation principal and cacheKey from LOCAL_TRUSTED_BRIEF fixture principal, shared constant in adapters.ts:46. Conversation tree remains per responder, but semantic identity/cache label is wrong. | Replace fixture admission with authenticated owner route. Per-user cache identity and tracing must use canonical owner. Provider cache behavior/privacy impact not proven here; do not assert an observed leak. |
| OTLP/Langfuse and DO trace book | DO traces label do_name (or unresolved); exporter identifies channel:subject; cost rows estimated from price table. | Canonical owner plus channel/session IDs, release/environment and response ID, estimated-vs-billed distinction. Avoid raw private data by default. Validate metrics segregation. |
| Scheduler alarms / run queues / webhook buffers | DO scheduler local; responsibility owner root; event ingress config carries owner_do. No general Cloudflare Queue consumer proven here. | Every work item includes canonical owner, source authority/version and idempotency scope. Recheck suspended/revoked state before effect. Inventory new external queues before rollout. |
| Ephemeral maps/cache | responder tree/offload/circuit state per instance; exporter maps per configured exporter; WhatsApp ingress map is request-local. | Confirm lifetime and owner boundaries by construction. Shared global maps must include canonical owner/environment or remain public immutable config. |

## Per-user production operations

### Admission, fairness and rate limits

Current auth email/IP throttles and the responsibility public edge limiter are not a complete per-user chat/model quota. The probe endpoint has DO-local per-owner counters, but ordinary Telegram/WhatsApp/model/provider work needs a unified owner budget. Define canonical owner + purpose windows for requests, concurrent turns, model calls/tokens, effects, workspace bytes/files and background jobs. Use durable counters/reservations, timeout/refund semantics and hard upper bounds; do not let new channel bindings evade the cap. Keep global/IP abuse limits as a second layer. Suspension and quota failure must precede effect, not just hide a response.

### Metrics and cost

Observability is dual-layer in the proposed production model: keep raw DO trace/outbox readback as the permanent development evidence path; step 4 adds Langfuse and Cloudflare observability above it, not instead of it. Cloudflare structured logs/metrics are another attribution source; invocation URLs/traces stay constrained by the existing credential-redaction/privacy gate in wrangler.jsonc. Source presence is not proof of per-user attribution or deployed receipt coverage.

Per-owner usage must include response IDs, model, tokens/cached tokens, estimate price version, provider request outcome, task/channel, release/environment, and independently reconciled aggregate charges where available. Current trace usd is a modelCost estimate; do not label it provider-billed. Operator views aggregate safely; users see only their own rows. Shared prompt cache labels and channel-based exporter IDs require the identity fix above. Define retention and content-free metrics before enabling broad text captures.

### Lifecycle

- **Suspend:** owners.state exists and route_presence excludes suspended owners. That does not prove cached DO runtimes, scheduled alarms, existing sessions or queued effects stop. Add state-version/revocation checks at each admission/effect boundary, cancel/hold background work, revoke channels/connections as intended. A documented resume path does not replay stale approvals.
- **Export:** produce a source-indexed owner export across DO memory/conversation/artifacts/schedules, R2 bodies, canonical and mapped legacy/app tables, settings and permitted metadata. Exclude provider secrets and third-party data outside scope. No complete export path was found in inspected console actions.
- **Delete:** current console calls delete_owner, then DO deleteAll, then says "Everything Waldo held for you is gone" (`telegram-owner-do.ts:332-335`). Latest SQL removes connections/vault secrets/sessions/health logs/owner, but that path does not remove R2 bodies, companion/legacy public rows, other DO namespaces, external telemetry, backups or indexes. Blanket copy is unsupported. Replace it with truthful status and implement a durable store-by-store purge job with retries, receipts, explicit retention exceptions and fresh survivor scan. Clear/disable schedules before deleting owner mapping; do not strand cleanup keys.

No suspend/export/delete action was executed during this audit. Deletion is a cross-store work item, not a single SQL cascade. Any recovery or migration of existing artifacts remains an owner-reviewed choice.

## Existing-path update plan, priority and acceptance

| Priority | Path / gap | Bounded change and proof |
| --- | --- | --- |
| Before external users | `owner-directory.ts`, route_presence, webhook/console admission | Carry canonical owner UUID, bind it immutably to doName and DO. Test channel relink and wrong-owner headers; no env fallback when directory is configured or fails. |
| Before external users | `telegram-turn.ts`, `run-loop/adapters.ts` local trusted fixture | Replace production fixture principal/context admission with authenticated owner. Test two owners have distinct cache/principal and no shared local fixture authority. Preserve hard trust gates. |
| Before external users | Open signup RPC / console signup | Restore intended invite gate with retry-safe transaction and verified-account binding; no extra owner on replay. Cohort membership visible to operator without leaking users to each other. |
| Pending #400 | `artifacts.ts` + one core caller | Prefix/map bodies, retain no-legacy-fallback caveat. Add environment separation, export/delete plan and explicit recovery choice. Workspace spec must use the same canonical-owner map. |
| Before deletion claim | console delete + SQL delete_owner + R2/index/app/telemetry cleanup | Truthful partial/queued status first; then durable purge ledger with owner mapping retained for recovery. Test survivor scan per store and idempotent retry. |
| Before shared usage | ordinary chat and scheduled/model/effect admissions | Per-user quotas and concurrency budget, lifecycle recheck, global abuse limits. Test cross-channel budget and suspend during pending work. |
| Before paid cohort | trace/cache/OTLP attribution | Canonical owner metrics, price-version estimates, response usage, aggregate bill reconciliation. Test A cannot read B metrics. |
| Before enabling each shared service | vector/index, provider proxies, event routes, workspace/sandbox | Owner-bound input/output and namespace, typed no-owner rejection, permission/revocation tests. Actual service probe required before readiness. |
| After core smoke, ahead of features | browser approval result contract | Coordinate typed executor and approval ledger truth; no Done toast for rejected/unverified/uncertain. Does not substitute for actual effect receipt. |

Do not block the two fictional smoke runs on completing this entire production model. They validate the core, not public readiness. Conversely, a smoke pass never clears the external-user/lifecycle blockers. Parallel lanes can own bounded store/contract fixes with exact core handoffs and one merged unit, not overlapping core edits.

## Scope and evidence limits

This is source-grounded, not a live account/schema/traffic audit. Repository migrations show intended schemas, not the current deployed DB. Table inventory above omits uninspected companion-app stores and future stores by design; require their inventory before release/export/deletion claims. Product readiness requires exact-head tests plus live routing, account permission and store-isolation probes. No production state, shared identity, RLS or spending authority is changed by this document.

Evidence: existing owners/open-signup/console-session/connection/proxy-idempotency/health-context/delete migrations; `identity/owner-directory.ts`, `channels/telegram-webhook.ts`, `whatsapp-webhook.ts`, `event-ingress.ts`, `telegram-owner-do.ts`, `telegram-turn.ts`, `run-loop/adapters.ts`, `tracer/schema.ts`, `observability/otlp-turns.ts`, `index.ts`, `wrangler.jsonc`; pending [#400](https://github.com/waldoco/waldo-backend/pull/400). Provider primitive reference: https://developers.cloudflare.com/durable-objects/concepts/what-are-durable-objects/ documents private per-object storage and addressed instances; application routing still selects that instance. Original tenancy directions inspected from owner audio and WhatsApp messages, not inferred from repository instructions.
