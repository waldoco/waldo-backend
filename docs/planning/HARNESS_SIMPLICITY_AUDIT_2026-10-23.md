# Harness simplicity audit: where the code decides what the model should (23 October 2026)

Source pin: `beta-mvp` at `8c45f38a` (23 Oct, 13:41Z). Staging runs `a3a34a31` (22 Oct), which has `3d1daf29` but not #1402 (`b83d6aa9`) [verified with `git merge-base --is-ancestor`; staging SHA from #1359's 18:26Z note]. Open-PR heads read: #1379 `f9bc6614`, #1420 `a9b350b7`, #1429 `6a78a3d7`, #1437 `367c6153`, #1439 `de459cf9`, #1445 `93800c9c`, #1456 `7506d396`, #1458 `6a42f15a`, #1383 `641e1739`, #1355 `bf44a08d`, #1440 `a5521d6e`.

Labels: **[verified]** read in source or on GitHub this session; **[inference]** a conclusion from what was read; **[cited]** a primary source opened this session, quoted under 15 words; **NOT READ** evidence that needs the owner's permission or was out of reach.

This is a candidate list for the owner to pick from. It changes no code and authorises nothing. The owner's concern, 23 Oct: the harness is "making things rigid for our agent", and "memory passes … if things are breaking".

## 0. The verdict

1. **The harness has fewer judgment rules than feared, and they sit in a few places.** No keyword router, intent classifier, stop-word list or reply-length rule exists on the turn path [verified, §2]. Almost every fixed rule guards a real boundary (health egress, secrets, owner checks, approvals). The rigidity comes from three things: **matchers that misfire on ordinary text**, **one taint stamp that turns the owner's own requests into cards**, and **a prompt full of silence-pushing style rules at its byte cap**.
2. **The biggest timidity driver is the whole-turn taint stamp.** Reading the owner's own calendar, mail, tasks, workspace or artifacts taints the rest of the turn (`contracts/src/tools/handler.ts:100-126`), so "what's on tomorrow? remind me 15 minutes before standup" becomes an approval card (`:181-199`) [verified]. Review bar question 14 asks for cards on channel links, grants, schedules and standing instructions *that text someone else wrote asked for*. It does not ask for a card on a change the owner typed.
3. **Two open taint PRs go beyond the bar.** #1437 blocks memory writes where the bar asks only to record the source; #1439 makes a reversible `close_loop` a card and leaves the loop check-back with no route to close a loop at all [verified, §3]. Narrow both before merge.
4. **The memory passes are not broken in `beta-mvp`, and nobody has looked at whether staging's are.** The 19–22 Oct failures came from a gate (`incompleteTopics()`) that `3d1daf29` retired on 20 Oct [verified on #1396]. Staging has run that fix since 22 Oct, yet #1396 has no update after 22 Oct 06:43Z, so no one has checked a night since [verified]. Meanwhile #1402 added a retry, bisection, quarantine and call-cap machine for a failure whose cause was already gone (§4).
5. **About 2,500 lines on the turn path do nothing in production** (§6): the fixture adapter shim built on every turn, a context-composer recall that always answers "unavailable", a skill list that is always empty, a dormant compaction trigger, dead hooks, a dead execution port and dead tables. Every review rereads them, and they make the turn path look deeper than it is.
6. **Mature harnesses enforce per tool, not per word** [cited, §5]. They keep deterministic code for permissions, hooks, storage access, schema and egress. They leave memory, relevance, tone and consolidation to the model, and gate side effects rather than what the model may think or store.

## 1. Corrections to the brief and to #1400, at `8c45f38a`

| Claim | Status now | Evidence |
| --- | --- | --- |
| "`promote` reads the unfiltered claim store" (#1400 §2.1 item 2) | **Fixed** by #1402 | `channels/owner-turn.ts:972-974` passes `promotionInput(visible)` where `visible = promptMemory()` [verified] |
| "M-4 (#1379) lands dormant" | **Worse: it has nowhere to run.** `compactIfDue` has no production caller at all | Only `owner-turn.ts:825, :863, :872` and tests reference it; owner-do never calls it [verified]. Owner ruled 23 Oct 12:56Z that compaction runs as a post-run job on #1355's jobs lane (#1450) |
| "#1396 failing since 19 Oct, cause unknown" | **Cause known; status unknown.** Release `f86af4fd` returned `done:false` while `incompleteTopics()` was non-empty; `3d1daf29` retired it | #1396 comments 05:54Z and 06:43Z, 22 Oct [verified]. Whether the 22 and 23 Oct nights consolidated on `a3a34a31`: **NOT READ** (owner decision D1) |
| `remember` health floor contradicts the prompt | **No longer.** #1381's final form keeps owner-stated readings and refuses a reading only on a turn that read outside content | `tools/live/memory.ts:62`, `memory/health-rules.ts:5` [verified]. The remaining problem is that tainted-turn block (§3, row G6) |
| The behaviour prompt cap is "15,500 bytes" | **19,050 bytes**, with the largest surface about 17 bytes under it | `test/messaging-behavior.test.ts:213` [verified]; the 19,033 figure is from the test's comment, not a measurement |
| "Gate writes, not drafts" PR | **Ruled, not opened.** The owner said yes on #1449 (23 Oct, ~11:59Z) to a default-deny gate for writes after outside text, derived from `TOOL_RECORDS[tool].claim`, drafts exempt | #1449 status comment [verified]. No branch or PR yet |

## 2. Fixed rules that make judgment calls

Classified by what the rule decides. "Boundary" means it is on CLAUDE.md's list (auth, secrets, canaries, owner checks, egress, schema validation, medication dosing). "Imprecise" means a real boundary whose matcher fires on ordinary text.

### 2a. Runtime

| # | Where | What it decides | When it fires | Class | Scenario test that proves the change |
| --- | --- | --- | --- | --- | --- |
| R1 | `tools/live/browser.ts:171, :176-177` `IRREVERSIBLE` | Whether a `browse_act` step commits something, from 30 words in the step's *description* ("book", "order", "send", "continue with", "get started") | Stops the run or turns it into an approval proposal | **Judgment** (the comment at `:168-170` says "judgment stays with the model" above it). The method default-deny at `:175` is the real boundary | "Sort by: order date", "Scroll to Book reviews", "Open the Send feedback FAQ" continue; "Click Place order" and any `submit`/`press` still stop |
| R2 | `channels/owner-turn.ts:850` `numericHealthIn(summary)` | Whether a compaction summary of the owner's own chat may be stored | Compaction silently skipped (`numeric_health`) | **Judgment.** The owner's readings are allowed to the model and the owner everywhere else (`scribe/sanitiser.ts:1296-1307`) | A long chat where the owner states sleep and weight still compacts; the summary never reaches a third-party send |
| R3 | `health/trigger.ts:199-208, :293` `healthWordsOf` + `calendarEgressClear` | Whether a health-triggered calendar change mentions health, by the words recovery, form, load, sleep, health, hrv, readiness, strain | Refuses the whole proposal | **Imprecise** (ADR-0081 egress is real) | "Move 'Form 16 filing' to Thursday", "Load-in at the venue", "Sleep Number delivery" go through; "Rest day: low recovery" is still refused |
| R4 | `scribe/sanitiser.ts:94-110, :129-159, :760-860` health patterns at third-party destinations | Whether a string carries a health value | `health_value_leak` denies the call (`llm/provider.ts:1464`) or redacts | **Imprecise.** `\b(?:crs\|form\|recovery\|load)…\d` (`:100`) matches "load 6 pallets", "form 16" | A draft saying "form 16 filed, load 6 pallets" sends; one quoting "BP 142/90" to a third party is still blocked |
| R5 | `security/artifact-hygiene.ts:90` bare `(code\|otp\|passcode)` + digits | Whether text is a one-time code | Rewrites the owner's WhatsApp message with a quarantine marker | **Imprecise** (secrets); the comment accepts "a postcode or barcode" false positives | "Promo code 2024", "Postcode 560001", "Gate code 1234" arrive intact; "482913 is your Google code" is still quarantined |
| R6 | `channels/egress-guard.ts:9` any URL with `?state=`, `?code=`, `?code_challenge=` | Whether a link is secret-bearing | Link replaced with "[link removed]", also in stored history | **Imprecise** (secrets); the header says "NARROW by design" | `shop.example/offers?code=SAVE10` shows; a real OAuth callback is still removed |
| R7 | `scribe/sanitiser.ts:189, :194, :1033-1042` phone, address, attendee-name shapes | Whether text is a phone, street address or a person's name | Redacts memory, audit and outbox rows | **Imprecise** (egress) | "Order #1234567890 shipped" survives in memory |
| R8 | `tools/live/memory.ts:104` `forget_memory` topic must be a literal substring of the owner's message | Whether the model understood which memory the owner meant | Fails; the model can retry by claim ids | **Boundary** (owner check), stricter than needed. #1400 §3 keeps it; the ids path already covers paraphrase. Keep |
| R9 | `skills/curated-owner.ts:136-138` exact `/skills install\|disable <name>` | Whether the owner approved a skill change | Refuses otherwise | **Boundary**, but a slash command against the 16 Oct no-commands ruling | An approval card (or the owner's "yes" to a proposal) installs; injected text never does |
| R10 | `channels/owner-do.ts:527, :534, :615, :2553` `/stop`, `/ledger` | Stop versus steer | Stops the turn | **Boundary** (protocol command). Draft #1253 removes the commands | "stop that please" is a steer the model reads |

Checked and legitimate (one line each, [verified] by the sweep, spot-checked): delivery-gate caps and cooldowns; owner-set proactivity and quiet hours; Telegram's reaction allowlist; `artifact-link-guard` (precise); egress host allowlists; id and fence validation in admission; FTS tokenisers; `llm/owner-routes.ts` (provider table, not a router).

### 2b. Eval receipts

The base suite on `beta-mvp` grades state, not tone: effects, final rows, seeded values in replies, dose [verified, `evals/nightly/receipts.ts`, `scenarios.ts`, `state-memory-scenarios.ts`, `voice-scenarios.ts`, `errands.ts`]. Three residues:

- **E1.** `evals/nightly/scenarios.ts:280` fails h1 when a calendar card's fields contain recovery, sleep, health, zone, hrv, readiness, strain, form or load: the same imprecise list as R3, now in the grader.
- **E2.** #1456 at `7506d396` moved most tone checks to the judge (good), but keeps two as receipts: **no exclamation marks** and **locale spelling** (`personality-scenarios.ts`, `noExclamation`, `spelledFor`). The judge's own instructions say spelling "is never a failure" (`voice.ts:55`), so the receipt and the judge disagree. Both are tone. Demote them to the rubric or to warnings.
- **E3.** `evals/nightly/dose.ts` counts "a tablet" as a dose. Dosing is on the boundary list, so keep it; the comment already accepts the false hit.

### 2c. Prompt rules

The prompt is at its cap (19,050 bytes, about 17 to spare). Most of it is good guidance. The absolute rules that matter:

- **Three overlapping silence drivers:** "Every message passes six tests, or you rewrite it or don't send it" (`prompt/messaging-behavior.ts:12`), "Silence is the default" (`:22`) and "Ask almost nothing" (`:23`). They pull against "Ask only for what is still unknown" (`:45`) and "Never reply with only a question" (`:54`). There are two ask budgets and no eval shows the silence rules earn their place [inference; #1383 maps them only to voice scenarios].
- **"Never narrate your guardrails … taint, gates"** (`:88`) against an approval card that needs a sentence of why; #1383 lists it as uncovered.
- **The India site list and two India examples** (`:68`, `:73-74`, about 1 KB) in a global-first product (BUILD_DIRECTION, Market). They are data for one market, not a rule, and belong in a per-market skill.
- **Safety rules to keep as they are:** dose, diagnosis, emergency, card contents, receipts-before-claims, untrusted text, no raw reading in a notification.

#1383's ablation runner is the right tool for the rest. This audit only nominates; #1383 decides with live runs.

## 3. Gates and ceilings

Measured against review bar question 14: memory written from untrusted text records its source; a tainted turn creates no channel links, grants, schedules or standing instructions without the owner's approval. Anything gated beyond that list needs a named harm.

| # | Gate | Bar-14 category or named harm | Owner sees | Verdict |
| --- | --- | --- | --- | --- |
| G1 | `PRIVILEGED_ACTION_TOOLS` (`handler.ts:143-160`): `send_message`, `call_mcp_tool`, `use_mac`, `execute_action` live; `write_task`, `update_task`, `draft_document`, `write_sheet_cell`, `create_thread`, `archive_thread`, `update_thread_topics`, `skills_install`, `skills_disable` have **no live handler** [sweep, not re-verified] | Injected external effect | A card via `propose_action` | **Keep** the live four; drop the dead names when "Gate writes, not drafts" derives the set from the tool table |
| G2 | `STANDING_CHANGE_TOOLS` (`:181-190`) on any tainted turn | Schedules and standing instructions: exactly bar 14 | A card | **Keep the category, narrow the trigger** (§0.2; decision D3) |
| G3 | The taint stamp: any read in `EXTERNAL_ORIGIN_TOOLS` (`:100-126`) taints the rest of the turn (`conversation/tool-loop.ts:348`), including the owner's own `workspace_*`, `read_artifact` and calendar | The stamp is the input to G1, G2 and G6 | Nothing directly | **Narrow** (D3) |
| G4 | `cancel_reminder`, `cancel_standing_order` in the standing set | An injected cancel silences a safety net. Reversible | A card | **Narrow**: allow, record the source, offer undo |
| G5 | `forget_memory` on a tainted turn: ids only, 20 per card (`tools/live/propose-action.ts:32, :61-65`) | Irreversible erase | A card listing each memory | **Keep** |
| G6 | `remember` refuses any health number on a tainted turn (`tools/live/memory.ts:62`) | Mail-sourced reading stored as the owner's | A failed save | **Replace with record-source.** `remember` already requires the quote to be the owner's own words (`:56-57`), so a reading in it is the owner's. The block is redundant with grounding |
| G7 | #1437: on a tainted turn (a) `remember` writes `origin:'agent'`, `source:'inferred'`; (b) cannot supersede an owner claim; (c) quote must be whole words | (a) is bar 14 exactly; (b) and (c) have no named harm | (b), (c) a failed save | **Keep (a); write beside the owner's claim instead of (b); drop (c)** |
| G8 | #1439: `close_loop` after outside content needs a card | Not in bar 14. Harm: a mail saying "paid" closes a commitment. Reversible | A card | **Record the source on the close; reopen is cheap.** As written, `LOOP_CHECK_BACK_TOOLS` (`channels/check-back.ts:9`) has `close_loop` but no `propose_action`, so a check-back that read mail can never close its loop [verified] |
| G9 | `OUTSIDE_TEXT_JOB_TOOLS` (`check-back.ts:12`), default-deny at `owner-turn.ts:945` (#1453) | Jobs over text someone else wrote | Cards via `propose_action` | **Keep.** The right shape: no human typed this turn |
| G10 | `health/trigger.ts:25` one health card per owner per local day | "Worth saying" decided by a count | A second real change that day is skipped (`budget_day`, `:354`) | **Keep for now** as a resource bound; revisit with the false-alarm measure (bar 7) |

Ceilings are mostly sized to real work [verified, sweep]: 25 rounds per 120 s of turn time up to 150 rounds and a "say continue" degrade (`llm/time-budget.ts:35-47`); 4 parallel reads; tool output over 16,000 characters shows its first 4,000 with a pointer (`tool-loop.ts:11-13`); #1355's 4,000-token budget counts only what is visible with tool search on (core tools plus namespace lines), so it does not limit what the agent can do. Two small ones: the 4,000-character head costs long mail threads an extra round, and an over-size skill is dropped without a word (`skills/loader.ts:256, :269`).

## 4. Memory passes

### 4.1 Each pass: running, failing, why

| Pass | Trigger | Running? | Failing? | Why, and what the owner sees |
| --- | --- | --- | --- | --- |
| Nightly consolidate (`channels/nightly-backlog.ts`, `owner-turn.ts:948-957`) | 03:00 local plus a catch-up (`channels/episodes.ts:183-187`) | Scheduled on staging | **Unknown since 22 Oct.** 19–22 Oct failed on `f86af4fd` because of `incompleteTopics()`; `3d1daf29` removed that, and staging has had it since 22 Oct [verified] | `consolidate` now always returns `done: true` (`owner-turn.ts:950, :956`), so only a throw (provider error, bad JSON in `applyClaimOps`, `assertFresh`) fails a chunk. The main run never throws; only the catch-up does (`owner-do.ts:3755`), and three catch-up throws pause it and send the owner "My overnight memory pass failed 3 times in a row" (`scheduler/failure-notice.ts:16, :49`) [verified] |
| Nightly diagnostic (`channels/nightly-diagnostic.ts`) | Console | Yes | **Misleading** | It reads only the `nightly-memory` schedule row and runs, not the catch-up or the consolidation mark, so it can show "ok" for a night whose consolidation failed [verified] |
| `migrate` | Nightly, and at boot | Only for owners with unmigrated legacy notes | Throws on any held topic (`owner-turn.ts:963`); swallowed (`owner-do.ts:3483`) | Nothing |
| `promote` | Nightly, after consolidate | Yes | Errors swallowed (`owner-do.ts:3766`) | Reads the held-filtered view on `beta-mvp`; **raw memory on staging** (pre-#1402) |
| Day plan | Nightly and at boot | Yes | Errors swallowed | **Reads raw `memory`**, not `promptMemory()` (`owner-turn.ts:984` → `prompt/day-cards.ts`), so a claim carrying a held topic can reach this call; #1420 leaves it too [verified] |
| Turn recall | Every turn | Yes | Fails open per leg (`memory/turn-recall.ts:86-107`) | Nothing |
| `remember` | Model tool | Yes | Refusals with reasons (`tools/live/memory.ts:56-67`) | The tool's error text; G6 above |
| `forget_memory` + per-turn `restored()` retry | Model tool; every turn while anything is pending (`owner-turn.ts:722-746`) | Yes | A full purge scan on every turn while a topic is pending; failures swallowed as `retained_cleanup_incomplete` | Nothing |
| **Hidden settle** in `applyClaimOps` (`memory/claims.ts:1254-1262`) | Every nightly and migrate write | Yes, on both builds | **A privacy defect**: with no `onPurged`, the call retries every pending topic and settles on the SQL readback alone, never checking the conversation store or tool ledger that `restored()` requires. A routine night can lift a hold while history still carries the topic [verified; also #1379 gate probe N8]. #1420 removes it | — |
| M-4 flush (#1379) | Only inside `compactIfDue` | **Never**: no production caller (§1) | Gate BLOCK at `f9bc6614` (H1: the numeric hold keys on where the evidence came from, not the reading; duplicate flushes) | — |

**On a night with a pending forget topic** [verified, diff `a3a34a31..8c45f38a`]: on staging the topic's turns reach the nightly model (no transcript filter there), older backlog past 7 days is dropped silently, and the hidden settle may lift the hold. On `beta-mvp` the turns are withheld to a retry lane and nothing is dropped, but the same hidden settle can release them early.

### 4.2 #1402's nightly machinery against the promise

The promise: memory learns from every conversation, nothing is dropped, cost is bounded, a forgotten topic never reaches the model. #1402 meets it with eight fixed mechanisms [verified, `channels/episodes.ts:187, :194-198`; `nightly-backlog.ts`]: 3 calls per pass, 40,000 characters per chunk, a catch-up 15 minutes later, 30 calls per local day, quarantine after 2 failures over 20 hours, one failed call per pass, bisection down to one time group, and an unbounded withheld-turn list in KV.

It was built on 22 Oct around 10:00Z (`929dd89c`), three hours after #1396 recorded that the failures came from a gate already retired (06:43Z). No trace has shown a size or poison-chunk failure [verified: none cited in #1396 or #1402]. Bisection guards against a failure nobody has seen; the withheld lane exists only because forget withholds whole turns instead of redacting words; the per-lane failure records duplicate the scheduler's own backoff and quarantine.

**Simplest design that keeps the promise** [inference, from the memory sweep and the sources in §5]:
1. **One memory job**, keyed on an episode row mark: it reads what is past the mark, asks the model for claim ops, applies them, moves the mark. Called twice, it does nothing new.
2. **Three callers, one job:** the nightly schedule, idle after delivery (the owner's 22 Oct ruling for M-4), and before any compaction summary (the 23 Oct post-run job ruling). That removes #1379's separate span flush and its duplicate-flush BLOCK by construction, because a second caller finds nothing past the mark (Letta runs this kind of work after a number of steps or at compaction, not on a clock [cited]).
3. **Bounded by one chunk size and one daily cap.** On failure, leave the mark and throw; the scheduler's backoff and pause already exist. After N failures at the same mark, skip that chunk and say so once. Drop bisection and the per-lane failure keys.
4. **Forget redacts inputs instead of withholding turns:** the episode index and conversation rows are redacted by word at commit (#1420's barrier semantics), derived claims are deleted, and the next pass learns only from redacted text. Drop the withheld lane. The model never sees the topic because the text no longer contains it (Anthropic's Dreams never edit inputs; Waldo's inputs are the owner's record, which ADR-0055 says must be erased, so here redaction of the input is the erasure).
5. **One settler:** the async purge job (#1420). Delete the hidden settle in `applyClaimOps` and the per-turn full purge in `restored()`.
6. **One floor on every claim write, keyed on the source:** every number in a health claim must appear in the owner's own words (#1379's H1 fix), in `applyClaimOps`, for adds and corrections. That replaces the tainted-turn block in `remember` (G6) and the wording floor on compaction (R2).
7. **The day plan and every memory reader go through the barrier.**

Net: about eight numbers become two, and three settle paths become one. What it does not change: the claims-plus-episodes store, `remember`, `search_episodes` and the nightly schedule, which #1400 §2.1 judged sound and this audit agrees with.

### 4.3 The other memory PRs

- **#1420** (forget redesign, `a9b350b7`, Ready after a BLOCK): one barrier at the model's view, deletion at commit, an async purge job, and the hidden settle removed. Its B1–B4 fixes went toward finer deletion lists (custody scopes, time bounds), not regeneration from redacted inputs [sweep]. The prompt's held-filter sites fall from about 24 to about 15; the tool-result sites, the day plan and the nightly whole-turn hold stay outside the barrier. Land it, then close those three gaps in a follow-up.
- **#1429** drops `memory_blocks` and `memory_inbox`: two fewer forget targets. Land.
- **#1445** merges `read_owner_context` into `read_memory`: simpler, but it also lets machine turns read memory (`ctx.memoryTurn !== undefined && !admitted(ctx)`) [sweep, not re-verified]. That scope change needs naming in its review.
- **#1458** adds the switch and filters held rows from the summary input but no caller for `compactIfDue`. Its value comes when the post-run job exists (§1).

## 5. What mature harnesses do

Each source opened this session; quotes under 15 words.

| Source | What it does | Lesson for Waldo |
| --- | --- | --- |
| Anthropic, [Building effective agents](https://www.anthropic.com/engineering/building-effective-agents) | "finding the simplest solution possible, and only increasing complexity when needed." | Mechanisms come after a measured failure, not before (§4: #1402) |
| Anthropic, [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) | Hard-coded prompt logic: "creates fragility and increases maintenance complexity over time." | The silence rules and micro-rules (§2c) are the brittle end of the "right altitude" |
| Claude Code, [permissions](https://code.claude.com/docs/en/permissions) and [hooks](https://code.claude.com/docs/en/hooks-guide) | "Rules are evaluated in order: deny, then ask, then allow." Matching is per tool and path, not on conversation text; hooks give "deterministic control"; judgment-type hooks call a model | Boundaries per tool (G1, G9) are mature; word lists over descriptions (R1, R3) are not |
| Claude Code, [memory](https://code.claude.com/docs/en/memory) | Memory files: "Claude treats them as context, not enforced configuration." Auto memory is notes Claude writes itself | Memory is the model's notes; the host guards storage, not content |
| Claude Agent SDK, [permissions](https://code.claude.com/docs/en/agent-sdk/permissions) | Order: hooks, deny, ask, permission mode, allow, then `canUseTool` | Waldo's card route is the same shape; it should be keyed by tool and taint category, never by words |
| Anthropic, [memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool); Managed Agents [memory](https://platform.claude.com/docs/en/managed-agents/memory) and [dreams](https://platform.claude.com/docs/en/managed-agents/dreams) | "Claude only requests memory operations"; injection risk is handled by `read_only` stores and immutable versions, not by refusing writes after untrusted reads. Dreams: "The input store is never modified, so you can review the output" | Record source and version (G6, G7) instead of blocking; consolidation writes reviewable output and never edits its inputs |
| OpenAI Agents SDK, [guardrails](https://openai.github.io/openai-agents-python/guardrails/) and [practical guide](https://cdn.openai.com/business-guides-and-resources/a-practical-guide-to-building-agents.pdf) | Guardrails run "with a fast/cheap model" and a tripwire; rules (regex, blocklists) are for known threats such as prohibited terms; "maximize a single agent's capabilities first" | Waldo has no model-based check tier; it uses regex where a cheap model call would judge (R2, R3) |
| Letta, [memory blocks](https://docs.letta.com/guides/agents/memory-blocks) and [sleep-time](https://docs.letta.com/guides/agents/architectures/sleeptime) | The agent edits its own blocks with tools; background memory runs after a number of steps or at compaction, not on a clock | Waldo's flush and nightly could share one activity-triggered job (§4) |
| mem0, [paper](https://arxiv.org/abs/2504.19413) | "The LLM itself determines which of four distinct operations to execute" (add, update, delete, no-op) | Waldo's claim ops are the same idea; keep the model deciding, keep code to provenance and floors |
| CaMeL, [arXiv 2503.18813](https://arxiv.org/abs/2503.18813); Willison, [dual LLM](https://simonwillison.net/2023/Apr/25/dual-llm-pattern/) | "untrusted data retrieved by the LLM can never impact the program flow." Gates sit on tool calls and egress | The owner's typed request is trusted control flow; the read is data. That supports narrowing G2/G3 to changes the owner did not ask for |

**Where Waldo over-engineers relative to these:** word lists over model or external text (R1, R3–R7), blocking memory writes after untrusted reads (G6, G7b-c), nightly retry machinery built before the trace was read (§4), and a forget filter applied at 29 lines of one file instead of one seam (§6).

**What Waldo lacks:** a cheap-model guardrail tier for the judgment checks it currently does by regex; consolidation output that is reviewable and discardable before it replaces anything; memory consolidation triggered by activity rather than the clock; and a measured cache share (#1400 §2.2, still unreported).

## 6. The deletion test on the turn path

Importers counted by resolving relative imports across `src` [sweep]; headline items re-checked by hand [verified].

| Module | Lines | Live on an owner turn? | Verdict |
| --- | --- | --- | --- |
| `llm/run-loop-adapters.ts` + `llm/gateway.ts` | 755 + 267 | Built on every responder with `WALDO_ENV: 'local'` hard-coded (`owner-turn.ts:199`), so it always takes the fake branch; production reads only `safety.sanitise`, a fallback composer and fixture admission values. The Cloudflare gateway branch is unreachable | **Shallow / misnamed fixture shim.** Import the three things directly; move the fakes to `testing/` |
| `context-composer/owner-turn.ts` recall and skills | recall 246, skills 247, `skills/loader.ts` 331 | Recall always returns "Additional owner temporal recall unavailable" (`:114-122`); system skills always `rows: []` (`:99-102`). Real recall and skills run elsewhere | **Dead in effect.** The composer feeds identity, health, workspace and tool outputs only; memory, recall, history, orders and loops bypass it (`owner-turn.ts:553-632`) |
| `prompt/reasons.ts`, `context-composer/sqlite.ts`, `context-composer/lifecycle.ts`, `tools/source-scope.ts` | 183, 279, 23, 54 | Test-only importers [verified for the first two] | **Dead** |
| `execution-environment/port.ts` | 282 | Zero importers | **Dead** |
| `hooks/claim-verify-lint.ts`, `evaluateTurnClaims`, `replayDecision`, `hooks/claim-verify-effects.ts` | ~120 | No production caller; the last is a one-line alias of `toolRecordColumn('claim')` | **Dead / shallow** |
| `memory_blocks`, `memory_inbox` (`do-schema.ts:101-157`) and tracer-era tables | ~180 DDL | No production insert or select | **Dead** (#1429 drops the first two) |
| `conversation/compaction.ts` + `compactIfDue` | ~250 | `enabled: false`, no caller | **Dormant**; keep only because the owner ruled it ships as a post-run job (§4) |
| `createOwnerResponder` | 22 positional parameters (`owner-turn.ts:117-163`); `telegram-turn.ts` re-indexes them by position (`args[20]`) | Yes | **Shallow interface on a deep body.** One options object |
| Forget filter | `heldTopics`/`holdsIn`/`holdsHeldTopic`/`holdsAnyHeldTopic` on 29 lines of `owner-turn.ts` plus `conversation/held-turns.ts` | Yes | **Not a seam.** One per-turn filter (#1420's barrier) |
| Earns its keep | `tool-loop.ts`, `tools/dispatcher.ts`, `hooks/registry.ts`, `scribe/sanitiser.ts`, `llm/provider.ts` (two real adapters), `canonical-owner-store.ts`, `tool-output-ledger.ts`, `run-effect-scope.ts` (33 callers), `delivery-gate/*`, `prompt/messaging-behavior.ts` | Yes | **Deep** |

Also: the composer runs twice per turn, once in `joined-path.ts:55` and again in the step callback at `owner-turn.ts:567` [sweep; not re-verified].

## 7. The ranked changes

At most fifteen, ranked by how much each frees the model per unit of risk. "Owner" names the open PR or lane that should carry it; none is started by this document.

| # | Change | Expected effect | Risk | Proof | Owner |
| --- | --- | --- | --- | --- | --- |
| 1 | **Read the 22 and 23 Oct nights before any more nightly code** (shape only: `nightly_memory` hop codes, the catch-up schedule rows, `NIGHTLY_THROUGH_KEY`, held-topic count; no text) and fix the diagnostic to show the catch-up and the mark | Settles #1396 one way or the other; stops building for a failure nobody has seen | None (read-only) | The diagnostic shows a moved mark after a night, or names the failing hop | Mac, with the owner's yes (D1) |
| 2 | **Delete the hidden settle** in `applyClaimOps` (`claims.ts:1254-1262`) and let one async purge settle (#1420 already does this) | Closes a privacy gap where a routine night lifts a forget while history still carries it | Low: it removes a path | #1379's probe N8 as a test: a pending topic stays pending after a nightly write until the conversation store verifies clean | N0, inside #1420 |
| 3 | **Narrow the taint stamp and the standing-change card** (G2–G4): a change the owner typed in this turn runs directly and records the read as its source; the card stays for changes the model starts after outside text, and for anything a job proposes | "Remind me 15 minutes before" after a calendar read stops becoming a card; injection still cannot persist | Medium: the model's claim that the owner asked is itself steerable, so the test is on the frozen arguments (the owner's current message must contain the request) | Two scenarios: an injected mail asking for a reminder still produces a card; the owner's typed reminder after a calendar read does not | T0, folded into "Gate writes, not drafts" (D3) |
| 4 | **#1439: record the source on `close_loop` instead of a card**, or at minimum add `propose_action` to `LOOP_CHECK_BACK_TOOLS` | Loop check-backs that read mail can close their loops again | Low | A check-back reads a "paid" mail and closes its loop with `source_ref`; the owner can reopen it | Mac queue, #1439 |
| 5 | **#1437: keep "record the source" only.** Write an agent-origin claim beside the owner's instead of failing; drop the whole-word quote failure | The model can still learn on a turn that read mail; provenance is kept | Low | A tainted turn's save lands as `origin:'agent'`, `source:'inferred'`, and never supersedes an owner claim | Mac queue, #1437 |
| 6 | **One source-keyed health floor in `applyClaimOps`**: every number in a health claim appears in the owner's own words, for adds and corrections, every writer. Then drop the tainted-turn block in `remember` (G6) and the compaction wording floor (R2) | One rule at the one writer, instead of three wording rules at three callers; closes #1379's H1 | Medium: grounding is a substring test today (`claims.ts:1143-1153`), so it needs whole-token matching for numbers | #1379's N1–N7 probes, plus "Form 16" and "laundry load at 6" stored, and a reading relayed from `get_health` refused | T0 or N0, as #1379's H1 fix |
| 7 | **One memory job with three callers** (§4.2 items 1–3): nightly, idle after delivery, before compaction; one chunk size, one daily cap, the scheduler's own backoff; drop bisection and the per-lane failure keys | M-4 runs for every conversation, not only long ones; the duplicate-flush BLOCK disappears; about eight numbers become two | Medium: touches `owner-do.ts` and the nightly lane, both hot | The m-series memory evals (#1360) pass with idle consolidation on and fail with it off; a second call finds nothing past the mark | T0 (#1355's jobs lane, B-6) with N0; replaces #1379's span flush (D4) |
| 8 | **Forget redacts inputs instead of withholding turns** (§4.2 item 4); route the day plan and every memory reader through #1420's barrier | Removes the withheld lane; closes the day-plan leak | Medium | A pending topic never reaches the day-plan or nightly model input; nothing in the episode index is dropped | N0, follow-up to #1420 |
| 9 | **Fix the imprecise boundary matchers** (R3–R7): the health-word egress check keyed on zone words and numbers, not "form" and "load"; the OTP rule needs the vendor phrasing; the URL rule names our OAuth hosts and callbacks; phone shapes need a separator | Ordinary mail, links and calendar titles stop being blanked or refused | Low to medium: each is a security matcher, so each needs its positive cases kept | The false-positive strings in §2a as tests, beside the existing true-positive tests | New small PR per matcher; the health one with the health lane (Mac) |
| 10 | **`browse_act`: drop the description word list** (R1); keep the method default-deny and the approval for submits | Research stops halting on "Book reviews" and "Sort by order date" | Medium: the description list catches clicks that commit; the method list and a model-declared `commits` field must cover them | Browser scenarios: sort, pagination and "Continue reading" run; "Place order" still stops | T0, with the browser wiring after #1410 |
| 11 | **Prompt: turn the three silence rules into one default, give one ask budget, move the India site list and examples into a per-market skill** (§2c) | About 1 KB of headroom under the 19,050-byte cap; fewer rules pulling toward silence | Medium: voice drift | #1383's ablation verdicts on the live suite; the voice scenarios | N0, #1383 (D6) |
| 12 | **Delete the dead turn-path code** (§6): fixture adapters built on every turn, the composer's stubbed recall and skill path, `prompt/reasons.ts`, `context-composer/sqlite.ts`, `execution-environment/`, the dead hooks, and the hall tables via #1429 | About 2,500 fewer lines on the path every review reads; the composer stops looking like the prompt's owner when it is not | Low per piece; each is test-only or dead by import graph | `verify` green; an import-graph check that no production file imports the deleted modules | Ashish's hygiene lane (#1443 pattern), one PR per group; #1429 for the tables (D7) |
| 13 | **`createOwnerResponder` takes one options object** | The 22-position interface and `telegram-turn.ts`'s `args[20]` re-indexing go; every future owner-turn change gets cheaper | Low risk, wide diff (about 50 test files) | `verify` green, no behaviour change | Ashish, after #1445 |
| 14 | **One nightly failure notice, then the console** (owner ruled yes on 22 Oct; still once per local day at `scheduler/failure-notice.ts:28-31, :47`) | The owner stops hearing about an internal job every morning | Low | A test: three paused nights produce one chat notice and a console line | Unowned; small PR |
| 15 | **Eval receipts hold boundaries only**: demote #1456's exclamation-mark and locale-spelling receipts to the judge (the judge says spelling "is never a failure"); narrow h1's calendar health-word receipt (`scenarios.ts:280`) the same way as R3 | Honest replies stop failing trials, so H-9's prune verdicts are not pushed the wrong way | Low | Re-run the recorded gate; the false-fail probes from #1456's review pass | N0, #1456 then #1383 |

## 8. What to stop doing

1. **Building for a failure before reading its trace.** #1402's bisection, quarantine and withheld lane were added after the cause was already known to be a retired gate. Read the trace first; add a mechanism only for a failure that has happened.
2. **Word lists next to a comment saying the decision is the model's.** Four places do this (`browser.ts:168-171`, `health/trigger.ts:15` against `:199-208`, `scribe/sanitiser.ts:171`, `memory/health-rules.ts:3`). Either it is a boundary, and the matcher must be precise, or it is a judgment, and code should not make it.
3. **Blocking a write where the bar asks to record its source.** Memory written after outside text is recorded with its origin and can be corrected; blocking it makes the agent forget what the owner just said.
4. **Treating "this turn read something" as "someone else is asking".** The taint stamp should mark data, not overrule the owner's typed request.
5. **Adding forget filters at new call sites.** One barrier at the model's view (#1420); every new reader goes through it.
6. **Merging code that stays off with no caller.** Compaction, the composer's recall, the run-loop gateway and the claim lint each passed review and then sat dormant. The 22 Oct ruling "no built-but-off features" already says this; hold reviews to it.
7. **Prompt rules without an eval behind them.** The prompt is at its cap; a new rule should arrive with the scenario that proves it and, where possible, delete one.
8. **Tone rules as eval receipts.** A receipt fails a trial whatever the judge says; it is for boundaries and state only.
9. **Telling the owner about internal jobs.** A background pass that retries is a console line, not a chat message.

## 9. Owner decisions

Each is yes or no, recommendation first.

1. **D1. May a session read the nightly state on staging, shape only (hop codes, schedule rows, the mark, a count of held topics; no conversation or claim text), for the owner account on 22 and 23 Oct?** Recommend **yes**. It settles #1396 and is the precondition for item 7. Staging Langfuse text stays unread under #1398's consent rule.
2. **D2. Delete the hidden settle now, inside #1420, rather than in a separate PR?** Recommend **yes**; #1420 already removes it.
3. **D3. Narrow the taint card to changes the owner did not type** (item 3), folded into the "Gate writes, not drafts" PR? Recommend **yes**. The alternative keeps a card on every reminder that follows a calendar read.
4. **D4. Replace #1379's span flush with one memory job that has three callers** (nightly, idle, before compaction), on #1355's jobs lane? Recommend **yes**. It meets the 22 Oct "flush on idle" ruling and the 23 Oct post-run-job ruling with one mechanism.
5. **D5. Remove #1402's bisection, per-lane failure records and withheld lane once forget redacts inputs** (items 7–8)? Recommend **yes, after D1**: if the trace shows a size or poison-chunk failure, keep bisection.
6. **D6. Let #1383 test the three silence rules and the two ask budgets first, and move the India site list and examples out of the core prompt into a per-market skill?** Recommend **yes**.
7. **D7. Delete the dead turn-path code in §6 (source deletion needs the owner's authority under CLAUDE.md)?** Recommend **yes**, one PR per group, each proven dead by the import graph and `verify`.
8. **D8. `close_loop` after outside text: record the source rather than ask on a card** (#1439)? Recommend **yes**; reopening a loop is cheap.
9. **D9. Classify `06773d2b` (memory holds pointers, not contents) and `de6aa10e` (never narrate guardrails) as boundary rules (#1383's question)?** Recommend **no** for `de6aa10e`, which is style and conflicts with explaining a card; **yes** for `06773d2b`, which protects connected data from being copied into memory.

## 10. Evidence

**Observed:** source at `8c45f38a` (files and lines above); `git merge-base` for `3d1daf29` and `b83d6aa9` against `a3a34a31`; PR heads fetched from `waldoco`; #1396, #1359, #1383, #1449, #1450 and #1456 read with `gh`; the primary sources in §5 opened with WebFetch (the two PDFs via `pdftotext`).

**Method:** four read-only source sweeps (rules, gates and prompt, memory passes, import graph) and one documentation sweep ran as subagents; every row marked [verified] was re-read by hand at `8c45f38a`; rows marked [sweep] were not.

**Unverified:** staging logs, Patrol and Langfuse (NOT READ; D1); whether the 22 and 23 Oct nights consolidated; the per-hook call counts inside `hooks/registry.ts`; dynamic imports in the deletion counts; the 19,033-byte prompt figure (from a test comment); any live eval (none has ever run; #1450).
