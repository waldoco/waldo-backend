# Outcome-bound planning harness Gate B handoff

## Outcome and proof level

Gate B implements the minimum Outcome-bound working-agent harness for one authorized provider
planning turn. Against live `origin/main` at `2a01cf242058d1bff460229c25894349b2c2d30e`, the
current candidate is `architecture_specified`, `contract_defined`, `module_implemented`, and
`adapter_conformance_passed` for the local public-adapter and deterministic-provider boundary.
The final local verification wall and the independent re-review status are recorded separately
below so local remediation is not presented as independent approval.

This is not `cross_surface_acceptance_passed` or `operational_proof_passed`. Kennel has not invoked
the public adapter, no hosted environment was changed, and no real provider turn was run because an
already-authorized, version-pinned non-production provider configuration was unavailable. The
deterministic provider fake proves the contract and runtime behavior, not a literal deployed agent.

## What was built

- A version-pinned responsibility planning-turn v0.3 contract with strict canonical request,
  trusted execution envelope, authorization result, `ExecutionRequest`, `AgentSession`, lease,
  Waldo provider-invocation record, bounded `WorkUnitCandidatePlan`, activity/projection item,
  page, and fixture schemas.
- One optimistic `WorkUnit` transition from `planned` to `planning_authorized`. The transition
  atomically persists the execution request, initial session activity, ordered projection item,
  cursor, and idempotency record before provider I/O.
- An explicit authority ceiling for exactly one planning turn. The capability manifest is empty:
  no inherited tools, connectors, filesystem, shell, network, email, calendar, publication, or
  external effects. The ceiling also denies Outcome mutation, Evidence, Verification, Acceptance,
  closure, and external effects.
- Pinned provider, executor, and capability-manifest references plus an execution lease with fence
  and cancellation generation. Stale WorkUnit revisions, invalid transitions, wrong or expired
  leases, stale fences, and cancellation generations fail closed.
- One physical provider path through the existing trusted `RunLoopDO` provider-effect seam.
  Provider I/O occurs outside the Durable Object transaction. The Coordinator performs no
  external I/O inside its SQLite transaction.
- A durable provider intent/result boundary. Exact retries through the deterministic fake reconcile
  the same Waldo invocation key rather than issuing a blind second call. Production gateway mode
  can issue one trusted call but cannot recover a lost provider response by identifier; restart
  therefore fails closed as ambiguous and never blindly reissues.
- Atomic settlement of bounded provider-invocation metadata, AgentSession activity, validated
  candidate plan, result digest, ordered projection item, and cursor. Injected settlement failure
  leaves no partial candidate, result activity, or projection write.
- Privacy-minimized persistence. The runtime does not persist composed prompts, chain of thought,
  raw provider responses, transcripts, or secrets. It persists only already-owned Outcome text,
  governed input references/digests, bounded invocation/result metadata, and the validated candidate
  plan. No provider receipt identifier is fabricated when the provider does not return one.
- Feature-gated public Worker routes for planning invocation and planning projection read. The
  adapter reuses authenticated owner-root routing, raw-byte duplicate-key defense, bounded bodies,
  trusted server derivation, signed DO admission, and content-free error behavior from Gate A.
- An authenticated, signed, idempotent planning-cancellation route. Kennel can request cancellation
  with an expected generation; Waldo validates current authority, increments the generation,
  fences late settlement, and publishes cancelled activity without changing Outcome state.
- A 256 KiB serialized planning-projection page ceiling with deterministic cursor-preserving
  trimming, including multibyte output coverage.
- Version-pinned executable fixtures, generator, and freshness guard for the v0.3 public boundary.
- Additive schema V5 for planning execution state. Upgrade tests preserve V4 responsibility state,
  and failure tests prove a V5 migration collision rolls back without replacing the WorkUnit table.
  Forward and rollback WorkUnit copies name every column so later schema changes cannot silently
  reorder persisted responsibility state.

## Observable behavior proved locally

Both scenarios pass through the same authorization, execution, validation, settlement, and
projection interfaces with the empty capability manifest:

1. **Kennel work scenario:** “Prepare a reviewable product update, but do not publish it.” The
   result is a bounded candidate plan only; no publication authority or effect exists.
2. **Personal-assistance scenario:** “Prepare me for tomorrow’s investor meeting and identify the
   follow-ups I should handle.” Bounded supplied fixture context produces a candidate plan only;
   no Gmail, Calendar, contacts, chat, health, or other connector exists.

The second scenario proves that the harness vocabulary is not work-only. It does not prove shipped
personal-assistance connectors, live context retrieval, or a Kennel personal-assistance surface.

Hostile Outcome/user text remains untrusted model input and cannot select or change the provider,
model, executor, manifest, authority ceiling, output schema, persistence rules, verification,
acceptance, closure, or stop conditions. Provider or AgentSession completion cannot mutate Outcome,
Verification, Acceptance, OpenLoop, or closure.

## Verification ledger

### Passed before final review

- `npx -y pnpm@10.34.4 install --frozen-lockfile`.
- `@waldo/contracts`: 58 files / 1,475 tests.
- `@waldo/runtime`: 38 files / 1,001 tests.
- Runtime Worker and Node integration TypeScript checks.
- v0.3 fixture generation and freshness guard.
- Local Supabase: eight canonical migrations, 53 pgTAP assertions, migration-list/history
  freshness, transactional rollback rehearsals, and no pending migration.
- Node adapter integrations: two files / five tests, including the real local Supabase exact-token
  sign-out retry through the public responsibility adapter contract.
- `DOCKER_CONTEXT=desktop-linux npx -y pnpm@10.34.4 verify`: frozen install, all workspace
  typechecks, contracts, Supabase reset/pgTAP, runtime, adapter integrations, and all guards.
- Local separate Standards and Spec remediation reviews: PASS on the final working tree.
- Mandatory Codex Security diff scan: complete coverage of all nine changed source/config rows,
  zero surviving candidates, and a sealed no-findings report. It was parent-executed because the
  resolved scan preflight selected the documented parent-only path.
- Local adversarial breaker: PASS after the review findings and the Draft 2020-12
  capability-schema defect below were fixed and reverified.
- `git diff --check`.

### Independent review status

- The independent clean-room review of commit `48514ee84bbf82ff41d0acea81ee474c8b843985`
  returned **NEEDS WORK** with eleven findings. Findings 1–10 were reproduced or inspected and
  remediated in commit `e5988cb67d9bff890a6da99824ebbc8ae1daec50`.
- Finding 11, modeling `work_unit_plan` as a general `TriggerType`, remains an explicit
  behavior-neutral architecture follow-up. This remediation does not add a scheduled trigger,
  inherited capability, connector, tool, external effect, or new provider path.
- Independent re-review of `e5988cb67d9bff890a6da99824ebbc8ae1daec50` verified findings
  1–10 as fixed and Finding 11 as correctly deferred, then found one residual mapped-error defect:
  a normal retry after cancellation returned HTTP 500. Finding 12 is fixed in the current
  candidate and locally reverified, but independent re-review of the new head has not yet run.
  The PR must not be represented as independently approved or merged until that review completes.

### Failed, then fixed

- Initial red tests established the missing v0.3 schemas, authorization transition, atomic
  execution state, provider settlement, restart reconciliation, and public adapter behavior before
  implementation.
- Adversarial additions exposed incomplete timeout/schema-invalid ambiguity handling, lease/fence
  rejection, settlement rollback coverage, and provider-reference validation. Each was repaired and
  the focused and full package suites rerun.
- Standards review found an unsafe V5 down migration, planning-projection persistence leaking into
  the Coordinator, and duplicated public projection parsing. Unsafe downgrade now refuses and
  rolls back atomically once durable planning state exists; projection reads live behind the owning
  planning module; and both public projections share one bounded query parser.
- Spec review found that gateway mode could not issue a trusted turn, expired recovery leases could
  not settle, known invalid output was mislabeled as receipt ambiguity, rollback could delete
  history, and Kennel lacked a cancellation boundary. Gateway mode now supports one trusted issue
  while receipt-only recovery fails closed; expired recovery increments the fence and renews the
  lease; invalid output records a known result digest and failed session without raw output; used
  V5 state blocks downgrade transactionally; and signed cancellation is public.
- Security review found planning projection response amplification. The v0.3 contract and owning
  module now enforce and test a 262,144-byte page ceiling without skipping ordered cursors.
- Final review removed a fabricated provider-receipt identifier, mapped planning digest conflicts
  to content-free 409 responses, made lease expiry inclusive, prevented late invalid output from
  settling, and kept failed sessions terminal. The contract and persistence now name the durable
  record as a Waldo provider invocation; production response-loss recovery remains ambiguous.
- The first full repository wall found only the disposable Supabase database container running, so
  the Auth/REST exact-token integration failed. The worktree-local Supabase stack was restarted
  without exposing its generated credentials before the full wall was rerun.
- Breaker validation found the generated empty-capability tuple representation was invalid Draft
  2020-12 JSON Schema even though runtime validation rejected non-empty arrays. The contract now
  emits `maxItems: 0`; an Ajv 8.17.1 Draft 2020-12 test compiles the generated trusted-envelope
  schema, accepts the pinned valid fixture, and rejects the non-empty-tools case.
- The clean-room review found that unknown WorkUnits, unsupported captured capabilities, and
  unknown cancellation targets escaped as HTTP 500 and amplified `owner_root_failure` reporting.
  The owning modules now use the bounded missing/conflict vocabulary; adapter regressions prove
  content-free 404/409 responses and no failure-reporter call.
- The clean-room review found that cancellation made a pending provider invocation eligible for
  reconciliation and left the lease at the previous cancellation generation. Recovery now requires
  a still-leased request with matching request/lease generations, and cancellation advances the
  request, session, and lease generation atomically. A restart after cancellation performs no
  additional provider call.
- The clean-room review found that ambiguity marking could replace the causal provider failure.
  Ambiguity marking now becomes a no-op after a concurrent terminal transition, preserving the
  original provider error while leaving settlement fenced.
- The clean-room review found stale/non-executable rejection metadata, a divergent ad-hoc
  cancellation test digest, root-only Ajv placement with permissive compilation, a scenario-aware
  fake, a vacuous hostile-input assertion, a theoretical projection skip-forward edge, and a
  positional migration copy. The fixture catalogue now declares exact schema/runtime layers and
  validates both positive and negative controls under strict Draft 2020-12 Ajv from the contracts
  package; tests use the canonical cancellation request/digest; the fake is input-agnostic and
  scenario variation is injected explicitly; hostile tests assert durable authority invariants;
  projection trimming refuses an unpageable single item; and both migration directions name every
  WorkUnit column.
- A new successful-down-migration rehearsal initially failed with Workerd `SQLITE_AUTH`; the
  unsupported rehearsal was replaced with a direct invariant over both migration definitions.
  Existing tests continue to prove forward data preservation, transactional collision rollback,
  and fail-closed downgrade after durable V5 state exists.
- Independent re-review found that a duplicate planning request arriving after cancellation was
  correctly fenced from provider I/O but `prepareProviderEffectInCurrentTransaction` classified
  the terminal request with a plain `Error`. The retry therefore became a content-free HTTP 500
  and `owner_root_failure` instead of an ordinary conflict. The owning module now throws
  `ResponsibilityPlanningConflictError`; the restart regression crosses the public Worker adapter
  into the actual planning module and asserts the exact internal error name, mapped content-free
  HTTP 409, and no failure-reporter amplification while continuing to prove zero provider calls,
  synchronized cancellation generations, no candidate plan, and unchanged Outcome state.

### Unavailable

- No approved non-production real-provider configuration was present under the supported runtime
  environment names. No credential was requested, printed, persisted, or committed. The literal
  real-provider turn and `operational_proof_passed` therefore remain unavailable. Production
  gateway mode can issue the trusted turn when configured; if a process loses the response after
  provider I/O, its receipt-only reconciliation remains honestly unavailable rather than risking a
  duplicate call.

### Deferred or not proved

- Kennel client integration and cross-surface acceptance.
- Hosted staging and production deployment, migration, observability, rollback drill, and
  operations.
- Tools, connectors, filesystem, shell, network, email, calendar, publishing, and other effects.
- Candidate Evidence, independent Verification, Acceptance, OpenLoop, ReEntryPoint, Outcome
  closure, and reopen/release behavior.
- A behavior-neutral refactor that removes `work_unit_plan` from the general scheduled-trigger
  vocabulary. No runtime path currently grants scheduled-trigger authority from that modeling
  choice, so it remains separate from the cancellation and public-boundary remediation.

## Preserved architecture boundaries

- `RunLoopDO` remains the owner-derived Durable Object and the only physical provider path.
- `WaldoCoordinator` remains the owner-domain orchestrator and canonical admission boundary. It
  does not call providers inside its transaction.
- `OutcomeModule` owns the canonical WorkUnit authorization transition. Planning execution state
  has one bounded owning module and does not become Outcome truth.
- Kennel may request and render planning activity, but Waldo determines whether a WorkUnit is
  authorized and still valid. A local or provider `DONE` state is not responsibility completion.
- Outcome, Mission, WorkUnit, AgentSession, candidate plan, Evidence, Verification, Acceptance, and
  OpenLoop remain distinct concepts.

## What Kennel can consume after this PR merges

Kennel can build a version-pinned client against the v0.3 request, result, and ordered projection
fixtures; invoke the authenticated planning-turn endpoint for an already-planned WorkUnit; and
render authorized/running/ambiguous/completed planning activity plus the bounded candidate plan.
It must continue treating those states as execution visibility, never verified Outcome completion.

That is a contract-consumption opportunity, not a claim that Kennel integration already passes.

## Next phase

After this PR is reviewed, merged, and re-pinned from live `origin/main`, run the shared v0.3
fixtures against a Kennel client and the real local Worker/DO boundary for the first cross-surface
acceptance proof. In parallel, define the next Waldo-owned domain slice for candidate Evidence and
independent Verification. Do not add effectful tools or connectors until their authority,
idempotency, reconciliation, privacy, and revocation contracts are separately proved.

## Files changed

- `packages/contracts/src/protocol/responsibility-planning-turn-v0-3*`
- `packages/contracts/fixtures/responsibility-planning-turn/v0.3/*`
- `packages/contracts/src/core/trigger*`
- `packages/contracts/src/runtime/routing*`
- `packages/contracts/src/tools/permissions*`
- `packages/contracts/src/protocol/responsibility-http-adapter-v0-1.ts`
- `packages/runtime/src/coordinator/outcome-module.ts`
- `packages/runtime/src/coordinator/planning-execution-module.ts`
- `packages/runtime/src/coordinator/waldo-coordinator.ts`
- `packages/runtime/src/do-schema.ts`
- `packages/runtime/src/responsibility/*`
- `packages/runtime/src/run-loop/*`
- `packages/runtime/test/work-unit-planning-authorization.test.ts`
- `packages/runtime/test/responsibility-public-do.test.ts`
- `packages/runtime/test/responsibility-worker-adapter.test.ts`
- `packages/runtime/test/do-schema.test.ts`
- `scripts/generate-responsibility-planning-turn-v0-3*`
- `scripts/guards/guard-responsibility-planning-turn-v0-3-fresh*`
- `package.json`
- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/NEXT-BACKEND-SESSION-PROMPT.md`
- this handoff
