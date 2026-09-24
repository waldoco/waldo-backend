# Waldo: caching, session and context design (token-efficiency companion)

24 September 2026. Companion to the token-efficiency packet. Sources inline; measurements from the repo harness (test-rendered, bytes/4 tokens).

## Measured baseline (repo-rendered)

- Instructions: 1,218 tokens flat per hop with empty memory (behavior prompt + tool roster line). Resent on every hop and every tool-loop round.
- Owner memory: 1,319 tokens for a realistic 30-claim store (seeded measurement, test/memory-size.test.ts). Realistic instructions total: ~2.5k tokens per hop before history.
- History: no windowing; grows linearly (~26 tokens/turn on short messages; real turns are longer).
- Tool roster: the full handler set is offered every round of every turn.

## What strong production agents do (primary sources)

**OpenAI Responses API - conversation state** (https://developers.openai.com/api/docs/guides/conversation-state)
- Two ways to carry state: replay the full output array (encrypted reasoning items included), or chain with previous_response_id (requires store: true, i.e. server-side retention).
- Replaying reasoning items lets the model continue from its prior reasoning instead of re-deriving it. Models with persisted reasoning can render prior reasoning forward via reasoning.context.
- Waldo fit: output-item replay, NOT previous_response_id. Server-side stored state conflicts with Waldo's privacy posture; encrypted-item replay keeps state client-side (DO storage).

**Anthropic prompt caching** (https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Cache prefix order: tools, then system, then messages. Explicit cache_control breakpoints or automatic mode (breakpoint on the last cacheable block, moves forward as history grows).
- 5-minute default TTL; 1-hour TTL at extra cost. Volatile content must live AFTER the last breakpoint.
- Waldo fit: Waldo is on OpenAI today, where caching is automatic above 1,024 tokens with prefix matching + prompt_cache_key affinity (shipped as TE2, cfaab4c). The Anthropic lesson that transfers: put volatile content last, keep the prefix byte-stable.

**Claude Code context engineering** (https://code.claude.com/docs/en/context-window, https://code.claude.com/docs/en/memory)
- Stable prefix = system prompt + memory files; everything stable reloads from disk after compaction rather than being re-summarized.
- Compaction summarizes message history but re-injects stable layers verbatim - the cached prefix survives compaction.
- Subagents hold large reads in their own context; only summaries return. (Waldo equivalent: tool outputs to files with on-demand reads.)
- /context gives a live per-category token breakdown. (Waldo equivalent shipped: /usage.)

## Cache-aware memory design (which layer rides the prefix)

Ordered most-stable-first, matching how the prefix should be built:

1. Behavior prompt (static across owners and turns) - already first.
2. Owner profile + claims CONTENT (changes only when memory is written, i.e. nightly or on extraction).
3. Constellation nodes/edges (same write cadence as claims).
4. Churning metadata OUT of the prefix: claim seen_count and last_seen_at change on re-observation without changing what Waldo knows. Today they are inlined in every claim line (memoryPrompt), which breaks the prefix exactly when nothing substantive changed. Move them to a per-claim suffix the model can ask for, or drop from the prompt entirely (they are bookkeeping, not knowledge).
5. Session-volatile context (time, day plan state, pending loops, tool results): never in the prefix; in messages, after it.

Load-on-demand: full claim evidence quotes, episode search results, document bodies. The prefix carries the compressed identity; tools fetch depth.

## Session and context design across surfaces

Surfaces: Telegram today, console and WhatsApp next. Design rules:

- One conversation tree per owner, not per surface. Cross-surface continuation works when the tree is the unit and the surface is an attribute of each entry (already the shape: ConversationEntry carries surface + threadAnchorId). Cross-verification = the tree is the single history every surface reads; no per-surface transcripts to reconcile.
- Prefix cache key is per owner (shipped, TE2: waldo:<owner-ref>), so a Telegram turn and a console turn from the same owner hit the same cached prefix.
- Compaction, when added, must follow the Claude Code rule: summarize message history, re-inject stable layers verbatim, never let the summarizer rewrite the behavior or memory layers.

## Designs for the two remaining safe changes

**TE3 - large tool outputs to files.** Today capToolOutput truncates at 16k chars with "narrow the request" (tool-loop.ts:8) - information is destroyed and the trap the brief warns about. Design: outputs over the limit are stored (DO sqlite, keyed by id); the model sees a head slice plus a reference; a new read tool fetches ranges on demand. Cost: new tool name in the contracts enum + per-trigger permission entry (the roster comment warns order/count are contract, ADR-0021), so this lands as its own slice with an ADR note. Flag: WALDO_TOOL_OFFLOAD.

**Reasoning-item passback.** Today every tool-loop round re-reasons from scratch: the adapter extracts text + function calls and discards reasoning items (openai.ts). Design: the adapter returns the response output items; the loop replays them into the next round's input ahead of the tool results. Rejected alternative: previous_response_id chaining (requires store: true, server-side retention - conflicts with Waldo's data posture). Contract change: optional output-items field on the response schema. No quality risk per OpenAI's guidance; it is their recommended pattern.

## Ranked opportunities (feeds the 5-section report)

1. DONE - cache affinity per owner (cfaab4c). Expected effect: instruction prefix (~2.5k tokens with memory) reads at 0.1x on hops 2..N within cache TTL.
2. Reasoning-item passback (design above): removes re-reasoning across rounds; also cuts latency per round.
3. TE3 tool-output offload (design above): removes the 16k truncation trap and caps worst-case tool-round cost.
4. Volatile fields out of memoryPrompt (seen_count, last_seen_at): makes the prefix stable across turns, raising cache-hit rate between turns, not just within them.
5. History windowing or compaction: quality-sensitive; propose with the Claude Code compaction rules above, flag-gated, measured on evals before any default.
6. Per-turn tool roster (offer only relevant defs): routing-adjacent, proposal only.

## What was deliberately not adopted

- previous_response_id / server-side conversation state (OpenAI): conflicts with client-side-state posture.
- 1-hour Anthropic TTL and Anthropic breakpoints: different provider; noted for the roster's future Anthropic route.
- Aggressive history truncation: quality risk without eval cover; evals run first.
