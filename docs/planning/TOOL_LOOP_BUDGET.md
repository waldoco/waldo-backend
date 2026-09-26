# Tool loop budget

This covers how many tool rounds a single Waldo turn may take. Researched 23 Sep 2026.

## What other harnesses do

| Harness | Round cap | Other stops |
|---|---|---|
| Hermes Agent | 500 iterations by default, via `agent.max_turns`. It was raised from 90 because complex runs hit the wall. Subagents default to 50. At 100% the agent stops and returns a summary of the work done. | Fallback providers |
| pi | The core loop runs until the model stops calling tools. There is no round cap. The only guard is on repeated non-terminal pauses with no tool call in between. | Compaction |
| Claude Agent SDK | No limit by default: "the loop runs until Claude finishes on its own". It offers `maxTurns` and `maxBudgetUsd`, and recommends setting a budget for production agents. | Spend budget |
| OpenAI Agents SDK | `max_turns` defaults to `DEFAULT_MAX_TURNS` (10). | Guardrails |
| OpenClaw | Heuristic loop detection plus whole-run timeouts. An explicit per-agent hard round budget is an open PR because some model/channel combinations kept calling tools after useful results. | Loop detection |

Sources:
- https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop
- https://github.com/NousResearch/hermes-agent/pull/72176
- https://github.com/badlogic/pi-mono/blob/f3a2c9d0/packages/agent/src/agent-loop.ts
- https://code.claude.com/docs/en/agent-sdk/agent-loop
- https://openai.github.io/openai-agents-python/ref/run/
- https://docs.openclaw.ai/tools/loop-detection
- https://github.com/openclaw/openclaw/pull/97485

## What the field agrees on

- The model decides when it's done.
- A cap is a safety budget, not a plan.
- The real protection is detecting loops and no progress.
- When the budget runs out, the agent should still answer with what it has.

## Waldo's choice

Code: `packages/runtime/src/conversation/tool-loop.ts`.

- A turn runs until the model answers.
- **Safety budget: 25 rounds per chat turn.** This is well above any chat task we have, and far below Hermes' 500. Hermes runs long coding tasks locally. Waldo answers in a Telegram chat, so long work belongs in scheduled or background runs (slice 2 onward), not in one reply.
- **Repeat refusal:** an identical call (same tool, same arguments) is refused with a note to use the earlier result.
- **No-progress stop:** after 3 rounds in a row where every call failed, tools are withdrawn.
- **Always ends in words:** once the budget or the no-progress stop withdraws tools, the model gets one more call with no tools and must answer with what it has. This matches Hermes' summary at 100%.
- Every call is still dispatched through the ACL, argument validation, taint gate and autonomy gate, and traced as its own Langfuse span.

## Warn-first and no-progress guards (2026-09-26, harness parity review)

Two guards join the cap and the failure withdrawal, chosen after comparing loop discipline
across mature open harnesses (Hermes agent, OpenClaw, LangGraph, OpenHands):

- WARN_WINDOW_ROUNDS = 5 (warn-first): results delivered once the remaining budget enters the
  last five rounds carry a `[budget: N tool rounds left this turn - wrap up and answer now]`
  notice, so the model closes in words before tools are withdrawn instead of hitting a silent
  hard stop. Precedent: Hermes injects budget warnings as ephemeral prompt layers; OpenClaw
  warns before it blocks.
- NO_PROGRESS_LIMIT = 3 (semantic no-progress): the same (tool, args, result) triple with only
  volatile spans (ISO timestamps, uuid-shaped ids, 20+ char token runs such as cursors/request
  ids) differing is counted across the turn; at three repeats the stabilized (tool, args) pair
  is refused pre-dispatch until a successful gated mutation lands, which opens a new state
  epoch and clears the block. Small integers (page numbers, amounts)
  survive stabilization, so legit pagination never trips it. Precedent: OpenClaw hashes tool
  outcomes with volatile fields stripped for its rolling-history detectors.

Kept as-is: TOOL_LOOP_MAX_ROUNDS (25, per chat turn - the same default LangGraph ships per graph
execution) and FAILED_ROUNDS_LIMIT (3).
