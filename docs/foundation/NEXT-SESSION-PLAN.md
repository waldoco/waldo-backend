# Next Session Plan - HEY-13 And The First App Seam

Status: documentation promotion after the approved app/backend/Brain reconciliation.
Date: 2026-07-10 IST.
Baseline: `origin/main` at `b311d54`; PR #44 is merged. HEY-143 remains In Progress because the
merged provider-readiness work is fake-first/fail-closed and has no real context, provider, sink,
staging, or Alpha proof.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/CONTRIBUTOR-ONBOARDING.md`
4. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
5. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
6. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
7. `docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md`
8. `docs/foundation/HEY-143-PHASE-HANDOFF.md`
9. Brain ADR-0081 before health-derived computation or public health fields.
10. Brain ADR-0082 before persistent device-local sensitive cache or account/consent lifecycle work.
11. The accepted ADRs and Waldo Brain source pages for the seam being changed.

Then run the baseline gate:

```bash
npx -y pnpm@10.34.4 verify
git diff --check
```

## Promoted Product And Repository Boundary

- The canonical deployable app repository is
  [`Pin4sf/waldo-app`](https://github.com/Pin4sf/waldo-app). The audited promotion snapshot is
  `c8b3b4555de076339554391da4dbf5fbe2dac0ae`.
- `Pin4sf/Waldo.git/waldo-app` is historical, nondeployable lineage. It is evidence only and must
  not receive new app integration work.
- `waldo-backend` owns agent execution, provider routing, tools, Governor, journal/outbox,
  DeliveryGate, public schemas, and the committed OpenAPI contract. The app owns UI, protected
  navigation, generated-client consumption, and device adapters.
- Home composes separately owned projections for the current Brief, Spots, relevant threads, and
  Patrol/audit. There is no persistent generic Feed entity, global Feed ordering, or Feed read-state
  store in this plan.

## Alpha Boundary

Alpha requires all of the following on a real authenticated staging path:

- an in-app morning Brief;
- shadow Fetch candidate/label evaluation with every delivery path off;
- real Spots generation, projection, evidence, and dismissal;
- persistent text Chat;
- the privacy, identity, journal/outbox, source, approval, Governor, and DeliveryGate spine;
- real context, recall, provider, and one accepted source seam;
- one asynchronous idempotent in-app delivery adapter.

Alpha explicitly excludes:

- Telegram, APNs, WhatsApp, or other external-channel breadth;
- live Fetch delivery or completed Fetch cards;
- Handoff and live actions;
- voice;
- message branching or soft delete/recovery;
- live interventions;
- the generative-card subset;
- full Constellations;
- direct Apple Watch/watchOS/WatchConnectivity work;
- proposed production SLO, RPO, RTO, partitioning, or DR thresholds.

The first read-only Brief projection below is an integration slice. It is not asynchronous
delivery, HEY-110 completion, HEY-143 completion, or Alpha proof.

## Current Implementation Truth

Built and merged:

- the local contract spine;
- SQLite Durable Object test substrate;
- run journal and fake-sink outbox crash/replay proof;
- DeliveryGate, Loop Governor, alarm multiplexer, triage, hooks, ToolDispatcher, and trigger ACL;
- fake-first LLM routing and Cloudflare gateway parsing/fail-closed configuration;
- fake-first `RunLoopDO`, governed multi-iteration `plan -> act -> observe`, and local replay
  evidence;
- the HEY-10 ten-table context schema artifact.

Not built or not proven:

- a public authenticated product route; the default Worker still returns 404;
- verified ES256 subject to owner-bound DO routing and two-user negative proof;
- merged Supabase migrations, RLS, Vault, R2, consent middleware, or all-store deletion runtime;
- a wired production context schema, recall, prompt builder, or real Scribe path;
- a real provider RunLoop call, atomic provider-spend reservation, or staging smoke;
- an asynchronous idempotent in-app adapter; the current runtime sink is synchronous/fake;
- the morning Brief public projection/OpenAPI/generated client;
- shadow Fetch, real Spots, or persistent text Chat end to end;
- native-device, staging, dogfood, Alpha, or production evidence.

Schema, contract, local test, ticket, or configuration evidence must not be described as a live
product capability.

## Next Backend Harness Slice - HEY-13

HEY-13 is Todo/ready-for-agent. Its structured Scribe/sanitiser runtime is the next backend harness
execution slice after this documentation promotion. It is required before real context-bearing
Brief, Spots, or Chat content can reach a provider, durable state, trace, cache, or public
projection.

Required outcome:

- recursively classify keys and string, number, object, and array values;
- reject or quarantine health-shaped numeric/structured values instead of accepting non-string
  leaves unchanged;
- sanitise before compression, persistence, provider egress, public projection, and delivery;
- preserve external-source taint/provenance across iterations and crash/resume;
- cover nested, intervening-word, CSV, synonym, and benign-key/sensitive-value cases;
- prove denial writes no outbox row and no forbidden value to trace/eval/log/cache;
- preserve the accepted nine-event hook contract: seven inner lifecycle events plus invocation
  start/end.

Keep live providers, credentials, app traffic, channel delivery, production data, and cloud
side effects out of the default HEY-13 verification path.

Parallel backend work:

- HEY-110 is Backlog in Phase 5 and owns the separate async idempotent in-app delivery interface and
  adapter proof.
- HEY-15/14/16 continue recall, skill loading, and prompt hydration from the HEY-10 schema root.
- HEY-125/134/114 prepare issuer, data-plane, and environment proof.
- HEY-137/138/135/141 harden DeliveryGate, timezone, watchdog, and egress paths.
- HEY-158 is Backlog in Phase 5 and owns the backend Spots generation/provenance/idempotency,
  public list/order/filter projection, safe evidence references, dismissal to engagement/Scribe,
  and two-user/privacy/Alpha proof.

## First Cross-Repo Seam

The first public operation is:

```http
GET /public/v1/briefs/morning/current
Authorization: Bearer <Woof ES256 access token>
Accept: application/vnd.waldo.morning-brief.v1+json
If-None-Match: "<optional subject-bound opaque ETag>"
```

Contract:

- no request body;
- no `userId`, tenant, account, DO, thread, run, model, provider, or other routing selector;
- version parse, ES256 signature/claim/session validation, canonical subject derivation, and exactly
  one owner-bound DO resolution happen before projection access;
- GET reads an already committed projection and never starts/resumes a run, calls a model/tool,
  mutates read state, writes journal/outbox, or sends;
- the strict success union is `ready | pending | empty`;
- `ready` owns stable opaque IDs, monotonic revision, morning variant, ordered static cards, UTC
  generation/source/stale timestamps, server freshness, and safe opaque source references;
- failures use strict content-free `WaldoProblemV1`;
- the ETag is opaque and subject-bound; a user-A ETag cannot produce 304 or content for user B;
- the committed OpenAPI document is the only app contract and generates HEY-132's runtime-validating
  client;
- a session/build uses one runtime path. There is no per-request legacy fallback, dual read, or dual
  writer.

Persistent app caching depends normatively on Brain ADR-0082 and HEY-159. Until both are proven,
first-slice responses remain memory-only. Any health-derived field or computation depends
normatively on Brain ADR-0081; the first public contract must not invent health authority.

## Ownership And Integration DAG

```text
HEY-149 integration umbrella
        |
HEY-150 matrix artifact accepted
        |
HEY-151 contract || HEY-152 route/cutover || HEY-157 identity || HEY-159 lifecycle
        |
HEY-125/134/114 + HEY-153 verified subject -> owner-bound DO
        |
HEY-154 committed morning-Brief projection
        |
HEY-132 generated client + HEY-28 protected shell + HEY-35/47 renderer
        |
HEY-156 two-user staging parity and whole-path rollback
        |
HEY-155 legacy app-runtime removal
```

HEY-149 and HEY-150 are In Progress; producing the matrix does not make HEY-150 Done before review
acceptance. HEY-151-159 otherwise remain Backlog in their documented lanes. HEY-13 gates real
content and runs in parallel with the contract/auth lanes. HEY-110 and HEY-158 are Phase 5 parallel
lanes. HEY-156 follows an integrated path; it cannot substitute for one.

## Surface Decisions

- **Home:** composition only. Do not create a `feed` table, global `OutboxKind`, cross-surface
  ordering, or persistent read state. HEY-127 is conditional/deferred and is not an Alpha
  prerequisite.
- **Chat:** HEY-126 owns a bounded transport/replay spike before the ADR-0077 amendment. Compare
  authenticated command POST plus durable cursor replay with SSE and active-only WebSocket
  behavior. Do not add a second authoritative transcript or freeze transport before evidence.
- **Health:** ADR-0081 owns derived-field destinations, computation authority, version,
  freshness/missingness/provenance, and public eligibility.
- **Device lifecycle:** ADR-0082 and HEY-159 own account/consent epoch, SQLCipher partition/key,
  signout, deletion/restore, key loss, and corruption behavior.
- **Watch:** direct Apple Watch/watchOS work is deferred. Phone-side HealthKit may receive
  Apple Watch-originated samples without a Waldo watch app.

## Verification And Promotion Gates

The Brief seam is not complete until:

- valid/invalid strict schema and problem tests pass;
- wrong signature, key, issuer, audience, expiry, revocation, and owner mismatch fail before DO
  projection access;
- synthetic users A and B cannot cross-read, share an ETag/cache entry, or infer internal IDs;
- repeated GET/304/crash retry changes no run, journal, outbox, or read-state count;
- freshness transitions are deterministic and invalid/future timestamps reject;
- the HEY-13 privacy corpus proves no forbidden value in response, cache, trace, log, or outbox;
- generated-client regeneration is byte-identical and the committed schema hash matches;
- the app renders loading, pending, empty, fresh, stale, denied, offline, rate-limit, service, and
  terminal error states without samples or fabricated effects;
- HEY-156 proves one-path staging cutover and rollback with no legacy fallback.

For this docs promotion, run the docs/guard wall and inspect the complete diff. Do not mark any
runtime ticket complete.
