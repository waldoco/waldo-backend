# Model-agnostic tool loading and turn efficiency

Status: candidate design with a first slice behind `WALDO_TOOL_LOADER` (default `off` in both environments). It is not authority to flip staging or production; that is an owner/gate call.

## Problem

Measured on staging e223d0d and a74a9d9 (26 Oct), one owner question ("inbox needing reply + calendar this week"):

- 51.7 s and 70.6 s, 5 and 6 reply rounds on `gpt-6.1-sol`.
- Input per round 27k–46k tokens. Round 1 was fully uncached; later rounds cached about all of the round before.
- Every round logged `tool_search_degraded`. Since #1573 the rejection reads `OpenAI request failed (400 tools)`: status 400, param `tools`, no code. Each round sent the tool-search shape, got the 400, then resent with every tool up front (`llm/provider.ts` ~559). That is two requests per round and about 14.6k tool tokens per round instead of about 3.4k.
- Tool hops ran one at a time (`parallel_batches: 1` on every hop). Mail was searched 4–5 times, `read_thread` ran up to 6 times, and calendar ran 4 times. That adds up to about 33 s of tool time.

The owner wants loading that is model- and provider-agnostic, because we will route between OpenAI, Anthropic and cheaper models. Tokens per question must fall. A minute is acceptable only for a detailed answer.

## Decision: the harness owns tool search

A round offers a small fixed core plus two meta tools. The provider-hosted search becomes an optional optimisation, used only where it is proven to work.

| Piece | What it is |
| --- | --- |
| Core | Tools with `brain: 'core'` in `tools/records.ts` (12 on an owner with Google). These are the same tools hosted search loads up front. |
| `find_tools({groups?, names?})` | Returns the full `{name, description, parameters}` of the named tools as tool-result text, plus `not_found`. It reads nothing about the owner and is `source_taint: null`. |
| `use_tool({name, arguments})` | The loop rewrites this call into the call it names, with the same `call_id`, before anything else reads the call. |
| Catalogue | One system-prompt line per group: the exact names this turn admitted, then that group's `BRAIN_NAMESPACES` line. |

Why this shape:

- **Stable cache prefix.** The tools array is the same bytes every round of a turn, and across turns while eligibility is unchanged (tested). Loaded definitions arrive at the end of the context as tool results. Both providers document the same reason for their own designs: OpenAI injects loaded tools "at the end of the context window" so the cache is preserved, and Anthropic says "the prefix is untouched, so prompt caching is preserved".
- **Works on any model that calls functions.** It needs no `namespace`, no `defer_loading` and no server tool. The 400 that staging hits today cannot happen on this path.
- **Selection is the model's call.** It picks from a named catalogue, and the harness only returns the definitions it asked for. There is no keyword matcher and no regex ranking.
- **Why the catalogue is in the system prompt.** A tool `description` is capped at 1,024 characters by `llmToolSchema` (contracts). The catalogue is about 2.7 KB and is part of the stable system head.

Mature practice this follows:

- Anthropic tool search (`defer_loading`, `tool_reference`) and its documented custom client-side search ([docs](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool)). Anthropic also recommends "a system prompt section describing available tool categories" and keeping the most used tools non-deferred.
- OpenAI's tool search ([guide](https://developers.openai.com/api/docs/guides/tools-tool-search)): namespaces with fewer than 10 functions, and `execution: "client"` for a search the application runs.
- Claude Code's deferred tools, listed by name with a search that returns schemas. [inference: from the harness running this session, not from a published spec]
- langgraph-bigtool-style retrieval, where the agent retrieves tools from a registry. [inference: not re-read from its repository for this note]

Neither provider's client-side search is provider-agnostic: Anthropic's returns `tool_reference` blocks and OpenAI's returns `tool_search_output`. `use_tool` is the portable equivalent. Its cost is that the inner arguments are not constrained by the provider's strict decoding. The dispatcher's Zod parse validates them. A schema miss through `use_tool` returns the tool's definition with the error, so the next call can be right.

## Safety: `use_tool` is the tool itself

`runToolLoop` (`conversation/tool-loop.ts`) routes every call before any per-call logic runs. The following all key on the inner name:

- repeat refusal;
- mutation tracking;
- concurrent-read batching;
- browse withholding;
- receipts;
- the `use_mac` exit;
- `onTool` and `onToolStart`;
- `dispatchTool`: ACL, held tools (spend ceiling), the approval token, the PreToolUse taint law, `proposal_only`, and schema parse.

The provider history keeps the outer `use_tool` call, so it matches the tools array. Whatever reads a recorded turn by its tool resolves the call through `toolOfCall` (`tools/loader.ts`), which accepts only a real tool name:

- In the provider (`llm/provider.ts`), the tool is resolved once per turn, by position, from the calls as the model made them. External-origin taint, the `[external data from …]` label, batch taint, health withholding, the owner-health hiding beside outside content, reduction and omission receipts all read that position. So a turn the scribe rebuilt with stripped arguments keeps its tool. A rebuilt `use_tool` call keeps `{"name": <tool>}`.
- The forget barrier's origin and `forget_memory` exemption (`context-composer/forget-barrier.ts`).
- The loop's notes for cleared and no-longer-shown results.

`LLMToolTurn` is unchanged. Only admitted handlers are catalogued and callable. The admitted set is what is left after eligibility, the owner-only, probe-strip and background filters (`EGRESS_READ_TOOLS` and outside-text jobs included). Any other name inside `use_tool` is refused `unknown_tool` and the call stays `use_tool`. That covers meta tools, respellings and free text, so the model's text never names a hop, a span, a receipt or a ledger row. `find_tools` events produce no receipt and no earlier-result row.

Tests that prove it:

- `test/tool-loader.test.ts`: on a tainted turn, `use_tool(set_proactivity)` returns the same `taint_needs_approval` result as the direct call, and the handler never runs. Also covered: an owner-only tool that was not admitted, a repeat across direct and routed calls, malformed calls, and a schema miss.
- `test/harness-tool-loader-owner-turn.test.ts`: the same hostile case on the real owner object, where a hosted web search taints the turn and the stored proactivity does not change.

Unverified:

- Whether every provider accepts a replayed call to a name outside the tools array. This happens when a model calls a deferred tool directly. The loop dispatches it, because the gates apply either way, and the existing unknown-name path already replays such calls.
- The loader runs wherever the owner object's `runToolLoop` runs: the owner's reply and machine jobs (reminders, jobs, cards), not only the owner's turn. That is safe because the loader is built from the turn's already-filtered handlers (`owner-turn.ts` ~403). A test shows a job without egress reads cannot reach them through `use_tool` or `find_tools`. Subagent (`runChildLoop`) and task-worker loops keep their own menus.

## Measured, first slice

From `test/harness-tool-loader-owner-turn.test.ts` (`HARNESS_TOOL_SURFACE`), for an owner with every Google feature connected, at about 4 bytes per token:

| | Tool tokens per round |
| --- | --- |
| Full menu (56 tools), what staging actually sends after the 400 | ~14,570 |
| Harness, OpenAI wire (12 core + 2 meta) | ~3,670 |
| Harness, Anthropic wire | ~3,560 |
| Catalogue and line added to the system prompt (cached, once per turn) | ~690 |

The net cut is about 10,200 tokens per round, and the 400-and-resend request disappears. A `find_tools` result costs its definitions once, in the turn that asks for them.

Trade-off: a turn that needs a deferred tool pays one `find_tools` round (about 3–8 s on staging), unless the model gets the arguments right from the catalogue and calls `use_tool` straight away. Loaded definitions do not carry into the next turn. The staging probe called `get_communication`, which is deferred (`mail`), so that exact question gets about one round longer under `harness` unless it moves into core. That costs its definition against the 4,000-token cap. Which tools are core is a gate decision.

Under `harness` the behaviour text gains the catalogue without a `VOICE_VERSION` bump, so cache-share comparisons by voice version mix the two modes. Compare by the flag.

## Round-1 cache miss: what the code shows

- **Order.** Anthropic caches tools, then system, then messages. OpenAI caches "the model's rendered context including … tool definitions" and does not document the order. With `instructions` and `tools`, nothing per turn sits ahead of the newest owner message.
- **Probe.** The new test drives two consecutive app turns on the real `OwnerDO`. It checks the OpenAI and Anthropic wire bodies, under the full menu, the staging degraded shape and the harness loader. Tools and `instructions`/`system` are byte-identical, and turn 2's `input` opens with turn 1's words as the owner wrote them. The clock, recall, receipts and health ride after the newest words (`owner-turn.ts` `turnSuffix`). The earlier responder-level test (`owner-turn-cross-turn-prefix.test.ts`) agrees.
- **Conclusion.** No local dynamic content early in the prefix was found, so no code fix is made here.

Remaining candidates. All are [inference] and need trace evidence: the previous turn's time, surface and model.

1. **Surface switch.** The tool list differs by channel: `progressNoteTools` and `attachTools` sit mid-array in `owner-do.ts` ~3916. `surfacePresentation` also sits inside the system head (`messaging-behavior.ts` `messagingSystemPrompt`). An iMessage turn followed by an app turn shares only the leading tools. A fix needs per-surface text moved after the stable head and a `VOICE_VERSION` decision. That is a gate call.
2. **Route.** The OpenAI docs say a key "influence[s] routing; [it does] not pin requests to a machine". Before GPT-5.6 they advise about 15 requests per minute per key. `cache_key` `waldo:<owner>` (`owner-turn.ts:189`) is shared by side calls with other prefixes (memory writer, titles, reactions). The 400-then-resend doubles the reply requests.
3. **Retention.** For pre-5.6 models the documented in-memory retention is "5 to 10 minutes of inactivity". For 5.6 and later the docs give a 30-minute minimum (12 h in Responses). Which tier `gpt-6.1-sol` gets on our route is unverified. If a turn more than about 10 minutes after the last one is the pattern, ask the gate about `prompt_cache_retention` or `prompt_cache_options.ttl`. Those are provider parameters to verify against that model first.
4. **Model.** The previous turn may have been answered by another model or provider (fallback, or the spend clamp). Caches are per model.

## Hosted tool search on our route

Staging's 400 names `tools` as a whole. `functionTools()` (`llm/openai.ts` 214–236) emits `{type:'namespace', name, description, tools:[functions with defer_loading]}` and `{type:'tool_search'}`. That matches the guide's documented shapes as read on 26 Oct. The guide also allows top-level deferred functions and requires gpt-5.4 or later in Responses.

The mismatch is therefore not visible from the docs. [inference] Candidates are support for `gpt-6.1-sol` (or the gateway route) or the hosted `web_search` alongside. The harness path does not depend on the answer.

If hosted search is kept anywhere, have the provider remember a `tools` 400 for the rest of the turn instead of re-sending the rejected shape every round. That alone halves requests on the live `on` path. It is design only, not built.

## Too many rounds (design only, not built)

The probe's six rounds were mostly re-reads.

1. **One question-shaped mail read.** For example, `mail_awaiting_reply({since, limit})`: threads where the newest message is not from the owner and is addressed to them, each with its last message's sender, subject, date and a bounded snippet, all from one Gmail query plus a thread metadata batch. This replaces search → read_thread ×N.
   - Whether a thread *needs* a reply stays the model's judgment. The tool returns facts (who spoke last, whether the owner is in To), never a priority verdict.
   - It is `source_taint: 'external'` and a safe read.
2. **Run independent reads in parallel.** The Google reads are `concurrent: false`, because their client stamps probe and health state across awaits (`records.ts`). Making that state per-call, or serialising only the stamp, would let one round's calendar and mail reads run together.
3. **Calendar over a span in one call.** `query_calendar` over a date range across all calendars would replace the four per-day or per-calendar calls.
4. **A budget hint the model reads.** Keep the existing round notes. Do not add a fixed round cap: when to stop is the model's judgment.

Expected effect [inference]: about 2–3 rounds for this question, about 15 s less tool time, and no repeated thread reads.

## Rollback and flags

- `WALDO_TOOL_LOADER=harness` turns the loader on, and it wins over `WALDO_TOOL_SEARCH`.
- `off`, or unset, is the rollback: the turn goes back to the full menu, or to hosted search if that flag is `on`. Nothing stored changes.
- `WALDO_LOADER_CARRY=1`, with the harness loader, appends to the next owner message the definitions of the deferred tools the owner's previous turn used or loaded (`carriedToolBlock`, `src/tools/loader.ts`). It rides the message, never the offered list or the system prompt, so the cached prefix is unchanged, and the offered list plus the block stay within 4,200 estimated tokens: the offered list is about 3,700, so the block holds roughly 400 tokens, a few small tools. A turn that read outside text, or a tool no longer admitted, carries nothing. The record is in the owner object's memory; losing it costs one `find_tools` round. `0` or unset is the rollback.

Open owner/gate decisions:

- a staging trial of `harness`;
- whether hosted search stays anywhere at all;
- the surface-presentation placement;
- cache retention parameters;
- building `mail_awaiting_reply` and per-call Google client state.
