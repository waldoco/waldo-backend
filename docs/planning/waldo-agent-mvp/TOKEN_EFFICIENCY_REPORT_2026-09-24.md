# Token efficiency: harness map, baseline, changes, test plan, gaps (2026-09-24)

Packet: lower price-weighted token cost per completed task, no measurable quality drop, measured per task. Owner additions folded in: KV-cache utilization first-class, cache-aware memory + session design, production-technique research (CACHE_SESSION_CONTEXT_DESIGN_2026-09-24.md is the companion).

## 1. Harness map and baseline

Request path: telegram update -> createTelegramResponder (channels/telegram-turn.ts) -> JoinedConversationPath (history + tool ACL only) -> runToolLoop (max 25 steps, 3-strike failure cutoff, identical-call refusal) -> complete() -> RuntimeLLMProvider (policy + sanitiser + fallback) -> OpenAIResponsesAdapter (Responses API; instructions=system; reasoning effort low).

Map correction found during the work: the context-composer's composed prompt (REASONS canvas) does NOT reach the chat model call today; the chat path builds its own system = messaging behavior + memoryPrompt. The composer output is used elsewhere in the runtime. Flagged, not changed.

History: ConversationTree.modelContext walks the full root-to-leaf path; per-entry include/omit/replace projection; no windowing. Tool turns replay as function_call/function_call_output items.

Baseline (repo-rendered harness, fixture invocation, bytes/4 tokens):
- instructions: 1,218 tokens flat per hop with empty memory; +1,319 for a realistic 30-claim memory (test/memory-size.test.ts) = ~2.5k per hop realistic, resent every hop and every tool-loop round.
- history: 18 -> 146 tokens over 6 short turns; linear, unwindowed.
- tool roster: full handler set offered every round (user_message has lazy discovery via search_tools, ADR-0034).
- dispatcher result bound: 16,384 JSON chars; previously a hard failure ('result_oversize').

Cost shape (verified prices: nano $0.05/$0.005/$0.40, mini $0.25/$0.025/$2.00 per 1M in/cached/out): on nano, a 5-hop turn at ~2.5k instructions costs ~$0.0006 of instruction reads uncached, ~$0.00006 cached. The instruction prefix dominates repeated cost; output tokens dominate price per token (8x input). Live per-hop cost by model/billing type is now measurable via /usage (TE1).

## 2. Ranked changes (estimate, quality risk, validation, rollback)

| # | Change | Estimate | Quality risk | Validation | Rollback |
|---|--------|----------|--------------|-----------|----------|
| 1 | Cache affinity per owner (shipped cfaab4c) | instruction prefix at 0.1x on hops 2..N within TTL | none (routing hint only) | adapter + full-path tests; /usage cached share | revert commit |
| 2 | Reasoning-item passback (shipped db55804) | removes re-reasoning per round; latency down | none per OpenAI guidance; replay is their stateless pattern | adapter replay + dedupe tests | revert commit |
| 3 | Tool-output offload (shipped 91ae8a2, flag-gated) | worst-case tool round capped; oversize no longer hard-fails | low; flag off = legacy | offload suite; staging run with flag | env flag off |
| 4 | Volatile fields out of memoryPrompt (seen_count, last_seen_at) | makes prefix stable across turns; cross-turn cache hits | low-moderate: model loses recency signals | evals before/after; flag | flag off |
| 5 | History windowing/compaction | unbounded-history cost capped | moderate: recall of early turns | evals + judgment cases; flag | flag off |
| 6 | Per-turn tool roster | tool schema tokens per round | moderate: missing tool discovery | evals; flag | flag off |

Items 4-6 are proposals; brief rules put them behind owner/eval gates. 1-3 are the brief's direct changes and are shipped.

## 3. Changes made (with prompt-level diffs and reasons)

- 01b7a0e telemetry: trace_log gains model/input/output/cached/cost columns (ALTER migration), per-hop request shape (system_bytes, request_bytes), /usage owner command. No prompt change. Reason: measure first, per the brief.
- cfaab4c cache affinity: contracts llmRequestSchema gains optional cache_key; adapter sets prompt_cache_key; responder keys waldo:<owner-ref>. No prompt text change. Reason: OpenAI caches by prefix + affinity key; per-owner key is their documented granularity.
- db55804 + 6c0edc7 reasoning passback: llmToolTurnSchema gains prior_items; llmResponseSchema gains output_items; adapter replays prior items verbatim and dedupes function_call by call_id; the loop attaches output items to the next round's first turn. previous_response_id deliberately rejected (requires store:true, server-side retention - conflicts with the data posture).
- 91ae8a2 tool-output offload (flag WALDO_TOOL_OFFLOAD):
  - Dispatcher oversize path: rewrite. Was: hard fail 'tool result exceeded bound'. Now, flag on: store full output, return { stored_output, total_chars, head 4k chars, read_with }. Reason: the dispatcher bound, not the loop cap, was the real trap; a hard failure is worse than truncation.
  - capToolOutput: keep legacy 16k cut message when no store (flag off). When on: 4k head + "[full output stored as <id>: N characters total; call read_tool_output with this id, offset and length to read more]". Reason: the model needs an actionable reference, not a dead end.
  - messagingSystemPrompt tool list: gains read_tool_output only when the flag is on. Reason: the prompt must not advertise a tool the dispatcher cannot run.
  - New read_tool_output handler: ranges over stored outputs; unknown id -> not_found with a plain error.
- Not changed, deliberately: reasoning effort (low) and max_tokens (4096) - model-mix/effort changes are proposal-class. memoryPrompt volatile fields - item 4 above, needs eval cover.

## 4. Test plan for flagged changes

WALDO_TOOL_OFFLOAD (the only flag shipped):
- Done: unit tests (store round-trip, legacy path unchanged, dispatcher offload path, loop threading, ACL drift consistency); contracts ACL/enum guards updated; prompt-builder snapshot and composer hash refreshed for the new roster.
- Before default-on: (a) staging with WALDO_TOOL_OFFLOAD=1, a real turn that produces >16k tool output (e.g. a wide episode search), confirm the reference appears and read_tool_output pages it; (b) /usage before/after on comparable tasks; (c) W7 eval suite with flag on vs off - no score drop allowed; (d) injection case W7.1 with flag on (a hostile oversized page must not reach the model raw - the stored output still passes the sanitiser on read).

## 5. Gaps

- Real-data validation pending owner keys (Supabase, Google, search, ElevenLabs, mini/luna enablement). All baselines above are repo-rendered; /usage turns them into live numbers on the next real turns.
- Model A/B (nano vs mini/luna) blocked on project enablement; per the brief, no model switch without numbers.
- The map correction (composer output not reaching the chat path) deserves a product decision: intended or gap.
- previous_response_id, Anthropic-style explicit breakpoints, server-side state: rejected for posture/provider reasons; revisit if the roster adds Anthropic.
- Trusted-path dispatcher (line ~557) has its own oversize bound; offload there is a follow-up if trusted runs produce big outputs.
