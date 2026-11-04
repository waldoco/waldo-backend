# Token-efficiency pass - groundwork, 2026-09-24

Owner brief: lower price-weighted token cost per completed task, no measurable quality drop, measured per task not per request. Order: map + measure baseline first (telemetry goes in first), rank opportunities, safe changes direct in revertible commits, prompt/tool/compaction changes behind flags, model-mix changes as proposals only.

This doc is the no-repo-access part: OpenAI caching behavior and current prices from primary docs, and the telemetry design. Phase 1 (mapping the actual harness) needs the repo and is queued behind the gh device login.

## 1. OpenAI prompt caching (primary: developers.openai.com/api/docs/guides/prompt-caching)

Current models in the roster are gpt-5 family (nano, mini). gpt-5.6-luna is the candidate alternative. The caching rules differ between the families, and the difference is load-bearing for a model switch.

gpt-5 family (what Waldo runs today):
- Automatic, no code changes, no cache-write fee. Enabled for prompts of 1024 tokens or longer.
- Hits require an exact prefix match. Static content (instructions, tools) first, variable content last. Tools must be byte-identical across requests or they invalidate the prefix.
- On a miss, the service falls back to the longest matching unmarked prefix.
- Hits are reported in usage as input_tokens_details.cached_tokens (Waldo's usage plumbing already reads this field - the eval judge uses it).
- prompt_cache_key improves routing to a warm machine; keep under about 15 requests/min per key. Per-owner or per-session keys are far under that at Waldo's scale.

gpt-5.6 family (luna, the A/B candidate):
- Cache writes cost 1.25x the uncached input rate. Reads are the cheap cached-input rate.
- Implicit breakpoint goes at the latest user or tool message, and there is NO fallback to a longest unmarked prefix. Consequence: if the implicit breakpoint lands after changing content (timestamps, tool history), cached_tokens can be 0 on every request and the changing prefix gets re-written to cache at 1.25x. A naive nano-to-luna switch can cost more per request even at lower list prices.
- To cache the stable prefix: explicit prompt_cache_breakpoint at the end of it, the same prompt_cache_key across requests, and prompt_cache_options.mode="explicit" so the changing suffix never incurs writes.
- Breakpoint TTL: 30 minutes, currently the only supported value. Up to 4 new writes per request; up to 50 breakpoints read.
- Diagnostics: prompt_cache_options.comparison_response_id measures a request against a baseline response's prefix.

## 2. Current prices (primary: developers.openai.com pricing page and model pages, 2026-09-24)

Per 1M tokens, standard processing, short context:

| Model | Input | Cached input | Cache writes | Output |
|---|---|---|---|---|
| gpt-5-nano (current) | $0.05 | $0.005 | free | $0.40 |
| gpt-5-mini (in roster, not routed) | $0.25 | $0.025 | free | $2.00 |
| gpt-5.6-luna (candidate) | $0.20 | $0.02 | $0.25 | $1.20 |

Read: luna input is 4x nano but half of mini; luna output is 3x nano. Any model switch is a proposal per the brief, and the caching-semantics change above must be in the A/B numbers, not just list prices. A task's price-weighted cost is dominated by whichever of (uncached input, cached input, output) the harness shape produces most - which is exactly what the telemetry has to measure.

## 3. Telemetry design (goes in first, per the brief's sequencing)

Hook point: the runtime already logs every hop with a trace id, duration, ok/failed and detail, and TurnLogEntry already carries usage {input, output} - the eval runner aggregates it into dollars today via modelCost(). The gap is per-task, per-billing-type persistence.

What to add (one new table, no behavior change):

- usage_events: trace id, hop, model, input tokens, cached input tokens, output tokens, (cache_write tokens once a 5.6 model exists), computed usd, wall ms, and request-shape facts: system prompt bytes/version, tool definition count/bytes, conversation turns sent, memory block bytes.
- A task is a trace root (a turn, a card, a fetch cycle). Per-task cost = sum over its hops, split by billing type. That is the brief's unit: per completed task, not per request.
- Rollup view: per task type (chat turn, brief card, update card, fetch, day plan) x model: p50/p90 of price-weighted cost, cache hit rate (cached / (cached + uncached input)), output share.

Baseline report (first deliverable after telemetry lands): the harness map (what each request assembles: system prompt, tools, memory, conversation window, per surface) joined to the rollup above. Every later change gets judged against it, with the eval suite as the quality gate (no measurable quality drop = W7 suite does not regress; it already runs the real responder, so it sees prompt changes).

Why the shape facts matter: the brief's own warning is that a change shrinking each request can add turns and cost more. Recording turns-per-task alongside per-request tokens is what catches that.

## 4. Opportunities the mapping will rank (hypotheses, not findings)

- Cache layout: verify the assembled prompt puts static instructions and tools first and anything time/varying last; on gpt-5 models a stable 1024+ token prefix is free money at 1/10 input price.
- Static vs discoverable context: anything in the system prompt that most turns do not need is a per-turn tax on every request of every task.
- Tool definitions: they ride every request and must stay byte-identical; trimming or offloading them cuts uncached input on every turn.
- Compaction/retrieval: how much conversation rides each turn is unmapped until phase 1.
- Model mix (proposal only): nano vs mini vs luna per surface, priced with the caching rules of section 1.

## 5. Blocked on

- gh device login (repo access): phase 1 mapping and the telemetry commit both need it. This is now the critical path for two workstreams.
- Model A/B: still needs mini or luna enabled on the OpenAI project (owner).

## Sources

- Prompt caching behavior, breakpoints, TTL, cache-write pricing: https://developers.openai.com/api/docs/guides/prompt-caching
- Prices: https://developers.openai.com/api/docs/pricing and https://developers.openai.com/api/docs/models/gpt-5-nano and https://developers.openai.com/api/docs/models/gpt-5-mini
