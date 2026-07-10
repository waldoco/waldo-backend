# Harness Runtime Build Plan

Status: active source for the promoted Waldo backend and app-integration build.
Date: 2026-07-10.
Baseline: `origin/main` at `b311d54` after PR #44.

## Source Map

Primary backend sources:

| Source | Why it matters |
| --- | --- |
| `docs/foundation/NEXT-SESSION-PLAN.md` | Current execution slice, promoted Alpha boundary, first app seam, and DAG. |
| `docs/foundation/CONTRIBUTOR-ONBOARDING.md` | Contributor lanes and assignable work. |
| `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md` | Verification wall and proof ladder. |
| `docs/foundation/AGENT-OPERATING-WORKFLOW.md` | Session loop, skills, external-system policy, and merge discipline. |
| `docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md` | HEY-150 commit-pinned app path ownership, cutover, residue, and removal matrix. |
| `docs/foundation/HEY-143-PHASE-HANDOFF.md` | Merged provider-readiness evidence and remaining live-provider blockers. |
| `docs/foundation/HEY-10-DO-SQLITE-SCHEMA.md` | Merged schema artifact and its exact limits. |
| `docs/foundation/DEFERRED-DO-SCHEMA-COVERAGE.md` | Deferred/proposed DO table ownership. |
| `packages/contracts/src/index.ts` | Current local contract barrel. |
| `packages/runtime/src/run-loop/do.ts` | Fake-first governed runtime implementation. |
| `packages/runtime/test/run-loop.test.ts` | Workerd/replay proof for the current runtime. |

Primary Waldo Brain authorities:

- accepted ADRs and the mirrored universal rules;
- ADR-0071 for scope;
- ADR-0077 for public projection/Chat ownership;
- ADR-0081 for health-derived fields and Form/CRS computation authority;
- ADR-0082 for device-local sensitive-cache account/consent lifecycle;
- the current architecture overview, final build image, decided-vs-gap map, and finalization
  blockers.

The canonical deployable app repository is
[`Pin4sf/waldo-app`](https://github.com/Pin4sf/waldo-app). The audited promotion snapshot is
`c8b3b4555de076339554391da4dbf5fbe2dac0ae`.
`Pin4sf/Waldo.git/waldo-app` is historical, nondeployable lineage.

## Goal

Build one first-party, persistent agent harness in `waldo-backend`:

1. a verified user maps to one owner-bound Durable Object;
2. the DO owns hot runtime state, scheduling, journal, Governor, context orchestration, and
   delivery decisions;
3. Supabase owns raw health and user-scoped relational data under RLS;
4. model calls cross the `LLMProvider`/Gateway seam;
5. tools execute under trigger ACL, taint, approval, autonomy, and sanitizer gates;
6. memory writes cross Scribe;
7. DeliveryGate and an idempotent outbox own every delivery candidate;
8. public projections are strict backend-owned contracts consumed through generated clients;
9. trace, replay, conformance, privacy, deletion, and rollback evidence determine proof level.

The V1 product proof is Brief, shadow Fetch, Spots, and text Chat on this shared spine. Product
verticals must not introduce alternate agent runtimes or direct app-owned provider/data paths.

## Non-Negotiables

- Agent execution is DO-only; no app or Edge Function owns a second agent loop.
- Raw health remains Supabase/RLS-only.
- Health-derived computation and destination authority depend on Brain ADR-0081.
- Persistent device-local sensitive cache and account/consent lifecycle depend on Brain ADR-0082
  and HEY-159.
- Session authorization, canaries, approvals, and ACL rebuild on every wake; runs may resume only
  from committed journal state.
- Governor is deterministic and outside the model.
- Scribe is the only committed-memory write path.
- DeliveryGate chooses delivery; the Governor does not write outbox rows.
- The app uses committed OpenAPI/generated-client contracts only. It supplies no user, tenant, DO,
  model, or provider selector.
- Home composes Brief, Spots, relevant threads, and Patrol/audit projections. There is no
  persistent generic Feed entity.
- The first Brief GET is a side-effect-free read, not async delivery. HEY-110 owns asynchronous
  idempotent in-app delivery.
- HEY-126 owns the bounded Chat transport/replay spike; production transport waits for the
  ADR-0077 amendment.
- HEY-127 is conditional/deferred. No generic Feed is an Alpha prerequisite.
- Direct Apple Watch/watchOS/WatchConnectivity work is deferred.
- No configuration, ticket, schema, local test, or merged source is called staging, Alpha, or
  production evidence without the corresponding runtime proof.

## Alpha Acceptance Boundary

Alpha requires:

- authenticated in-app morning Brief;
- shadow Fetch candidate/label evaluation with delivery disabled;
- real Spots generation, public projection, evidence, and dismissal;
- persistent text Chat;
- privacy, identity, source, approval, journal/outbox, Governor, and DeliveryGate proof;
- real context, recall, provider, and one accepted source seam;
- one asynchronous idempotent in-app adapter;
- two-user isolation, privacy-safe traces, deletion/consent gates, and whole-path rollback.

Alpha excludes:

- external-channel breadth;
- live Fetch;
- Handoff and live actions;
- voice;
- branching or soft delete/recovery;
- live intervention;
- generative cards;
- full Constellations;
- direct Watch work;
- proposed production SLO/RPO/RTO/partitioning/DR thresholds.

## Current Backend Reality

### Built And Merged

- broad local contracts across runtime, tools, memory, prompts, routing, adapters, auth, telemetry,
  public scaffolding, and evidence;
- SQLite DO/workerd test substrate;
- durable journal/outbox interfaces and fake-sink crash/resume proof;
- DeliveryGate policy state;
- Loop Governor;
- alarm multiplexer;
- triage, nine-event hook registry, ToolDispatcher, and per-trigger ACL;
- fake-first LLM routing and gateway adapter parsing/configuration;
- fake-first `RunLoopDO`, runtime hardening, governed multi-iteration loop, and local replay;
- HEY-10 ten-table context schema artifact;
- PR #44 provider-readiness/fail-closed hardening at `b311d54`.

HEY-143 remains In Progress. PR #44 proves configuration, parsing, privacy, and fail-closed
behavior with fakes/mocks. It does not prove a real context/provider/channel path or Alpha.

### Not Built Or Not Proven

- public authenticated product ingress; the default Worker returns 404;
- verified ES256 subject to owner-bound DO routing;
- merged canonical Supabase/RLS/Vault migrations or R2;
- consent middleware, all-store deletion, and restore/re-delete proof;
- wired production context DDL, recall, skills, prompt hydration, or real Scribe;
- real provider RunLoop execution, atomic spend reservation, fleet kill, or staging smoke;
- asynchronous idempotent in-app delivery;
- current morning Brief projection/OpenAPI/generated app client;
- shadow Fetch, real Spots, or persistent text Chat end to end;
- standalone eval, property, mutation, load, native-device, staging, dogfood, Alpha, or production
  evidence.

## Workstream Map

| Phase | Workstream | Current truth | Next proof |
| ---: | --- | --- | --- |
| 1 | Journal/outbox | Local workerd/fake-sink proof merged | Preserve; real async adapter proof is HEY-110 |
| 2 | Governor/scheduler/DeliveryGate | Core local runtime merged | HEY-135/137/138 and held-candidate re-admission contract |
| 3 | Context/memory/safety | HEY-10 schema artifact merged; runtime unwired | HEY-13, then HEY-15/14/16 and accepted goal scope |
| 4 | Tools/adapters/provider | Dispatcher/ACL and fake-first provider merged | real context/provider/source, spend, egress, custody |
| 5 | Delivery/product loops | Policies and generic contracts only | HEY-110 async adapter, Brief seam, HEY-158 Spots, HEY-126 Chat spike |
| 6 | Eval/launch | local replay/conformance only | two-user staging, rollback, deletion/privacy, eval/load/ops proof |
| App | generated consumer | canonical app has UI/native shell plus legacy bypass inventory | HEY-132 client, protected shell, honest renderer, staged cutover |

## Next Backend Slice - HEY-13

HEY-13 structured Scribe/sanitizer runtime is next.

Interface outcome:

- one typed sanitizer/taint result consumed by hook, prompt, memory, provider-egress, projection,
  trace, and delivery paths;
- recursive key/value classification across strings, numbers, objects, and arrays;
- fail-closed handling for unknown health-shaped content;
- bounded, content-free denial evidence;
- no direct committed-memory mutation.

First failing tests:

- a health-shaped numeric value under a benign key rejects;
- nested, array, CSV, synonym, and intervening-word shapes reject;
- external taint survives iteration and crash/resume;
- sanitizer failure prevents provider call, projection response, trace payload, and outbox row;
- the nine-event hook order remains deterministic.

Verification:

- focused contract/runtime tests;
- health-leak and fake-callback guards;
- workerd proof where durable state/outbox is involved;
- `npx -y pnpm@10.34.4 verify`;
- `git diff --check`.

Live provider calls, credentials, channel delivery, app traffic, production data, and cloud side
effects remain out of the default HEY-13 path.

## First Public Seam

```http
GET /public/v1/briefs/morning/current
Authorization: Bearer <Woof ES256 access token>
Accept: application/vnd.waldo.morning-brief.v1+json
If-None-Match: "<optional subject-bound opaque ETag>"
```

The contract:

- accepts no body or routing selector;
- verifies version, ES256 signature/claims/session, and owner-bound DO before read;
- reads one committed current-morning projection;
- is side-effect-free;
- returns a strict `ready | pending | empty` union;
- uses strict content-free `WaldoProblemV1` failures;
- returns server-owned freshness and opaque subject-bound cache identity;
- is committed in OpenAPI and generates HEY-132's runtime-validating client;
- never falls back to the app's embedded Worker, Functions, direct tables, provider code, or
  handwritten DTOs.

This seam does not generate a Brief or satisfy HEY-110 delivery.

## Home, Spots, Chat, And Watch

### Home

Home is composition:

- current Brief projection;
- real Spots projection;
- relevant thread projection;
- Patrol/audit projection.

Do not create a generic Feed table, global ordering, generic read-state authority, or global
OutboxKind. If product later requires a distinct persistent Feed source of truth, that requires a
separate decision before schema work.

### HEY-158 Backend Spots Vertical - Phase 5

Add explicit Phase 5 ownership for:

- Spot candidate generation across accepted source domains;
- source provenance, freshness, confidence band, and occurrence idempotency;
- public list/order/filter projection with stable opaque IDs;
- safe evidence references;
- dismissal to bounded engagement plus Scribe candidate, never direct memory mutation;
- source-missing, duplicate, stale, cross-user, raw-health, and deletion tests;
- Alpha staging proof.

HEY-158 owns backend Spot semantics. HEY-132 owns only the generated consumer.

### Chat

HEY-126 owns the bounded transport/replay spike before amending ADR-0077:

- authenticated command POST with client idempotency;
- server-owned thread/message IDs;
- durable cursor replay;
- SSE versus active-only WebSocket measurement;
- background, reconnect, cancellation, and offline-draft behavior;
- no second authoritative transcript.

Do not freeze the production transport before the spike evidence.

### Watch

Direct Apple Watch/watchOS/WatchConnectivity work is deferred. Phone-side HealthKit work may
ingest Apple Watch-originated data without a Waldo watch app.

## Integration Ownership And DAG

| Owner | Contract |
| --- | --- |
| HEY-149 | cross-repo integration umbrella and one-runtime rule |
| HEY-150 | commit-pinned path ownership/migration matrix; In Progress until accepted |
| HEY-151 | current morning-Brief public contract/OpenAPI |
| HEY-152 | whole-path route assignment, cutover, global kill, and rollback |
| HEY-153 | verified subject, fresh trust, owner-bound DO, two-user rejection |
| HEY-154 | side-effect-free committed morning-Brief projection |
| HEY-132 | generated runtime-validating app client |
| HEY-28 | protected app shell and generated-client CI |
| HEY-35/47 | honest renderer, static cards, and degraded states |
| HEY-156 | cross-repo staging parity and whole-path rollback |
| HEY-155 | legacy app runtime/direct-path decommission and removal |
| HEY-13 | privacy-safe real content, parallel |
| HEY-110 | async idempotent in-app delivery, parallel |
| HEY-126 | bounded Chat transport/replay spike, then ADR-0077 amendment |
| HEY-127 | conditional/deferred persistent Feed decision; not Alpha-critical |
| HEY-158 | backend Spots generation/projection/engagement/privacy, Phase 5 |
| HEY-159 | per-account sensitive cache and consent-epoch lifecycle, App Track |

```text
HEY-149 umbrella
      |
HEY-150 matrix accepted
      |
HEY-151 contract || HEY-152 cutover || HEY-157 identity || HEY-159 lifecycle
      |
HEY-125/134/114 + HEY-153 verified ingress/owner DO
      |
HEY-154 projection -> HEY-132 client -> HEY-28/35/47 app path
      |
HEY-156 staging/rollback
      |
HEY-155 removal
```

HEY-149 and HEY-150 are In Progress. HEY-150 is not Done until the matrix is reviewed and accepted.
HEY-151-159 otherwise remain Backlog in their documented lanes. HEY-13 is Todo/ready-for-agent and
gates real content. HEY-110 is Backlog in Phase 5 and gates Alpha delivery. Neither is replaced by
the GET.

## Parallel Lanes

Safe parallel work:

- HEY-13 structured sanitizer and taint proof;
- HEY-15/14/16 context hydration;
- HEY-110 async delivery with fake adapters;
- HEY-158 backend Spots vertical;
- HEY-125/134/114 auth/data/environment proof;
- HEY-137/138/135/141 reliability and egress;
- strict Brief contract fixtures and generated-client scaffolding after contract approval;
- HEY-126 Chat transport/replay spike;
- HEY-159 app account/consent lifecycle after ADR-0082;
- read-only review, failure mapping, and conformance guards.

Single-writer surfaces remain:

- `packages/runtime/src/*`;
- `packages/contracts/src/runtime/*`;
- `packages/contracts/src/tools/*`;
- `packages/contracts/src/memory/*`;
- public schema/OpenAPI barrels;
- migrations, model roster, trigger vocabulary, budgets, and policies;
- these foundation truth docs.

## Runtime Slice Ledger

Merged:

1. HEY-120/121/124 journal, outbox, and DeliveryGate local runtime proof.
2. HEY-122 Loop Governor.
3. HEY-123 alarm multiplexer.
4. HEY-77 triage.
5. HEY-12 nine-event hooks.
6. HEY-78 ToolDispatcher/ACL.
7. HEY-17 fake-first provider.
8. HEY-136 fake-first run loop.
9. HEY-139 runtime hardening.
10. HEY-10 context schema artifact.
11. HEY-111 local evidence/replay.
12. HEY-142 governed multi-iteration loop.
13. PR #44 HEY-143 provider-readiness/fail-closed hardening.

Next:

14. HEY-13 real Scribe/sanitizer runtime.

Do not infer HEY ticket completion beyond the bounded merged capability named above.

## Proof Ladder

### Contract

- strict success/problem valid and invalid pairs;
- incompatible v1 drift rejected;
- byte-identical generated-client regeneration;
- no internal schema derivation or handwritten parallel DTO.

### Identity And Tenancy

- wrong signature/key/issuer/audience/expiry/revocation fails before DO lookup;
- user A and B resolve separate owner-bound DOs;
- caller identity selectors reject;
- RLS, service-role owner check, response, ETag, cache, log, and trace isolation.

### Read, Privacy, And Idempotency

- repeated GET/304/crash retry changes no run/journal/outbox/read-state count;
- scheduled generation deduplicates separately by occurrence/journal;
- deterministic fresh/stale transition;
- HEY-13 corpus proves no forbidden value in response/cache/log/trace/outbox.

### App And Staging

- protected routes and generated-client-only network path;
- loading/pending/empty/fresh/stale/denied/offline/429/503/500/malformed UI states;
- no sample or fabricated effect fallback;
- one runtime path per session/build;
- HEY-156 redacted two-user staging trace and whole-path rollback;
- zero reachable legacy route/binding/callback/job/grant/secret custody before HEY-155 removal.

Production remains a separate proof level. Exact proposed production SLO/DR numbers are not Alpha
law.

## Assignment Template

```text
Owner:
Phase/workstream:
Primary ADRs/docs:
Files owned:
Files explicitly out of scope:
Invariant:
First failing test:
Degraded/security cases:
Verification:
Merge dependency:
Rollback:
```

Every assignment must state whether it proves a contract, local runtime, staging path, or
production behavior. “Implemented” without that proof level is not an acceptable status.
