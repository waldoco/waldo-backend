# Waldo App -> Backend Ownership And Migration Plan

Status: HEY-150 artifact supplied for review; HEY-150 remains In Progress until this matrix is
accepted. This document is not parity, cutover, staging, or decommission proof.

Date: 2026-07-10 IST.

## Pinned Source And Authority

- Canonical deployable app repository: `Pin4sf/waldo-app`.
- Audited app snapshot: `c8b3b4555de076339554391da4dbf5fbe2dac0ae`.
- Current-path evidence: routed APP-R2 at
  `/tmp/waldo-harness-audit-bus/app-current-evidence-packet.md`.
- Merged backend implementation baseline: `waldo-backend` `origin/main` at
  `b311d548a91b3c71f65004833621f5f4cdb6fab5`.
- PR #45 supplies and amends this HEY-150 artifact for review; the PR number is review provenance,
  not an implementation baseline.
- Historical `Pin4sf/Waldo.git/waldo-app` is nondeployable lineage and is not a migration source of
  truth.

This plan classifies APP-R2's known source paths. APP-R2 intentionally did not query deployed
Supabase, Cloudflare, callback, scheduler, binding, secret, or provider state. Every deployed-residue
cell below is therefore a required future check, not a claim that residue is absent.

## Proof Vocabulary

APP-R2 uses these proof levels:

| Level | Meaning in this plan |
| --- | --- |
| `absent` | APP-R2 found no implementation for the claimed capability. |
| `static/mock` | Source, schema, fixture, or UI exists without a proved reachable real path. |
| `local-functional` | A reachable app-side source path or pure local behavior exists; its remote dependency is not proved. |
| `native-device` | Physical-device behavior is proved. APP-R2 found none. |
| `staging` | Authenticated deployed staging behavior is proved. APP-R2 found none. |
| `production` | Production behavior is proved. APP-R2 found none. |

Across the 69 routed product flows, APP-R2 counted 14 `absent`, 29 `static/mock`, and 26
`local-functional`; it found zero `native-device`, `staging`, or `production` rows. A source path,
configuration file, migration, or ticket must not be promoted above that evidence.

## Ownership Rules

1. `waldo-backend` is the only agent runtime. It owns verified ingress, owner-bound Durable Object
   selection, Governor, provider/tool execution, context, Scribe, journal/outbox, DeliveryGate,
   public projections, and committed OpenAPI.
2. `waldo-app` owns UI, protected navigation, generated-client consumption, device/native adapters,
   and HEY-159's account/consent-bound cache implementation.
3. The app supplies no `userId`, tenant, account, DO, thread, run, model, or provider routing
   selector to public ingress.
4. Cutover is one path per build/session. There is no per-request legacy retry, dual read, dual
   write, or user-visible fallback to embedded runtime code.
5. HEY-152 owns route assignment, global cutover/kill, and rollback. HEY-156 owns staged parity,
   two-user isolation, and rollback proof. HEY-155 removes legacy source and deployed residue last.

## A. Direct Tables And Function Invocations

| Current path/category | Current owner and APP-R2 proof | Canonical destination/owner | Freeze guard | Cutover and rollback | Deployed-residue check | Removal gate |
| --- | --- | --- | --- | --- | --- | --- |
| `src/home/backendHome.ts:42-110` -> `patrol_log` | App direct table read; `local-functional`, remote/RLS unproved | Patrol/audit public projection in `waldo-backend`; generated client HEY-132 | Guard new app `.from(` calls and forbid internal table names in app network code | HEY-152 selects backend projection globally; rollback reverts the build/route, never retries this table per request | Inventory deployed RLS, grants, views, clients, and logs using `patrol_log` | HEY-156 A/B parity and rollback; zero reachable readers/grants before HEY-155 deletes source |
| `src/home/backendHome.ts:42-110` -> `handoffs` | App direct table read; `local-functional`, Handoff product behavior deferred | No Alpha public Handoff projection; future accepted backend state owner only | Guard `handoffs` and Handoff DTO imports; hide deferred UI | Remove from Alpha composition; rollback restores only non-action UI behind an off flag | Inventory table/view/grants/jobs/callbacks that read or write `handoffs` | Accepted future Handoff decision or deletion after HEY-156 confirms no Alpha dependency; HEY-155 removes current read |
| `src/home/backendHome.ts:42-110` -> `spots` | App direct table read; `local-functional`, authority/provenance unproved | HEY-158 generation, provenance, projection, engagement, and privacy; HEY-132 generated consumer | Guard direct `spots` table strings and handwritten Spot DTOs | Cut to HEY-158 public projection; whole-build rollback only | Inventory RLS, grants, Functions, jobs, views, callbacks, and clients touching `spots` | HEY-158 contract/staging proof plus HEY-156 parity; zero direct readers before HEY-155 removal |
| `src/connectors/useGmail.ts:16-25` connector-account read | App direct internal-account read; `local-functional`, deployed RLS unproved | Backend connector status projection and OAuth custody; app renders generated DTO | Guard connector table names and `.from(` outside the generated client | HEY-152 switches connector status route; rollback switches the whole route/build | Inventory account tables, Vault grants, callback allowlists, Function callers, and service-role readers | Callback/refresh/revoke parity, two-user denial, and zero direct readers before HEY-155 |
| `src/agent/agentClient.ts:74-121` -> Function `agent` | App-owned agent Function invocation; `local-functional`, provider path unproved | Backend authenticated command/Chat seam after HEY-126 and ADR-0077 amendment | Guard `functions.invoke("agent")` and app-owned model/provider DTOs | Cut only after backend Chat command/replay parity; rollback selects one prior route globally | Inventory deployed Function, URL, logs, secrets, service-role grants, schedules, and callers | HEY-126 evidence + amended ADR-0077 + HEY-156 parity; HEY-155 removes invocation/Function |
| `src/agent/agentClient.ts:74-121` -> Function `calendar` | App-owned calendar invocation; `local-functional`, external write proof absent | Backend calendar adapter/OAuth custody and signed approval path | Guard `functions.invoke("calendar")` and direct calendar writes | Cut adapter after fake/staging read-write-confirm-deny parity; rollback disables writes and selects one route | Inventory deployed Function, Google OAuth client, Vault tokens, callbacks, cron refresh, and grants | Restricted-scope verification, approval/journal/idempotency proof, revoke parity, then HEY-155 |
| `src/health/sync/healthSyncClient.ts:17-42` -> Function `health-sync` | App-owned health upload; `local-functional`, consent/RLS/device proof absent | Versioned backend health ingestion under ADR-0081 plus HEY-159 lifecycle gates | Guard direct Function name, pre-consent network start, raw-health logs, and caller identity fields | Cut after consent/source/cursor/idempotency contract; rollback stops sync and retains device data per policy | Inventory deployed Function, tables, RLS, service-role grants, jobs, buckets, logs, and deletion hooks | Two-user/consent/revocation/deletion/device proof; HEY-155 removes legacy upload only after rollback window |
| `src/insights/insightsClient.ts:33-52` -> Function `insights` | App-owned derived insight invocation; `local-functional`, remote/provider proof absent | Backend committed Brief/Spot/health projection as applicable; no app model call | Guard Function name and handwritten insight response | Cut surface-by-surface to generated projections; rollback selects one prior build/route | Inventory deployed Function, provider calls, tables, schedules, caches, and clients | Contract parity, no-fabrication degraded states, HEY-156 staging, then HEY-155 |

## B. Embedded Supabase, KAIROS, Providers, And DTOs

| Current path/category | Current owner and APP-R2 proof | Canonical destination/owner | Freeze guard | Cutover and rollback | Deployed-residue check | Removal gate |
| --- | --- | --- | --- | --- | --- | --- |
| `supabase/migrations/**` | App-owned schema/RLS migration tree; `static/mock`, root checks exclude it and merge/deploy state is unproved | Canonical Supabase/RLS/Vault migrations in `waldo-backend` under HEY-134/114 | Freeze new app migrations; require a guard that app contains no authoritative migration owner | Re-land reviewed schema in backend with forward/rollback plan; never run two writers | Compare deployed migration ledger, schemas, policies, grants, triggers, functions, buckets, extensions, and ownership | HEY-134/114 accepted migration/rollback plus zero app-owned deployment dependency; archive/delete under HEY-155 |
| `supabase/functions/**` | App-owned Edge Function tree; `static/mock` to `local-functional` by caller, deployment unproved | Typed backend Worker/DO/adapters only | Freeze new app Functions and ensure CI scans/typechecks the tree until removal | Route each caller through HEY-152; global rollback per route, no request fallback | Enumerate deployed Functions, versions, routes, JWT settings, env, secrets, logs, cron/webhooks, and callers | Every Function has a mapped replacement or explicit deletion; HEY-156 parity and zero deployed callers before HEY-155 |
| `supabase/functions/agent/chat.ts:47-83,85-115,137-138` | App-owned Chat/OpenAI runtime; `local-functional` source path with latent thread BOLA, provider/deploy proof absent | Backend Chat transport after HEY-126/ADR-0077; backend provider/Governor/journal/Scribe | Guard service-role thread access, OpenAI imports, and app Function Chat entrypoint | Migrate transcript/command semantics once, then switch global Chat route; rollback disables new writes before route revert | Inventory Function deployment, thread/message tables, service-role grants, provider secrets, logs, queues, and callers | Ownership/BOLA negative tests, replay/idempotency, provider/privacy proof, HEY-156 parity, then HEY-155 |
| `supabase/functions/agent/commit.ts:23-198` | App-owned external calendar commit path; `local-functional` source, real write/deploy proof absent | Backend signed-approval tool/adapter with journal and idempotency | Guard external write SDK/REST calls in app-owned Functions | Cut only after dry-run/confirm/deny/retry parity; rollback kills writes before selecting old build | Inventory deployed Function, OAuth/Vault tokens, external webhook/jobs, grants, logs, and idempotency records | External verification, approval/replay proof, revoke/rollback drill, then HEY-155 |
| `supabase/functions/_shared/google.ts` | App-owned Google token/provider/Vault helper; `static/mock` source, deployment/custody unproved | Backend connector/OAuth/Vault module | Guard Google token exchange/refresh and Vault RPCs outside backend | Migrate custody only after callback/refresh/revoke parity; rollback disables callbacks and refresh jobs first | Inventory OAuth clients, redirect URIs, Vault rows/functions/grants, secret env, cron refresh, and active tokens | Initiating-subject binding, single-use state, revoke/delete proof, zero active legacy tokens/jobs, then HEY-155 |
| `supabase/functions/_shared/contracts.ts:12-347` | Handwritten Function contracts; `static/mock`, separate from app client DTOs | Committed backend OpenAPI/contracts; generated runtime-validating HEY-132 client | Hash/freshness guard rejects handwritten duplicate public schemas | Consumers switch with one schema version and rollback-compatible artifact | Search deployed Functions/bundles and app releases for the old schema hash | Byte-identical regeneration, compatibility fixtures, no imports/callers, then HEY-155 |
| `src/kairos/kairosClient.ts:11-35` | App-owned KAIROS URL/client; `local-functional`, remote proof absent | Generated backend public client only | Guard KAIROS base URL, client import, and caller `userId` payload | HEY-152 selects canonical backend base/route; rollback is whole-route/build | Inventory shipped URLs, remote config, deep links, logs, app releases, and callers | HEY-153 two-user rejection + HEY-156 parity; zero reachable KAIROS URL/client before HEY-155 |
| `src/kairos/kairosClient.ts:23-34` caller `userId` | Caller-selected identity; `local-functional`, unsafe by construction | HEY-153 derives verified Woof subject before owner-bound DO lookup | Static guard rejects identity/routing selectors in public requests | Remove field with versioned request contract; no compatibility fallback accepting it | Search app releases, server logs/metrics schemas, Worker routes, and tests for the field | Wrong-user/selector rejection before DO lookup and no accepted schema containing `userId` |
| `runtime/waldo-worker/src/index.ts:13-45` | App-owned Worker/DO; `local-functional` source, deployment unproved; uses `userId` for `idFromName` | Canonical authenticated backend ingress and owner-bound DO under HEY-153 | Freeze app Worker edits/deploy config; guard `idFromName` from caller data | HEY-152 routes all traffic to backend; rollback uses one global route and disabled writes | Inventory Workers, routes, custom domains, DO namespaces/classes/storage, bindings, secrets, logs, queues, and alarms | HEY-153/156 identity/parity proof; exported/deleted required DO state; zero routes/bindings before HEY-155 |
| `runtime/waldo-worker/package.json:1-15` | App Worker dependency island outside root lock; `static/mock` | No retained app Worker package; backend pinned workspace owns runtime dependencies | CI rejects unlocked embedded runtime packages | No runtime cutover effect; retain only until source/deploy inventory is reproducible | Compare deployed bundle/module versions and lock provenance | Worker decommission evidence retained, then package/tree removed by HEY-155 |
| `supabase/functions/agent/chat.ts:85-115` OpenAI | App-owned provider call; `local-functional` source, real call/deploy proof absent | Backend `LLMProvider`/Gateway; HEY-143 remains In Progress and HEY-13 gates real content | Guard provider SDK/import/API URLs outside backend and secret-bearing app config | Provider route moves only after backend fail-closed/spend/sanitizer/staging gates; rollback kills provider before route switch | Inventory OpenAI projects/keys, Function secrets, logs, usage, allowlists, and active callers | HEY-13, spend/secret custody, bounded provider smoke, HEY-156 parity, zero legacy key/caller, then HEY-155 |
| `supabase/functions/_shared/google.ts` and `supabase/functions/agent/commit.ts:23-198` Google | App-owned Google provider/token/write path; `static/mock`/`local-functional`, deployment unproved | Backend connector adapters and Vault custody | Guard direct Google REST/token calls outside backend | Cut per connector after callback/read/write/revoke parity; rollback disables jobs/writes first | Inventory OAuth clients, credentials, redirect URIs, refresh jobs, Vault grants/tokens, external webhooks, and callers | External verification plus revoke/delete/rollback proof; zero legacy custody before HEY-155 |
| `src/connectors/googleCalendar.ts:5-100` | Deprecated device Google token/REST client; reportedly unimported, `static/mock` | App browser UX plus generated backend connector client | Guard import and direct Google token/REST endpoints | Keep unreachable until backend parity, then delete; rollback never re-enables device custody | Search app bundles/releases, deep links, remote config, OAuth redirects, Keychain/SecureStore, and logs | Zero imports/bundle symbols/tokens/redirects for one rollback window, then HEY-155 |
| `src/types/index.ts:1` | App-local type barrel replacing generated types; `static/mock` | HEY-132 generated client/types | Guard public DTO declarations outside generated output | Switch imports atomically with schema hash; rollback uses prior generated artifact | Search shipped bundles and source for old type imports | Zero handwritten public DTO imports and byte-identical generation |
| `src/agent/agentClient.ts:9-62` | Handwritten agent/calendar request/response DTOs; `static/mock` | HEY-132 generated clients after HEY-151 and HEY-126 contracts | Guard named DTOs and manual fetch/invoke response casts | Replace per accepted contract; no dual parser or fallback | Search bundles/tests/callers for old DTO names and schema hashes | Runtime validation, invalid-pair fixtures, zero imports/callers, then HEY-155 |

## C. App-Owned Auth, Data, Cache, And Runtime Seams

| Current path/category | Current owner and APP-R2 proof | Canonical destination/owner | Freeze guard | Cutover and rollback | Deployed-residue check | Removal gate |
| --- | --- | --- | --- | --- | --- | --- |
| `app/(app)/_layout.tsx` protected route group | App currently lacks a group guard; `absent` protection | App protected navigation HEY-28 plus server auth HEY-153 | Route test requires denied/no-session state for every protected route | Land guard before live client; rollback must not expose protected UI | Check deep links, universal links, cached navigation, and released builds | HEY-28 route matrix and HEY-156 denied-session staging proof |
| `src/supabase/client.ts:10-17` | App PKCE/Supabase client; `local-functional`, remote auth unproved | Retain app auth UX while HEY-157 migrates to Woof session contract | Freeze issuer/audience/base URL and disallow service-role material | Versioned session migration; global logout/kill rollback | Inventory auth projects, redirect allowlists, publishable identifiers, released configs, and session issuers | HEY-157 issuer/expiry/revocation/account-switch proof and HEY-156 staging |
| `src/supabase/auth.ts:32-76` (`:15-85` in APP-R2 evidence key) | App auth/session helpers; `local-functional` | Retain behind HEY-157 Woof lifecycle; backend trusts only verified subject | Guard implicit fallback, identity selectors, URL/PII logging, and stale issuer | One session format per build; forced signout on incompatible migration | Inventory redirect URLs, sessions, callback initiators, logs, and released builds | HEY-157 callback subject/expiry/revocation tests and no old-session acceptance |
| `src/supabase/storage.ts:3-38` | Chunked SecureStore with surplus-chunk residue; `local-functional` | HEY-159 account/consent-epoch session/cache cleanup | Property tests for shorter replacement, remove, account switch, and epoch invalidation | Migrate with forced cleanup; rollback preserves isolation and can force signout | Check Keychain/SecureStore namespaces in upgrade/account-switch/device fixtures | Zero surplus chunks and HEY-159 signout/delete/restore proof |
| `src/db/database.ts:6-27` and `src/db/encryptionKey.ts:10-30` | App SQLCipher direction; `local-functional`, no device/recovery proof | Retain under HEY-159 and normative ADR-0082 | Fail closed on no SQLCipher, wrong account/epoch, key loss, or corruption | Migrate only after layout decision; rollback never opens another account's DB | Device upgrade/account switch/reinstall/restore/keychain residue checks | HEY-159 fake + physical-device partition/key/corruption tests; blocks HEY-156 |
| `src/db/migrations.ts:16-35` | One global local DB/table without account/consent epoch; `local-functional` | HEY-159 account/epoch schema and migration | Migration tests reject global rows without owner/epoch | Transactional local migration with export/rollback or fail-closed purge per ADR | Inspect old DB files, WAL/SHM, backups/restores, and migration markers | A/B isolation, rollback, deletion/restore/re-delete, and corruption proof |
| `src/health/sync/syncPrefs.ts:8-24` and `src/health/sync/watermark.ts:9-63` | Global sync preference/watermark; `local-functional` | HEY-159 account+consent epoch state; backend cursor contract | Guard unscoped keys and pre-consent sync start | Re-key/migrate per account+epoch; rollback stops sync rather than sharing cursor | Device/account-switch/restore inspection plus backend cursor residue | HEY-159 start/stop/signout/revoke/delete proof and no cross-account cursor |
| `src/chat/threads.store.ts:3-6` | Memory-only app Chat authority; `local-functional`, not durable | App renderer/cache only; backend transcript/IDs after HEY-126 and ADR-0077 amendment | Guard app-generated authoritative thread/message IDs | Replace store with reducer over backend IDs/cursor; offline drafts remain non-authoritative | Check AsyncStorage/Query/Zustand/released bundle residue and duplicate transcript stores | Replay/reconnect/offline/cancel parity; one authoritative transcript; HEY-156 staging |
| `src/stores/onboarding.store.ts:1-4` | Memory-only onboarding answers; `local-functional` | App draft UX plus versioned consent/profile/Scribe owners; HEY-159 for lifecycle | Guard health read/upload before durable consent and age/purpose gates | Persist only accepted fields after policy; rollback clears incomplete state | Inspect device stores, auth metadata, backend profile/consent rows, and released builds | Durable versioned consent, no pre-consent egress, signout/delete proof |
| `modules/health/ios/*`, `modules/health/android/*`, `src/health/**` | App native/device and local health seams; source exists, zero `native-device` proof | Retain device adapters; ADR-0081 owns computation/destination and HEY-159 owns lifecycle | Guard broad purpose grants, false `granted`, unscoped cache, and unversioned source batches | Fake adapter first; staged backend after contract; device rollback stops reads/uploads | Check permissions, observers/cursors, local DB/key, background jobs, backend rows, and device logs | Physical-device permission/background/revocation plus HEY-159/ADR-0081 proof |

## D. Callbacks, Jobs, Secrets, Bindings, And URLs

| Current path/category | Current owner and APP-R2 proof | Canonical destination/owner | Freeze guard | Cutover and rollback | Deployed-residue check | Removal gate |
| --- | --- | --- | --- | --- | --- | --- |
| `app/auth-callback.tsx` | App auth callback route; `local-functional`, remote redirect proof absent | Retain app callback UX under HEY-157; backend validates session/subject | Initiating-subject, state/nonce, one-use, expiry, and redirect allowlist tests | Cut issuer/config per build; rollback forces signout before old callback route | Inventory auth redirect allowlists, universal links, released schemes, sessions, and logs | HEY-157 replay/mismatch/account-switch tests and HEY-156 staging |
| `app/connector-callback.tsx` | App connector callback route; `local-functional`, backend callback/deploy proof absent | App browser completion UX; backend OAuth/Vault callback custody | Guard token/code logging, caller subject injection, replay, and arbitrary redirect | Switch callback registration once; rollback disables refresh/write jobs first | Inventory Google redirect URIs, Supabase/Worker callbacks, state stores, Vault rows, jobs, and tokens | Initiating-subject/single-use/revoke/delete proof; zero legacy callback registrations |
| `supabase/**` and `runtime/waldo-worker/**` deployed jobs/webhooks/cron/routes | Source trees exist; exact deployed jobs were not queried, so proof is `absent` for deployment inventory | Backend scheduler/alarm/adapters; HEY-152 route map and HEY-155 residue owner | No new app-owned cron, webhook, route, queue, or alarm registration | Disable triggers/writers before route cutover; rollback uses documented global enable order | Enumerate Supabase cron/webhooks/Functions/triggers and Cloudflare routes/queues/alarms/DO bindings | Every deployed item classified, disabled/deleted/exported, and observed through rollback window before HEY-155 |
| `supabase/functions/**`, `supabase/functions/_shared/google.ts`, `runtime/waldo-worker/**` secrets/bindings/grants | Source references exist; custody/deployment proof absent | Backend Secrets Store/Vault least-privilege custody | Guard plaintext secrets and app/runtime env access; publishable keys remain identifiers, not secrets | Rotate after canonical path is live; revoke legacy only after rollback plan no longer needs it | Enumerate encrypted secrets, vars, Vault functions/rows/grants, service-role access, OAuth clients, binding versions, and audit logs | Zero active legacy credential/grant/binding; rotation/revoke drill; HEY-155 records destruction evidence |
| `src/kairos/kairosClient.ts:11-35` and app Function base URLs | App-owned runtime URLs; `local-functional`, shipped/deployed reachability unproved | Generated client uses one approved backend base/version | Static URL/domain allowlist and remote-config inventory | HEY-152 global route selection; no per-request retry to legacy URL | Inspect source, build artifacts, OTA/remote config, DNS/routes, deep links, and network telemetry schemas | Zero shipped/reachable legacy URL for rollback window before HEY-155 |

## E. Fabricated Or Deferred Product Actions

| Current path/category | Current owner and APP-R2 proof | Canonical destination/owner | Freeze guard | Cutover and rollback | Deployed-residue check | Removal gate |
| --- | --- | --- | --- | --- | --- | --- |
| `src/mocks/waldo.ts`, `app/(app)/home.tsx`, `app/(app)/brief.tsx` sample scores/completed effects | App mock/UI; `static/mock` | Honest Brief/Home projections under HEY-151/154/35/47; no fabricated fallback | Guard production imports of mocks and completed-action copy without evidence | Replace with strict loading/pending/empty/stale/error fixtures and generated client; rollback remains honest/offline | Search release bundles, OTA updates, screenshots, flags, and analytics schemas for sample payloads | Zero production-reachable mock/fabricated effect; HEY-156 degraded-state proof |
| `src/home/backendHome.ts:42-110` Handoff read plus Brief/Home Handoff/completed-move UI | App direct read/UI; `static/mock`/`local-functional`; Handoff/live actions excluded from Alpha | Hide/defer; future accepted approval/state/runtime only | Guard Handoff/action kinds in Alpha public DTO and UI | Disable/hide before Brief cutover; rollback does not enable external effects | Search tables, Functions, jobs, callbacks, routes, flags, and release bundles for Handoff actions | HEY-127 does not own this; accepted future decision required, otherwise HEY-155 removes legacy path |
| Chat archive/delete, mic, fake confirmation/action UI on the Chat route and `src/chat/threads.store.ts:3-6` | App UI/local state; `static/mock`/`local-functional`; branching/delete/voice/actions deferred | HEY-126 owns bounded text transport spike; final text contract follows ADR-0077 amendment; deferred controls hidden | UI inventory guard rejects deferred controls in Alpha builds | Hide controls; text transport cutover follows spike evidence; rollback keeps offline drafts only | Search release bundles, feature flags, local state, backend routes/tables, and provider/tool callers | HEY-126 replay/transport evidence + amended ADR-0077 for text; separate future decisions for deferred controls |
| Constellations route/teaser identified by APP-R2 | App static teaser; `static/mock`; full feature deferred | Retain only truthful static teaser; no persistent graph/progress authority | Guard hardcoded progress and generative/full Constellation kinds | Replace “Day 3 of 30”/progress claims with neutral teaser; rollback remains static | Search release bundles, tables, graph stores, jobs, routes, and generated card kinds | No full feature until accepted re-entry gate; HEY-155 removes any legacy backend path |
| `app/(app)/settings.tsx:95-117` inert deletion/export and other deferred settings claims | App UI; `static/mock`, deletion explicitly unwired | Honest unavailable state until HEY-101/159 and backend export/deletion owners are real | Guard success copy/actions without journaled result and all-store proof | Hide/disable or label unavailable; rollback never fabricates success | Inventory device DB/key/cache, Supabase/DO/R2/Vault/provider/push/connector residue | All-store delete/restore/re-delete and export proof; no deferred voice/skill claim in Alpha |
| `modules/wear/ios/WearModule.swift:3-19` iOS stub and direct Watch claims | Empty iOS stub; `static/mock`; no watchOS target/WatchConnectivity/native-device proof | Direct Apple Watch/watchOS deferred; phone HealthKit may ingest Watch-origin samples | Guard present-tense Watch support claims and watchOS/WatchConnectivity dependencies in Alpha | Hide claims; no cutover dependency for Alpha | Search targets, entitlements, bundle IDs, sessions, routes, device stores, and release metadata | Accepted future Watch scope plus device proof; otherwise retain only harmless stub or remove separately |

## Live Issue Status And DAG

This is a documentation snapshot of the coordinator-promoted state. It does not mutate Linear.

| Issue | Live status/lane | Ownership truth |
| --- | --- | --- |
| HEY-13 | Todo, ready-for-agent | Next backend slice; structured Scribe/sanitizer and taint proof. |
| HEY-110 | Backlog, Phase 5 | Async idempotent in-app delivery; not replaced by the Brief GET. |
| HEY-126 | Existing Chat spike owner | Bounded transport/replay spike, then amend ADR-0077 before production transport. |
| HEY-127 | Conditional/deferred | No generic Feed is an Alpha prerequisite; activate only if a distinct persistent Feed is accepted. |
| HEY-143 | In Progress | Merged fake-first/fail-closed hardening is not real provider/staging/Alpha proof. |
| HEY-149 | In Progress | Cross-repo integration umbrella and one-runtime rule. |
| HEY-150 | In Progress | Owns this commit-pinned matrix; artifact review/acceptance is pending, so it is not Done. |
| HEY-151 | Backlog, App Track | Morning-Brief v1 public contract/OpenAPI; Feed remains separate and conditional. |
| HEY-152 | Backlog, App Track | Whole-path route assignment, cutover, kill, and rollback. |
| HEY-153 | Backlog, App Track | Verified Woof subject, owner-bound DO, and A/B rejection. |
| HEY-154 | Backlog, App Track | Side-effect-free committed morning-Brief projection. |
| HEY-155 | Backlog, App Track; last | Source and deployed legacy runtime/direct-path removal. |
| HEY-156 | Backlog, App Track | Cross-repo staging parity, two-user/privacy proof, and whole-path rollback. |
| HEY-157 | Backlog, App Track | Woof identity/session migration and callback/account-switch lifecycle. |
| HEY-158 | Backlog, Phase 5 | Real Spots vertical: provenance, projection, engagement, and privacy. |
| HEY-159 | Backlog, App Track | Per-account sensitive cache and consent-epoch lifecycle under ADR-0082. |

```text
HEY-149 integration umbrella
        |
HEY-150 matrix artifact accepted
        |
        +--> HEY-151 Brief contract -------------------+
        +--> HEY-152 route/cutover --------------------+----> HEY-153 auth/owner DO
        +--> HEY-157 Woof session migration ----------+              |
        +--> HEY-159 app lifecycle (parallel)                         v
                                                           HEY-154 Brief projection
                                                                     |
                                                           HEY-132 generated client
                                                                     |
                                                           HEY-28/35/47 app path
                                                                     |
                                                           HEY-156 staging/rollback
                                                                     |
                                                           HEY-155 decommission
```

HEY-125/134/114 also gate HEY-153. HEY-13 gates real content. HEY-110 and HEY-158 are Phase 5
parallel lanes. HEY-126 can spike text transport in parallel but production Chat waits for the
ADR-0077 amendment. HEY-127 remains conditional/deferred and is not on this critical path.

## Zero-Unclassified-Path Checklist

Known APP-R2 source categories:

- [x] Direct `patrol_log`, `handoffs`, and `spots` reads are classified.
- [x] Connector-account direct reads are classified.
- [x] `agent`, `calendar`, `health-sync`, and `insights` Function invocations are classified.
- [x] Embedded `supabase/migrations/**` and `supabase/functions/**` are classified.
- [x] KAIROS client, URL, caller `userId`, Worker/DO, and unlocked package island are classified.
- [x] OpenAI, Google token/provider, calendar commit, and deprecated device Google REST paths are
  classified.
- [x] Handwritten app/Function DTO paths are classified.
- [x] App auth, protected routes, session storage, SQLCipher, sync state, onboarding, Chat state,
  and native health seams are classified.
- [x] Callback, job/webhook/cron, secret, Vault, grant, binding, route, and URL categories are
  classified, including categories whose deployed state APP-R2 did not query.
- [x] Fabricated samples/effects and deferred Handoff, Chat controls, Constellations, Settings, and
  Watch claims are classified.

Known APP-R2 categories remaining `unclassified`: **0**.

Promotion/decommission checks still open:

- [ ] Re-run the inventory against the implementation commit used for cutover; diff every added,
  removed, renamed, generated, and dynamically constructed network path.
- [ ] Enumerate actual Supabase migrations/policies/grants/Functions/jobs/webhooks/Vault/secrets and
  actual Cloudflare Workers/routes/DO namespaces/storage/queues/alarms/bindings/secrets.
- [ ] Enumerate OAuth clients/redirects/tokens, provider projects/keys, released/OTA app configs,
  legacy URLs, callbacks, and remote feature flags.
- [ ] Prove every retained path through generated contracts and every migrated path through one
  global route with bounded rollback.
- [ ] Prove two-user auth/RLS/DO/cache/ETag isolation, no-fabrication degraded states, consent and
  deletion/restore behavior, and privacy-safe traces in HEY-156.
- [ ] Observe zero legacy traffic/jobs/writes for the accepted rollback window, preserve redacted
  decommission evidence, then execute HEY-155 removal.

HEY-150 acceptance requires reviewers to confirm this source classification and its freeze/cutover
controls. HEY-155 completion requires the separate deployed-residue checklist to reach zero. The
first condition does not imply the second.
