# HEY-111 Sequencing Handoff

## HEY-111 → Post-Merge Handoff

Status: merged via PR #39 at `61eb3c7` after HEY-139 PR #38 and HEY-10 PR #37.

### What Was Built

- Typed runtime evidence contracts for trace events, replay fixtures, and local rule-based trace evals.
- DO-local evidence builder over the existing run-loop `runtime_trace`, `runtime_journal`, delivery journal, and outbox proof surfaces.
- Stable trace `event_key` generation and uniqueness for crash/resume evidence.
- Product-first evidence-spine plan in `docs/foundation/HEY-111-EVIDENCE-SPINE.md`.
- Focused contract and runtime tests for trace order, replay shape, failed branches, denied tools, privacy guards, and event-key uniqueness.

### What Works (with evidence)

- [observed] Contract evidence schemas pass via:
  - `npx -y pnpm@10.34.4 --filter @waldo/contracts test -- src/runtime/evidence.test.ts`
- [observed] Runtime fake-first evidence paths pass via:
  - `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- test/run-loop.test.ts`
- [observed] Full repo verification passed before this handoff via:
  - `npx -y pnpm@10.34.4 verify`
  - `git diff --check`

### What Doesn't Work Yet (known issues)

- [blocked] No standalone eval-suite runner or golden corpus exists in this repo. HEY-111 has local rule scoring only; fake-first WIS remains unavailable rather than fake-green.
- [inference] HEY-142 should revisit trace `event_key` granularity if multi-iteration loops can emit the same event type more than once in one runtime state step. HEY-111's current key is intentionally sufficient for fake-first retry/resume dedupe.

### Architecture Decisions Made During This Phase

- Runtime evidence is derived from existing DO-local proof state, not a new generic observability platform.
- `trace_id` is the runtime `run_id` for this local fake-first proof slice.
- `RuntimeReplayFixture` is hermetic and local-only; production R2 Interaction Journal and Supabase `agent_logs` / `trace_evaluations` remain deferred.
- `RuntimeTraceEval` is rule-based for local harness proof and reports `wis.available = false` with `not_observed_fake_first`.

### Hard-Won Lessons

- HEY-111 and HEY-139 intentionally touch the same run-loop files. HEY-139 should land first because it changes ingress, idempotency, gate branches, and failure coverage that HEY-111 needs to describe rather than compete with.
- Trace schema must answer harness/product questions directly. OpenAI/LangGraph/OTel patterns are useful precedent, but Waldo's fake-first evidence contract should not copy their schemas.

### Next Phase

1. Start HEY-142 from `origin/main` at or after `61eb3c7`.
2. Use HEY-111 evidence as the assertion surface for multi-iteration behavior: trace order, terminal visibility, outbox consistency, and privacy guard.
3. Update trace `event_key` shape only if HEY-142 proves duplicate event types are legitimate within one runtime step.
4. Rerun:
   - `npx -y pnpm@10.34.4 --filter @waldo/contracts test -- src/runtime/evidence.test.ts`
   - `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- test/run-loop.test.ts`
   - `npx -y pnpm@10.34.4 verify`
   - `git diff --check`
5. Run `/check-contract`, `/break-feature`, `/run-eval`, and `/code-review` before opening a PR.

### Files Changed

- `docs/foundation/HEY-111-EVIDENCE-SPINE.md`
- `docs/foundation/HEY-111-PHASE-HANDOFF.md`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/runtime/evidence.ts`
- `packages/contracts/src/runtime/evidence.test.ts`
- `packages/runtime/src/run-loop/do.ts`
- `packages/runtime/src/run-loop/evidence.ts`
- `packages/runtime/test/run-loop.test.ts`
