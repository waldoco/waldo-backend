# HEY-111 Sequencing Handoff

## HEY-111 → Post-HEY-139 Handoff

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
  - `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- src/run-loop.test.ts`
- [observed] Full repo verification passed before this handoff via:
  - `npx -y pnpm@10.34.4 verify`
  - `git diff --check`

### What Doesn't Work Yet (known issues)

- [blocked] HEY-139 is still In Progress in Linear and owns overlapping changes in `packages/runtime/src/run-loop/do.ts` and `packages/runtime/test/run-loop.test.ts`.
- [blocked] No HEY-111 PR should be opened from the current base until HEY-139 merges, unless the coordinator explicitly asks for a stacked PR.
- [blocked] No standalone eval-suite runner or golden corpus exists in this repo. HEY-111 has local rule scoring only; fake-first WIS remains unavailable rather than fake-green.

### Architecture Decisions Made During This Phase

- Runtime evidence is derived from existing DO-local proof state, not a new generic observability platform.
- `trace_id` is the runtime `run_id` for this local fake-first proof slice.
- `RuntimeReplayFixture` is hermetic and local-only; production R2 Interaction Journal and Supabase `agent_logs` / `trace_evaluations` remain deferred.
- `RuntimeTraceEval` is rule-based for local harness proof and reports `wis.available = false` with `not_observed_fake_first`.

### Hard-Won Lessons

- HEY-111 and HEY-139 intentionally touch the same run-loop files. HEY-139 should land first because it changes ingress, idempotency, gate branches, and failure coverage that HEY-111 needs to describe rather than compete with.
- Trace schema must answer harness/product questions directly. OpenAI/LangGraph/OTel patterns are useful precedent, but Waldo's fake-first evidence contract should not copy their schemas.

### Prerequisites for Next Phase

1. Wait until HEY-139 is merged to `origin/main`.
2. Rebase `codex/hey-111-runtime-eval-trace-replay` onto updated `origin/main`.
3. Resolve overlaps deliberately in:
   - `packages/runtime/src/run-loop/do.ts`
   - `packages/runtime/test/run-loop.test.ts`
4. Preserve `docs/foundation/HEY-111-EVIDENCE-SPINE.md`.
5. Rerun:
   - `npx -y pnpm@10.34.4 --filter @waldo/contracts test -- src/runtime/evidence.test.ts`
   - `npx -y pnpm@10.34.4 --filter @waldo/runtime test -- src/run-loop.test.ts`
   - `npx -y pnpm@10.34.4 verify`
   - `git diff --check`
6. Run `/check-contract`, `/break-feature`, `/run-eval`, and `/code-review` before opening a PR.
7. Push/open a draft PR only after HEY-139 merge/rebase unless a stacked PR is explicitly requested.
8. Move Linear HEY-111 to In Review only after the PR exists.

### Files Changed

- `docs/foundation/HEY-111-EVIDENCE-SPINE.md`
- `docs/foundation/HEY-111-PHASE-HANDOFF.md`
- `packages/contracts/src/index.ts`
- `packages/contracts/src/runtime/evidence.ts`
- `packages/contracts/src/runtime/evidence.test.ts`
- `packages/runtime/src/run-loop/do.ts`
- `packages/runtime/src/run-loop/evidence.ts`
- `packages/runtime/test/run-loop.test.ts`
