# Agent practice gaps, 1 Nov 2026

A ranked gap list that compares Waldo's harness at `beta-mvp` `b80f0f1ac` with primary vendor guidance from Anthropic and OpenAI and with four open agent harnesses. It is meant to drive the next day's work. It authorizes nothing. Docs only.

**How it was done.** Waldo's source was read at `b80f0f1ac`. Paths starting `src/` are under `packages/runtime/src/`. Vendor pages were read on 1 Nov 2026. Open-source code was read from shallow clones at the SHAs below. Nothing was run. Tags:

- `[inference]`: a conclusion that was not observed.
- `[docs]`: read in a repository's docs, not its code.

**What "today" means.** Staging is the only deployed backend. The production stand-up runbook (`docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md`) found no production Worker. Gaps that exist only in the production block of `packages/runtime/wrangler.jsonc:32` therefore rank low here. Staging's flags (`wrangler.jsonc:109`) are what testers use: the harness tool loader, app compaction, semantic recall, memory selection and the forget barrier are all on.

**Earlier work this builds on.**

- `docs/research/HARNESS_COMPARISON_2026-10-13.md`. Its §3.2 alarm gap is fixed: a failed pass now re-arms with backoff (`src/channels/owner-do.ts:2776-2798`).
- `docs/proposals/WALDO_HARNESS_REDESIGN_2026-10-30.md`, slices S0–S9 (#1684–#1688, #1700–#1702). Its claim that live trials lack the staging profile is stale; `packages/runtime/evals/nightly/config.ts:53-63` has it.
- `docs/proposals/WALDO_MEMORY_REDESIGN_2026-10-30.md` (#1691). Selection and semantic recall are already in source behind flags.

Items those documents already own are listed with their owner and are not re-proposed.

## References

| Source | Read |
|---|---|
| Anthropic tool use: define tools, handle tool calls, strict tool use, parallel tool use, tool search, programmatic tool calling, tool use with prompt caching | platform.claude.com/docs/en/agents-and-tools/tool-use/{define-tools, handle-tool-calls, strict-tool-use, parallel-tool-use, tool-search-tool, programmatic-tool-calling, tool-use-with-prompt-caching} |
| Anthropic context: prompt caching, context editing, threshold and on-demand compaction, memory tool | platform.claude.com/docs/en/build-with-claude/{prompt-caching, context-editing, compaction-threshold, compaction-on-demand}; …/tool-use/memory-tool |
| Anthropic engineering | anthropic.com/engineering/{building-effective-agents, writing-tools-for-agents, effective-context-engineering-for-ai-agents, effective-harnesses-for-long-running-agents, demystifying-evals-for-ai-agents} |
| Claude Agent SDK | code.claude.com/docs/en/agent-sdk/{agent-loop, permissions, hooks, subagents, sessions} |
| OpenAI | developers.openai.com/api/docs/guides/{function-calling, tools-tool-search, prompt-caching, conversation-state, compaction, background}; openai.github.io/openai-agents-python/{sessions, guardrails, handoffs, tracing}; cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf |
| letta-code (the live Letta harness; `letta-ai/letta` `main` is now a landing page) | github.com/letta-ai/letta-code @ `8b713fe8` |
| OpenHands software-agent-sdk | github.com/OpenHands/software-agent-sdk @ `98de8bf3` (paths under `openhands-sdk/openhands/sdk/`) |
| Hermes Agent (personal agent: memory, cron, multi-platform gateway) | github.com/NousResearch/hermes-agent @ `c419cf7c` |
| OpenClaw (personal assistant: multi-channel gateway, memory, proactive jobs) | github.com/openclaw/openclaw @ `dbc44d3b` |

## Where Waldo is already at parity or stronger

These are not gaps. They are listed so nobody re-proposes them.

- **Tool results are cleared within a turn, with the cache in mind.** Old results become a note that keeps the outcome and the stored id (`src/conversation/tool-loop.ts:79-99`). This matches Anthropic's `clear_tool_uses`, tuned from Waldo's own cost sweep.
- **Large outputs go to a store** that `read_tool_output` pages (`tool-loop.ts:14-27`, `src/tools/read-tool-output.ts`). This matches letta-code's overflow files (`src/tools/impl/overflow.ts:17`) and Hermes's spill budgets (`tools/budget_config.py:13-25`).
- **Typed errors carry a `fix` line** (`packages/contracts/src/core/error.ts:85-116`), as Anthropic's "instructive errors" advice asks.
- **Replay classes, intent-before-I/O and in-turn dedupe** (`src/tools/records.ts:24-35`, `tool-loop.ts:332-358`) are stricter than any of the four harnesses.
- **A memory flush runs before compaction** (`src/channels/owner-turn.ts:909-912`). It matches OpenClaw's flush (`extensions/memory-core/src/flush-plan.ts:48`) and Anthropic's advice to pair memory with compaction.
- **The per-turn suffix is frozen** (`owner-turn.ts:548-553`), the same idea as Hermes's frozen memory snapshot (`tools/memory_tool.py:1-5`).
- **One brain, ticketed workers.** A `TaskWorkerDO` holds a ticket and calls the brain for every tool (`src/tasks/worker-do.ts:15-21`). This is stricter on authority than Agent SDK subagents, which hold their own tools.
- **Missed recurring runs coalesce** (`src/scheduler/multiplexer.ts:229-253`), as Hermes does.
- **Proactive runs decide whether to speak**, by answering `SKIP` (`src/channels/day-cards.ts:478`). This matches Hermes `[SILENT]` (`cron/scheduler.py:559`) and OpenClaw's `heartbeat_respond` (`src/auto-reply/heartbeat.ts:12-19`).
- **An owner turn that no model can answer** gets a floor reply that promises a time, backed by a committed retry job (`owner-turn.ts:247-256`, `src/tasks/retry-turn.ts`). This is stronger than every reference.
- **Forget is enforced by barriers** (`src/context-composer/forget-barrier.ts`). None of the references has an equivalent.
- **Failed calls are metered** when the provider reports usage (`src/channels/billed-attempts.ts:6-14`).

## 1. Tool engineering

Waldo has 88 tool records in 11 namespaces, 15 of them core (`src/tools/records.ts:8-20, 82-188`). Schemas are zod `strictObject`, and the descriptions are hand-written with when and when-not guidance (`src/tools/live/memory.ts:81`, `src/tools/live/google.ts:423`). The harness loader offers the core tools plus `find_tools` and `use_tool`, with a catalogue of names in the system prompt (`src/tools/loader.ts:56-107`). Anthropic recommends keeping the three to five most-used tools loaded and finding the rest through search, so the cache holds. OpenAI's tool search groups functions into namespaces and can run the lookup on the client. Waldo's loader is that client-side shape on either provider.

The gaps are in what the model hears when a call goes wrong.

| # | Waldo now | Reference | Owner-visible impact | Size | Risk | Seam | Tracked |
|---|---|---|---|---|---|---|---|
| T1 | A direct call with bad arguments drops the zod issues and returns the generic `invalid_args` text, which names no field (`src/tools/dispatcher.ts:299-309`). The definition comes back only on `use_tool` calls (`tool-loop.ts:364-368`). | Anthropic handle-tool-calls: errors should say what to change. OpenHands sends the validation text back to the model (`agent/agent.py:831-841`). | A malformed reminder or calendar call costs another model round (about 6 s each) or ends as "couldn't do it". | S | Low. Send field paths and expected types, not values. | dispatcher `failDispatch`, `toolError` | none |
| T2 | No schema is sent strict: OpenAI uses `strict:false` unless tool search is on (`src/llm/openai.ts:219-222`), and Anthropic is never strict (`src/llm/anthropic.ts:276-279`). | Anthropic strict tool use: grammar-constrained, so inputs always match. OpenAI function calling: use strict whenever possible. | Fewer wasted rounds and fewer half-formed writes. | M | OpenAI refused the tool-search request shape on 26 Oct (`docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md:109`), so strict without search needs its own staging check. #1789 already makes every schema's root an object. | `src/llm/strict-schema.ts`, both adapters | none |
| T3 | Each deferred tool costs a `find_tools` round, and loaded definitions don't carry to the next turn (`owner-turn.ts:698`). Native tool search is built but off. | Anthropic tool search: keep the most-used tools loaded; discovered tools load inline, so the cache holds. | Errands that need mail, calendar or web tools wait an extra round on every turn. | S (left) | Low | `loader.ts` | S3 #1687, PR #1761 Ready |
| T4 | No per-tool timeout. "Started tools are never cut" (`src/llm/time-budget.ts:15-17`). | Agent SDK hooks: a `PreToolUse` hook that times out blocks the call. OpenClaw's tool errors carry timeout and `mutatingAction` metadata (`src/agents/tool-error-summary.ts`). | One hung MCP or browse read eats the 120 s turn, and the owner gets "I ran out of time" (`tool-loop.ts:68-72`). | S–M | Cut reads only (`safe_read`, `provider_idempotent`). Writes keep running, for honest terminal ambiguity. | dispatcher, keyed by replay class | none |
| T5 | 47 of 88 tools are `non_replayable_uncertain`, and 20 of those say their keys were never inspected (`records.ts:79`). | MCP annotations `readOnlyHint`, `destructiveHint` and `idempotentHint` (OpenHands `tool/tool.py:215`). OpenAI's practical guide rates each tool's risk. | An interrupted turn says "not sure it happened" when the tool could have safely re-run. | M | Misclassifying a write sends twice, so each record needs evidence. | `records.ts` | none |
| T6 | The only loop guard is the exact-repeat refusal (`tool-loop.ts:350-352`). | OpenHands `StuckDetector`: four patterns, a nudge and then a stop (`conversation/stuck_detector.py:27`, `conversation/impl/local_conversation.py:787`). OpenClaw `src/agents/tool-loop-detection.ts:57-59`. | The model cycles through near-identical searches until the time budget ends. | S | It must stay context, not a rule. Tell the model "N calls, nothing new"; the round and time budgets remain the only stop. | `tool-loop.ts` | none |

## 2. Context engineering

Each turn's system prompt is a cached head: behaviour, tool catalogue, skills, standing orders and identity (`src/prompt/messaging-behavior.ts:5-140`). Memory, recall, health, day cards and the clock ride a frozen suffix on the newest owner message (`src/prompt/turn-prompt.ts:52-75`, `owner-turn.ts:677-679`). History is a 100k-token drop-oldest window estimated at bytes/4 (`src/conversation/window.ts:31-61`). OpenAI, the primary, gets `store:false` and a per-owner `prompt_cache_key` (`openai.ts:80-93`). The Anthropic fallback has four 5-minute breakpoints (`anthropic.ts:149-171`).

This layout follows the advice to put stable content first and dynamic content last. The gaps are the cache lifetime, reasoning carry-over, and where outside words sit.

| # | Waldo now | Reference | Owner-visible impact | Size | Risk | Seam | Tracked |
|---|---|---|---|---|---|---|---|
| C1 | The OpenAI request sets no cache TTL and does not ask for `reasoning.encrypted_content` with `store:false` (`openai.ts:80-93`). `[inference]`: reasoning items may not survive between rounds. Anthropic thinking is deliberately never replayed (`anthropic.ts:25-28`). | OpenAI conversation state: stateless callers replay every output item, encrypted reasoning included. OpenAI prompt caching: `prompt_cache_options.ttl` is 30m or 12h. Anthropic: a 1h TTL for human-paced gaps. | `[inference]` Slower, costlier rounds in long errands, and a cold prefix after a pause. | S to verify, then S | Low. The 12h TTL costs 2.5× on writes, so decide from staging's `cache_write` data. | `openai.ts` request body | S7 #1700 (cache-miss diagnosis) |
| C2 | Words other people wrote ride the owner message in labelled blocks (`src/llm/owner-routes.ts:23-24`), not in tool results. | Anthropic handle-tool-calls: keep untrusted content in `tool_result` blocks, never in system or user text. | Defence in depth against injection in forwarded mail or messages. Effects are already gated by taint, so this protects the reply, not actions. | M | The cache layout changes. | `src/context-composer/source-sanitisation.ts`, `turn-prompt.ts` | none |
| C3 | The core prompt hard-codes an India site list (`messaging-behavior.ts:69`). | Anthropic context engineering: prompts at the right altitude, not a list of special cases. CLAUDE.md: market rails are per-market adapters. | Owners outside India pay tokens for this list and are steered by it. | S | Low. The cohort is in India, so the owner should rule on it. | a market skill | none |

Compaction off the app is §5's S1.

## 3. Memory

The model writes memory with `remember` (add or correct, grounded in a verbatim owner quote) and `forget_memory` (`src/tools/live/memory.ts:41-212`). A nightly pass on the auxiliary model curates the pinned blocks (`owner-turn.ts:1039-1046`, `src/memory/claims.ts:1304-1387`). Supersession keeps history (`claims.ts:598-623`). This is model judgment with provenance checks, and it is stricter than any reference. The gaps are curation speed and recall reach.

| # | Waldo now | Reference | Owner-visible impact | Size | Risk | Seam | Tracked |
|---|---|---|---|---|---|---|---|
| M1 | In a turn the model cannot pin, confirm or dismiss. Pins apply only from the nightly pass (`claims.ts:1588-1596`). | Anthropic memory tool: the model edits its memory in-turn. Hermes `memory` add/patch/remove with consolidate-on-full (`tools/memory_tool.py:373`, `tools/memory_tool_store.py:129`). letta-code's reflection runs on a step count (`src/reflection-settings.ts:1`). | "Always remember: no meetings before 9" is not pinned until the night, and may fall out of recall that day. | M | The pinned budget. The writer is still `OwnerDO`. | `memory.ts` tool, the `claims.ts` op set | memory lane (#1691 family; #1782 is mail and calendar only) |
| M2 | Episodes are lexical only. The semantic leg covers claims, with an uncalibrated cosine floor of 0.5 (`src/memory/semantic-recall.ts:12-31`, `src/channels/episodes.ts:46-54`). | Anthropic context engineering: hybrid just-in-time retrieval. OpenClaw `memory_search` is semantic (`extensions/memory-core/src/memory-tool-contract.ts:92-130`). | "What did I say about my knee last month?" misses a paraphrase in chat history. | M | Cost and privacy notice (O1 is already approved). | `semantic-recall.ts` | memory redesign O1 |
| M3 | `statedReading` uses a regex on digits to decide which health claims leave the pinned block (`claims.ts:1202`). | CLAUDE.md: no fixed rule for a judgment call. | Low | S | Keep `numericHealthReadings` (`src/scribe/sanitiser.ts:265-267`), which is a privacy boundary. `statedReading` is prompt placement. | `claims.ts` | file under `post-mvp-cleanup` |
| M4 | Dedupe is exact text only, with no merge or decay (`memory.ts:106`). | Hermes bounded memory forces consolidation. letta-code reflection fixes mistakes first (`src/agent/subagents/builtin/reflection-v2.md:37`). | Recall crowds over months. Low for this cohort. | M | Low | nightly pass | entities #1717 (partial) |

## 4. Proactivity and scheduling

The model decides whether and what to send for day cards, check-backs, update sweeps and health wakes (`day-cards.ts:478`, `src/channels/update-sweep.ts:157-256`, `src/health/trigger.ts:533-556`). Owner settings gate it (`src/channels/proactive-gate.ts:16-25`). That matches the references. The gaps are what happens when the model is down or late.

| # | Waldo now | Reference | Owner-visible impact | Size | Risk | Seam | Tracked |
|---|---|---|---|---|---|---|---|
| P1 | A reminder needs a live model call. A throw is retried at 30 s and quarantined for 24 h after three tries (`owner-do.ts:4562-4571`, `multiplexer.ts:24-27`). Only day cards wait for the model (`multiplexer.ts:269-273`). | Waldo's own owner-turn floor (`owner-routes.ts:39`). OpenClaw keeps partial work through failover [docs] (`docs/concepts/model-failover.md`). | "Remind me at 6 to take my meds": a two-minute provider outage means no reminder, only a failure notice. This is the most trust-breaking failure a PA can have. | S | Low. The floor sends the owner's own note verbatim. It adds no judgment and no health numbers. | reminder executor in `owner-do.ts`, `src/channels/check-back.ts` | fallback lane (not in #1789) |
| P2 | A one-shot reminder fires late without saying so: "Reminder due now" (`check-back.ts:20-23`, `multiplexer.ts:571`). | Hermes's catch-up window [docs] (`cron/AGENTS.md`). Anthropic effective agents: give the model the environment's ground truth. | A reminder that fires 5 h late after an outage still says "due now" ("leave for the airport"). | S | None. The model judges, given the set time, the due time and the current time. | `check-back.ts` | none |
| P3 | Fixed numbers decide staleness and cooldowns: Brief stale at noon, a 4 h re-notify, 30 min update expiry (`day-cards.ts:260-267`, `src/channels/heartbeat.ts:32`, `update-sweep.ts:25`). | CLAUDE.md judgment rule. OpenClaw's model sets `notify` (`heartbeat.ts:12-19`). | A late Brief is dropped when it would still help. | S each | Give the model the age; don't swap in new thresholds. | per path | file under `post-mvp-cleanup` |
| P4 | Quiet hours default to none (`src/channels/loops.ts:13`). | No external reference; this is product judgment. | A nudge can land at 2 a.m. | S | Ask at onboarding. A sleep-derived window may only be offered as an owner-confirmed setting, never applied implicitly. | onboarding settings | none |
| P5 | A machine job with no model for an hour is dropped, with only a log hop (`src/tasks/machine.ts:120-128`). | OpenClaw records non-fatal failures and can announce them (`src/config/schema.help.agents.ts:178`). | A "your 3 pm moved" card never arrives, and no record says why. | S | Low | `machine.ts` | none |

The health wake gate (`src/health/wakes.ts:27`) belongs to the health-coaching A1 lane.

## 5. Multi-surface continuity

The code says each surface keeps its own transcript (`src/context-composer/owner-turn.ts:41-43`).

| # | Waldo now | Reference | Owner-visible impact | Size | Risk | Seam | Tracked |
|---|---|---|---|---|---|---|---|
| S1 | WhatsApp is on the legacy `conv:*` store (`owner-do.ts:4372`, `src/channels/conversation-store.ts:36-62`). That store cannot compact (`owner-turn.ts:886-888`), so the pre-compaction memory flush never runs and old turns drop off the 100k window unsaved. The app does not list WhatsApp rows (`src/channels/app-api.ts:348`). `[inference]`: WhatsApp turns get no composer context host (`owner-do.ts:4315`). | OpenClaw: one main session for the owner's DMs across channels, with explicit identity links (`src/routing/session-key.ts:179-238`). Anthropic pairs compaction with memory. | The owner talks on WhatsApp, opens the app, and Waldo there doesn't know. Early WhatsApp details vanish without a memory flush. | M first step, L whole | Medium. A store move needs a migration and rollback. | First S9 step: put WhatsApp on the canonical store as iMessage already is (`owner-do.ts:4433`), with compaction settings | S9 #1702; after #1783 lands |
| S2 | iMessage history is never episode-indexed (`owner-do.ts:4433` against `:4372`, `:4427`), so the Brief, the Close and `search_episodes` miss it. | Hermes mirrors deliveries into the target session (`gateway/mirror.py:36`). | iMessage talk is absent from the day's cards. | S | Low | wrap with `indexedConversationStore` | parked (iMessage parked 31 Oct) |

## 6. Evals and observability

There are about 110 scenarios (`packages/runtime/evals/nightly/gate.ts:27-30`). PRs run recorded mode, which grades nothing (`config.ts:69`). Live judged runs go nightly and weekly with an independent judge (`judge.ts:33-37`, `live-plan.ts:19-22`). Langfuse carries cache read and write tokens, `fallback_fired` and per-tool latency (`src/observability/otlp-turns.ts:80-190`, `owner-turn.ts:701`).

| # | Waldo now | Reference | Owner-visible impact | Size | Risk | Seam | Tracked |
|---|---|---|---|---|---|---|---|
| E1 | Live runs skip without secrets and have no pass-rate floor (`.github/workflows/evals-live.yml:49-61`, `gate.ts:24-26`). There are no WhatsApp scenarios, no fault-injected fallback or reminder-under-outage cases, and no compaction-recall eval. | Anthropic "Demystifying evals": pass^k for consistency, 20–50 tasks from real failures, regression evals near 100%. Hermes `evals/compaction/` checks recall after compaction. OpenClaw has a personal benchmark pack [docs] (reminder round-trip, no-fake-progress). | Regressions on WhatsApp and outage paths reach testers before anyone sees them. | M | Live cost, already capped. | `evals/nightly/*` | S0 #1684 (profile and subset). These cases are new. |
| E2 | Online quality signal is thumbs only (`src/observability/langfuse-scores.ts:68`). | Anthropic evals: read transcripts and calibrate model graders against human spot checks. | Silent quality drift. | M | Trace text is staging-only, by ruling. | Langfuse scores | none |
| E3 | Billed but aborted streams can report no usage (`openai.ts:155,161`, `anthropic.ts:134`). Unpriced models count as $0 (`src/observability/cost-rollup.ts:49`). There is no spend ceiling while the ledger is off (`owner-do.ts:4334-4336`), which is the production block. | Agent SDK: `max_budget_usd` is a sensible production default. | Cost truth only; no tester impact on staging. | S | Low | `cost-rollup.ts`, `provider.ts` | S1 #1685, w1-cost-truth lane |

## 7. Failure and fallback

`complete()` is the one retry owner. The fallback is Anthropic, there is a per-owner breaker, and owner turns get the floor reply (`src/llm/provider.ts:357-431`, `owner-routes.ts:50-61`). #1789 sends a fallback-side 400 to the floor.

| # | Waldo now | Reference | Owner-visible impact | Size | Risk | Seam | Tracked |
|---|---|---|---|---|---|---|---|
| F1 | A 400 from the first provider still ends the turn as a plain error, with no retry promise (`provider.ts:600-602`, `owner-turn.ts:363-365`). | Hermes maps each of about 30 failure classes to a recovery: strip and retry, compress, or fall back (`agent/error_classifier.py:34`). | Rare. The owner gets "did not finish" and nothing comes later. | S | One extra paid attempt | `provider.ts` | fallback lane |
| F2 | The breaker is per owner and in memory (`owner-do.ts:572`). | `[inference]` Shared health state is common practice; none of the four harnesses shares it across tenants either. | Each owner's first messages in an outage wait out full timeouts. | M | Low | provider health | none |

## Top 10, by owner value per unit of effort

| Rank | Gap | Why here | Size | Owner seam |
|---|---|---|---|---|
| 1 | P1: a reminder floor when no model answers | A missed medication or call reminder is the worst trust failure, and the fix sends the owner's own words. | S | reminder executor, fallback lane |
| 2 | P2: lateness in the reminder text | One line of facts, and the model judges what to say. It pairs with P1. | S | `check-back.ts` |
| 3 | T1: bad-argument errors name the field, with the definition returned on direct calls | It saves a model round on the most common tool failure. | S | `dispatcher.ts` |
| 4 | S1: WhatsApp on the canonical store | The owner's focus surface gets app visibility, compaction and the memory flush. | M | S9 #1702, after #1783 |
| 5 | T6: a no-progress note in the tool loop | It stops two-minute thrash ending in "ran out of time". | S | `tool-loop.ts` |
| 6 | T4: a per-tool timeout for reads only | One hung connector read no longer costs the turn. | S–M | `dispatcher.ts` |
| 7 | T3: loader carry-over | It is already built (#1761); merge and measure. | S | #1761 |
| 8 | C1: verify reasoning carry-over and the cache TTL on OpenAI | A cheap check that could cut latency on every long errand. | S | `openai.ts`, S7 #1700 |
| 9 | E1: WhatsApp, outage and compaction-recall scenarios, with a pass^k floor on the live subset | It catches regressions in 1–6 before testers do. | M | `evals/nightly`, S0 #1684 |
| 10 | T2: strict schemas without tool search | It removes a class of malformed calls. It needs its own staging check. | M | `strict-schema.ts` |

Next in line: M1 (in-turn pin), P5, C3, T5, C2, M2, P4, S2, E2, P3, M3, F1, E3, M4, F2.

## Do not copy

Waldo's constraints are deliberately stricter in these places.

- **Memory as freely editable files.** Examples are the Anthropic memory tool's raw `create`, `str_replace` and `delete`, letta-code's MemFS, and OpenClaw's markdown files. Waldo needs grounded claims, supersession, forget barriers and one writer (`OwnerDO`). Take the verbs (M1), not the storage.
- **Provider-side compaction.** Anthropic's `compact_20260112` and on-demand `compaction`, and OpenAI's `context_management`, return an opaque summary. That bypasses the memory flush hook and the refusal of numeric health in summaries (`owner-turn.ts:924`). Keep compaction in Waldo's own job.
- **Provider-held state.** This covers `store:true`, `previous_response_id` and the Conversations API, which keeps objects past 30 days. CLAUDE.md says a provider request must not ask the provider to retain it. Keep `store:false`.
- **Regex judgment layers.** Hermes's pattern scan on memory writes (`tools/memory_tool_store.py:29`) and the regex rung in OpenAI's guardrail stack are fixed rules for a judgment call. Waldo uses provenance (`ground()`) and taint instead.
- **A weighted promotion formula.** OpenClaw scores what becomes long-term memory with fixed weights (`extensions/memory-core/src/short-term-promotion.ts:30`). That is a judgment call; it stays with the model.
- **Collapsing every DM into one session.** OpenClaw's `dmScope=main` merges everyone who DMs the agent. Waldo collapses only the owner's own surfaces (S9). Trusted Relationships never share memory.
- **Tracing with sensitive data on by default.** The Agents SDK sets `trace_include_sensitive_data=True` and swallows processor errors, so a redactor processor can fail open. Waldo's production text capture is off in code (`src/observability/trace-privacy.ts:101-102`).
- **Guardrails that run beside the agent.** The Agents SDK's default input guardrails can let tools run before a tripwire fires. Waldo's gates run before dispatch.
- **Programmatic tool calling for effect tools.** It is not ZDR-eligible, and scripts call tools in parallel outside per-call approval sequencing.
- **Iteration budgets in the hundreds.** OpenHands and Hermes allow 500 iterations. Waldo bounds a turn by time (25–150 rounds, `time-budget.ts:38-39`), which is right for a chat surface.
- **Unrestricted tools on proactive runs.** Waldo's proactive jobs run as externally tainted, with reads plus `propose_action` (`src/channels/check-back.ts:8-16`). Keep that.

## Unverified

- Whether OpenAI drops reasoning between rounds (C1) is `[inference]`. Check it on staging traces before building anything.
- That WhatsApp turns have no composer context host (S1) is `[inference]` from the `channel === 'telegram'` gate at `owner-do.ts:4315`.
- Vendor rows were partly read through a summarizing fetch. The numbers (TTLs, multipliers, defaults) should be re-read on the page before any build relies on them.
- The four open harnesses were read, not run. OpenClaw's compaction and failover rows are [docs].
