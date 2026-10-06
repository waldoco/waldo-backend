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

## Design principles

- The model decides when it's done.
- A cap is a safety budget, not a plan.
- Finite resource budgets bound repeated work; usefulness is a model judgment.
- When the budget runs out, the agent should still answer with what it has.

## Waldo's current controls

Code: `packages/runtime/src/conversation/tool-loop.ts`.

- A turn runs until the model answers or its hard resources are exhausted. The owner chat caller supplies a 25-round local/shared budget; children spend the same shared object. The loop accepts the caller's `maxSteps`, so a child can have a smaller local cap.
- **Transient read recovery:** an identical non-mutating read that returns `code: transient` may dispatch again while round/shared budget and run authority remain. There is no additional per-read attempt cap. Every retry passes the dispatcher again and returns its actual typed outcome.
- **Settled exact-call protection:** successful identical reads are refused with the earlier-result notice; nonretryable failures are returned from cache with an explicit no-new-execution notice. Exact mutation calls are never re-executed, including after a transient or ambiguous failure. A successful mutation opens a new read epoch without clearing mutation replay protection.
- **Distinct identities:** dates, UUIDs, target IDs, cursors and revisions retain their bytes. Empty or repeated-looking results do not establish semantic no-progress. Failure counts never withdraw unrelated healthy tools.
- **Hard exhaustion:** the local/shared round cap withdraws tools. The model receives a final no-tools closing step; tool calls returned by that step cannot dispatch. `onSettle` reports `budget_exhausted` instead of completion. If the model returns no closing text, the loop supplies an honest exhaustion notice.
- **Empty authority ceiling:** when the handler set starts empty and budget remains, an illegal call receives one refusal-only round and one closing step. The refusal consumes shared round budget and performs no handler I/O. Repeated illegal requests cannot continue the loop or extend an exhausted budget.
- **Run fences:** `runScope.admit()` checks remain before and after model/handler awaits. Deadline, cancellation and closed-run authority can stop recovery despite remaining rounds. Provider token enforcement remains outside this loop and is unchanged.
- Dispatch still enforces authentication, ACLs, argument schemas, taint and approval gates. Output caps and final artifact-receipt guards remain in place.

## Warn-first budget notices

`WARN_WINDOW_ROUNDS = 5`. For local caps larger than that window, results carry the smaller of remaining local/shared rounds once it enters the final five rounds. The last result explicitly says the budget is exhausted. Tiny local fixture caps remain notice-free, but retain the same hard stop.

The former three-failed-round withdrawal and semantic no-progress normalization are removed. They could block distinct Calendar windows or a healthy recovery tool while budget remained. Read recovery uses the existing finite budgets rather than a replacement three-attempt rule.

`LoopExit` retains `withdrawn` for compatibility with the existing subagent consumer. This implementation emits `completed` when the model closes with resources available, or `budget_exhausted` when the hard round cap is reached; failures alone do not emit `withdrawn`. Neither exit certifies that the owner's task is complete: callers must preserve actual tool outcomes and partial-answer uncertainty.
