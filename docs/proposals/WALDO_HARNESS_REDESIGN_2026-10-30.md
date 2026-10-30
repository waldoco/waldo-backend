# Harness redesign proposal, 30 Oct 2026

Design only. This document changes no runtime code, flag, deploy or migration. It is a candidate. The owner approves it before any slice is built, and each slice is then built under its own issue and gate review.

- **Baseline:** `beta-mvp` at `7e6bce8a` (merge of #1683). All file:line citations are at that SHA.
- **Written:** 2026-10-30, starting 06:25Z (`date -u`).
- **Tags:** [verified] means read in source at the baseline or observed in a command. [inference] means concluded but not observed. [proposed] means a design choice or number this document puts forward. [blocked] means evidence I could not get, with the reason.
- **Citations:** a script printed every cited `file:line` at the baseline and I checked each one against its claim. That includes the citations that came from two read-only subagent audits.
- **Companion:** the memory-redesign session designs memory selection. It owns the memory-selection interface. This document states only what the harness needs from that interface (§Seam).

## Owner direction (30 Oct, relayed by the orchestrator)

- Waldo behaves like a real personal assistant. It watches the day and acts ahead of the owner.
- If a meeting moves two hours after the Brief, Waldo knows. It updates the day card, the app, notifications, chat and the console. The same holds for any Google Workspace or connector change.
- Messages from iMessage and other channels appear in one main chat thread, in the app and in the console.
- Nothing is rigid. The model reasons about what matters. Prompt caching and spend discipline still hold.
- The owner called the earlier recommendations "good". They stand as approved unless a decision below changes them.

This adds §E (trace), §F (day working state, slice S8) and §G (one main thread, slice S9).

## Owner decisions, with recommendations

**Status: all 13 approved as recommended.** Source: the owner, 30 Oct, in chat, relayed by the orchestrator.

These still need the owner's own separate action:
- placing the Langfuse key (decision 3), which the owner saves themselves;
- each staging flag flip, as a named deploy;
- the #1463 data-agreement answer (decision 11).

Approving the design starts no build. Each slice still goes through its issue and the gate.

| # | Decision | Recommendation | Why |
|---|---|---|---|
| 1 | Land `evals-live.yml` on `main` (S0). GitHub runs and dispatches workflows only from the default branch, where it is 404 today. | **Yes.** Same as the dispatch-only precedents `7296c718d` and `46f21fd76`. | No slice can be measured without it. |
| 2 | Live eval spend (S0) | **Yes**, with two parts: (a) the live-judged subset runs nightly, capped at about 600 calls; (b) the full 3-trial run (cap 4,000, `evals-live.yml:71`) moves to weekly. | Daily signal on what S8/S9 change, at about a seventh of the full run's cost. The numbers are provisional. |
| 3 | Langfuse read access | **Yes.** Add one project-scoped Langfuse secret key to the orchestrator's local `.env`, the file that already holds the public key. Never in the repo, prompts or logs. Design sessions get read-only exports through the orchestrator. | S1, S3–S5 and S7 are all gated on trace data. The 30 Oct cache check could only be done by reading the UI by hand. |
| 4 | Cost-ledger write column (S1) | **Yes.** An additive migration with default 0, through the reviewed-migration lane. | The ledger can't separate write cost today. |
| 5 | Router (S6) | **Defer.** Build on #1639 only when the S6 thresholds are met. Adding Sol/Opus as a tier and the Decisions egress each need their own yes later. | No per-turn data shows a saving yet. |
| 6 | Core tool promotion (S3) | **No promotion now.** Decide per tool from S0's data. | Promotion costs cached bytes on every round. |
| 7 | Compaction beyond the app (S4) | **Fold it into S9.** Once every surface writes the one main chain, that chain's existing compaction covers them, if the job is triggered from every drain. Before S9, no separate iMessage compaction. | Avoids building per-surface compaction twice. |
| 8 | **New.** A delivered day card can be **revised**: Waldo writes a new revision, shown as "updated HH:MM" in the app and console. On surfaces that can't edit, Waldo sends an update message. | **Yes.** | The owner's meeting example. The original card stays in history; nothing is rewritten in place. |
| 9 | **New.** A phone notification for a change the model judges worth interrupting for. It is a new push kind, `update`, an additive app.v1 contract change whose revision the gate allocates. Quiet hours and the owner's volume preference still hold. | **Yes.** | Today no push fires for an update (`expo-push.ts:8-11`). |
| 10 | **New.** Remove the fixed "after the Close, hold every update until tomorrow" rule (`owner-do.ts:4921`). The model judges whether a change after the Close matters, such as tomorrow's 08:00 meeting moving. | **Yes.** Quiet hours and volume stay, because they are owner preferences, not judgments. | `CLAUDE.md`: no fixed rules for judgment calls. |
| 11 | **New.** One main thread: build #1544's "one timeline" design as S9, behind `WALDO_ONE_TIMELINE`. | **Yes**, but iMessage cutover waits on #1463's data-agreement answer, or on #1544's host-set health marker. Recommend also answering #1463. | Owner direction. The design exists and needs no new store. |
| 12 | **New.** An owner-approved two-call Luna probe, if S7's digests show identical prefixes and the misses continue | **Yes**, capped at $0.01. | It settles whether caching is happening on the provider side. |
| 13 | **New.** Change detection on MCP connectors | **Defer.** Calendar and Gmail changes already come through the REST Google grant. MCP servers have no push, and polling them costs model-free API calls with no clear owner value yet. Revisit if an owner connects a connector that has no REST path. | Today MCP is read only inside turns (`tools/live/mcp.ts`). |

## Summary

Ranked by owner value, after the 30 Oct direction:

1. **S0**: measurement for everything else.
2. **S8**: the day keeps up.
3. **S9**: one main thread.
4. **S7**: cache-miss diagnosis.
5. **S1**: cost truth.
6. **S2**: small; any time.
7. **S3**, **S5**, **S6**: data-gated.

S4 folds into S9.

| Slice | What | Cited failure | Gate to start |
|---|---|---|---|
| **S8** | Day working state: model-judged updates to the card, app, push, chat and console | A moved meeting never changes the delivered Brief. No push fires. After the Close, updates wait until tomorrow (§E). | S0 + decisions 8–10 |
| **S9** | One main thread (#1544's design) | Each surface has its own chain. Telegram and WhatsApp are invisible in the app and console. The app shows iMessage rows the model doesn't share (§G). | Decision 11 (and #1463 for iMessage) |
| **S0** | Eval parity: staging profile, live-judged subset, per-scenario cost and round metrics | Live suite never ran. Recorded mode grades nothing. Eval config differs from staging in 6 settings. | Owner decisions 1–2 |
| **S1** | Cost truth: write tokens in the ledger, failed-call spend, per-model attribution, clamp | Ledger has no write column. Failed attempts drop billed tokens. Fallback reprices earlier attempts. | Decision 4 for the migration half |
| **S2** | `read_tool_output` handle naming | Results say `stored_output`; the tool's strict schema takes only `id` | None (smallest) |
| **S3** | Loader carry-over | Definitions are not carried to the next turn; a deferred-tool turn pays a `find_tools` round, about 3–8 s on staging | S0 metrics + threshold |
| **S4** | Compaction beyond the app (iMessage first) | No trace yet. The mechanism is verified: a plain window that slides once full re-bills the history every turn. | Folded into S9 (decision 7) |
| **S5** | In-turn tool results | No change. Modelled only; needs write-billing data. | ≥7 days of write data + instrumentation |
| **S6** | Router (#1639) | No per-turn cache data exists yet. | S0 + S1 + decision 5 |
| **S7** | Diagnose prompt-cache misses | The first round of each Terra chat turn is uncached (about 36k tokens); Luna jobs never cache. Langfuse metadata, read by the orchestrator. | None for the measurement; P0 for any fix |

Dropped from the 776489078 audit after re-checking at `7e6bce8a`:

- **Serial Google reads.** No longer true: `query_calendar`, `get_communication`, `search_communication` and `read_thread` are `concurrent: true` (`tools/records.ts:96-100`) [verified].
- **Tool list order.** Fixed by #1680 and #1683 [verified, merged].

Every path below is under `packages/runtime/` unless it starts with `packages/`, `supabase/`, `.github/` or `docs/`.

## Step 1: re-baseline at 7e6bce8a

| Audit gap | Status at 7e6bce8a | Where |
|---|---|---|
| Compaction covers app threads only | **Confirmed, with a sharper split.** See below. | `src/channels/owner-do.ts:4292`, `:4298`, `:4181`, `:1957-1964` |
| Loader costs extra rounds; nothing carries over | **Confirmed.** History between turns holds only user and assistant text. `find_tools` results are kept out of the next turn's earlier results on purpose. | `packages/contracts/src/runtime/conversation-entry.ts:167-172`; `src/channels/owner-turn.ts:673-679` |
| About 160k characters of tool results within a turn | **Confirmed as a constant. Cost question only.** | `src/conversation/tool-loop.ts:85` (`TOOL_RESULTS_KEEP_CHARS = 160_000`), `:90` (`COLD_CACHE_KEEP_ROUNDS = 3`) |
| Evals don't match staging | **Confirmed, and worse than listed.** The live suite has never run. | §S0 |
| Monthly ceiling prices writes; check the rollup | **Prices are right on successful calls. The rollup has gaps.** | §S1 |
| `stored_output` vs `id` | **Confirmed. It is not specific to browse.** The generic offload result uses the same name. | `src/tools/dispatcher.ts:910`, `:954`; `src/channels/cloudflare-public-read.ts:230`; `packages/contracts/src/tools/schemas/reads.ts:353-357` |

How compaction differs by surface [verified]:

- **App:**
  - The history is the canonical store with `compactionSettings(this.env)` (`owner-do.ts:4292`).
  - The compaction job `compactApp` runs only from the app inbox drain (`owner-do.ts:1957`). It returns early unless `WALDO_COMPACTION=on` (`:1964`).
- **iMessage:**
  - The history is the canonical store with no settings, so it falls back to the default `COMPACTION` with `enabled: false` (`owner-do.ts:4298`; `src/conversation/compaction.ts:8-9`).
  - No compaction job is triggered from the iMessage drain.
- **Telegram:**
  - `telegramContext` has a `contextHost` but no `history` factory (`owner-do.ts:4181-4199`).
  - The responder therefore reads the legacy `store` (`src/channels/owner-turn.ts:171`).
- **WhatsApp:**
  - It runs `this.turn(update, 'whatsapp', …)` (`owner-do.ts:2092`).
  - `telegramContext` is defined only for `channel === 'telegram'` (`:4181`), so WhatsApp has no context host and no history factory. It gets the legacy store too.
- **Every non-app surface:** the model sees `windowModelMessages` over a 100k-token budget (`src/conversation/window.ts:27`, `:43-60`).
  - That window keeps the newest messages and drops the oldest.
  - It logs a `context_window` hop only when something is dropped (`owner-turn.ts:362-365`).

## Step 2: evidence

### Cache writes on staging: P0 passed

**Evidence.** The orchestrator read this in the Langfuse UI. It is staging, `llm_reply`, release `7e6bce8aa`, trace key `app-8000000000006`: one app turn on gpt-6.1-terra over 3 rounds. Metadata only; no content was read.

| Round | Uncached input | Cached | Cache write | Total cost |
|---|---|---|---|---|
| 1 | 3 | 0 | 16,729 | $0.02110 (the write alone is $0.02091) |
| 2 | — | 16,729 | 795 | $0.00370 |
| 3 | — | 17,524 | 3,230 | $0.00594 |

What it shows:

- **[verified by the orchestrator]**
  - Langfuse records writes as `input_cache_write_tokens` in usage details and `cache_write` in cost details.
  - Uncached input stays at 3, never negative. So OpenAI's `input_tokens` includes the written tokens, as #1681 assumed (`pricing.ts:26`), and S1's clamp is defensive only.
- **[inference] Economics.** Writing 16,729 tokens cost $0.0209. Leaving them uncached would have cost $0.0167, about 25% less.
  - A write pays back only when it is read again. Each read saves $0.95 per 1M against uncached input.
  - Break-even: about 26% of the written tokens read once. Round 2 alone paid it back here.
  - The same arithmetic drives S3 (carried definitions), S7 (first-round misses and the retention option) and S8 (keep the change text in the suffix).

**Before P0 passed** (kept for the record):

- I could not confirm `cache_write > 0` on a real staging turn.
  - The Langfuse web UI showed a sign-in page in the built-in browser, and I did not sign in.
  - No Langfuse keys are present in this checkout or environment.
- Before 06:38Z, I asked the orchestrator whether it can read one `llm_reply` usage block from after 05:29Z. It could not check either (no Langfuse secret key), and asked the owner to.
- What the code shows [verified]:
  - Both adapters read write tokens:
    - OpenAI: `input_tokens_details.cache_write_tokens`, through a cast because SDK 5.12.2 lacks the field (`src/llm/openai.ts:246-249`).
    - Anthropic: `cache_creation_input_tokens` (`src/llm/anthropic.ts:85-101`).
  - The per-call log carries `cache_write` (`owner-turn.ts:342-343`).
  - The cost function prices it at the write rate (`src/llm/pricing.ts:27-37`).
- **Check for the gate** (read-only):
  - In the Langfuse UI, open any `llm_reply` generation on the staging environment that started after 2026-10-30T05:29Z, and read its usage details for `cache_write`.
  - For a count, export the generations and count those with `cache_write > 0`, by model.
  - `scripts/cost-report.mjs` at this SHA can't do this: it never reads `cache_write`, and its windows are whole days.
- **Precondition P0 for every cost-driven slice** (S1's per-attempt half, S3's B, S4, S5's follow-ups, S6): one staging `llm_reply` usage block after 05:29Z on 30 Oct shows `cache_write > 0`. **Passed 30 Oct.** See the evidence above.
- **Every threshold number in this document is provisional.** That covers each percentage, character size and day count. They are set again once P0 holds and there are at least 7 days of write data.

### The cost rollup, end to end

**What works** [verified]:
- The monthly total is DO KV `cost_month_usd` (`src/observability/cost-rollup.ts:107-118`).
- It uses the same `modelCost(usage).total` (`cost-rollup.ts:49`), so writes are in `usd`.
- It is written by the owner DO's `log` sink only when `WALDO_COST_LEDGER_SYNC=on` (`owner-do.ts:3414`, `:3442`). Staging sets it on (`wrangler.jsonc:109`).
- The cap is checked before calls (`src/llm/provider.ts:469`, `:1507-1511`).

**Gaps.** I verified items 1–4 in source. Items 5–6 were found by a read-only subagent; I spot-checked the cited lines, but they need the slice's own red test.

1. **The ledger cannot show write tokens.** `CostRollupRow` has no write field (`cost-rollup.ts:9-13`), and `waldo.cost_ledger_daily` has no column for it (`supabase/migrations/20261020120000_waldo_cost_ledger.sql:6-22`). Writes exist only inside `usd_estimate`, so the durable record can't separate write cost from input cost.
2. **A failed call logs no usage.** On `!result.ok` the hop has no `usage` (`owner-turn.ts:337`). Tokens billed by attempts before the failure never reach the month.
3. **Fallback reprices earlier attempts.** `usage: { ...usage, ...addTokens(usage, spent) }` (`provider.ts:658`) folds a failed Terra attempt's tokens into the usage of the model that answered (for example Sonnet). Those tokens are then priced at Sonnet's rates.
4. **No clamp on uncached input.** `input - cached - cache_write` is not clamped at 0 (`pricing.ts:30`). The comment at `:26` assumes OpenAI's `input_tokens` includes the written tokens, and only the fixture at `test/openai.test.ts:69` encodes that.
   - If the assumption is wrong, uncached input goes negative.
   - A negative row would then violate `usd_estimate >= 0` (`migration:19`), and the batch could be dropped after retries [inference].
5. **Unpriced paths count as $0** [inference, unconfirmed]: the embedder, transcription, and Gemma (`cost-rollup.ts:49`, `?? 0`).
6. **Side jobs check stale spend.** `turnSpend` is refreshed only in `converse()` (`owner-turn.ts:691`, `:788`). Nightly memory, welcome and compaction calls check whatever was last set [inference].

**Tests.** `test/owner-turn-spend-ceiling.test.ts` checks writes up to the log entry. No test drives writes through `costRollup.record` into the month total.

### The router, draft #1639

Head `3e005f12`, draft, not wired, no flag [verified via `gh pr view`].

- **What it holds:**
  - `routeTurn`, a pure, sticky, escalate-only tier choice (`light`/`standard`/`deep` → Luna/Terra/Sol);
  - a Decisions adapter: one `POST /v1/decisions` answered by Luna, which sends the last 4 turns, redacts health numbers, and returns `null` on every failure;
  - a Sol→Opus fallback route;
  - `scripts/cost-report.mjs --turns`.
- **What its own body says is missing:**
  - no per-turn measurement has run, because Langfuse credentials weren't available;
  - the Decisions request and response shape comes from unpinned `openai-node` master source;
  - no labelled set, no threshold tuning, no security review and no A/B.

**Decision for this design: defer, and build on it later rather than replace it.**

- **Why defer:**
  - Its saving case needs per-turn cold-cache data, which nobody has measured.
  - Its `light` tier fires only when Terra's cache is cold. OpenAI's TTL is a 30-minute minimum, so that window may be narrow [inference].
  - Quality per tier can't be measured until S0 exists.
- **Why build on it rather than replace it:**
  - The policy is pure, tested, and already escalate-only, which protects the per-model cache.
  - The owner already chose a Decisions router on 27 Oct.

See §S6 for the action threshold.

## Seam with memory-redesign

**Placement, corrected.** `ContextComposer` and the owner turn consume memory in two places. Neither is in the system prompt [verified]:

- **The pinned memory block** is a `sized` part:
  - built at `owner-turn.ts:613`;
  - placed into `turnContext` by `assembleTurnPrompt` (`src/prompt/turn-prompt.ts:60-66`);
  - appended to the newest owner message as the frozen per-turn suffix (`owner-turn.ts:625-655`).
- **Per-message recall** is `RECALL_MAX_CHARS = 3_000` (`src/memory/turn-recall.ts:10`), in the same suffix (`owner-turn.ts:586`, `:626`).

What this placement means:

- **Cost.** The suffix is not kept in history for the next turn. So memory bytes are paid once per turn as uncached input, then read from cache on every later round of that turn.
- **Caching.** Memory changing between turns does not break the cached prefix.
- **Size.** The pinned block's room is `system_prompt.max_chars` (400,000) minus everything else minus 2,048 (`owner-turn.ts:694`). In practice that means it has no budget.

What the harness needs from the memory-selection interface. memory-redesign owns the inputs, ranking and how each budget is spent.

| # | Need | Why | Number |
|---|---|---|---|
| M1 | An explicit character budget for the pinned block (`core`), passed in by the harness as `room.core`. It is a hard cap, never derived from leftover system-prompt room. | It is uncached input on every turn and has no limit today | ≤ 5,200 characters (agreed with memory-redesign: profile 1,500 + facts 2,500 + constellation 1,200) |
| M2 | An explicit character budget for per-message recall (`recalled`) | Same reason | ≤ 3,000 (the existing constant). Total 8,200. |
| M3 | Deterministic output for the same view, message and `revision`: stable order, no wall-clock text | S0 evals compare runs | — |
| M4 | Bounded latency through `deadlineMs`, degrading to empty recall plus a bounded logged hop (leg and code only), never a failed turn | Selection runs before the first model call | Lexical path p95 ≤ 250 ms (`deadlineMs` 250). The semantic leg (one embed call, 1.5 s, fail-open) only while `MEMORY_SEMANTIC_RECALL` is on, which staging has off, and only after an S0 run shows it helps. |
| M5 | One interface for every surface (app, iMessage, Telegram, WhatsApp) and for jobs. The compaction flush keeps `SpanMemory` (`compaction.ts:45-50`). | S4 extends compaction beyond the app | — |
| M6 | Output stays `owner_store` parts that pass `applyForgetBarrier`. No numeric health. | Forget barrier and ADR-0081 | — |
| M7 | Bounded metrics: characters emitted per block, and whether the budget was hit (yes/no). No content, no IDs as labels. | Attribute per-turn input cost | — |

**Scenario plug-in.** Memory scenarios join the S0 suite as follows:

- Spread a new array into `NIGHTLY_SCENARIOS` (`evals/nightly/catalogue.ts:14`), shaped as `NightlyScenario` (`evals/nightly/scenarios.ts:11-21`). See `m01-stale-premise` (`evals/nightly/state-memory-scenarios.ts:62-70`) for a worked example.
- Mark up to 5 cases with S0's `live_subset: true` so they run in the nightly live-judged subset.
- Raise `min_scenarios` (`evals/nightly/gate.ts:28-29`) in the same PR.

**Event-input seam, agreed by message on 30 Oct.** Memory-redesign asked; the harness confirmed it at about 07:10Z.

- The day's working state is a **read view over the existing tables**, each keeping its own writer: `update_cards` with observed mail, episodes, loops and health freshness. There is no new day-state store. S8's last-seen calendar table is written only by `updateCheck`.
- After an ingestion commit, the owner object emits `observed({kind, refs, taint, at, localDay})`.
  - It carries ids only and no text, and is emitted after the commit, outside the transaction.
  - It is a **wake hint, not a record.** Each consumer reads by its own watermark, as the nightly source pass does (`update-cards.ts:96-100`), so a lost hint costs only latency.
  - It has two consumers: S8's day-update judge, and memory's debounced consolidator.
- Memory's consolidator is owned by memory-redesign:
  - at most one pass per 15 minutes and 6 extra passes per day, both provisional;
  - every pass is logged through `llm_*`, so it counts in the ceiling, and passes are skipped at the spend cap;
  - input is bounded to rows since its watermark.

**Agreed terms.** memory-redesign proposed the interface below, and the harness confirmed it on 30 Oct. Its doc (`docs/proposals/WALDO_MEMORY_REDESIGN_2026-10-30.md`) owns the detail:

- **Call:** `selectMemory({ view, text, previous?, turn, room: { core, recalled }, deadlineMs }) -> { core, recalled, shown, failed, revision }`. Both `room` fields are hard caps, defaulting to 5,200 and 3,000 characters.
  - `view` is the store the caller already filtered: barrier, outside view or owner-only. Selection never widens it.
  - `shown` carries ids only, for traces.
- **Placement:** memory stays in the per-message suffix. No harness slice moves it.
- **`revision`:** used for the "core changed vs the previous turn" metric and for freezing within the turn. It is not used for the cross-turn cache.
- **Scenarios:** memory-redesign adds its scenarios in the `state-memory-scenarios.ts` shape and proposes m08, m09, m10, m12 and m13 for `live_subset` once S0 (#1684) lands. Its doc (PR #1691, §1.6) records the same terms.

## E: "a meeting moves after the Brief", traced at 7e6bce8a

A read-only subagent traced this path. I checked its key lines myself: `expo-push.ts:8-11`, `owner-do.ts:4919-4923`, `:5002-5006`, `update-cards.ts:108-112`, `:131-136`. Every other citation went through the line-printing script.

### What happens today, step by step [verified]

1. **The push.** Google's push carries no event data (`connectors/google-push.ts:1-3`).
   - `handleCalendarPush` checks the channel token and forwards the call to the owner object (`channels/event-ingress.ts:115-136`).
   - `calendarPush` (`owner-do.ts:2240-2250`) admits it and calls `wakeBriefSweep`. That moves the 10-minute sweep earlier, to no sooner than 60 s after its last run (`channels/calendar-push.ts:14`, `:52-56`).
   - With no armed sweep (event briefs off, or the time zone not confirmed), nothing happens (`calendar-push.ts:51`).
2. **The poll fallback.** The sweep runs every 10 minutes (`channels/event-briefs.ts:12`). Its run calls `updateCheck` (`owner-do.ts:4890`).
3. **Detection.** `readChanges` lists events with `updatedMin` set to the watermark, over the next 48 hours only (`update-cards.ts:131-134`).
   - A fixed rule labels each change: `cancelled`, `added` (created after the watermark) or `changed` (`update-cards.ts:108-112`).
   - **No earlier state is stored, so "moved from 10:00 to 15:00" can't be said.** Only the new time is known [inference from `toChange`].
4. **The record.** `updateSweepCheck` writes the `update_cards` row, the watermarks and, if the gate is open, a reader job, all in one transaction (`update-sweep.ts:44-78`). The writer is the owner object's `updateCheck`.
5. **The gate, fixed rules** (`owner-do.ts:4919-4923`). An update is held when:
   - follow-ups are off;
   - **the Close was sent today;**
   - volume is low;
   - it is quiet hours;
   - the surface can't send now.

   Follow-ups, volume and quiet hours are owner preferences. "The Close was sent" is a judgment call in code (decision 10).
6. **The judgment.** It is all done by the model:
   - a worker reader job judges which changes affect today or tomorrow (`prompt/machine-jobs.ts:19-28`);
   - then the brain's apply turn writes "Update" with one to three lines, or `SKIP` (`update-sweep.ts:110-127`).

### What the owner sees

| Effect | Today |
|---|---|
| The delivered Brief | **Never changes.** `dayCardFinalId` stops a re-send (`owner-do.ts:5002-5006`). The change waits for the next main card: the Check-in at 14:00, or tomorrow's Brief if the Close already went. |
| A separate "Update" message | Only if both model calls say so. It is dropped if not delivered within 30 minutes (`update-sweep.ts:22`). |
| App | A new Main chat row for that update only (`proactive-surface.ts:110-122`). The Brief row is untouched. |
| Phone push | **None.** Push kinds are `brief` and `approval` only (`expo-push.ts:8-11`). |
| Console Today | "Today's messages" still shows the original Brief. Day history lists delivered updates (`day-history.ts:89-100`). Changes that were recorded but held are shown nowhere. |
| Gmail | The same path: the push only wakes the sweep (`owner-do.ts:2253-2260`). At most 10 new primary-inbox mails per tick (`update-cards.ts:136`). With `MAIL_SOURCE_FOLLOWUPS=1`, the apply turn may open a loop. |
| MCP connectors | No push and no polling. They are read only inside turns (`tools/live/mcp.ts:212`, `:287`). |

### Where it stops

The delivered card never changes, and nothing interrupts the owner. A change after the Close waits until tomorrow. Old times aren't known. Moves outside 48 hours aren't seen. While a sweep job is open, new changes wait (`update-sweep.ts:47`).

## F: a working state for the day (slice S8)

### Goal

When something the owner's day depends on changes, Waldo knows within minutes. The model decides whether it matters and what to do: revise the card, notify, say it in chat, or stay quiet. Every effect goes through the one existing path.

### What stays

- the update sweep, the push wake and the 10-minute poll;
- `update_cards` as the single record of changes, with the owner object's `updateCheck` as its writer;
- the two-step judgment: a cheap worker judges, and the brain acts only when the worker found something;
- `WaldoCoordinator` and the final outbox as the effect path.

S8 changes four things.

**1. Know what it was.**
- Store a small "last seen" projection per calendar event: id, start, end, a title digest and attendee count. It's a DO table written only by `updateCheck`, inside its existing transaction, kept for 14 days.
- Then the change carries `before → after`, and the model can say "moved from 10:00 to 15:00".
- Widen the read window to now−1 day through now+14 days, so a move out of the next 48 hours is seen. Google filters by the event's current times, so a meeting moved to next week is otherwise invisible [inference].
- This needs a DO migration reserved in the lineage guard (`guard-do-migration-lineage`), plus a short contract note. Raw calendar text stays in the existing projection (`calendarPromptProjection`). No health values.

**2. One hint, two consumers.**
- After any ingestion commit (update record, mail observed, health freshness, chat episode), the owner object emits `observed({kind, refs, taint, at, localDay})`. It carries ids only, and is emitted after the commit, outside the transaction.
- It is a wake hint only. Each consumer reads by its own watermark, so a lost hint costs latency, not data.
- **Consumers:**
  - the update judge (this slice), which pulls the sweep forward as push does today;
  - memory-redesign's debounced consolidator, which owns how events become claims. This was agreed by message on 30 Oct; see §Seam.

**3. The judge chooses effects, with no fixed significance rules.**
- The apply turn's answer widens from "Update or SKIP" to a typed choice of zero or more effects:
  - `revise_card(card_id)`: a new revision of today's delivered card, written by the day-card writer through the final outbox, linked to the original app row;
  - `notify`: an `update` push, held during quiet hours, where the revision still lands;
  - `say`: a Main chat message, today's update message;
  - `none`.
- What counts as significant is the model's call, in the existing prompts, given the change (`before → after`), today's delivered cards, the plan and the owner's volume preference.
- Code enforces only authority and preferences:
  - quiet hours;
  - the volume preference;
  - follow-ups off;
  - a surface that can't send now;
  - the outbox's dedup.
- The "Close already sent" hold is removed (decision 10).
- On Telegram, iMessage and WhatsApp a card can't be edited. There, `revise_card` is delivered as a short update message, and the app and console show the revision.

**4. Nothing gets lost.**
- A change seen while a sweep job is open joins the next job instead of waiting for it (`update-sweep.ts:47`).
- An update not delivered within 30 minutes is still folded into the next card, as today. It is also listed under the card's revision in the console Today view, so recorded-but-held changes are visible there.

### Cost and caching [proposed; all numbers provisional]

- **Debounce.** At most one judge pass per 5 minutes per owner. A burst of pushes coalesces into one pass. The pull-forward gap is 60 s today; the judge's own debounce sits on top.
- **Cheapest judge.** The worker step stays on Luna. Its input is bounded to the changes (`before → after`), the delivered cards' summaries and the plan, with a character cap.
  - S7 shows Luna isn't caching on staging today, so input size is the lever.
- **Escalation.** The brain's apply turn on Terra runs only when the worker found something. The change text goes in the machine turn's per-message suffix, so the cached prefix (instructions, tools, history) holds.
- **Budget.** Every pass is logged through `llm_*`, so it counts in the ceiling, and passes are skipped when the spend cap is reached. [proposed] Cap: 24 judge passes per owner per day. That is about $0.03 on Luna at 10k input [inference].

### Falsifiers and threshold

- **Falsifier.** In the S0 day-change scenarios, the model notifies for changes a human judge marks trivial, or misses moves the judge marks material, in more than 2 of 10 [proposed].
  - If that happens, fix the prompts and the context given to the judge. Never add a significance rule in code.
- **Done.** Latency from a calendar change to a visible revision is p50 ≤ 2 minutes with push on, and ≤ 11 minutes on the poll.

### Metrics

- latency from change to the first visible effect;
- effects chosen per change, as bounded counts;
- pushes per owner per day;
- judge and apply cost per owner per day (S1 ledger);
- the S0 scenarios. These are new: "meeting moved after the Brief", "cancelled after the Close for tomorrow 08:00", "trivial title edit", "burst of 5 pushes", and "change during quiet hours".

### Rollback

`WALDO_DAY_STATE=off` restores today's "Update or SKIP" path and gate. The last-seen table is additive. The `update` push kind and the card revision are additive contract fields that old app builds ignore.

### Build slice S8

| | |
|---|---|
| **Files** | `src/channels/update-cards.ts`, `src/channels/update-sweep.ts`, `src/prompt/update-cards.ts`, `src/channels/owner-do.ts` (gate, apply effects, `observed` emit), `src/channels/expo-push.ts`, day-card revision in `src/channels/day-cards.ts`, `src/channels/day-history.ts`, `packages/contracts` (app.v1 additive: push kind `update`, card revision), DO migration, tests |
| **Single writer** | `updateCheck` for changes and last-seen state; the day-card writer for revisions through the final outbox; the existing push sender. |
| **Tests** | Golden: a meeting moved after the Brief gives a revision plus a push. Time-mocked: quiet hours (revision without push), after the Close (the model judges; the hold is gone), DST, time zone change. Concurrent: 5 pushes in a burst give one pass; a change during an open job joins the next job. Degraded: provider down means the change is recorded and the next card covers it; push failure leaves the revision in place. Hostile: an event title carrying instructions stays external-tainted data, and a tainted turn's effects stay card-only. Null: no Google grant means no sweep and a logged reason. |
| **Migration / ADR** | DO migration (last-seen) / no ADR. It extends the update-card contract additively. App.v1 additions need a gate-allocated revision and a brief for Suyash's app lane: show "updated HH:MM" and handle push kind `update`. |
| **Flag** | `WALDO_DAY_STATE` [proposed], default off, staging on after S0 scenarios pass. |

## G: one main thread (slice S9)

### Current state [verified]

A subagent traced this. I checked `context-composer/owner-turn.ts:38-43`, `conversation/canonical-owner-store.ts:78-79`, `channels/app-api.ts:348` and `conversation/joined-path.ts:70` myself.

| Surface | Chain and store | In the app's main chat? | In the console's main thread? | In the model's history? |
|---|---|---|---|---|
| App | `owner:<principal>`, canonical store (`context-composer/owner-turn.ts:43`; `owner-do.ts:4292`) | Yes | Yes (the console forwards to the app endpoint, `console-chat.ts:58`) | Its own chain only (`joined-path.ts:70`) |
| iMessage | its own chain, in the same canonical store (`imessage/ingress.ts:11`; `owner-do.ts:4298`) | **Yes, mixed in**, labelled `imessage` (`canonical-owner-store.ts:188`; `app-api.ts:348`) | Yes | **No.** Its own chain; episode recall only |
| Telegram | `telegram-<subject>`, legacy `conv:*` store (`owner-do.ts:3962`, `:4199`) | No | No | No |
| WhatsApp | `whatsapp-<chat>`, legacy store; no admitted owner context (`owner-do.ts:4181`) | No | No | No |

The code comment says so directly (`context-composer/owner-turn.ts:41-42`): until the single transcript, each surface keeps its own chain.

### Cited failure

- **What the owner sees and what Waldo holds in context disagree.** The app shows iMessage messages that the app-side model doesn't have in its history, and the reverse.
- **Telegram and WhatsApp are invisible** in the app and the console.

### Options

- **A.** Build #1544's "one timeline" (draft, head `8d49bfab`):
  - one main chain `owner:<principal>`, read and written by every user surface;
  - the delivery binding split from the history chain;
  - a forward-only cutover behind `WALDO_ONE_TIMELINE`;
  - no new store.
- **B.** A merged read view only: the app and console show all surfaces interleaved by time, while the model's chains stay separate. Cheaper, but it keeps the disagreement the owner noticed.
- **C.** Status quo.

### Recommendation: A [proposed]

- Telegram and WhatsApp move onto the canonical store as part of A.
- That also gives them compaction through the main chain, which folds S4 in.
- The iMessage cutover waits on #1463's data-agreement answer, or on #1544's host-set health marker.

### Falsifier, metric and rollback

- **Falsifier:** after cutover, a turn on any surface fails to see the previous turn from another surface within the window. The S0 scenario is "said on iMessage, asked in app".
- **Metric:**
  - the cross-surface recall scenario passes;
  - zero rows in the app main chat that the model's main chain lacks.
- **Rollback:** `WALDO_ONE_TIMELINE=off`. The cutover is forward-only, so rows written to the main chain stay readable there [per #1544].

### Build slice S9

| | |
|---|---|
| **Files** | per #1544: `src/context-composer/owner-turn.ts` (`ownerChainRef`), `src/channels/owner-do.ts` (history factories for Telegram, WhatsApp and iMessage; compaction trigger from every drain), `src/conversation/canonical-owner-store.ts`, `src/channels/app-api.ts`, tests |
| **Single writer** | the owner object's conversation chain writer through the canonical store |
| **Tests** | per #1544, plus: said on iMessage then asked in the app (golden); a WhatsApp turn admitted with an owner context; compaction triggered from an iMessage drain on the main chain. Adversarial: a row from another owner's chat is never attached; a forget lands across surfaces. |
| **Migration / ADR** | none for the store. #1544 drafts an ADR-0077 amendment. |
| **Flag** | `WALDO_ONE_TIMELINE` |
| **App lane** | Show the surface badge (it already exists as `channel`). No contract change needed for reads [inference]. |

## S0: eval parity (do first)

### Current state [verified]

- **No live run has ever happened.**
  - `gh run list --workflow evals-live.yml` returns `HTTP 404: workflow evals-live.yml not found on the default branch`.
  - `docs/evals/LIVE_BASELINE_RUNBOOK.md:5` says "Nothing here has been run live."
- **Recorded mode grades nothing.** The judge in recorded mode always returns `judge_error` (`evals/nightly/config.ts:34`, `:70-71`).
- **No pass-rate floor exists.** `min_pass_rate: null` in both modes (`evals/nightly/gate.ts:28-29`).
- **The eval config differs from staging (`wrangler.jsonc:109`):**

| Setting | Staging | Nightly eval |
|---|---|---|
| Tool loader | `harness` (`owner-do.ts:4237`) | Not settable: `runTrial` deps have no `toolLoader` (`evals/nightly/trial.ts:60`, `:73`) |
| Compaction | `on` | Off unless `WALDO_EVAL_COMPACTION=on` (`config.ts:58`); neither workflow sets it |
| Fallback models | Sonnet 5.5 / Haiku 5.5 when the Anthropic key is valid (`src/llm/owner-routes.ts:54-56`) | None: the trial passes only an OpenAI key (`trial.ts:73`) |
| Streaming | `on` | Not wired; the trial calls `respond` directly (`trial.ts:85`) |
| Surface | app, iMessage, Telegram, WhatsApp | `app` only (`trial.ts:75`) |
| Tools | Live registry | Synthetic handlers (`evals/nightly/world.ts:320-331`). This one is intentional. |

  `MEMORY_SEMANTIC_RECALL=0` and the forget barrier already match.

### Cited failure

A harness slice measured by this suite today would be measured on a different loader, without fallback, and with no grade. So none of S1–S6 has a way to show it helped or hurt.

### Options

- **A.** A staging profile in the eval config that **reads `wrangler.jsonc` `env.staging.vars` at run time** and maps each turn-shaping variable to the trial deps. A parity test fails when a turn-shaping staging variable has no mapping.
- **B.** A hand-kept list of eval flags that mirrors staging. It's simpler, but it drifts silently, which is the failure we have today.
- **C.** Run evals against the deployed staging Worker over HTTP. That's the truest test, but it mutates staging state, costs per run, and can't use the synthetic world.

### Recommendation: A [proposed]

- **`WALDO_EVAL_PROFILE=staging`:**
  - It sets `toolLoader: 'harness'`, compaction on, the Anthropic fallback (from the existing `WALDO_EVAL_ANTHROPIC_KEY`), the forget barrier and semantic recall as staging sets them.
  - It runs the scenario's declared surface: `app` by default; `imessage` for cases that declare it, once S4 is relevant.
- **A parity guard test:**
  - It holds an explicit list of the turn-shaping staging variables: `WALDO_TOOL_LOADER`, `WALDO_TOOL_SEARCH`, `WALDO_COMPACTION`, `WALDO_FORGET_BARRIER`, `MEMORY_SEMANTIC_RECALL` and the model roster.
  - It fails if any of them is unmapped or differs from the profile.
  - A new staging flag that shapes turns then breaks CI until it is classified.
- **A live-judged subset:**
  - A `live_subset: true` field on `NightlyScenario`, and a `subset` input on `evals-live.yml` that reaches the runner only through `env:`.
  - The subset is 12–20 scenarios: harness-sensitive cases (deferred-tool use, long chats, browse paging) plus up to 5 memory cases.
  - It runs nightly under its own cap.
- **Per-scenario metrics on the scorecard:**
  - model rounds;
  - `find_tools` calls and groups loaded;
  - peak tool-result characters;
  - input, cached and write tokens;
  - USD.

  These are counts only; the scorecard never holds reply text (runbook :22).
- **A baseline.** The first green subset run at the S0 head is the baseline. Later slices report the delta against it.
- **Recorded mode** stays a wiring smoke test for PRs. It is not a quality gate.

### Falsifiers and threshold

- **Falsifier.** S0 is wrong if two runs of the same subset at the same SHA disagree on more than 2 scenario verdicts out of 20 [proposed]. That would mean the judge is too noisy to gate on.
- **If that happens:** raise trials to 3 for the subset, or tighten the rubrics, before any later slice relies on it.
- **Done when:** one live subset run completes on `main` at the profile, and the parity test is green.

### Proof and rollback

- **Proof:** the parity test, plus one dispatched live subset run that the owner approves (it costs money).
- **Rollback:** remove the profile. The default config is unchanged, so recorded CI is unaffected.

### Build slice

| | |
|---|---|
| **Files** | `evals/nightly/config.ts`, `evals/nightly/trial.ts`, `evals/nightly/scenarios.ts`, `evals/nightly/plan.ts`, `evals/nightly/gate.ts`; a new `evals/nightly/staging-profile.ts`; `.github/workflows/evals-live.yml`; tests under `test/` |
| **Single writer** | the S0 owner. memory-redesign adds scenario files only, after S0 merges. |
| **Tests** | parity guard: red when a staging variable is unmapped; profile turns the loader on (trace assertion that a deferred tool goes through `find_tools`/`use_tool`); fallback fires when the OpenAI fake fails; `subset` filter rejects an unknown id before any call; the cap is scaled to the subset plan. Adversarial: an injected `subset` value with shell metacharacters is rejected and never interpolated into `run:`. |
| **Migration / ADR** | none / none |
| **Flag** | none in runtime. The profile is an eval-only environment variable. |
| **Owner** | decisions 1 and 2 |

## S1: cost truth

### Current state, cited failure

See §Step 2, gaps 1–6.

- **Concrete failure:** the durable ledger can't answer "how much of this month's cost was cache writes" [verified, the column doesn't exist].
- **Pricing that is already wrong:** a fallback turn prices Terra's billed tokens at Sonnet's rates [verified mechanism at `provider.ts:658`; size unmeasured].

### Options

- **A.** Additive `cache_write_tokens` column, plus a per-attempt usage list on the provider result. Each attempt is priced at its own model, and failed attempts log their billed usage as a separate `llm_<purpose>_attempt` usage entry. Uncached input is clamped at 0, and a bounded `usage_anomaly` hop is logged when the clamp fires.
- **B.** Keep write tokens in Langfuse only, and fix pricing in the DO without a migration. The ledger stays blind to writes.
- **C.** Leave it as is. Every S3–S6 cost argument then rests on Langfuse exports alone.

### Recommendation: A [proposed]

S3–S6 all argue in cost, and the ledger is the only durable per-owner record.

- **Falsifier:** gap 2 or 3 never fires on staging. Measure failed-with-usage attempts and fallback turns per day from the `fallback_fired` field already on the hop (`owner-turn.ts:335`).
- **Threshold:**
  - If fewer than 1% of turns fire a fallback, or fail after a billed attempt, over 7 days [proposed], ship only the column and the clamp.
  - Defer the per-attempt work.

### Proof and rollback

- **Proof:**
  - `test/cost-rollup.test.ts` gains write cases;
  - a fallback test asserts two priced rows, Terra and Sonnet;
  - the clamp test.
- **Rollback:** the column is additive with default 0. The DO change reverts cleanly, and the old rows stay valid.

### Build slice

| | |
|---|---|
| **Files** | `src/observability/cost-rollup.ts`, `src/llm/pricing.ts`, `src/llm/provider.ts`, `src/channels/owner-turn.ts` (log sites only), `supabase/migrations/<new>_cost_ledger_cache_write.sql`, the `cost_ledger_add` RPC, tests |
| **Single writer** | the owner DO cost rollup (existing). The migration goes through the reviewed-migration lane. |
| **Tests** | red first: a write reaches the month; a negative uncached input is clamped and logged; a fallback is priced per attempt; a failed attempt with billed usage counts. Adversarial: a replayed batch with the new column is not double-counted (`cost_ledger_batches`); old DO code writing without the column still inserts. |
| **Migration / ADR** | **migration: yes, additive** / ADR: none (no new store or writer) |
| **Flag** | none. It rides `WALDO_COST_LEDGER_SYNC`. |

## S2: `read_tool_output` handle name

### Current state [verified]

- Truncated results name the handle `stored_output`: the generic offload (`src/tools/dispatcher.ts:910`, `:954`) and the browse page (`src/channels/cloudflare-public-read.ts:230`).
- `read_tool_output` takes a strict `{ id, offset?, length? }` (`packages/contracts/src/tools/schemas/reads.ts:353-357`).
- Its description says only "The id comes from a truncated tool result" (`src/tools/read-tool-output.ts:13`).
- A model that passes `{"stored_output": …}` gets `invalid_args`, which costs a round.
- The cleared-result note does say "call read_tool_output with this id" (`tool-loop.ts:99`).
- `provider.ts:1693` keys retrieval promises on the `"stored_output"` field, so renaming the field is not free.

### Cited failure

The naming mismatch is verified. That it costs rounds in practice is [inference]: there is no trace yet.

### Options

- **A.** The description names the field: "`id` is the `stored_output` value of a truncated result". It's one string. It changes the cached tool bytes once, at deploy.
- **B.** Accept `stored_output` as an alias in the schema. This is an additive contract change, but it gives the model two names for one thing.
- **C.** Rename the result field to `id`. It touches `provider.ts:1693`, the browse result and its tests, and the history text of old turns.

### Recommendation: A [proposed]

It is the smallest change that removes the guess.

- **Falsifier:** `read_tool_output` `invalid_args` is already about zero in Langfuse over 7 days. In that case ship A anyway, since it costs nothing, and close the issue.
- **Proof:** a scenario in S0's subset that pages a long browse result; it asserts no `invalid_args` on `read_tool_output`.
- **Rollback:** revert the string.

### Build slice

| | |
|---|---|
| **Files** | `src/tools/read-tool-output.ts`; one test |
| **Single writer** | the S2 owner |
| **Tests** | the description names `stored_output`; a paging trace in the S0 subset. Adversarial: an id from another call is still refused (the existing provenance check at `provider.ts:1688-1697`). |
| **Migration / ADR** | none / none |
| **Flag** | none |

## S3: loader carry-over

### Current state [verified]

- **What is offered:** under `WALDO_TOOL_LOADER=harness`, each round offers the core tools plus `find_tools` and `use_tool` (`src/tools/loader.ts:64-84`). The system prompt names the deferred tools by group (`loader.ts:56-62`; `src/prompt/messaging-behavior.ts:129-131`).
- **Within a turn:** the offered list is fixed (`loader.ts:9-11`).
- **Across turns:** loaded definitions don't carry over.
  - History between turns is user and assistant text only (`conversation-entry.ts:167-172`).
  - `find_tools` results are kept out of the earlier-results context on purpose (`owner-turn.ts:673-679`).
- **Calling without finding:** `use_tool` can call any admitted tool without `find_tools` (`loader.ts:94-104`).
  - A `use_tool` call that fails the schema already gets the tool's definition back (`src/conversation/tool-loop.ts:367-371`, shipped with the loader in `f502c7c7b`). So a guess costs at most the round a `find_tools` would have cost.
  - The prompt doesn't tell the model this. It says "find_tools loads their definitions… Load the one you need" (`messaging-behavior.ts:129`), so the model is steered to `find_tools` first [inference: no trace of what it actually does].

### Cited failure

The 26 Oct design note states the cost (`docs/planning/agnostic-tool-loading.md:87`): "a turn that needs a deferred tool pays one `find_tools` round (about 3–8 s on staging)… Loaded definitions do not carry into the next turn." The staging probe's question used `get_communication`, which is deferred (group `mail`, `records.ts:97`).

Caveat: the measured rounds in that note (`:7-11`) were on hosted tool search with `gpt-6.1-sol`, not on the harness loader. **No trace measures how often `find_tools` runs under `harness` on Terra.**

### Options

| Option | What it does | Trade-off |
|---|---|---|
| **A. Status quo** | Nothing | One extra round whenever a turn needs a deferred tool |
| **B. Data-driven core promotion** | Move the most-loaded deferred tools into core | Static bytes, so the cache prefix stays byte-stable. Every round of every turn pays their definitions as cached input. Each promotion is a gate decision (owner decision 6). |
| **C. Carry the last turn's loaded definitions into the next turn's frozen suffix** | Those definitions arrive with the owner message, so `use_tool` works with no `find_tools` round | The definitions are paid once per turn as uncached input. That's only worth it when the next turn reuses them. The tools array never changes, so the cache prefix stays byte-stable. Needs a small "loaded last turn" record per chain. |
| **D. Carry them into `offered`** | Grow the tools array with what was loaded | **Rejected.** The tools array leads the cached prefix. Changing it re-bills everything after it as writes (terra 1.25× input), on every turn the set changes. |
| **E. Say what already works** | The harness line says `use_tool` may be called directly and a wrong-argument call returns the definition. The mechanism exists (`tool-loop.ts:367-371`); this changes only the prompt. | Whether to guess stays the model's call. A wrong guess costs one round, the same as `find_tools` today; a right guess saves one. One system-prompt string, so the cached prefix changes once, at deploy. |

### Recommendation [proposed]

1. Measure first, in S0:
   - `find_tools` calls per owner turn and the groups loaded;
   - direct `use_tool` calls, and how many of them come back `invalid_args`.
2. Then ship **E**: no state, one string, and it never costs more than today.
3. Then **B** for any tool loaded in at least 15% of owner turns over 7 days.
4. Ship **C** only if a run of follow-up turns keeps reloading the same group.

- **Falsifier:** fewer than 10% of owner turns call `find_tools` [proposed]. In that case close S3 without changes.
- **Falsifier for E:** after E, more than half of direct `use_tool` calls come back `invalid_args` [proposed]. Guessing doesn't pay; revert the string.
- **Threshold for B:** a tool loaded in at least 15% of owner turns, with the definition-size cost under 25% of the round time it saves. Price it with S1's real write and read rates.
- **Metric:** the S0 subset's rounds per scenario and `find_tools` count, and p50 turn latency for turns with `find_tools` against turns without it (from the `llm_reply` hops).
- **Rollback:**
  - E: revert the string.
  - B: move the tool's `brain:` back.
  - C: a flag. The loader still works without the record.

### Build slice (E, then B)

| | |
|---|---|
| **Files** | E: `src/prompt/messaging-behavior.ts` (`HARNESS_TOOLS_LINE`) plus a test. B: `src/tools/records.ts` plus tests. |
| **Single writer** | the S3 owner. `records.ts` is a hot file, so coordinate with any open tool PR. |
| **Tests** | E: the line names direct `use_tool` and the definition-on-error behaviour; a trace where a direct `use_tool` with bad args gets the definition and the next call succeeds (the existing behaviour, now pinned); an unadmitted or meta name still gets `unknown_tool` without echo (`loader.ts:103`); every gate still runs (ACL, held, taint, approval). Adversarial: an argument payload naming another tool or embedding `find_tools` can't escalate. B: the tools array is byte-stable across two turns. |
| **Migration / ADR** | none / none (C would need a DO table and a short contract note) |
| **Flag** | E: none. B: none (a gate decision). C: yes, `WALDO_LOADER_CARRY` [proposed]. |

## S4: compaction beyond the app

### Current state

See §Step 1, how compaction differs by surface.

### Cited failure

None in traces. The mechanism is verified; the cost is [inference].

- **The mechanism.** `windowModelMessages` keeps the newest messages that fit 100k estimated tokens (`window.ts:43-60`). Once a non-app chain is over budget, every new turn drops the oldest message. The first message after the system prompt changes, so the whole kept history is a new prefix on that turn.
- **The cost.** At about 100k tokens on terra that is roughly $0.125 a turn billed as writes, against roughly $0.005 as cached reads [inference]. That assumes uncached tokens bill as writes, which is unverified (§Step 2).
- **The quality loss.** It is also silent: dropped rows are not summarised.
- **The counter-evidence.** No trace shows any non-app chain reaching the window. The `context_window` hop that would show it exists (`owner-turn.ts:365`), but nobody has queried it [blocked: Langfuse].

### Options

- **A. iMessage compaction.**
  - Pass `compactionSettings(this.env)` at `owner-do.ts:4298`.
  - Run the existing compaction job after the iMessage drain, as `compactApp` does after the app drain.
  - The surface-neutral-core guard bans surface compares, so this needs a declared host option, not a `channel ===` branch.
- **B. A surface-neutral compaction job keyed by chain.** This covers all four surfaces. Telegram and WhatsApp would first need to move off the legacy store to the canonical store, a much larger change.
- **C. Chunked windowing for the legacy and plain paths.** When over budget, drop to 50% at once instead of one message per turn. The prefix then changes once per chunk instead of every turn. It is cheaper and needs no summary, but it loses more context at each step.
- **D. Defer.** Telegram is internal only. WhatsApp is held by Meta verification. iMessage is the only non-app surface with users.

### Recommendation [proposed]

- **Now:** D, with a measurement.
- **Then A for iMessage** when the threshold is met.
- **C** is worth its small size if A is still a long way off once the threshold is met.
- **B** waits until Telegram or WhatsApp has real users.

### Falsifier and threshold

- **Pull from Langfuse:**
  - `context_window` hops with `dropped > 0` on `imessage-*` traces;
  - the `estimated_tokens` / `budget_tokens` ratio on iMessage turns.
- **Act (A)** if, over 7 days, any iMessage chain crosses 70% of budget (the app trigger, `compaction.ts:11`). The owner's own chain counts.
- **Stay deferred** if no iMessage chain passes 50%.

### Metric and rollback

- **Metric:**
  - S0 adds an `imessage`-surface long-chat scenario to the subset;
  - the compaction summary keeps the owner's instructions (the existing compaction rubric);
  - per-turn cache writes on that scenario fall after compaction.
- **Rollback:**
  - `WALDO_COMPACTION=off` turns off every surface;
  - [proposed] a per-surface variable `WALDO_COMPACTION_SURFACES=app,imessage` lets iMessage roll back alone.

### Build slice (A)

| | |
|---|---|
| **Files** | `src/channels/owner-do.ts` (iMessage history factory, post-drain compaction call), `src/conversation/compaction.ts` (surface list in settings), tests |
| **Single writer** | the conversation chain's existing writer, the owner DO. The compaction row is written through the same fenced `scope.commit` as the app (`owner-do.ts:1970`). |
| **Tests** | red first: an iMessage chain over the trigger gets one compaction row and the next turn's view is summary + tail. Adversarial: a message admitted during compaction wins and the job yields (as `owner-do.ts:1957`); a forget landing mid-compaction leaves no summary that carries the topic (the existing flush and barrier); a summary never includes a health number (`COMPACTION_INSTRUCTION`, `compaction.ts:33`); the alarm deadline is respected. Time-mocked: the `minIntervalMs` re-compaction spacing. |
| **Migration / ADR** | none. It reuses the compaction row (`docs/proposals/ADR_DRAFT_CONVERSATION_COMPACTION_ROW_2026-10-13.md`), whose scope note needs "app" widened to "app and iMessage". |
| **Flag** | yes: the surface list [proposed]. Default `app` keeps today's behaviour. |

## S5: in-turn tool results

### Current state [verified]

- `TOOL_RESULTS_KEEP_CHARS = 160_000` clears the oldest results down to half, once past the limit (`tool-loop.ts:82-85`).
- Clearing for time applies only when every serving provider's cache has expired. In practice that means Anthropic (`tool-loop.ts:86-90`).
- #1682 cut the 10-round browse test's peak resent results from 141,487 to 90,111 characters (side note `harness-efficiency-qol-2026-10-30.md`).
- Nothing logs a turn's peak result characters or its clear count. `tool-loop.ts` has no hop for either.

### Cited failure

**None.** This area is settled and is not re-proposed.

- Lowering the threshold or clearing in-turn on OpenAI was modelled as **more** expensive: a clear re-bills everything after it as writes at 1.25×.
- Only T ≤ 32K was modelled as cheaper, by 8–34%. That rests on an unverified assumption that every uncached token bills as a write.

### Options

- **A.** No change, plus instrumentation: a bounded per-turn `tool_results` detail with the peak-characters bucket, the clear count, and the top tool by characters. Tool names are a bounded set, so they're safe as a label.
- **B.** T = 32K. It is modelled cheaper only for some shapes, and it hides prior results from the model.
- **C.** Source-side windows for the worst offenders, as #1682 did for browse, chosen from A's data.

### Recommendation [proposed]

- **Now:** A.
- **C** for any tool that is the top contributor in at least 20% of turns whose peak exceeds 32K.
- **B** only if, after 7 days of write data, the observed write billing matches the model **and** turns over 32K are at least 10% of owner-turn cost.

### Falsifier, metric and rollback

- **Falsifier:** fewer than 5% of turns ever exceed 32K. Then close S5 after A.
- **Metric:** the peak bucket and clear count per turn in Langfuse; write tokens per turn from S1.
- **Rollback:** A is a log field. C reverts per tool.

### Build slice (A)

| | |
|---|---|
| **Files** | `src/conversation/tool-loop.ts`, `src/channels/owner-turn.ts` (log site), tests |
| **Single writer** | the S5 owner. `owner-turn.ts` is a hot file, so serialize with S1. |
| **Tests** | the bucket is bounded (fixed edges); the detail never carries result text, ids or URLs; the clear count matches the existing clear test. |
| **Migration / ADR** | none / none |
| **Flag** | none |

## S6: the router

See §Step 2 for the evidence.

### Recommendation [proposed]

Defer. When the threshold below is met, build the wiring on #1639's `routeTurn` behind a default-off flag, as its own body plans. Owner decision 5 is needed.

### Falsifiers and threshold

Run `scripts/cost-report.mjs --turns` (from #1639) over at least 7 days of staging `llm_reply` turns. Then:

- **Light tier:** act only if turns on a cold Terra cache are at least 25% of owner-turn cost, **and** the S0 subset run on Luna for those scenario types loses no more than 1 verdict in 20 against Terra.
- **Deep tier:** act only if the S0 subset shows scenarios Terra fails and Sol passes.
- **Stop:** if cold turns are under 10% of cost, the light tier's saving is too small to justify a second model in the cache [proposed].

### Before wiring

- the security review of the Decisions egress;
- a live check of the `/v1/decisions` shape against a pinned source.

### Metric and rollback

- **Metric:** USD per owner turn by tier (S1 ledger), and the subset's pass rate per tier.
- **Rollback:** the flag off returns every turn to Terra.

### Build slice

| | |
|---|---|
| **Files** | per #1639, plus `src/channels/owner-turn.ts` route selection, plus a flag in `wrangler.jsonc` |
| **Single writer** | the #1639 lane owner |
| **Tests** | already pinned in #1639: no switch inside a warm chain without a confident escalation; every failure path returns null; no secret, canary or health number in the request. The wiring adds: an escalation mid-chain keeps its tier on the next turn; the spend clamp still wins over the router. |
| **Migration / ADR** | none / **yes**: a model-routing ADR or amendment, because it adds a tier and a provider egress |
| **Flag** | yes, default off |

## S7: prompt-cache misses (first round of each chat turn; jobs)

### Cited failure

The orchestrator read about 48 staging `llm_reply` observations in Langfuse on releases `ea00689d3`, `2c96be452` and `eafe888`. It read metadata only, no content, and relayed the results on 30 Oct.

- **Terra chat:**
  - The first round of each turn is uncached: about 35–37k input tokens, `cached_share` 0.
  - Later rounds in the same turn hit 85–99.7%.
  - One later round hit only about 35–37%.
- **Luna jobs (Brief and card jobs):** `input_cached_tokens` is 0 on every call, at inputs from about 10k to 114k tokens.
- **When this was first read,** there was no observation on `7e6bce8a` yet. P0 has since passed (§Step 2).

I haven't seen these traces myself. They are a teammate's reading, cited as such.

### Current state [verified]

- The request carries `prompt_cache_key: waldo:<ownerId>` (`src/llm/openai.ts:87`; `owner-turn.ts:188`, `:300`). It sets no `prompt_cache_retention`.
- Owner turns and machine jobs share one `runToolLoop` call with `stableMenu: true` (`owner-turn.ts:533-536`). So a job's tool list is stable across its own rounds too.
- The 26 Oct probe found tools and instructions byte-identical across two consecutive app turns. That was in a test, not on staging (`docs/planning/agnostic-tool-loading.md:91-97`).
- No per-call digest of the tools bytes or the instructions bytes exists, so a trace can't show which part of the prefix changed.

### Hypotheses [inference]

**First round of a chat turn uncached, even the stable instructions and tools:**

- **H1, retention.** The gap since the previous call on that prefix exceeded the cache lifetime.
  - Falsifier: a first round at `cached_share` 0 that comes less than 5 minutes after the previous turn.
- **H2, prefix instability.** Something per turn sits inside the instructions or the tools array: the admitted tool set, the catalogue, standing orders, the skill catalogue, the surface text.
  - Falsifier: equal instructions and tools digests across consecutive turns while the miss persists.
- **H3, model or route change** (fallback or the spend clamp).
  - Falsifier: the same model on both turns.

**Mid-turn round at about 35%:**

- **H4.** The frozen suffix was rebuilt mid-turn, which it does on a steer, a landed forget, or a health change (`owner-turn.ts:525-528`).
  - Falsifier: no steer, forget or health change in that turn.

**Luna jobs at 0:**

- **H5.** Most jobs are one model call, hours apart, so nothing can be reused by construction.
  - **Falsified.** The orchestrator's grouping by `trace_key` shows multi-round luna jobs at 0 cached tokens in every round: `card:brief` 5 rounds, `card:close` 4 rounds, `card:midday` 3 rounds.
- **H6a.** The jobs path builds its request differently from chat (cache key, adapter, or prefix order).
  - **Not supported by source.** I compared the two paths at the baseline and found no jobs-only difference [verified for the items listed]:
    - Both use one cache key, `waldo:<ownerId>` (`owner-turn.ts:188`, `:300`).
    - Both use one OpenAI adapter. Only the model differs (`src/llm/owner-routes.ts:50-75`).
    - Both run one tool loop with `stableMenu: true` (`owner-turn.ts:533-536`).
    - The system instructions are the composer's stable layers: identity, approach, tools, voice and safety (`src/context-composer/prompt.ts:165`).
    - The per-round snapshot id and time (`src/context-composer/owner-turn.ts:131`) feed health provenance, not the instructions.
  - [inference] If something in a job's prefix changed every round, the same path would also break chat rounds 2+. They hit 85–99.7%.
- **H6b.** Luna doesn't prompt-cache on this route, or doesn't report it in `input_tokens_details.cached_tokens`.
  - **Now the leading hypothesis** [inference].
  - Falsifier: any luna call ever showing cached tokens.
  - **Docs, read by the orchestrator in the OpenAI prompt-caching guide on 30 Oct:**
    - GPT-5.6 and later default to implicit mode, with the breakpoint at the latest eligible user message.
    - Developer messages after the first block are not boundaries.
    - Luna has published cache-write rates, so it supports caching.
  - **Weakened: "Luna can't cache" is out.** "Caching happens but isn't reported" stays open.
- **H7, no implicit breakpoint on jobs** (the orchestrator's lead: no user-role message, or the trigger sits in later developer messages). **Not supported by source** [verified]:
  - The adapter sends only user and assistant roles (`src/llm/openai.ts:297`). The system text goes in `instructions` (`openai.ts:82`), so no developer messages are sent at all.
  - A job's text is a tree entry with no explicit role (`owner-turn.ts:781` and the `userEntry` that follows). It defaults to `user` (`conversation-entry.ts:168`) and is the last message of the request.
  - Reasoning effort is fixed per model: luna `low` (`packages/contracts/src/model/roster.ts:56`; `openai.ts:60-61`, `:86`). `parallel_tool_calls`, verbosity and `context_management` are never set.
- **What is left [inference]:**
  - The bytes of the latest user message differ between a job's rounds, which moves the implicit breakpoint.
  - Or a provider-side behaviour on this model.
  - A's digests, extended to the latest user message, split these two. If the digests are equal across rounds and the misses continue, the paid two-call probe needs owner approval (well under $0.01). This session runs no paid calls.

**Terra round 1, refined by the same grouping:**

- Two turns had a partial round-1 hit (`app-…172`, `app-…169`), as expected when the previous turn's prefix is still cached up to the owner's earlier words.
- Three had none (`app-…171`, `…170`, `…168`).
- That mix fits H1 (expiry between turns) better than H2: an unstable head would miss on every turn [inference]. A's gap field decides it.

### Weighing it

Cost per miss, using `src/llm/pricing.ts:10-12` [inference]:

| Miss | Cost |
|---|---|
| Terra first round, about 36k tokens | about $0.036 uncached, or about $0.045 if billed as a write |
| Luna call, 114k tokens | about $0.011 |

Per call, the chat first round is the bigger lever. Which matters more overall depends on how many calls each path makes. S1's ledger, with the write column, gives those counts.

### Options

- **A. Measure first.**
  - Log a short digest of the tools bytes, of the instructions bytes and of the latest user message (the implicit cache breakpoint) on each `llm_*` hop.
  - Log the gap since the owner's previous model call on the same model.
  - Digests are a trace field, never a metric label (security checklist).
  - A read-only analysis then sorts each miss into H1–H6.
- **B. Set `prompt_cache_retention`** to the long tier on chat. Terra's write rate goes from $1.25 to $2.50 per 1M.
  - It only helps if H1 holds.
  - Verify the parameter against the pinned SDK and the current docs first.
- **C. Fix whatever H2 finds varies.** Move per-turn text behind the stable head. This may need a `VOICE_VERSION` decision.
- **D. For jobs:** first settle H6b with the docs check, or the probe the owner approves.
  - If luna can cache, the digests in A find what changes per round.
  - If it can't, caching is off the table for jobs. The lever is then job input size: one Brief had about 79k bytes of conversation history (`context_history_bytes`). Cut what the job doesn't need.
  - At luna's price ($0.10 per 1M input), that lever is worth about a cent per large call. Weigh it against call counts from S1.

### Recommendation [proposed]

- A now: it is small and decides B, C and D.
- The H6b docs check now, at no cost. The probe only with owner approval.
- Then exactly one of B or C for chat, depending on which hypothesis survives.
- D only after H6b is settled.

### Threshold

- **Act on B** if at least 50% of uncached first rounds fall after gaps longer than 30 minutes and the digests are stable.
- **Act on C** if any consecutive-turn pair shows a changed instructions or tools digest without a change in tools admitted for the owner.

Both numbers are provisional.

### Metric and rollback

- **Metric:**
  - first-round `cached_share` per chat turn;
  - luna `cached_share` on multi-round jobs;
  - write tokens per turn (S1).
- **Rollback:** A is log fields. B is one request parameter.

### Build slice (A)

| | |
|---|---|
| **Files** | `src/channels/owner-turn.ts` (log site), `src/llm/provider.ts` or `src/llm/openai.ts` (where the request bytes are final), `src/observability/otlp-turns.ts` (trace field), tests |
| **Single writer** | the S7 owner. Serialize with S1 and S5, which touch the same `owner-turn.ts` log sites. |
| **Tests** | the digest is stable for identical bytes and changes when one tools byte changes; it is not a metric label; no content enters the trace field; the gap is computed per model. Adversarial: an instructions block with owner text produces only a digest, never the text. |
| **Migration / ADR** | none / none |
| **Flag** | none |
| **Precondition** | none for A. B and C need P0. |

## Order and dependencies

1. **S0** first. **S2** can go at any time.
2. **S8 and S9** next, in parallel. Their files mostly differ, but both touch `owner-do.ts`, so each needs its own writer and the gate orders their merges.
   - S9's iMessage cutover waits on #1463.
   - S8 needs decisions 8–10 and an app-lane brief for the contract additions.
3. **S7 (A), S1, S5** share the `owner-turn.ts` log sites, so they are serialized in that order. S7 goes first because it has cited evidence.
4. **S3 (E)** needs S0's `find_tools` metric.
5. **S4** is folded into S9 (decision 7).
6. **S6** last.

The memory-redesign scenarios plug into S0 once it merges.

Things this proposal never touches: `WaldoCoordinator`, the trusted RunLoop and physical-effect path, `ContextComposer`'s structure, the forget barrier, and ADR-0081/0082 health rules.

## Issues

One issue per slice, in `waldoco/waldo-backend`:

| Slice | Issue |
|---|---|
| S0 eval parity | #1684 |
| S1 cost truth | #1685 |
| S2 `read_tool_output` handle | #1686 |
| S3 loader carry-over | #1687 |
| S4 compaction for iMessage | #1688 |
| S5 tool-result instrumentation | #1689 |
| S6 router on #1639 | #1690 |
| S7 cache-miss diagnosis | #1700 |
| S8 day working state | #1701 |
| S9 one main thread | #1702 |
