# Harness and agent engineering: what changes, in what order (22 October 2026)

Source pin: `origin/beta-mvp` at `c5e44093` (22 Oct, 06:12Z). PR and CI state read with `gh` the same morning. ADR text read from `Pin4sf/waldo-brain` `main`. Owner-account staging evidence is the orchestrator's console E2E of 22 Oct (issues #1395, #1396); the last staging Worker deploy recorded in #1359 is `7bab4193` (04:33Z). Labels: **[verified]** read in source or on GitHub this session; **[inference]** a conclusion from what was read; **[plan-only]** the only evidence is prose; **[cited]** a primary source quoted, with its link.

This document answers one question: what must change, and in what order, for Waldo's harness and agent engineering to be state of the art while holding the repo's principles, owning the health-aware niche and covering a good range of general assistant tasks. It is a candidate roadmap under [`BUILD_DIRECTION_2026-10-21.md`](BUILD_DIRECTION_2026-10-21.md); it authorises nothing by itself.

## 0. The decisions

1. **The health plane is the first gap, not the harness.** Fourteen Apple Watch signals are accepted and nine feed the scores; sleep stages cannot be represented; scores recompute only after an upload; every score is an unaccepted candidate. Fix completeness and freshness first (PR #1399's AW-1 to AW-8), because this is the product the owner is selling.
2. **Switch the live eval on before anything else flips.** No live eval has ever run: the secrets are not set and the workflow lives on `beta-mvp`, where GitHub never schedules it. Compaction, rule pruning, tool search and the voice judge all wait on it.
3. **Redesign forget, do not patch it.** Today a forgotten topic is a substring purge verified store by store; an unverified topic is held for ever and, while held, whole web pages, history rows and recall results are withheld from the model. Replace with a redaction barrier at one seam plus hard deletion of derived memory plus an asynchronous purge that gates nothing. The word-boundary fix in flight is necessary and not sufficient.
4. **Keep the memory architecture (claims, episodes, pinned blocks, nightly pass); finish it.** It matches mature practice and 2026 evidence. Decouple the M-4 flush from compaction, fix promotion's unfiltered read, diagnose the nightly failure with logs, and retire the dead halls schema and the ADRs that describe it.
5. **Keep compaction as built and keep it off until its eval exists.** Provider-native compaction stays rejected: Anthropic's summary block is signed and cannot be redacted after the fact.
6. **Context engineering is at parity; finish the two open pieces** (frozen turn context #1363, rule pruning #1383) and report cache share, which telemetry records per call and nobody has read back as a number [verified, §2.2].
7. **Google links die after seven days because the OAuth app is in Testing.** Publishing status, not code, fixes it.

## 1. Status matrix: every BUILD_DIRECTION wave item

Merged means the merge commit is an ancestor of `c5e44093`. "Open" states are as of 06:12Z, 22 Oct. There are 46 open PRs.

### Wave 1

| Item | Status | Evidence |
| --- | --- | --- |
| Ashish's 17 PRs (#1318–#1336 minus #1334) | **Merged** as one integration | #1337 merge `30ed5a02` [verified]. Five stacked PRs (#1328, #1332, #1333, #1335, #1336) show CLOSED, not MERGED, because their base was a stack branch; their commits are in `beta-mvp`. |
| #1334 `deleted_classes` v8 | **Open, draft**, precondition met | Storage check SAFE (21 Oct 21:08Z: 123 staging namespaces, 1 object, 0 with data, no production worker). `wrangler.jsonc` still binds `RUN_LOOP_DO`, `TRACER_DO`, `RUNTIME_DO`; the classes are 410 stubs in `packages/runtime/src/retired-durable-objects.ts:13-25` [verified]. Needs a tag renumber against #1355's v9. |
| Resolve every other open PR | **Not done** | 46 open, about 20 drafts; #213, #1043, #1063, #1078, #1127, #1133, #1148 among them [verified]. |
| Repoint repository rules | **Merged** | #1339 `db49cb66`; `CLAUDE.md:5` and `AGENTS.md:15` link BUILD_DIRECTION [verified]. |

### Wave 2

| Item | Status | Evidence |
| --- | --- | --- |
| H-4 byte-stable prompt, versioned voice | **Merged** | #1346 `5574a291`; `prompt/messaging-behavior.ts:8` `VOICE_VERSION = 2`; digest pin `test/messaging-behavior.test.ts:231-239` [verified]. |
| H-5 parallel read calls | **Merged, on, no flag** | #1343 closed; landed inside #1351 → train #1358 `19ccd5e8`. `conversation/tool-loop.ts:56` `CONCURRENT_READ_TOOLS`, `:61` `MAX_CONCURRENT_READS = 4`, `:240` `concurrentBatch`, `:246` `Promise.allSettled` [verified]. The brief's "not found in source" was wrong. Google reads are not yet in the concurrent set; Google bookkeeping was serialised in #1355's branch, not on `beta-mvp` [inference from the worker-layer note]. |
| H-8 compaction | **Merged, OFF** | #1248 via #1351. `conversation/compaction.ts:7` `COMPACTION = { enabled: false … }`, a source constant; consumed at `channels/owner-turn.ts:795`, `conversation/canonical-owner-store.ts:164` [verified]. **No eval gates the flip**: no `compaction` match in `packages/runtime/evals/` or `.github/workflows` [verified]. |
| H-9 rule pruning with ablations | **Open** | #1383 head `472296cb`, Ready for gate review; ablations NOT RUN (no keys) [verified]. |
| Personality in the voice block, eval cases | **Merged** | Voice block in #1346; voice and safety judge #1342 `6936fc2d` (14 scenarios, 33 labels, `eval:voice-agreement`). Suyash's labels are all `reviewed_by: null`, so judge agreement is unmeasured [verified]. |
| M-4 durable post-chat memory flush | **Open, lands dormant** | #1379 head `1a94a6b0`, Ready. On `beta-mvp` the hook `privateOwner.compactionFlush` is called only inside `compactIfDue` (`owner-turn.ts:810-811`), which returns early while compaction is off [verified]. See §2.1. |
| iMessage proactive-delivery gap | **Open** | #1378 head `9e759425`, Ready [verified]. |
| Per-owner cost cap wired | **Merged, inert** | #1348. `llm/cost-ledger.ts:26` `MONTHLY_SPEND_CEILING_USD = 25`; `dispatcher.ts:69` holds paid tools; but "off unless `WALDO_COST_LEDGER_SYNC=on`. No hosted config sets it" (`docs/ops/OBSERVABILITY.md:85`) [verified]. Background work is not ceiling-gated [inference]. |
| Frozen turn context (#1363) | **Open**, blocked once | BLOCK at `e98164cd` for a forget leak in the frozen suffix (decided from rendered text); fix `0c1195b8`, Ready at `25fdc680`; one additive conflict with the tip [verified]. |
| Cheapest rung, structured blocked outcomes | **Open** | #1366 head `b33f1996`, Ready [verified]. |
| Tool search readiness | **Open** | #1364 head `60f9ad7b`, Ready; base #1349 merged `d3e98637` behind `WALDO_TOOL_SEARCH`, off [verified]. |
| Untrusted text stays untrusted | **Open** | #1365 head `85627308`, Ready [verified]. |

### Wave 3

| Item | Status | Evidence |
| --- | --- | --- |
| Worker layer (jobs table, TaskWorker, profiles, `start_task`, reader jobs, crash recovery, parked retry R-4) | **Open**, one PR | #1355 head `c67e01e2`, Ready, CI 7/7, but GitHub reports CONFLICTING against `c5e44093` [verified]. Nothing landed independently: no `TaskWorker`, `start_task` or jobs table in `beta-mvp` source [verified]. Needs wrangler tag v9. |

### Wave 4

| Item | Status | Evidence |
| --- | --- | --- |
| Health trigger | **Merged** | #1354 (`06fcb21c`) and #1376 (`791cf3d1`). One card per owner per local day (`health/trigger.ts:25, :352`), one evaluation per hour (`:19`), marks expire after 12 h (`:23`), only a zone change with an item in the next 24 h (`:21`); shadow until a baseline exists (`:317-318`) [verified]. Deployed to staging Worker `7bab4193`; not production. |
| WHOOP | **Code merged; approval plan-only** | `health/providers/whoop-*.ts`; routes answer `not_configured` without secrets; owner steps 1–7 in `docs/app/WHOOP_AND_OURA_2026-10-21.md` not done [verified]. |
| Oura | **Mappers only** | `health/providers/oura-map.ts`; no client, by design (Oura's terms) [verified]. |
| Health Connect client | **Backend ingest merged; client in waldo-app, not verifiable here** | `health_connect` source in `contracts/src/app/health-ingest.ts` [verified]. |
| Photon for iMessage | **Not started** | Only doc mentions [verified]. |
| WhatsApp production switches | **Not flipped** | `wrangler.jsonc:21`: template vars empty, `IMESSAGE_CONNECTOR_ENABLED` "0"; Meta verification resubmitted 22 Oct as ECOFRESH GREENSYNC LLP, in review [verified in source; verification state from the orchestrator's note]. |
| Onboarding and consent ledger O-1 to O-8 | **Open** | #1356 head `6ab65eed`, Ready, CONFLICTING; O-7 partial pending the standing-grant ADR [verified]. |

### Wave 5

| Item | Status | Evidence |
| --- | --- | --- |
| MCP client with OAuth, connect page C-1 to C-5 | **Merged, off in production** | #1357 via `06fcb21c`; `MCP_READ_INTENTS` "0", `WALDO_MCP_SERVERS` "[]" in production [verified]. Follow-ups #1388 (callback binding, migration `20261022040000`), #1393 (items 3–11, new secret `WALDO_OAUTH_STATE_SECRET`, fail-closed) open and CONFLICTING. |
| Health admin from mail | **Not found** | Only evals and fixtures mention refills or appointments [verified]. Gated by wave 3. |
| Launch jobs J-0 to J-7 | **Plan-only** | One mention, BUILD_DIRECTION line 53 [verified]. |
| Browser work, Browser Use bake-off | **Scaffold merged, unwired, off** | #1344 `6f4a6456`; `BROWSER_USE_ADOPTED_ERRAND_TYPES` empty; harness at `evals/browser-errand-bakeoff/`; no bake-off result [verified]. |

### Proof ladder

| Rung | Status |
| --- | --- |
| Recorded eval gate | Runs on PRs; grades nothing ("Graded 0" on #1364 and #1366 scorecards) [verified]. Floor 60 on the tip. |
| Live eval suite | **Never ran.** `evals-live.yml:34-36` needs `WALDO_EVAL_OPENAI_KEY`, `WALDO_EVAL_ANTHROPIC_KEY`, `WALDO_EVAL_JUDGE_MODEL`; `gh secret list` shows none; `:9-10` says schedules run only from the default branch (`main`); `gate.ts:26` `min_pass_rate: null` [verified]. |
| Voice and safety judge | Built (#1342); agreement with the owner unmeasured [verified]. |
| Memory suite | #1360 state and memory evals merged (`c5e44093`); blinding and the m02 receipt are owed in a follow-up [verified]. |
| Owner telemetry | Turn event v10 carries `cached` per model call (`contracts/src/telemetry/turn-event.ts:36`); both adapters fill it (`llm/openai.ts:100`, `llm/anthropic.ts:85`); the cost ledger stores it (`llm/cost-ledger.ts:43`) and Langfuse receives `input_cached_tokens` (`observability/otlp-turns.ts:85`) [verified]. No report or check turns it into a cache share per owner turn [verified: none found]. |

## 2. Architecture verdicts

Each verdict names the mature practice it is measured against, the call (keep, finish or redesign), the reason and the falsifier.

### 2.1 Memory: keep, finish

**What exists [verified].** One claims store in the owner's SQLite (`memory/claims.ts`) with `supersedes_id`, `valid_to`, `verification_status` (`owner-grounded` or null), origin and `source_ref`; pinned `owner_profile` (1,500 chars) and `owner_facts` (2,500 chars) blocks (`claims.ts:16-17`); keyword recall of 3,000 chars per turn (`memory/turn-recall.ts:10`); episodes in FTS5 with `search_episodes`; the `remember` tool with quote grounding and `replaces_id`; a nightly pass that extracts claim ops from the day and curates the pins. The five-hall `memory_blocks` and `memory_inbox` tables exist in the schema (`do-schema.ts:96-129`) and **nothing writes them**: no INSERT outside tests [verified].

**Mature practice [cited].** Anthropic's memory tool: "an agent records what it learns in memory files and reads them back on demand" and "memory preserves the information that must survive summarization" (platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool). Managed Agents memory: "Every change to a memory creates an immutable memory version, giving you an audit trail and point-in-time recovery" (platform.claude.com/docs/en/managed-agents/memory). Claude Code re-injects memory "from disk" after compaction (code.claude.com/docs/en/memory). 2026 evidence: agentic search over the raw record beat RAG on LongMemEval-V2 (72.5 vs 48.5, arXiv 2605.12493); agent-written memory scored below plain retrieval on MemDelta (42 vs 47, arXiv 2606.29914); LongMemEval found a 30% drop across sustained chats (arXiv 2410.10813).

**Verdict.** Keep. Claims plus episodes is the right shape: rows with provenance, a small pinned core, text search, supersession, a background pass. The evidence says the episode index and `search_episodes` are the strongest piece and the thing to protect.

**Finish, in this order.**
1. **Decouple M-4 from compaction.** #1379's flush runs inside `compactIfDue` (`owner-turn.ts:810-811`), so it never runs until compaction is on, and then only for chains past 70% of a 100k-token window. The brief's memory requirement is "facts save without a `remember` call" for every conversation, not for long ones. Move the flush to an idle trigger after delivery (debounced per chain, same `scope.admit()`, same numeric floor), with compaction calling the same function as one of its callers. Falsifier: the m-series evals in #1360 pass with the flush on and fail with it off; if they pass either way, the flush earns nothing.
2. **Promotion reads the unfiltered store.** `promote` builds `promotionInput(memory)` (`claims.ts:1274`), not the held-filtered `promptMemory()` the nightly consolidation uses [verified]. A topic the owner asked to forget can be promoted into a constellation node while its purge is pending. Privacy defect, MEDIUM: fix is one argument.
3. **Retire the dead halls schema and amend the ADRs that describe it.** ADR-0005 (five halls), ADR-0006 (inbox merge), ADR-0031 (`<recall>` block over halls) and ADR-0046 (supersedence through the Scribe seam on `memory_blocks`) describe a memory architecture the source never built; the claims store implements their intent under other names. This is contract drift at the ADR layer. Amend each with one paragraph naming `claims` and `episodes` as the canonical implementation, then drop `memory_blocks`, `memory_inbox` and their redaction entries after a read-only hosted check that they are empty. Source deletion needs the owner's authority (CLAUDE.md).
4. World time on claims (`valid_from` never populated; `valid_to` is correction time) stays the low-priority ADR proposal from the 13 Oct comparison.

**What not to do.** Do not add a vector store or a graph layer now. The 2026 numbers favour search over the raw record; `search_episodes` with stemming (the agent build plan's own ask) is the cheaper experiment. ADR-0078 (edges graph) stays proposed.

### 2.2 Context engineering: keep, finish two pieces, report one number

**What exists [verified].** A stable head (identity, voice v2, vocabulary, tasks, skills catalogue) and a per-turn tail; the owner's message carries recall and earlier tool results as fenced data; tool outputs live in a cross-turn ledger (six fragments per kind, 500 chars); `turn_only_output` keeps health tool text out of storage; parallel read batches of four; tool search built behind a flag; subagents on a bounded shared budget. The ContextComposer builds materials, skills, health and recall fragments with provenance (`context-composer/types.ts:28-31, 84-97`), but **memory blocks and recall do not pass through it**: the composer's recall is stubbed "unavailable/skipped" (`context-composer/owner-turn.ts:114-122`) and the claim renderer lives in `channels/owner-turn.ts` [verified].

**Mature practice [cited].** "finding the smallest possible set of high-signal tokens" and "One of the safest lightest touch forms of compaction is tool result clearing" (anthropic.com/engineering/effective-context-engineering-for-ai-agents). "More tools don't always lead to better outcomes" (anthropic.com/engineering/writing-tools-for-agents). Tool search raised tool selection from 49% to 74% on Opus 4 (anthropic.com/engineering/advanced-tool-use). The MCP 2026-07-28 changelog asks servers to order tools deterministically for cache hits.

**Verdict.** Parity. The prefix is byte-stable within a turn; across turns, standing orders and open loops still sit in the head (voice brief, 16 Oct), so a change to either moves the cache prefix. Finish:
1. **#1363 frozen turn context.** Its BLOCK was the right call: deciding reuse from rendered text missed topic forgets whose topic sat only in evidence. The fix (`forgetEpoch` plus a store-level forget generation) is the shape the forget redesign in §3 needs anyway; land it first.
2. **#1383 rule pruning.** The behaviour prompt is at its 15,500-byte ceiling with about 25 bytes left (voice brief). Pruning needs the live ablation runner, which needs the eval keys (§2.6).
3. **Report cache share.** Review bar question 4 asks for "cache share measured". The number exists per call: `cached` on the turn event v10, in `cost_ledger`, and in Langfuse `usage_details` [verified, §1]. Nobody has read it back: there is no query, console line or eval assertion that states cache share across consecutive owner turns, and the stable-prefix test proves identical bytes only across rounds within one turn (`test/owner-turn-stable-prefix.test.ts`). One Langfuse query over a staging week, recorded in the H-9 PR, is enough to start; a `cache_share` line on the console's trace view is the durable form. Without the number, H-4 and H-9 are unmeasured claims.

**Falsifier.** If cache share across consecutive owner turns is already above 80% with the head as it is, moving standing orders and loops out of the head is not worth a serializer revision.

### 2.3 Compression and compaction: finish as designed; keep off until the eval exists

**What exists [verified].** A token-aware window keeps the newest rows within about 100k tokens and drops the oldest with no marker (`conversation/window.ts:48-61`). The compaction row (`conversation/compaction.ts`) is built to the 13 Oct ADR draft: a summary of the oldest span, appended by the canonical store, `[summary] + [verbatim tail]`, triggered after delivery at 70% of budget, hourly at most, with `numericHealthIn` rejecting any numeric health before the write (`owner-turn.ts:820`) and forget setting the row to `omit`. It is off by a source constant. The option-A marker ("N earlier messages out of view") from the long-conversations brief was not built; the option-C working set (ADR-0057 buckets) has no runtime reference [verified].

**Mature practice [cited].** Anthropic server-side compaction "replaces the older turns of a conversation with a summary that Claude writes on the server"; "The block holds the summary as text you can read, and a signature. Send it in future requests exactly as it came"; a request fails when "The block's `signature` or `content` was changed after the API returned it" (platform.claude.com/docs/en/build-with-claude/compaction). OpenAI's compaction item "is opaque and not intended to be human-interpretable" (developers.openai.com/api/docs/guides/compaction). Context editing "replaces each cleared result with placeholder text" and "Claude can write essential information from tool results to memory files before those results are cleared" (platform.claude.com/docs/en/build-with-claude/context-editing).

**Verdict.** Keep the client-side row. Provider-native compaction stays rejected for the reason the 13 Oct brief gave and the docs now confirm: a signed or opaque block cannot be redacted in place, so a forget could never reach it. Finish:
1. **Write the flip eval** from the ADR draft's §6: two safety probes (no forgotten topic resurfaces; no invented approval) and five recall probes, switch on versus off, on the live suite. It does not exist. The flip waits for it.
2. **Add the option-A marker now.** One fenced line in the model's view saying how many earlier rows are out of view and that `search_episodes` reaches them. No model call, no store, no ADR. It makes the loss legible today, before compaction is on.
3. Tool-result clearing is already done by design (tool outputs are turn-only and ledgered), which is the "safest, lightest" form Anthropic names; nothing to add.

**Falsifier.** A staging count of `context_window` hops with `dropped > 0` near zero over two weeks of real owner use means compaction is not where context is being lost, and the flip can wait behind the health work indefinitely.

### 2.4 Forget: redesign

**What exists [verified].** `forget_memory` requires the topic to be a literal substring of the current owner message (`tools/live/memory.ts:95`); `hideHistory` cleans the KV stores first and throws on a remainder (`:110`); the commit writes a hashed barrier, DELETEs the claim, and runs `purge()` (`claims.ts:540-820`), which inserts `topic_purge_pending` before redacting (`:559-563`), redacts every store in `LITERAL_REDACTED_STORES`, and reads each store back with an exact match (`:770-812`). `ready` means nothing remains; `settle` deletes the pending rows (`:913-919`). Both redactors are case-insensitive substring replaces with no word boundary: `ciRedact` (`claims.ts:87-88`) and `literalTextRedactor` (`contracts/src/runtime/conversation-entry.ts:51-56`); so are the detectors `carriesTopic` (`memory/forget-guard.ts:27`) and `holdsIn` (`owner-turn.ts:341-342`). That is #1395: "team" became "[forgotten]m", permanently, at rest.

`topic_purge_pending` has no expiry column and is deleted only on a verified settle (`claims.ts:830, :914`) [verified]. While a topic is held, `heldTopics()` (`owner-turn.ts:339`) feeds **24 filter sites** in `owner-turn.ts`: claims, nodes, edges, pinned blocks and recall (`:371-377`), episode hits (`:452`), history messages (`:536`), standing orders (`:542`), earlier tool results (`:576`), task context (`:583-586`), the tool ledger (`:191-196`) and every in-loop tool turn (`:628` → `conversation/held-turns.ts:10-17`), where a public web page that mentions the topic is replaced whole by `HELD_TURN_OUTPUT`. That is #1286. The console lists purging claims but not bare held topics [verified].

**Correction to the brief.** The nightly pass is **not** gated by a held topic at `c5e44093`. `consolidate` returns `done: true` after the model call (`owner-turn.ts:915-920`); only `migrate()` throws on a held topic (`:927`), and `migrateCoreFiles` swallows that error (`owner-do.ts:3288-3298`) [verified]. #1396's root cause is unknown; the issue says so. The candidates are a provider timeout on a 40,000-character chunk, `assertFresh()` throwing, or an exception inside `applyClaimOps`; `wrangler tail` on hop `nightly_memory` at the next 21:46Z attempt decides it. What the held topic does break is the model's view: pages, history and recall go missing silently, which is the owner's "half the product".

**Mature practice [cited].** Managed Agents: "Redact scrubs content out of a historical version while preserving the audit trail (who did what, when)", "A version that is the current head of a live memory cannot be redacted" (delete the head; redact history), and Dreams "never deletes or modifies its inputs" (derived stores regenerate from inputs) (platform.claude.com/docs/en/managed-agents/memory, …/dreams). Meta Muse is the honest competitor baseline: "After you've deleted something from Muse, Muse may still remember information that it learnt from what you deleted" (meta.com/help/artificial-intelligence/2225571704857152). Context editing's placeholder is the analogue of Waldo's marker. No Anthropic page claims paraphrase-proof erasure; neither should Waldo.

**Verdict: redesign.** The guarantee is right and the mechanism is in the wrong place. The guarantee the owner needs is "the model never sees it again and nothing derived from it survives"; the mechanism built is "every store is proven clean before anything else may read". That makes a privacy barrier into a product outage. The redesign (§3) keeps the guarantee, moves the barrier to the one seam everything crosses, and makes the purge a background job.

**Falsifier.** A held-out forget eval (topic and paraphrase probes across replies, compaction rows, nightly output, cards and console) that passes on the current design and fails on the redesign. The redesign is also wrong if a real owner can tell, from redacted text alone, what was forgotten; the word-boundary marker leaks less than today's mid-word marker, and the eval must include that probe.

### 2.5 Nightly passes: keep the shape, fix five things

**What exists [verified].** `nightly-memory` at 03:00 local, kind `dreaming` (`channels/episodes.ts:182-205`): migrate (errors swallowed), `consolidateBacklog` (`owner-do.ts:3541-3567`: from `NIGHTLY_THROUGH_KEY`, 7-day floor, up to 3 chunks of 40,000 characters, mark moves only after a consolidated chunk, 15-minute catch-up, scheduler back-off then pause), `promote` (errors swallowed), day cards, plan. The failure notice "My overnight memory pass failed 3 times in a row, so I've paused it" reaches the owner's chat (`scheduler/failure-notice.ts:16`).

**Mature practice [cited].** Letta's dreaming "uses background subagents to review recent conversations" and runs "after a set number of completed agent steps or when the context window is compacted" (docs.letta.com). Anthropic Dreams: "duplicates merged, stale or contradicted entries replaced with the latest value, and new insights surfaced"; "The input store is never modified, so you can review the output and discard it"; runs take "minutes to a few hours" (platform.claude.com/docs/en/managed-agents/dreams). No primary source gives a cadence; all run between sessions.

**Verdict.** Keep: a between-sessions synthesis pass over the day's record, with corrections applied through code, is exactly the reference shape. Fix:
1. **Diagnose #1396 from logs before changing code** (above). Four nights of no learning is the live cost.
2. **Promotion reads the held-filtered view** (§2.1 item 2).
3. **Bound the chunk by topics, not characters.** A 40,000-character transcript to the auxiliary model is the likeliest timeout [inference]; the agent build plan already asks to bound the nightly prompt "to the day's topics plus pinned claims".
4. **Stop telling the owner about an internal job every night.** One notice the first night, then a line in the console's schedule health, is the honest version. The owner should hear when a promise is at risk (a Brief that will not come), not when a background pass retries.
5. When #1355 lands, run consolidation in a reader worker, as the plan says; the brain applies the ops.

**Falsifier.** If the 21:46Z trace shows `done: false` from the model's own output (schema or validation), the chunk bound is the fix; if it shows `provider_error` timeouts, the bound is the fix for a different reason; if it shows neither, the cause is elsewhere and items 3 and 4 wait.

### 2.6 Evals: finish, then gate on them

Live evals have never run [verified, §1]. Every flag-on decision in this document (compaction, tool search, rule pruning, voice judge agreement) is blocked on it. Anthropic's eval guidance asks for pass^k and a different grader model with human calibration (anthropic.com/engineering/demystifying-evals-for-ai-agents); the suite already has three trials and a split judge (`evals-live.yml:70-72`). What is missing is operational: the three secrets, a run from `main` (dispatch with `ref: beta-mvp`, as the runbook offers), a first baseline, then `min_pass_rate` set from it. Cost is about $14–55 a run [inference from the evals handover]. Suyash's 33 voice labels decide whether the judge can be trusted on voice at all; they are on hold until #1360's blinding follow-up lands.

### 2.7 The health plane: redesign per #1399, now

**What exists [verified].** The ingest contract accepts 14 signals (`contracts/src/app/health-ingest.ts:149-171`); the producer reads 9 (`health/producer.ts:25`); `sleep_efficiency`, `spo2`, `respiratory_rate`, `steps_window` and `active_energy_window` are stored and feed nothing. Interval kind is only `asleep` or `in_bed` (`health-ingest.ts:108-116`; `supabase/migrations/20261011020000_health_series.sql:171-176`), so sleep stages cannot be represented. Scores recompute only after a committed ingest or WHOOP's daily sync (`channels/app-health.ts:132-137`; `owner-do.ts:1044`); there is no scheduled recompute; stored rows are aged on read. Every algorithm is an unaccepted candidate (`recovery.candidate.v1`, `form.candidate.v3`, `weight.candidate.v3`). The trigger allows at most one card per owner per local day.

**Verdict.** Redesign the inputs, keep the authority split (backend computes once, app uploads summaries, ADR-0081). #1399 (docs-only, open) proposes exactly this: feed the five signals as drivers, keep sleep stages, `recovery.candidate.v2`, `weight.candidate.v4`, per-sample rejection at app health revision 3, clinical types deferred. It is the owner's first priority and two sessions hold it. The one addition this review makes: **freshness needs a schedule, not only an upload.** With HealthKit background delivery (ADR-0010) the phone wakes on new samples, but a quiet phone means a stale score at the Brief. A recompute at the owner's Brief time from whatever has arrived, with "as of" said out loud, is the honest floor.

**Falsifier.** If a two-week staging window shows every owner upload lands before the Brief, the scheduled recompute is unnecessary and only the signal and stage work remains.

### 2.8 Fixed rules that make judgment calls

CLAUDE.md allows deterministic rejection only for hard security and safety boundaries and asks that every other fixed rule be filed under `post-mvp-cleanup` or moved to model reasoning with scenario tests. Three remain in the harness [verified]:

- the `IRREVERSIBLE` word list over browser action descriptions (`tools/live/browser.ts:171, :177`), which can stop a read on a navigation label such as "Book" or "Continue with";
- the `/skills install|disable` exact-text match (`skills/curated-owner.ts:138`), which contradicts the no-slash-commands ruling and is not covered by #1253;
- the literal-substring requirement on `forget_memory` (`tools/live/memory.ts:95`), which is a judgment call about what the owner meant, not a safety boundary (the barrier and purge are the boundary).

None is in the next ten on its own; the first belongs to the browser wiring, the second to the skills lifecycle fix the voice brief names first, the third to the forget redesign (§3), where the model proposes the topic and the owner's words confirm it.

### 2.9 Proactivity and authority: at parity on safety, behind on "already on it"

The deterministic heartbeat, quiet hours, delivery gate and the one-card health trigger are stricter than Hermes or Claude Code `/loop` (13 Oct comparison §5). What Poke and Instinct have that Waldo does not is standing authority: a scoped, revocable grant that lets a proposal become an action without a card each time. `authority_grants` is single-use (`do-schema.ts`, `CHECK (use_limit = 1)`); #1356's O-7 stops at "day zero asks first" pending the standing-grant ADR. This is an ADR, not a commit (CLAUDE.md), and calendar is the owner-approved first area. It belongs in the next ten (§4, item 9).

## 3. The forget design

**Principle.** Forget is a privacy boundary, so its guarantee is deterministic (CLAUDE.md allows it). Its *cost* must land on the forgotten words, not on unrelated reads.

**Three parts.**

1. **A redaction barrier at the ContextComposer seam.** One function, `applyForgetBarrier(fragments, heldTopics)`, applied once to every fragment that enters the model's view: materials, workspace, tool outputs, recall, memory blocks, history rows, standing orders, task context, in-loop tool turns. Behaviour by origin:
   - external-origin text (web pages, mail bodies, MCP results): redact the topic's literal and encoded forms by word boundary (`(?<![\p{L}\p{N}])…(?![\p{L}\p{N}])`, `giu`) and keep the rest, with a typed note that text was withheld. This is #1290's proposal made general.
   - owner-origin stores (claims, episodes, history, ledger, loops): drop the matching item, never the whole read.
   - The 24 call sites in `owner-turn.ts` collapse to one, and the composer becomes the only path to the model, which it is not today (§2.2). Memory blocks and recall route through it as fragments with provenance.
   - Deletion test (language.md): delete the barrier and the forget guarantee disappears from 24 places; it earns its keep.
2. **Hard deletion of derived memory.** Claims (already DELETE), nodes and edges, aliases, FTS rows, pinned blocks, compaction rows (`omit` with marker), tool-ledger fragments, update cards, loop and outbox payloads (#1372's `node.forget` gap), WhatsApp and iMessage held cards: delete or regenerate from redacted inputs, never redact in place. The owner's transcript rows are the one place redaction in place is right, by word boundary, because the transcript is the owner's own record and ADR-0055 requires erasure, not a rewrite.
3. **An asynchronous purge that gates nothing.** The purge is a keyed job (alarm lane now, `task_jobs` once #1355 lands), idempotent per topic fingerprint, one retry owner, per-store receipts. While any store is pending, the barrier is the guarantee for the model's view; no read is withheld whole, no nightly step defers, no migration waits. The hold has **no TTL** (the privacy boundary stays), but a held topic now costs a few redacted words rather than whole pages.

**What stays.** The literal-substring requirement on the owner's message (the owner names what to forget), the hashed re-admission barrier, `touches_forgotten` in the nightly extraction, compaction regeneration from redacted rows, and honest receipts that name every store still pending and the stores outside reach (traces, backups, copies the owner shared).

**What the word-boundary session must also change.** Detector (`carriesTopic`, `holdsIn`), redactor (`ciRedact`, `literalTextRedactor`) and readback (`exact`, `claims.ts:774`) have to move together; a boundary-aware redactor with a substring readback leaves every topic pending for ever [inference, from the source map]. Compound words ("teapot" when "tea" is forgotten) stay; that is the owner's call (§5).

**Owner visibility.** Held and pending topics appear on the console memory page with a "retry forget" action, and the receipt says what the barrier is still covering.

**ADR changes.**
- **ADR-0055** (GDPR deletion runbook): add the per-owner forget cascade with the DO store enumeration above, each with mechanism and latency; name Langfuse traces, provider logs, the R2 archive and the 30-day Durable Object point-in-time restore as residue the receipt must mention (the agent build plan already asks for the PITR line in the owning contract).
- **ADR-0046** (external truth invalidates memory): add erasure as the third operation beside supersede and invalidate: erasure deletes derived understanding and leaves a fingerprint tombstone; it runs through the same single seam.
- **ADR-0024** (Scribe sanitiser): the forget barrier is a deterministic check at the `internal_context` and `system_prompt` destinations, listed beside the health and canary checks.
- **ADR-0031** (recall-before-act): the recall renderer applies the barrier; recall fails open on availability but never on the barrier.
- **New ADR** (or the compaction-row ADR's forget section widened): barrier semantics (redaction, not withholding; by origin), asynchronous purge, no gating of nightly or compaction, no TTL, owner visibility, honest receipts.

## 4. The next ten changes, ranked by owner value

Health wedge first, then what makes every general task safer or faster. "Opus" means a design or security session; "Sonnet" means implementing a settled design.

| # | Change | Session | Files | Depends on | Proof |
| --- | --- | --- | --- | --- | --- |
| 1 | **Apple Watch completeness and freshness**: feed the five unused signals as drivers, represent sleep stages (app health revision 3), scheduled recompute at Brief time with "as of", and the `source_as_of`/`stale_at` columns ADR-0081 §2 lists and the row lacks | Opus (ADR-0081 amendment, #1399 AW-1–AW-8), then Sonnet | `contracts/src/app/health-ingest.ts`, `health/producer.ts`, `health/scores/*`, a `health_series` migration, `channels/app-health.ts`, the `provider_sync` executor | Owner's AW decisions; waldo-app for the client | Unit and synthetic-ingest fixtures; a staging upload E2E where the Brief's zone words reflect a stage-bearing night and a quiet phone still gets a fresh "as of" |
| 2 | **Live eval on**: secrets set, `evals-live.yml` runs from `main` with `ref: beta-mvp`, first baseline, `min_pass_rate` set | Sonnet | `.github/workflows/evals-live.yml`, `packages/runtime/evals/nightly/gate.ts` | Owner sets three secrets (§5) | One green scheduled run with pass^3 and a floor |
| 3 | **Forget redesign** (§3) | Opus design, Sonnet build | `memory/forget-guard.ts`, `memory/claims.ts`, `contracts/src/runtime/conversation-entry.ts`, `conversation/held-turns.ts`, `context-composer/*`, `channels/owner-turn.ts` | The word-boundary session (coordinate, do not duplicate); #1363 first | Forget eval with paraphrase probes; zero `HELD_TURN_OUTPUT` whole-page withholds in staging traces; the nightly runs every night |
| 4 | **Nightly: diagnose #1396 from the 21:46Z trace; promotion on the held-filtered view; the numeric health floor on nightly claim writes (today only `remember` gets it, in #1381); one failure notice then console** | Sonnet | `channels/owner-turn.ts` (`promote`, `consolidate`), `memory/claims.ts` (`promotionInput`, `applyClaimOps`), `scheduler/failure-notice.ts` | #1381 | A test that a held topic never reaches a node; a test that an owner-typed reading in the day's transcript never lands in a claim (the h05 eval relies on the model today [inference: its mechanism was not read]); a staging night that consolidates |
| 5 | **Land lane A in the mapped order** (#1363 → #1379 with the M-4 decoupling → #1383 → #1364, #1365, #1366, #1378), each re-walled on its merged head | Gate; Sonnet carries | As the PRs | Item 2 for #1383's ablations | CI 7/7 and the local wall per merged head |
| 6 | **Health-aware proof**: a trigger case in the nightly world (zone words plus a calendar event), the build handoff's health cases (low-recovery morning with and without a wearable, a dose question, "still learning"), and a timing read-out from staging traces (false interrupts and missed moments per owner per week, the review bar's "fewer than 1 per owner per week") | Sonnet | `packages/runtime/evals/nightly/*`, `gate.ts` floor; a Langfuse query | Item 2 | The cases run live and pass; floor raised; the two timing rates reported once |
| 7 | **Google OAuth to production status**; brand and scope verification started; the Workspace MCP agentic-client switch before 2026-11-11 | Owner, then Sonnet for docs | GCP console; `docs/research/GOOGLE_INTEGRATION_2026-10-21.md` | Owner | A test account's refresh token survives eight days |
| 8 | **Worker layer** #1355 landed with wrangler v9 (and #1334's v8 renumbered after it), then nightly consolidation in a reader worker | Gate; Sonnet carry; Opus for the reader move | As the PR; `channels/owner-do.ts` nightly | #1355 carry of the tip | Its workerd end-to-end tests; a staging night consolidated by a worker |
| 9 | **Standing grants ADR, calendar first** (owner/resource/parameter/time/budget scoped, revocable, rechecked before dispatch and resume) | Opus | `waldo-brain` ADR; later `do-schema.ts` `authority_grants`, approvals | Owner's yes to the area | A scenario where a granted calendar move runs without a card and a revoked one does not |
| 10 | **ADR drift and dead schema**: amend ADR-0005/0006/0031/0046/0055 as in §2.1 and §3; publish the compaction-row ADR; drop `memory_blocks` and `memory_inbox` after a hosted empty check | Opus docs; Sonnet migration | `waldo-brain` ADRs; `docs/foundation/accepted-adrs.json`; `packages/runtime/src/do-schema.ts` | Owner's yes to deletion | `verify` green; the forget store table test passes without the two tables |

Not in the ten, and why: tool search flag-on waits on item 2 and a staging smoke; the cost cap flip is a one-line config decision (§5); WhatsApp and Photon wait on Meta and a vendor; browser wiring waits on the team's redraft and on item 8.

## 5. Owner decisions

Each is yes or no, with the recommendation first.

1. **Set `WALDO_EVAL_OPENAI_KEY`, `WALDO_EVAL_ANTHROPIC_KEY` and `WALDO_EVAL_JUDGE_MODEL`, and let the live suite run from `main` against `beta-mvp` (about $14–55 a run)?** Recommend **yes**. Nothing else in this document can flip without it.
2. **Adopt the forget redesign: redaction barrier at the composer seam, derived deletion, asynchronous purge, no whole-read withholding?** Recommend **yes**. It keeps the guarantee and removes the outage.
3. **Word-boundary matching, accepting that a forgotten word inside a compound word survives?** Recommend **yes**. The alternative keeps corrupting unrelated words at rest. Reject the "substring for 5+ characters" middle path: two rules where one will do.
4. **Keep no TTL on held topics?** Recommend **yes**, because after decision 2 a held topic costs words, not pages.
5. **Decouple the M-4 flush from compaction and run it on idle?** Recommend **yes**; otherwise M-4 ships and never runs.
6. **Keep compaction off until the §6 eval exists and passes?** Recommend **yes**. Approve the option-A marker now.
7. **Amend ADR-0005/0006/0031/0046 to name claims and episodes canonical, and delete `memory_blocks` and `memory_inbox` after a hosted empty check?** Recommend **yes**. The ADRs currently describe software that does not exist.
8. **Publish the Google OAuth consent screen to production and start verification (brand, sensitive scopes; CASA for `gmail.readonly`)?** Recommend **yes**; until then every tester re-links weekly, and Waldo should say so in the reconnect notice.
9. **#1399's AW-1 to AW-8, plus a scheduled recompute at Brief time?** Recommend **yes** to the five signals, sleep stages and the schedule; **defer** clinical-adjacent types as #1399 proposes.
10. **One nightly failure notice, then quiet, with a console line?** Recommend **yes**.
11. **Turn `WALDO_COST_LEDGER_SYNC=on` on staging now that the migration is applied, so the $25 ceiling and the month total are real?** Recommend **yes** on staging; the ceiling value stays provisional (#1277).
12. **Merge #1334 in the bundled deploy, after #1355's v9 and a renumber to v10?** Recommend **yes**; the storage check is SAFE.
13. **Standing grants, calendar first, as an ADR?** Recommend **yes**; it is the shortest path to "already on it" that the review bar allows.
14. **Which pilot bars govern?** Two designs exist: the wedge doc's wearable-day versus check-in-day comparison (acceptance 1.3× higher, 3+ accepted health actions a week, 60% active at day 30, under one false alarm a week), which BUILD_DIRECTION points to, and the health-niche doc's care-loop bars (4+ loops closed a month, refills on time, 12 of 20 active, 6 of 20 paying). Recommend **the wedge design governs**, with "refills on time" kept as the one care-loop measure, because the launch frame is now wearable owners and the thesis to falsify is that body data beats a one-tap question.

## 6a. What the owner documents add, and where they disagree

Read in full this session: the build handoff, agent build plan, launch brief, personality north star, v1 build, wedge, onboarding research, voice and prompt brief, backend position (14 Oct, both "not covered" tabs) and health niche and rollout.

- **Settled by BUILD_DIRECTION, so no action:** the agent build plan's India-first cohort and pricing, and the health-niche doc's "India first, then the US" and "the loops need health context, but not a wearable", are superseded by the 21 Oct decisions. The niche doc's eight backend changes are all in the waves except "onboarding seeds the medication schedule", which needs the ADR-0081 contract review the plan itself asks for.
- **Still open from the 14 Oct "not covered" list and absent from BUILD_DIRECTION:** forget beyond the owner object (R2 archive, Langfuse traces, the 30-day DO point-in-time restore: G59, G60), a retention schedule (G61), owner-typed health text stored verbatim in the transcript and the episode index (G37; allowed for conversation rows by the beta ruling, but the index and the nightly extraction read it, see §4 item 4), recall scoped to a chain (G6), and a private no-memory chat (G11, the parity doc's M7). The first three belong in the ADR-0055 amendment (§3); the last two are owner calls, not launch blockers.
- **From the voice and prompt brief:** editing a skill's text silently disables it for every existing owner (version hard-coded in `skills/bundled-file.ts:28`); the behaviour prompt has about 25 bytes of headroom; the REASONS canvas carries a second, weaker one-line voice. The first is a trap to fix before any skill edit; the other two are H-9's job.
- **From the personality doc and build handoff:** the health voice (zone words, own normal, "still learning", a short night is a scheduling reason, never a diagnosis) and the near-medicine line are prompt material with eval cases, not rules; they are item 6's cases.
- **From the launch brief:** Photon's three checks (proactive messages on shared numbers, platform risk, a BAA) and the model provider's zero-retention terms are approvals on other clocks; nothing in the harness waits on them except the iMessage proactive fix (#1378), which is in the ten.

## 6. Corrections to the 22 October brief

- **H-5 is in source and on**, since `19ccd5e8` on 21 Oct (§1). The brief's "[inference] not found" should be struck.
- **#1396 is not caused by the held topic** at `c5e44093` (§2.4). The held topic breaks the model's view, not the schedule. Diagnose from the trace before changing the nightly.
- **Google's 7-day expiry is confirmed**, not inferred: "a publishing status of 'Testing' is issued a refresh token expiring in 7 days" (developers.google.com/identity/protocols/oauth2, "Refresh token expiration"), and the project is Testing/External with 7 of 100 test users (google-connectors note, 21 Oct).
- **Cache share is recorded but never reported** (§2.2). The review bar's "measured" is half true.
- **M-4 as opened never runs** while compaction is off (§2.1).

## 7. Sources

Repository: `origin/beta-mvp` `c5e44093`; `docs/planning/BUILD_DIRECTION_2026-10-21.md`; `docs/research/HARNESS_COMPARISON_2026-10-13.md`; `docs/planning/lanes-2026-10-11/LONG_CONVERSATIONS_BRIEF.md`; `docs/proposals/ADR_DRAFT_CONVERSATION_COMPACTION_ROW_2026-10-13.md`; `docs/evals/SELECTIVE_FORGETTING_INTEGRATION.md`; `docs/planning/MEMORY_ROADMAP.md`; `docs/planning/MATURE_AGENT_MEMORY_PARITY_2026-10-02.md`; `docs/planning/FORGET_COVERAGE_AUDIT_2026-10-02.md`; PR #1359's README, progress log and comments; issues #1286, #1290, #1395, #1396; PRs #1355, #1356, #1363, #1379, #1383, #1399 and the 46 open PRs listed on 22 Oct. Sibling session notes of 21 Oct (harness-prompt, harness-turn, evals, worker-layer, wearables, connectors, google-connectors, onboarding).

Owner documents (Claude Docs, read 22 Oct): Waldo build handoff; Waldo agent build plan (rev of 19 Oct); Waldo launch brief (20 Oct); Waldo personality: north star; Waldo v1 build; Health as Waldo's wedge; Waldo onboarding: how a real assistant starts; Waldo voice, skills and prompt brief (16 Oct); Waldo backend position, 14 October; Waldo health niche and rollout.

ADRs (`Pin4sf/waldo-brain`): 0005, 0006, 0010, 0024, 0031, 0046, 0055, 0057, 0077, 0081.

Primary sources quoted: Anthropic, effective context engineering (29 Sep 2025); compaction and compaction-on-demand docs (beta `compact-2026-09-04`); context editing; memory tool; Managed Agents memory (`agent-memory-2026-07-22`) and Dreams (`dreaming-2026-04-21`); Claude Code memory and context-window docs; writing tools for agents (11 Sep 2025); advanced tool use (24 Nov 2025); demystifying evals (Jan 2026). Letta dreaming docs. OpenAI Responses compaction guide. Meta Muse help page (memory). Google OAuth 2.0 refresh token expiration. arXiv 2410.10813, 2504.19413, 2605.12493, 2606.29914, 2605.06527.

Not verified: any deployed environment beyond what #1359 records; the waldo-app client; Meta, WHOOP, Oura and Photon approval state; the two sessions' unpushed branches (`fix/forget-word-boundary-held-consolidation` has no commits; the freshness session's branch is not on origin).
