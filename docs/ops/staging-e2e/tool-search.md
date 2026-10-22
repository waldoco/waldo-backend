# Staging E2E: tool search

Flag: `WALDO_TOOL_SEARCH` in `packages/runtime/wrangler.jsonc`. Staging is `on`; production is `off`.

Rollback: set staging to `"off"` and redeploy. Every round then sends the full tool menu again. Nothing stored changes.

## What should change

With search on, a reply round sends about a dozen core tools. Every other tool sits behind the provider's tool search, by namespace.

Measured by `test/brain-tool-surface.test.ts` (`BRAIN_TOOL_SURFACE`), at about 4 UTF-8 bytes per token:

| Menu | Tool-definition tokens per reply round |
| --- | --- |
| Off (54 tools) | ~14,190 |
| On, as OpenAI sees it | ~3,410 |
| On, as Anthropic sees it | ~3,450 |
| On, OpenAI, after loading the calendar namespace | ~5,140 |

The trace's `tools_tokens_est` counts the whole menu, deferred tools included, so it does not fall. The figure that falls is the provider's **input tokens per reply call**.

## Steps

Run as the owner, after the staging deploy that carries the flip. Note the deploy time as `T`.

1. **Baseline.** Before `T`, record the median input tokens per reply generation over the last 24 hours. Read it from Langfuse (staging project, generations named for the chat model). If the cost ledger is on, `scripts/cost-report.mjs` gives the same figure (#1417); keep its JSON for `--baseline`.
2. **A core-tool turn.** In the app: "what's on my calendar tomorrow?" Expect a normal answer. In the trace, the reply generation's input tokens are well under the baseline median. The trace metadata has no `tool_search_degraded`.
3. **A searched-tool turn.** In the app, ask for something only a namespaced tool does, such as "draft a reply to the last email from my manager", or one of the owner's standing-order tools. Expect it to work. In the trace, the model's first call searches (OpenAI shows a `tool_search` call; Anthropic shows a `tool_search_tool_bm25` server-tool use), then the tool runs.
4. **A turn on another surface.** Repeat step 2 on WhatsApp and on Telegram. Same expectations.
5. **After 24 hours.** Record the same median as step 1 for the hours after `T`. Expect it well below the baseline; the definitions alone account for about 10,000 tokens per round.
6. **Degrades.** Count traces after `T` with `tool_search_degraded: true`. Each one fell back to the full menu after the provider refused a shape. A few are tolerable; a steady rate means a tool shape to fix.

## Pass and fail

**Pass:** steps 2 to 4 answer correctly; step 5's median is clearly lower than step 1's; step 6 has no steady degrade rate.

**Fail:** a turn that needed a namespaced tool answered without it, or a step-6 degrade on most turns. On a fail, set the flag off and copy the trace ids into the PR.
