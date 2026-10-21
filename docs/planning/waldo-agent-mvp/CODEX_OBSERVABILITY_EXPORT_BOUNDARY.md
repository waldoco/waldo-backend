# Observability exporter boundary — lane 4

Status: implemented locally; review/merge and deployment are separate gates. No live export, settings change, deployment, provider call or post-gate probe was performed.

## Run contract and ownership

- Repository: `waldoco/waldo-backend`; base `b596405ccbeb9f89f5fc125e8c418eec9116d3e9`.
- Branch: `lane/codex-l4-observability-export-boundary`; isolated checkout `/Users/shivanshfulper/.codex/worktrees/l4-observability/waldo-backend-mvp`.
- Coordination: issue #116 SESSION START; planner, security reviewer and qa-breaker are read-only collaborators. Primary checkout's existing dirty files were preserved.
- Initial fetched beta-mvp was `cf37b70` (credential guard #417). Pre-push refresh advanced to `98ec957` (#418/#419 smoke transport/policy and #413 browser outcomes). None changed owned exporter/test/doc paths. Starting base stays the explicitly assigned commit; CI must test integration against the current PR base.
- Owned paths: `packages/runtime/src/observability/otlp-turns.ts`, `packages/runtime/test/otlp-turns.test.ts`, `packages/runtime/test/codex-observability-export-boundary.test.ts`, this document. `console-correlation.ts` is consumed by tests but unchanged.
- Everything else, including privacy gate, runtime producers, signed identity route, contracts, packages, lockfile, wrangler and CI, remains read-only.
- Current/ideal gap: current exporter lacks observation-level filtering, transport deadlines and truthful partial cost coverage. Ideal for this slice is bounded, privacy-gated, diagnosable OTLP serialization of the identities and usage actually supplied. Canonical tenant and provider response/run/effect identity require host integration.

## Root causes, falsifiers and minimal fix

Line references in this table are against the assigned base, not moving HEAD.

| Root cause | Base source | Decisive falsifier | Fix and verification layer |
|---|---|---|---|
| Only root has user/session/release labels; initial children omit trace tags, and late machine spans lose root kind | `otlp-turns.ts:104-119,138,150-158,163` | Inspect every serialized initial/late observation for filters and machine trace name | Put supplied correlation on each span; carry root kind into late children. Local real exporter/synthetic sink. |
| Factory trusts captureText directly and retains mutable caller entry/context | `otlp-turns.ts:50,72-89,136` | Production toggle mis-set plus private synthetic text/error/detail; mutate buffered context/usage | Snapshot supplied context and text/usage; reapply unchanged resolveCaptureText/gateTraceEntry at exporter boundary. Local serialization and unchanged privacy canary suite. |
| Unknown model costs become zero in aggregate | `otlp-turns.ts:92-98` | Mix priced/unpriced calls; all-unpriced trace must omit dollar total | Explicit estimate kind, partial/unpriced coverage and priced/unpriced counts; omit unknown amount. Include cached tokens and price fingerprint from existing modelCost. |
| Vendor fetch never times out and raw thrown errors can reach host failure logging | `otlp-turns.ts:124-133` | Inject never-settling or synchronously throwing sink; inspect rejection and cleanup | Standard OTLP 10-second deadline, AbortController plus settlement race, fixed content-free errors, timer/capacity cleanup, no retry. |
| Map limits trace count but not hops in a single trace; silent oldest-trace eviction | `otlp-turns.ts:139-142` | Fill one trace or 50 abandoned traces; fresh work must recover and discard must be visible | Reuse existing 50-item budget for total pending hops; evict one oldest buffered hop, retain arriving hop, reject with otlp_buffer_evicted and report count on next root. |
| Root registered before delivery; late child can export after root fails | `otlp-turns.ts:138,147,163` | Queue late child before rejection and after settled rejection; sink must receive no child | Retain root delivery promise in existing bounded 50-trace window; child awaits it within its own deadline/capacity slot. Rejected parent prevents child send. |

The existing host records raw trace before export (`channels/telegram-owner-do.ts:616-627`) and records exporter rejection as a gated `otlp_export`/`export_failed` row. This consumer makes rejection observable without editing durable producers. Local exporter tests do **not** establish deployed durability of that host path.

Smallest alternative considered: use an OpenTelemetry/Langfuse SDK plus host identity/schema overhaul. That would change dependencies, configs and core-owned paths, so it is deferred. No unused telemetry framework or second trace database was introduced.

## Serialization and operational semantics

- Schema version 4. Dashboards must filter `schema_version=4` before interpreting changed cost metadata. Every observation carries the supplied user/session/channel/release/environment and trace key; these are trace attributes, not metric labels.
- `langfuse.user.id` remains the existing host's channel label. `owner_attribution=canonical_owner_not_supplied` explicitly forbids interpreting it as verified `waldo.owners.id`. `entry.owner` remains a legacy locator attribute, also not canonical authority. A nonempty value is schema validation, not authentication. No UUID is derived or borrowed.
- Context and entry snapshots prevent caller mutation from relabelling already buffered spans. Independent exporter instances have independent pending maps, parent IDs and budgets; a shared trace key does not share data.
- Production capture remains OFF even when captureText is true. Staging capture follows the existing gate; enabling it is not permission to export real private data. Existing safe-hop detail/code/owner fields still rely on trusted, content-free producers. Arbitrary malicious IDs or producer enum/count fields are not fully sanitized by this slice.
- Price evidence is `runtime:modelCost:standard-flat` plus the exact input/cached/output rates per million and per-observation release/version. That rate fingerprint and release identify the estimate source without copying another price table. Source is `llm/pricing.ts`; its tier/long-context/batch/provider-discount limitations remain.
- `estimated_cost_usd` includes only priced **pre-root** hops. It is absent for zero priced calls. Root metadata records `cost_scope=pre_root_hops`, coverage and `pricing_limit=flat_table_not_tier_or_bill_reconciled`. Late generations have independent usage/estimate attributes and are excluded from immutable root totals; aggregate from generation observations with deduplication for complete usage.
- Per-response billed charges are unavailable. No provider billing value is synthesized. Ingestion HTTP success is acceptance, not proof of persisted Langfuse visibility, billing reconciliation or effect/delivery.
- Maximum pending hop count: 50, preserving the old retention budget rather than inventing a new policy threshold. Maximum concurrent exports including children waiting on parents: 50. Root correlation retention: latest 50 roots, including failures. Count bounds are **not byte bounds**; host-owned text/detail size budgets remain a handoff gap.
- Overflow retains new work and evicts the globally oldest buffered hop by arrival sequence. Promise rejects `otlp_buffer_evicted`; next root reports cumulative `buffer_evicted_hops` since previous root construction. If that root export fails, its count is not visible in vendor UI; raw host failure evidence remains necessary. No automatic resend.
- Export timeout is 10,000 ms, the [standard OTLP exporter default](https://opentelemetry.io/docs/languages/sdk-configuration/otlp-exporter/). Finally clears timer/capacity; fetch receives an abort signal. An injected sink that ignores abort cannot hold the returned promise indefinitely; cancellation of arbitrary external implementations cannot be guaranteed.
- Errors are `otlp_context_invalid`, `otlp_buffer_evicted`, `otlp_export_capacity`, `otlp_export_timeout`, `otlp_export_transport`, `otlp_export_http_<status>`. Vendor bodies and thrown error strings are not forwarded. Unused response bodies are cancelled. HTTP rejection is not retried.
- After 50 newer roots, old root state is evicted; exceptionally late children outside that window may buffer until a root or bounded eviction. No cross-eviction durability, TTL, replay or exact-once vendor-delivery claim. Raw DO trace/outbox is the permanent evidence path.
- Missing Langfuse configuration remains `null` and existing host self-test reports explicit unconfigured status. No new fallback identity or vendor account was added.

Langfuse's [OTLP integration](https://langfuse.com/integrations/native/opentelemetry) specifies user/session/release attributes on all observations for observation filtering. HTTP JSON and the existing v4 ingestion header are retained. No external service was contacted by the test sink.

## Known nesting limitation and core-owned handoff

[Langfuse's nesting best practice](https://langfuse.com/docs/observability/best-practices#is-it-nested-correctly) groups tool spans and their requesting generations as siblings under the actual orchestrating agent/step span. Our exporter currently gives every child the root parent, including late children, because `TurnLogEntry` has no typed step or parent IDs. This flat tree preserves turn correlation but cannot show which orchestration step requested a tool or generation.

Core owns the planned typed step/parent producer handoff: emit stable observation/step IDs and explicit parent-step relationships at the actual orchestration boundaries, preserve them through the log contract and privacy gate, then coordinate exporter mapping to OTLP parent span IDs. Do not infer hierarchy from timing, arrival order or hop names; this slice adds no producer fields or nesting code.

Eventual nested-fixture acceptance must invoke the real exporter with core-supplied typed relationships and inspect serialized IDs: tool and requesting generation share their orchestrating step as parent; different steps stay distinct; initial and late observations retain those relationships. That future fixture proves supplied relationship mapping, while core integration tests must prove the producers emit the actual relationships. Until that handoff and acceptance pass, nested step attribution remains unsupported.

## Adversarial self-review and verification evidence

TDD evidence: missing per-observation attributes failed 1/14 before the fix; production mis-set capture failed 1/15; partial cost failed before coverage fields; hung transport timed out locally; buffer/context/failed-parent tests failed 3/4; reviewer cases for already-failed parent and orphaned buffer failed 2/11. These are local synthetic falsifiers, not deployed failures.

Security/qa review found two additional P2 defects in the first candidate: permanent saturation from abandoned traces and late children silently buffering after settled root failure. Both received regression tests and the eviction/promise-retention changes above. Final security and qa-breaker disposition: PASS by read-only source/test/doc review; neither reviewer independently reran tests.

| Command | Evidence / layer |
|---|---|
| `node --version`; `pnpm --version` | v22.23.2; 10.34.4 |
| `pnpm install --frozen-lockfile` | Passed; no manifest/lockfile change |
| `pnpm --filter @waldo/runtime exec vitest run test/otlp-turns.test.ts test/codex-observability-export-boundary.test.ts test/trace-privacy-canary.test.ts` | 43/43 tests, 3 files; real exporter JSON and synthetic transport plus unchanged core privacy tests |
| `pnpm -r typecheck` | Passed across workspace, worker and integration configs |
| `TZ=UTC WALDO_DO_MIGRATION_BASE_REF=b596405ccbeb9f89f5fc125e8c418eec9116d3e9 pnpm verify:guards` | Full local runner blocked at pgTAP bootstrap: macOS lacks /etc/os-release and dpkg; PostgreSQL 15 binary absent. Earlier static guards passed. Pre-commit run separately stopped at strict-ancestor prerequisite, satisfied by the slice commit. No bootstrap/config/source repair attempted; required isolated Linux Actions remains the full gate. |
| Static guard pass excluding Linux-only `guard-pgtap.mjs` | 34/34 passed, including health leak and wrangler privacy regression; full runner remains blocked locally |
| `git diff --check` | Passed |

Coverage: two independent supplied contexts, colliding trace keys and separate user/session/release/environment; mutation isolation; production/capture-off privacy; invalid context; machine root and late parent correlation; mixed/all-unpriced costs and source fingerprint; hung/HTTP/thrown transport; unused-body cancellation; ordering and failed parents before/after settlement; 50 concurrent exports with overload/recovery; one-trace and abandoned-trace buffer bounds/visible eviction; console response header/status/body preservation.

Full isolated Supabase/scenario/owner-ingress wall is delegated to required exact-head GitHub Actions, not claimed by these local tests. Required green checks are the review-to-merge gate. Optional runtime shard failures and Cloudflare preview failures remain separate evidence, never staging proof. No live/post-gate tests were run.

Engineering checklist for this slice: serialization privacy, production mis-set switch, immutable attribution, unknown cost, late machine span, hung transport, safe vendor errors, body/timer release, bounded orphan recovery, failed-parent ordering, no retries, no metrics cardinality expansion. This checklist belongs here because the shared fundamentals file is outside this lane's write authority.

## Proposed core integration diffs — NOT APPLIED

These are additive boundary targets for a separately owned core PR; not a complete auth migration or a claim of host enforcement. Preserve and review the current routing signatures, SQL grants and transaction semantics when implementing them.

1. Signed directory must return canonical owner. In a **new** reviewed migration (do not edit shipped migration), recreate `route_presence` with unchanged signed admission/state filters/grants and the following projection delta:

```diff
-returns table (do_name text, subject text, timezone text)
+returns table (owner_id uuid, do_name text, subject text, timezone text)
-  return query select o.do_name, p.subject, s.timezone
+  return query select o.id, o.do_name, p.subject, s.timezone
```

`identity/owner-directory.ts` target after SQL and all callers/tests are coordinated:

```diff
-export type OwnerRoute = Readonly<{ doName: string; subject: string; timezone: string | null }>;
+export type OwnerRoute = Readonly<{ ownerId: string; doName: string; subject: string; timezone: string | null }>;
-type RouteRow = { do_name: string; subject: string; timezone: string | null };
+type RouteRow = { owner_id: string; do_name: string; subject: string; timezone: string | null };
-    return row ? { doName: row.do_name, subject: row.subject, timezone: row.timezone } : null;
+    return row ? { ownerId: row.owner_id, doName: row.do_name, subject: row.subject, timezone: row.timezone } : null;
```

The legacy deploy-owner adapter cannot manufacture ownerId. Core must explicitly resolve it from trusted provisioning or represent legacy attribution as unavailable. A type-only patch is not sufficient.

2. Core admission carries the verified `{ownerId,doName,channelProvider,channelSubject,stateVersion}` across Telegram, WhatsApp, console, event and scheduled entry points; binds ownerId immutably inside the DO before setup; rejects conflicting/revoked route. Do not just trust a client `x-owner-id` header. Proposed exporter type/host delta **after** that authority exists:

```diff
 // TraceContext (additive; current type unchanged in this PR)
+ ownerId?: string; // host-verified owners.id only
 // TelegramOwnerDO.setup exporter context, after verified persisted binding
+ ownerId: identity.get<string>('owner_id'),
 // Span attributes: retain channel/session labels separately
+ ...(context.ownerId ? [attr('langfuse.trace.metadata.owner_id', context.ownerId)] : []),
- attr('langfuse.trace.metadata.owner_attribution', 'canonical_owner_not_supplied'),
+ attr('langfuse.trace.metadata.owner_attribution', context.ownerId ? 'host_verified' : 'canonical_owner_not_supplied'),
```

Core tests must prove independent owners/channel relink, wrong-owner rejection, immutable DO binding, suspension during background work and raw-read ACLs. Exporter synthetic contexts cannot prove any of these.

3. `TurnLogEntry` target additive fields, supplied by actual run/effect/provider producers and passed through unchanged privacy review:

```diff
+ runId?: string;
+ responseId?: string;
+ effectId?: string;
+ providerOutcome?: 'accepted' | 'failed' | 'uncertain';
```

Exact OTLP target mapping after core consumers/privacy tests exist: `runId -> langfuse.observation.metadata.run_id`, `responseId -> ...response_id`, `effectId -> ...effect_id`, `providerOutcome -> ...provider_outcome`. Existing `trace` is the supplied turn correlation key. Response ID already exists in `llm/openai.ts`; core owns propagating it through typed usage/log producers. No ID is guessed, hashed into existence or substituted for an absent provider receipt.

## Cloudflare/config handoff — NOT APPLIED

Configuration delta proposed in this slice: **none**. Keep structured logs enabled, `logs.invocation_logs=false`, `traces.enabled=false` in staging/production. Existing wrangler binding and regression guards enforce this. Automatic URLs can disclose `/c/<ticket>`, OAuth code/state and private paths.

Future metric adapter requires a concrete host consumer and privacy review; no metrics exporter is claimed here. Permit bounded enum labels for environment/model/channel/outcome/feature; release must use a bounded rollout/version view. Owner/trace/run/response/effect IDs belong only in access-controlled trace attributes. Never put payload hashes, URLs/paths, health values or bodies in metric labels. Do not treat an operator aggregate as an owner dashboard.

## No-secrets operator runbook and controlled live plan

1. Review exact PR head and required Actions; merge/deploy belong to owner/core. Inspect deployed SHA/environment independently when authorized; do not infer them from a green PR or preview.
2. Secure setup owner checks Langfuse project/environment/access and secret **presence by name only**: LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY, LANGFUSE_BASE_URL. Use approved secret storage, no paste into source/CLI reports/PR. Current config remains unchanged by this lane.
3. Preserve raw owner DO trace and actual effect/delivery outbox readers. Use authenticated existing owner/core APIs; do not expose an operator cross-owner query to an owner browser. Keep missing canonical mapping visible until core proof exists.
4. After separate live authorization, run a controlled synthetic two-owner canary with capture off: normal turn, scheduled machine turn, late generation, vendor unavailable/timeout. Exercise URLs/path tickets/OAuth state/code/auth/cookies/API-key-like canaries and synthetic health/private text across **every** persisted sink. Do not use real personal data or broaden capture.
5. Record deployed revision, environment, host-verified owner mapping, supplied turn/run/response/effect IDs, typed request/outbox state, raw DO trace/failure rows and vendor observation IDs. Filter each observation by environment/release/schema/user/session and verify parent IDs. Check no synthetic private canary survives in raw logs, console logs, vendor or other configured sinks. A synthetic sink test here does not substitute for that deployed readback.
6. Effect acceptance requires provider feature-level readback correlated with durable effect evidence; Telegram ack is channel-delivery evidence only. Keep pending/uncertain rows explicit. Reconcile aggregate provider invoices separately from versioned price estimates; report late-call coverage honestly.
7. Only after complete evidence may operator views be called wired. Current status is local exporter improvement, host identity gap and live integration unverified.

Rollback: revert this PR via reviewed source change and normal core release process; preserve raw traces/outboxes. No live settings changed, so this lane has no settings rollback. Schema-4 dashboards must tolerate rollback to schema 3; stop interpreting estimate metadata when schema differs. Reverting source restores previous exporter deadline/retention limitations and is not a privacy gate change.
