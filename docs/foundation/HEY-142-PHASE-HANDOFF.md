# HEY-142 Phase Handoff

Status: merged in PR #42 at `d896500` on 2026-07-09.

## What Was Built

- Fake-first governed multi-iteration `plan -> act -> observe` loop in `RunLoopDO`.
- Public runtime FSM edge for `TOOLS_DONE -> LLM_CALLED`.
- Observe-phase continuation parsing: valid tool calls continue, malformed tool-call envelopes fail,
  and terminal non-tool text/JSON can gate and deliver.
- Cumulative governor usage across plan/observe LLM passes and tool observations.
- Stable observation hashing for duplicate/no-progress detection in the fake-first loop.
- Crash/resume proof from `TOOLS_DONE` without re-executing completed tools.
- HEY-111 evidence/replay reuse; no parallel trace path was added.

## What Works

- Multi-pass model/tool/observe runs terminate through gate/outbox when the model stops requesting
  tools.
- Token budget, iteration budget, duplicate observation, kill flag, malformed tool output, denied
  tool behavior, and existing HEY-139 failure paths stop durably without gate/outbox leakage.
- Trace `event_key` remains unique because repeated event families occur across distinct runtime
  state steps.
- Replay evidence remains prompt/private-provider/channel safe under the existing forbidden-key
  contract checks.
- Full local verification passed before merge:

```bash
npx -y pnpm@10.34.4 --filter @waldo/contracts test -- src/runtime/run.test.ts
npx -y pnpm@10.34.4 --filter @waldo/runtime test -- test/run-loop.test.ts
npx -y pnpm@10.34.4 --filter @waldo/runtime typecheck
npx -y pnpm@10.34.4 verify
git diff --check
```

Final observed full verify results: contracts 48 files / 1168 tests passed; runtime 14 files / 164
tests passed; guards passed.

## What Does Not Work Yet

- Real context/recall/prompt hydration is still fake or out of this lane; HEY-15, HEY-14, and
  HEY-16 own that work.
- Real-provider flip readiness is not built; HEY-143 owns staging-only provider readiness.
- Live channel delivery, app feed, Telegram ingress, and committed Scribe memory writes are not
  enabled.
- Standalone eval-suite/golden-corpus runner is absent; local HEY-111 scoring plus the verification
  wall remain the fallback.

## Architecture Decisions Made

- Iteration is represented in the public runtime transition graph, not hidden local loop state.
- HEY-111 evidence remains the replay/debugging surface for HEY-142; trace is explanatory, while
  journal/outbox remain the durability truth.
- Repeated trace families did not require a new event-key schema because the runtime advances state
  steps between repeated event types.
- HEY-142 stayed fake-first: no live provider calls, no live credentials, no live channel delivery,
  and no production Cloudflare/Supabase side effects.

## Hard-Won Lessons

- Observe parsing must be phase-aware. Plan output stays strict, while observe output may be
  terminal delivery text unless it explicitly looks like a malformed tool-call envelope.
- Duplicate/no-progress checks need semantic result hashes, not raw call IDs. HEY-142 strips
  transient call IDs; HEY-143 or real-tool integration may need per-tool semantic canonicalizers.
- The current governor iteration cap denies when `iterations > max`, so tests explicitly document
  the first over-limit LLM pass before `iteration_budget_exhausted`.

## Prerequisites For HEY-143

- Start from `origin/main` at or after `d896500`.
- Keep fake provider and fake delivery as the default local verification path.
- Add provider-readiness tests without logging prompts, raw health, provider bodies, credentials,
  or channel payloads.
- Treat staging credentials and any real provider call as opt-in, bounded by spend cap and kill
  switch, with no live channel delivery by default.
- Carry forward the two P3 notes: iteration-cap semantics and future per-tool semantic observation
  canonicalizers.

## Files Changed In HEY-142

- `packages/contracts/src/runtime/run.ts`
- `packages/contracts/src/runtime/run.test.ts`
- `packages/runtime/src/run-loop/do.ts`
- `packages/runtime/test/run-loop.test.ts`
