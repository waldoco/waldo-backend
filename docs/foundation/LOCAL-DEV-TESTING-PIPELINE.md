# Waldo Harness Local Development & Verification Pipeline

> Status: target standard for `waldo-backend` harness work.
> Audience: Claude/Codex sessions, human developers, and future reviewers.
> Scope: local development, CI gates, runtime verification, scenario evidence, and test discipline for the Waldo agent harness.

## Purpose

This pipeline exists to prove the harness is correct, not to accumulate tests.

Every test or gate must answer at least one of these questions:

1. Did the code implement a specific accepted ADR or DeepWiki target?
2. Would this test fail if the implementation violated the invariant?
3. Does the evidence show what happened during the run, not just that a command exited `0`?
4. Can a new agent/developer reproduce the result without hidden state or real secrets?

If a test cannot name the invariant it protects, it is documentation at best and noise at worst.

## Canonical Inputs

Before changing harness code, read only the source set needed for the change:

- `docs/foundation/BUILD-PLAN.md`
- this file
- the relevant DeepWiki page under `waldo-brain/01-Waldo/waldo-harness-deepwiki/`
- the accepted ADRs that own the touched seam
- the touched package/module code

Do not treat legacy code or old package snippets as canon unless the DeepWiki labels them as current target/code evidence.

## Gate Ladder

The Waldo harness has ten verification layers. They are cumulative: higher gates do not replace lower gates.

| Gate | Name | Runs where | Blocks merge? | Purpose |
|---|---|---:|---:|---|
| 0 | Source/canon gate | local + review | yes | Prove the work maps to accepted ADR/DeepWiki target, not stale plans. |
| 1 | Static wall | local + CI | yes | Typecheck, lockfile, lint/security greps, package/import guards. |
| 2 | Contract tests | local + CI | yes | Zod schemas, exact enum tuples, valid/invalid fixtures, OpenAPI freshness. |
| 3 | Pure deterministic tests | local + CI | yes | Math, routing, policies, idempotency keys, trust comparators, sanitizers. |
| 4 | Property/fuzz tests | local + scheduled CI | targeted | Generate many inputs for security-critical deterministic code. |
| 5 | Hermetic runtime tests | local + CI | yes for runtime work | Run Worker/DO code inside the Cloudflare runtime with SQLite, alarms, bindings. |
| 6 | Deterministic simulation | local + CI for core paths | yes for runtime core | Crash/resume, retry storms, time travel, outbox exactly-once. |
| 7 | Scenario/evidence tests | local + CI smoke | yes for harness flows | End-to-end behavior traces with fake model/provider/sinks. |
| 8 | Live/dogfood lanes | manual/opt-in | no for ordinary PRs | Real provider/channel checks, cost/latency smoke, human review. |
| 9 | Mutation testing | nightly/beta gate | targeted | Prove tests kill meaningful mutants in deterministic core. |

The **beta gate** is the release-readiness gate before real beta users or real staging dogfood depend on the harness. It is not an ordinary PR merge gate and not a calendar date. It is where Waldo must prove the deterministic core is hard to break: runtime scenarios, crash/resume, privacy fuzzing, and targeted mutation must have evidence.

## Current Command Surface

Current committed root command surface:

```bash
pnpm install
pnpm -r typecheck
pnpm -r test
```

Target command surface to build next:

```bash
pnpm verify              # full local merge gate, no secrets, release-age policy active
pnpm verify:fast         # targeted dev loop: typecheck + affected tests + guards
pnpm verify:contracts    # Zod schemas, exact tuples, OpenAPI freshness, leak checks
pnpm verify:workers      # @cloudflare/vitest-pool-workers hermetic runtime tests
pnpm verify:scenarios    # deterministic scenario traces with fake model/sinks
pnpm verify:property     # fast-check suites for selected deterministic invariants
pnpm verify:mutation     # Stryker targeted deterministic-core mutation run
```

Until a target command exists, do not pretend it passed. Report it as "not implemented yet" and run the closest lower-level command.

## Standard Local Loop

For every feature or fix:

1. **Orient**
   - Identify the owning ADR/DeepWiki section.
   - Write down the invariant in one sentence.
   - Identify the smallest seam that can prove it.

2. **Create the failing proof**
   - Contract change: add exact valid/invalid tests first.
   - Runtime change: add hermetic Workers/DO test first.
   - Deterministic policy: add table/golden/property test first.
   - Bug fix: add a regression test that fails on the old behavior.

3. **Implement narrowly**
   - Change only the module that owns the seam.
   - Keep policy single-owner. Do not duplicate delivery, model, trigger, auth, or budget logic in adapters.
   - Do not add broad abstractions before two real call sites need them.

4. **Run targeted checks**
   - Run package typecheck.
   - Run the specific test file.
   - Run the nearest gate for the touched layer.

5. **Run merge gate**
   - Run `pnpm verify` once it exists.
   - Until then, run `pnpm install`, `pnpm -r typecheck`, and `pnpm -r test`.

6. **Record evidence**
   - Final response or PR body must include commands run, pass/fail, and skipped gates.
   - If a gate is target-only, say so explicitly.

## Test Discipline Rules

### Every test must be anchored

Each nontrivial test file should include or clearly imply:

- source: ADR/DeepWiki/code issue it validates
- invariant: what must always be true
- failure mode: what bad implementation it catches
- fixture class: synthetic, golden, property-generated, or live opt-in

Example:

```ts
// ADR-0068: DeliveryGate stamps admission once during GATED.
// Catches double budget decrement on alarm retry after outbox commit.
```

### Avoid library-testing

Bad:

```ts
expect(schema.parse(value)).toEqual(value);
```

Good:

```ts
expect(triggerTypeSchema.options).toEqual([
  "brief",
  "fetch_alert",
  "patrol",
  "handoff_explore",
  "handoff_plan",
  "handoff_act",
  "handoff_replan",
  "intervention",
  "user_message",
  "dreaming_mode",
  "pre_activity_spot",
]);
expect(triggerTypeSchema.safeParse("morning_wag").success).toBe(false);
```

The first test mostly proves Zod works. The second proves Waldo's contract did not drift.

### No silent skips

No `--passWithNoTests`.
No broad `.skip` without issue/reference.
No tests that require real provider keys in the default gate.
No generated snapshots without a human-readable summary of what changed.

### Tests own their fixtures

Use synthetic data by default. Real health data must never be committed.

Fixture names should state intent:

- `synthetic-pro-user-fetch-budget.json`
- `synthetic-empty-profile-brief1.json`
- `golden-delivery-trace-fetch-adjustment-spot.json`
- `attack-prompt-canary-leak.json`

## Runtime Verification Spine

The next major deliverable is not the full contract spine. It is the verification spine that proves Waldo can be tested in the real runtime.

Minimum target:

```text
DO alarm
  -> Loop Governor
  -> run journal
  -> DeliveryGate
  -> outbox
  -> fake channel sink
```

This spine needs:

- `@cloudflare/vitest-pool-workers`
- `wrangler.jsonc`
- SQLite-backed Durable Object migration using `new_sqlite_classes`
- fake clock/alarm controls
- fake model/provider
- fake APNs/Telegram/in-app sink
- trace recorder
- crash injection points
- evidence JSON artifacts

The first green scenario must prove:

1. alarm fires
2. Governor admits the run
3. run opens and journals steps
4. DeliveryGate produces a stamped verdict
5. outbox row commits transactionally
6. fake sink receives exactly one delivery
7. replay/resume does not double-send

## Hermetic Cloudflare Tests

Use Workers Vitest for anything involving Worker APIs, Durable Objects, SQLite, alarms, bindings, or runtime-specific behavior.

Required patterns:

- `runInDurableObject()` to inspect or seed DO internals in tests.
- `runDurableObjectAlarm()` to execute scheduled alarms immediately.
- `evictDurableObject()` / `evictAllDurableObjects()` to simulate production eviction and resume behavior.
- per-test-file isolated storage as the default.
- no real Workers AI, Vectorize, APNs, Telegram, Supabase, or provider calls in default tests.

Outbound calls in hermetic tests must go through explicit fake bindings or request mocks.

## Deterministic Simulation

For durable execution, example-based tests are not enough.

The run-journal/outbox simulator should model:

- deterministic clock
- deterministic IDs
- seeded pseudo-random schedule where needed
- alarm retry count
- eviction after selected steps
- throw after selected steps
- duplicate alarm delivery
- sink ack/no-ack/permanent failure

Crash points to cover first:

1. after `RUN_OPENED`
2. after `GOVERNOR_ADMITTED`
3. after `GATED` decision but before outbox insert
4. after outbox insert but before sink call
5. after sink call but before sink ack is recorded
6. after ack record but before handler returns

Required invariant:

```text
For a fixed event_id and idempotency_key:
  budget decrements at most once
  outbox contains at most one active delivery
  fake sink observes at most one successful send
  resume reaches the same terminal state
```

## Property/Fuzz Testing

Use property-based tests for pure code where the input space is large and failures are high-impact.

Adopt `fast-check` for:

- DeliveryGate budgets, cooldowns, day boundaries, time zones, quiet hours
- idempotency-key canonicalization
- Scribe/PII/health sanitizer
- canary leak detector
- prompt/output taint gates
- CRS math invariants
- memory `dominates()` ordering and tie-breaks

Property tests must record the failing seed in output. A failure without a reproducible seed is not acceptable.

Example property statement:

```text
For any generated sequence of candidates within one local day,
counted APNs sends must never exceed the user's tier budget,
and exempt sends must not consume counted budget.
```

## Mutation Testing

Mutation testing is how we answer "are the tests real?" with evidence.

Use Stryker only on deterministic core at first:

- `core/trigger`
- CRS math
- sanitizer
- DeliveryGate
- Loop Governor
- run-journal/outbox idempotency
- memory trust comparator

Do not run broad mutation across the whole repo in the normal dev loop. It is too slow and will create noise before the core is stable.

Initial thresholds:

- local exploratory: report only
- CI scheduled/nightly: fail below agreed score for deterministic core
- beta gate: fail if critical-policy mutants survive

Important Stryker/Vitest note: if a mutation target is only tested through API/runtime integration tests that do not directly import the source file, configure Stryker so Vitest does not only run "related" tests by import graph.

## Scenario/Evidence Harness

Every meaningful end-to-end harness behavior should be expressible as a scenario file:

```text
scenario id
source refs
initial DO SQLite rows
synthetic user/tier/timezone
trigger/alarm event
fake model response script
expected journal events
expected DeliveryGate verdicts
expected outbox rows
expected sink deliveries
expected trace redactions
```

The scenario runner should emit:

```text
artifacts/verification/<run-id>/
  summary.json
  trace.jsonl
  journal.json
  outbox.json
  sqlite-inspection.json
  command.txt
  git.txt
```

`summary.json` must include:

- git commit SHA
- dirty tree flag
- command
- scenario IDs
- random/property seeds
- package manager version
- pass/fail
- failure class
- source refs

This gives future agents something to inspect instead of guessing from terminal text.

## Agent Behavior Evals

Agent behavior evals are not the same as runtime correctness tests.

Runtime correctness asks:

```text
Did the harness enforce the state machine, policy, and delivery guarantees?
```

Behavior evals ask:

```text
Did the model produce a useful, safe, on-brand result under the allowed tools/context?
```

For now, wire trace hooks and fake-model scenario support. Do not block foundation work on live LLM judging.

Later eval lanes:

- deterministic fake-model trajectories for tool-policy behavior
- golden prompt/context assembly snapshots
- LLM-as-judge for soul/voice only after trace capture is stable
- provider shadow-eval for ADR-0069 routing
- cost/latency reports per trigger class

## CI Wall

Minimum CI wall:

1. checkout with pinned GitHub Actions SHAs
2. setup pnpm/node using declared versions
3. install with lockfile and release-age policy active
4. typecheck
5. unit/contract tests
6. Workers/DO tests once runtime package exists
7. OpenAPI freshness once emitter exists
8. generated-client freshness once clients exist
9. stale import guard: no `@waldo/types`
10. model-name guard: no hardcoded non-roster model IDs
11. health/internal leak scan
12. credential-boundary scan
13. ADR-status lint
14. no `--passWithNoTests`

Add CI slicing only when test runtime justifies it. Borrow the Hermes pattern: store test durations, slice by longest-processing-time, and merge duration artifacts after successful main-branch runs.

## Local Dev Modes

### Fast edit loop

Use while writing one module:

```bash
pnpm --filter @waldo/contracts typecheck
pnpm --filter @waldo/contracts test -- src/path/to/file.test.ts
```

### Runtime loop

Use when touching Worker/DO behavior:

```bash
pnpm verify:workers -- path/to/scenario.test.ts
```

The test must run inside the Workers runtime, not a Node-only approximation.

### Scenario loop

Use when changing behavior that spans modules:

```bash
pnpm verify:scenarios -- --scenario scheduled-fetch-budget
```

Inspect `artifacts/verification/<run-id>/summary.json` before calling it done.

### Manual local server

Use `wrangler dev` for manual exploration only.

Manual checks do not replace hermetic tests. If manual exploration finds a bug, capture it as a scenario or regression test before fixing.

## Live Tests

Live tests are opt-in and never part of the default merge gate.

They may use:

- real Workers AI or AI Gateway
- real Supabase staging
- real APNs/Telegram sandbox
- real provider model calls

Rules:

- require explicit env var such as `WALDO_LIVE=1`
- never use production user data
- write artifacts under `artifacts/live/`
- print estimated cost before running
- redact secrets and raw health values
- fail closed if required credentials are missing

## Quality Bars By Module Type

| Module type | Required tests before merge |
|---|---|
| Contract schema | exact tuple tests, valid/invalid fixtures, typecheck, OpenAPI freshness if public. |
| Pure policy/math | golden tests, edge cases, property test for invariant, targeted mutation later. |
| Worker route | auth/authz test, input validation, generic error test, rate-limit plan/test. |
| Durable Object state | hermetic runtime test, SQLite inspection, alarm/eviction coverage. |
| Run journal/outbox | deterministic simulation, crash/resume matrix, idempotency property. |
| DeliveryGate | ADR-0068 golden traces, budget/cooldown properties, hostile candidate tests. |
| Scribe/sanitizer | fuzz/property tests, canary/PII health leak tests, no raw prompt/log leakage. |
| Adapter boundary | fake adapter tests, `adapterResultSchema(dataSchema)`, timeout/error mapping. |
| Model routing | roster guard, fake provider tests, no untyped model IDs, cost/escalation telemetry. |
| Public DTO/API | no internal fields, OpenAPI artifact diff, generated client freshness. |

## Developer And Agent Session Discipline

Every new coding session should start with this checklist:

1. Confirm branch and dirty tree.
2. Read `BUILD-PLAN.md` and this file.
3. Read only relevant ADR/DeepWiki pages.
4. State the owning invariant before editing.
5. Add or update the failing proof first.
6. Keep changes scoped to the owning seam.
7. Run targeted checks, then merge gate.
8. Report skipped gates honestly.
9. Do not mark work complete if evidence artifacts are missing.

Required final report shape:

```text
Changed:
- file/module summary

Verified:
- command -> result
- scenario/artifact path if applicable

Not run:
- gate -> reason

Residual risk:
- specific, not vague
```

## Anti-Patterns

Block or rewrite work that does any of these:

- uses Node mocks for Durable Object behavior that must be proven in Workers runtime
- adds broad schema snapshots without exact semantic assertions
- adds behavior without a source ref
- introduces a second writer for budget, outbox, memory, model roster, or trigger vocabulary
- calls real providers in default tests
- stores raw health values in logs, prompts, traces, or committed fixtures
- treats `wrangler dev` manual success as proof
- claims "green" while release-age, OpenAPI, generated-client, or runtime gates are absent
- adds full mutation testing before deterministic core has stable tests

## Research Baseline

The pipeline intentionally borrows from peer systems but adapts to Waldo's constraints:

- Cloudflare Workers Vitest: real Workers runtime, bindings, isolated storage, local Miniflare.
- Cloudflare Durable Object tests: direct DO access, alarms, SQLite, eviction helpers.
- Hermes: pinned supply chain, split CI lanes, per-file isolation, duration-based test slicing, live-test artifacts, observer hooks with correlation IDs.
- Pi: faux providers, in-memory session managers, scripted model responses, event capture, queue/session replay discipline.
- OpenClaw: explicit local/pre-push/e2e/live lanes, Docker/VM runners, QA scenario evidence.
- Aider/HAL: benchmark/eval reporting with commit SHA, cost, pass rate, and reproducible artifacts.

Waldo differs from coding agents because its hard guarantees are stateful, privacy-sensitive, and user-health-adjacent. Therefore the first-class proof is durable runtime correctness, not only model task pass rate.

## Near-Term Build Order

1. Implement the CI wall and local `pnpm verify` scripts.
2. Add `@cloudflare/vitest-pool-workers` and a minimal Worker/DO test package.
3. Build minimal scheduled-path contracts.
4. Add fake clock, fake model/provider, fake sink, and trace recorder.
5. Green the scheduled tracer scenario.
6. Add crash/resume simulation and eviction tests.
7. Add DeliveryGate property tests.
8. Add Scribe/sanitizer fuzz tests.
9. Add targeted mutation for deterministic core.
10. Add live/dogfood lanes after hermetic gates are stable.

## Definition Of Done

Harness work is done only when:

- the owning source refs are named
- the invariant is tested
- the relevant gate passes
- runtime behavior is proven in Workers when applicable
- deterministic failures are reproducible by seed or scenario ID
- evidence artifacts exist for scenario/runtime work
- skipped target gates are named honestly
- no raw health/secrets/internal-only DTOs leak into public artifacts or logs

Green terminal output is necessary. It is not sufficient.
