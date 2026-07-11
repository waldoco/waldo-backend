# Next Session Plan - Harness Foundation Waves

Status: Wave 0 reconciliation merged in PR #49. PRs #50 (HEY-100), #52 (HEY-144 storage
foundation), and #51 (HEY-75 scorer) are merged through `2fd798f`; draft PRs #53 (HEY-75 corpus
correction) and #54 (HEY-141 egress hardening) remain pending review and merge.
Date: 2026-07-12 IST.
Baseline: `2fd798f818213b344e700d98def006e80e0d56ae`. HEY-143 remains In Progress because
provider-readiness is fail-closed and has no real context, provider, sink, staging, or Alpha proof.

## Start Here

Read in this order:

1. `.claude/rules/INDEX.md`
2. `README.md`
3. `docs/foundation/CONTRIBUTOR-ONBOARDING.md`
4. `docs/foundation/AGENT-OPERATING-WORKFLOW.md`
5. `docs/foundation/HARNESS-RUNTIME-BUILD-PLAN.md`
6. `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
7. `docs/planning/WALDO_APP_BACKEND_INTEGRATION_PLAN.md`
8. `docs/foundation/HARNESS-WAVE-COORDINATION.md`
9. `docs/foundation/HEY-109-WAVE-0-PHASE-HANDOFF.md`
10. `docs/foundation/HEY-143-PHASE-HANDOFF.md`
11. Accepted ADR-0081 before health-derived computation or public health fields.
12. Accepted ADR-0082 before persistent device-local sensitive cache or account/consent lifecycle
    work.
13. The accepted ADRs and Waldo Brain source pages for the seam being changed.

Authority promotion note: [`waldo-brain` PR #17](https://github.com/Pin4sf/waldo-brain/pull/17)
merged at `75591543053dbdda6cf7c7f0210f8d16f36c3db8`. Its ADR-0001/0071/0077 amendments and new
accepted ADR-0081/0082 govern the named architecture and ownership decisions, not implementation
proof.

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
- HEY-13's destination-aware Scribe/taint runtime and its final property/mutation proof.
- PR #50's static DO-only runtime guard; it is not a production custody/data-plane claim.
- PR #52's V2 goals storage foundation; it does not add a durable writer, admission path, or prompt
  hydration.
- PR #51's deterministic injection scorer; its independent held-out acceptance evidence remains
  pending corrective PR #53.

Not built or not proven:

- a public authenticated product route; the default Worker still returns 404;
- verified ES256 subject to owner-bound DO routing and two-user negative proof;
- merged Supabase migrations, RLS, Vault, R2, consent middleware, or all-store deletion runtime;
- a wired production context schema, recall, skills, or prompt builder;
- a real provider RunLoop call, atomic provider-spend reservation, or staging smoke;
- an asynchronous idempotent in-app adapter; the current runtime sink is synchronous/fake;
- the morning Brief public projection/OpenAPI/generated client;
- shadow Fetch, real Spots, or persistent text Chat end to end;
- native-device, staging, dogfood, Alpha, or production evidence.

Schema, contract, local test, ticket, or configuration evidence must not be described as a live
product capability.

## Current Harness Program

HEY-13 is historical and Done. Its Scribe/taint interface is a consumed foundation, not the next
execution slice.

1. **Wave 0:** reconciliation merged in PR #49. The numbered sequence below remains the structural
   dependency plan; it is not an inventory of unstarted work.
2. **Wave 1:** HEY-144's V2 goals storage foundation is merged. HEY-14 is Todo and blocked by
   HEY-163's WorkspaceMount seam; HEY-15 is Todo and blocked by HEY-14. Any later FTS work remains
   an additive internal DO migration after rebase. HEY-14's source merge plus trigger, ACL,
   connector, and user-state checks form its five-stage eligibility pipeline; deterministic top-K is
   terminal selection.
3. **Wave 2:** HEY-100's static guard and HEY-75's initial scorer are merged. Corrective PR #53
   must merge before an HEY-75 acceptance claim; HEY-160 separately owns any future production
   per-user JWT/`db.forUser()` custody path and is not convergence proof.
4. **Wave 3:** HEY-100 is merged and HEY-141 is implemented in draft PR #54. It remains a
   parse-only declared-target policy with no DNS, redirect, fetch, transport, or ACL expansion.
5. **Convergence:** a fresh clean `origin/main` must prove HEY-14, HEY-15, HEY-144, HEY-16, HEY-100,
   HEY-75, and HEY-141 merged before HEY-143 closure planning. This authorizes planning only.

Every wave remains fake-first and forbids live providers, credentials, app traffic, channel delivery,
production data, and cloud side effects.

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

Persistent app caching depends on accepted Brain ADR-0082 and HEY-159. Until both are proven,
first-slice responses remain memory-only. Any health-derived field or computation depends on
accepted Brain ADR-0081; the first public contract must not invent health authority.

## Ownership And Integration DAG

HEY-149 is the integration umbrella, not a serial prerequisite. The exact current live Linear
relations are:

| Node | Live Linear `blockedBy` |
| --- | --- |
| HEY-151 | HEY-150 |
| HEY-152 | HEY-150 |
| HEY-157 | None |
| HEY-159 | None |
| HEY-153 | HEY-114; HEY-125; HEY-134; HEY-152; HEY-157 |
| HEY-154 | HEY-13; HEY-151; HEY-153 |
| HEY-132 live client | HEY-151; HEY-153; HEY-154; HEY-157 |
| HEY-35 | HEY-28; HEY-132; HEY-151; HEY-154 |
| HEY-47 | HEY-28; HEY-132; HEY-151 |
| HEY-156 | HEY-13; HEY-28; HEY-35; HEY-47; HEY-132; HEY-154; HEY-159 |
| HEY-56 | HEY-28; HEY-29; HEY-35; HEY-36; HEY-47; HEY-132; HEY-156; HEY-159 |
| HEY-155 | HEY-132; HEY-156 |

HEY-149 and HEY-150 are In Progress; producing the matrix does not make HEY-150 Done before review
acceptance. HEY-150 directly gates only HEY-151 and HEY-152. HEY-157 and HEY-159 run in parallel.
HEY-151-159 otherwise remain Backlog in their documented lanes. HEY-13 is the completed Scribe/taint
prerequisite for real HEY-154 content.
HEY-110 async delivery and HEY-158 Spots are separate Alpha gates. HEY-126 is a parallel spike;
HEY-127 remains off-path conditional/deferred. The adopted dogfood gate follows HEY-156 and
precedes HEY-155 as an acceptance gate, not a Linear `blockedBy` relation.

## Surface Decisions

- **Home:** composition only. Do not create a `feed` table, global `OutboxKind`, cross-surface
  ordering, or persistent read state. HEY-127 is conditional/deferred and is not an Alpha
  prerequisite.
- **Chat:** HEY-126 owns a bounded transport/replay spike under the accepted ADR-0077 amendment.
  Compare authenticated command POST plus durable cursor replay with SSE and active-only WebSocket
  behavior. Do not add a second authoritative transcript or freeze transport before evidence.
- **Health:** accepted ADR-0081 owns derived-field destinations, computation authority,
  version, freshness/missingness/provenance, and public eligibility.
- **Device lifecycle:** accepted ADR-0082 and HEY-159 own account/consent epoch, SQLCipher
  partition/key, signout, deletion/restore, key loss, and corruption behavior.
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
