# Codex Review Handoff - Post-PR7 Phase D Contract Spine

> Claude builds; Codex audits adversarially. Treat reports from any authoring
> workflow as leads, not proof. Re-run commands and inspect source before
> claiming green.

## Current State

- Repo: `waldo-backend`
- Baseline: PR #7 was squash-merged into `main`.
- Branch: `codex/phase-d-next-contracts`
- PR: create from this branch after the local verification wall passes.
- Canon: accepted ADR corpus plus `waldo-brain/01-Waldo/waldo-harness-deepwiki/`
- Current contract source: `packages/contracts`
- Stale source: `@waldo/types` and old `waldo-types` package snippets

Foundation Phases A/B/C plus Phase D Waves 1-4a are built on `main`:

1. Root contracts: `core/error`, `core/trigger`, `model/roster`.
2. Phase A: CI/conformance wall with SHA-pinned GitHub Actions, `pnpm verify`,
   package-manager guard, stale-types guard, model-id guard, ADR-status guard,
   setAlarm guard, no-passWithNoTests guard, and health-leak guard.
3. Phase B: Cloudflare Workers/Durable Object runtime substrate using
   `@cloudflare/vitest-pool-workers`, DO SQLite, alarms, and eviction proof.
4. Phase C: scheduled durable-execution tracer bullet through
   `DO alarm -> Loop Governor -> run journal -> DeliveryGate -> outbox -> fake sink`,
   with crash/resume exactly-once tests in workerd.
5. Phase C hardening: journal reads validate persisted FSM/verdict values,
   multi-line raw-health leak patterns are covered, and guard self-tests prove
   the health guard catches its own target shapes.
6. Phase D Wave 1: memory contracts are built from current ADR-0046 canon,
   including trust dominance, value-free pattern IDs, hall ACLs, sanitiser
   vocabulary, episode recall hits, and the recall gateway.
7. Phase D Wave 2: CRS/prompt contracts are built, including CRS zone/source
   vocabulary, derived-only narrative context, skill loader contract, and
   REASONS prompt layer/fence contracts.
8. Phase D Wave 3: routing and LLM provider contracts are built with fake-provider
   seams only.
9. Phase D Wave 4a: UI card/notification contracts and provider adapter seams are
   built for health, calendar, sheet, email, and doc.
10. Post-PR7 Phase D contract wave: channel adapters, tool union/ACL/schemas/handler,
    core hooks, memory-skill lifecycle, auth minting, and consent contracts are built
    on this branch.

Branch status to verify at handoff:

- `codex/phase-d-next-contracts` should be based on current `origin/main`.
- A new PR should contain only the post-PR7 contract wave plus doc/handoff updates.
- Re-check GitHub status after every push before merging.

## Fresh Orientation

Run these before forming a verdict:

```bash
git status --short --branch
git rev-parse HEAD
npx -y pnpm@10.34.4 verify
git diff --check
```

Do not claim this branch is merge-ready if GitHub reports a dirty/conflicting
merge state. Resolve that first, then re-run the gate.

## What Exists Now

Contracts:

- `packages/contracts/src/core/*`
- `packages/contracts/src/model/roster.ts`
- `packages/contracts/src/health/crs.ts`
- `packages/contracts/src/memory/*`
- `packages/contracts/src/prompt/*`
- `packages/contracts/src/ui/*`
- `packages/contracts/src/adapters/*`
- `packages/contracts/src/auth/*`
- `packages/contracts/src/tools/*`
- `packages/contracts/src/runtime/*`

Runtime substrate and tracer:

- `packages/runtime/src/index.ts`
- `packages/runtime/src/scheduler/alarm-slot.ts`
- `packages/runtime/src/seams/deps.ts`
- `packages/runtime/src/tracer/*`
- `packages/runtime/test/runtime-probe.test.ts`
- `packages/runtime/test/tracer.test.ts`

Conformance wall:

- `.github/workflows/verify.yml`
- `scripts/guards/*.mjs`
- `pnpm-workspace.yaml`
- root `package.json`

Docs/runbooks:

- `.claude/rules/INDEX.md`
- `docs/foundation/BUILD-PLAN.md`
- `docs/foundation/LOCAL-DEV-TESTING-PIPELINE.md`
- `docs/foundation/NEXT-SESSION-PLAN.md`
- `docs/foundation/PHASE-D-NEXT-AUDIT.md`

## What Is Only A Tracer

Phase C proves the durable execution pattern for one scheduled path. It does not
ship the full harness.

Still missing before broad developer build-out:

- full run/session/working-memory contracts
- full scheduler and seven-schedule multiplexer
- full delivery policy: counted budget paths, priority arbitration, recurrence,
  quarantine, and cross-run no-progress guards
- telemetry contracts
- public DTOs, OpenAPI emitter, generated client freshness
- scenario evidence artifacts, property tests, and targeted mutation lanes
- live/dogfood lanes

## Architecture Claims To Challenge

Use accepted ADRs and DeepWiki pages, not this handoff alone.

- ADR-0054: the reduced tracer FSM must be documented honestly. It maps into
  the full durable run journal but does not replace it.
- ADR-0065: the only raw `setAlarm` call should remain the `alarm-slot` seam.
- ADR-0068: DeliveryGate Reading A is the current build model. `fetch_alert` is
  budget-exempt, class-capped, cooldown-bound, and telemetry-counted; it must not
  touch daily push budget in the tracer.
- ADR-0074: Loop Governor admission is deterministic in the tracer; Phase D must
  reconcile the pre-context governor step with the full context/LLM/tools chain.
- ADR-0046: memory contracts predate the current truth-invalidation model in
  older snippets. Build memory from the accepted ADR, not legacy type drift.

## Security And Privacy Checks

This is GDPR Art-9 health infrastructure. Default tests must use synthetic data
only.

Block or flag immediately if you find:

- real secrets, live provider keys, or production user data
- raw health values in DO SQLite, logs, prompts, traces, eval fixtures, or R2
- live provider/model calls in default gates
- auth/authz claims without real verification
- untrusted execution (`eval`, shelling from untrusted input, unsafe deserialization)
- unpinned GitHub Actions or broad permissions

## Phase D Recommendation To Challenge

Do not broaden runtime implementation until this post-PR7 contract branch is
mergeable/merged and the fresh local gate passes on the pushed branch.

Completed safe units:

```text
Wave 1: memory contracts from ADR-0046
Wave 2: CRS/prompt contracts from ADR-0011/0028
Wave 3: routing/LLM contracts with fake providers only
Wave 4a: UI cards/notifications plus health/calendar/sheet/email/doc adapters
Post-PR7: channel adapters, tool ACL/schemas/handler, hooks, memory-skill, auth mint/consent
```

Next safe unit after this PR lands:

```text
Fresh post-merge PR: runtime run/session/working-memory and scheduler/goal contracts before
full delivery, telemetry, or public DTO expansion.
```

Continuing criteria:

- exact Zod schemas and exported types
- valid and invalid tests that catch enum, field, trust-order, and raw-value drift
- source refs named
- no raw health values, live providers, production data, or public DTO derivation
  from internal schemas
- `npx -y pnpm@10.34.4 verify` green
- `git diff --check` clean

## Review Output Format

1. Executive verdict: pass/block for this PR and pass/block for starting runtime expansion.
2. Current foundation map: what exists, what is tracer-only, and which Phase D waves remain.
3. Findings: severity-ranked with `file:line`.
4. Testing/local-dev verdict.
5. Phase D readiness and the exact next safe unit of work.
6. Residual risks to track.
