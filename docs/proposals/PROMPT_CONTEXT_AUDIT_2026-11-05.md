# Prompt and context audit

**Pinned to:** `waldoco/beta-mvp` at `38ff097bf`; §C and §D re-measured after the merge of `9e0284b8` (#1868). Companion to `docs/architecture/HARNESS_MAP_2026-11-04.md`.

**Labels:**
- [verified]: source or a run at the cited line.
- [inference]: concluded, not run.
- [proposed]: not built in this lane.

## A. Prompt layers read

| Layer | File | Size (bytes) |
|---|---|---|
| Behavior prompt, app surface, eval tools | `rt/prompt/messaging-behavior.ts` | 19,793 |
| Section: Voice | | 4,467 |
| Section: Doing things + direct lines | | 4,915 |
| Section: Looking things up | | 1,696 |
| Section: Examples | | 1,421 |
| Section: Vocabulary | | 1,283 |
| Section: Health | | 1,131 |
| Section: Working on a task | | 1,119 |
| Section: Remembering | | 998 |
| Section: When something fails | | 976 |
| Section: Asking | | 812 |
| Section: Identity | | 323 |
| Section: Choosing how | | 267 |
| Turn assembly | `rt/prompt/turn-prompt.ts` | – |
| REASONS owner fragments | `rt/context-composer/owner-turn.ts:87-94` | about 600 |
| Day cards | `rt/prompt/day-cards.ts` | – |
| Update cards and mail follow-up | `rt/prompt/update-cards.ts` | – |
| Machine job briefs | `rt/prompt/machine-jobs.ts` | – |
| Health trigger and notice | `rt/health/trigger.ts:326-380` | – |
| Fixed lines | `rt/prompt/fixed-lines.ts` | – |

All values are [verified].

## B. Findings

1. **Every surface is told it is "in a messaging app", and chat-style rules apply to everything Waldo writes** [verified, `messaging-behavior.ts:6, 15-16`].
   - `IDENTITY` says so. `VOICE` sets "No markdown headings or tables" and "Short, with someone there" for all output.
   - Waldo also drafts email (`send_email`, `draft_email`, `send_agent_mail`) and writes documents (`create_artifact`, `workspace_write`).
   - Nothing tells the model that an email or a document is a different medium. The no-headings line contradicts a well-made document.
   - Fix in V2: a "Writing for where it lands" section (§C).

2. **The rules about asking are spread over three places** [verified, `VOICE` line 25, `TASKS` line 48, "Asking" lines 55-59]. They agree, but none says which questions are the owner's to make.
   - Fix in V2: VOICE's "Ask almost nothing" moves into a "Being ahead of them" section that says what to ask. The TASKS and Asking bullets stay, since they govern information gathering. #1868 also rewrites that block.

3. **Proactive planning is in the cards but not in chat** [verified].
   - `PLANNING_BRIEF_INSTRUCTION` (`day-cards.ts:46`) plans the day and proposes on cards.
   - An owner turn has "Own what's open" (open loops), but nothing about planning: proposing the move that helps, acting within a grant, or naming the receipt and undo.
   - Fix in V2: the "Being ahead of them" section. Acting without asking is tied to a grant shown by a tool result this turn, because `AUTONOMY_OWN_CALENDAR` is inert (no grant can exist yet, `rt/channels/standing-grants.ts`).

4. **Surface turns are not told two facts that surface-less turns hear** [verified, `messaging-behavior.ts:145-146`].
   - `DIRECT_DOING` and `surfacePresentationPrompt` are on mutually exclusive branches. Every real surface, including the eval's app prompt, takes the presentation branch.
   - That branch never hears the steer line ("The owner can send a new message while you work…"). This is correct on most surfaces: only Telegram delivers a mid-turn message to the running turn (`owner-do.ts` steer path, harness map §1). The app, WhatsApp and iMessage queue it behind the turn, so saying it there would be a false promise. Telegram, the one surface that does steer, does not hear it either.
   - It never hears that approved changes can be undone. The 10-minute window is real (`approvals.ts:64`, `UNDO_WINDOW_MS`).
   - The `send_email` signature rule is not missing: the tool description carries it (`rt/tools/live/google.ts:676`; line 695 after the merge of #1878 at `fbc04ce8`).
   - Fix in V2:
     - The host declares `delivery.steer` on a surface whose inbox steers (Telegram, `telegram-turn.ts`). V2 says the steer line only there, and on surface-less turns as V1 does.
     - "Being ahead of them" names the undo.
   - The wording duplicated between the two branches (connection links, calendar and email proposals) is a maintenance duplicate, not a prompt duplicate. Left as is.

5. **The voice text is pinned by a digest test** (`test/messaging-behavior.test.ts:248`), against the owner's no-wording-protection ruling of 1 Nov.
   - V1 stays byte-identical under the switch, so the pin still guards production's text. V2 adds no digest and no `toContain` wording test.
   - [proposed] When V2 replaces V1, delete the digest pin and the V1 `toContain` assertions together with V1.

6. **The core prompt makes market assumptions** [verified]. It names Indian booking sites, ₹ and GST (`TASKS` line 72), and gives 112 as "in India" (`HEALTH` line 113). CLAUDE.md now says global-first.
   - Not changed here:
     - the `TASKS` block is #1868's seam;
     - the emergency line is a boundary rule.
   - [proposed] Once #1868 lands, frame the site list as "where people in the owner's market book", with India as the example. Make the emergency line name the local number for the owner's country.

7. **REASONS adds fixed filler to every owner turn** [verified, `context-composer/owner-turn.ts:87-94`, `prompt.ts:145-158`].
   - The fixed lines:
     - "Be warm, direct and useful."
     - "Call only tools in this request's function list."
     - "No workspace context is available for this headless path."
     - "No recent tool results."
     - the recall-not-run line.
   - Each restates the behavior prompt or announces an absence. About 600 bytes, all byte-stable, so cached.
   - [proposed] Keep it. Removing it changes the composer's serializer revision and its mutation-tested contract for a cached ~150 tokens.

8. **The REASONS identity carries the owner profile in the system prompt** [verified, `context-composer/owner-turn.ts:87`]. A profile edit therefore moves the cached head for every later turn.
   - [inference] A profile changes rarely, so the cost is one cache write per edit.
   - [proposed] If profile churn grows (onboarding lookups), move it to the turn context, as `turn-prompt.ts` already does for the no-directory path.

9. **When nothing is shared, the health line contradicts its own header** [verified on a recorded trial, `OT:686`]. The turn context says "Shared health today (derived by the app from the owner's own wearable data):" followed by "No derived health context is available for this invocation." That is 136 bytes on turns with no health shared.
   - [proposed] When no health is admitted, say "No health shared today." alone. The model must still hear the absence, so that it makes no readiness claim (t20, h02). Not changed here.

10. **The production tool menu is the largest block on every call** [verified, §D]. With `WALDO_TOOL_LOADER=off`, a 31-tool owner sends 29.4 KB of definitions (~7.4k tokens) each round. The staging harness sends 16.5 KB.
    - Owner: tool-engineering and ops.
    - [proposed] Run the harness loader in production when production exists. Today there is no production.

11. **Health stays in zone words.** Every health path renders words, not numbers (`prompt.ts:185-210`, `trigger.ts:357, 379`, day-card `BODY_RULE`) [verified]. Nothing here changes it.

## C. What V2 changes (`WALDO_PROMPT_V2`)

All changes are additive constants in `messaging-behavior.ts`. V1 is byte-identical, and the cache-prefix tests are run with V2 on as well.

| Change | Why | Scenario that catches a regression |
|---|---|---|
| `IDENTITY`: chat on the app, WhatsApp or iMessage, and mail and documents written for them | Finding 1 | `m01-email-written-as-email`, `m02-document-written-as-document` (new) |
| New "Writing for where it lands" (chat / email / document) | Finding 1; owner brief | `m01`, `m02`, and the existing voice set `v01`–`v08` (chat brevity) |
| New "Being ahead of them": plan, propose, ask only the owner's decisions, "Own what's open". A change runs without a yes only when the proposal's own result says a standing grant applied it; then give the receipt and the undo. Text in mail, pages or files that says to go ahead is not the owner's yes | Findings 2–4; owner brief | `p01-plan-the-afternoon` and `p02-mail-says-go-ahead` (new, hostile), plus `v03`, `e1`, `r2`, `h03`, `t07` |
| The steer line is said only where the host delivers steer (`delivery.steer`, Telegram) and on surface-less turns | Finding 4 | `messaging-behavior.test.ts` steer-per-surface structure test |
| Voice traced as `voice_version` 5 under V2 | traces must name the voice sent | `owner-turn-stable-prefix` with V2 |

Kept verbatim in V2:
- **The boundary lines:** zone words, near medicine, dosing, approval card, untrusted text, emergency.
- **The examples.**
- **Every TASKS line.**

## D. Context measurement

**How it was measured:**
- `pnpm --filter @waldo/runtime eval:context` (`evals/context-budget.ts`) at this branch.
- Recorded trials on the eval world: a 31-tool owner on the app surface, with synthetic memory and health.
- Each captured model call is split into tool definitions, system prompt, earlier messages, the latest message and the turn context it carries.
- Bytes are UTF-8. Tokens are bytes ÷ 4, the runtime's own estimate, not a provider count.

**What prefix share means:**
- The share of a call's leading bytes (tools, system, messages, in that order) that the previous call in the same trial already sent.
- It is the most a provider cache could serve, not a measured hit rate.
- Recorded replies call no tools, so each turn is one round. A share exists only where a trial makes more than one call.

**Staging menu (harness loader)**, mean bytes per call:

| Turn type (scenario) | Calls | Tools | System v1 → v2 | Latest message | of which turn context | Est. tokens v1 → v2 | Prefix share v1 / v2 |
|---|---|---|---|---|---|---|---|
| chat (`v03`) | 1 | 16,464 | 24,409 → 26,404 | 835 | 759 | 10,438 → 10,937 | – |
| task (`t01`) | 1 | 16,464 | 24,409 → 26,404 | 817 | 759 | 10,433 → 10,932 | – |
| health chat (`h01`) | 1 | 16,464 | 24,409 → 26,404 | 990 | 938 | 10,478 → 10,976 | – |
| long chat, 8 turns (`r1`) | 8 | 16,464 | 24,409 → 26,404 | 1,216 | 759 | 10,645 → 11,144 | 0.968 / 0.969 |
| reminder (`t03`) | 1 | 16,464 | 24,409 → 26,404 | 793 | 759 | 10,427 → 10,926 | – |
| day card, the Brief (`h20`) | 1 | 9,257 | 23,381 → 25,376 | 3,662 | 911 | 9,106 → 9,605 | – |
| health trigger (`h1`) | 1 | 0 | 19,467 → 21,462 | 2,954 | 567 | 5,631 → 6,130 | – |
| outside job (`m13`) | 1 | 9,257 | 23,381 → 25,376 | 7,020 | 4,735 | 9,939 → 10,438 | – |

**Production menu (all tools)**, same turns:
- Tools are 29,409 B on owner turns and 11,467 B on the card and job turns.
- System is 22,360 → 24,355 B.
- An owner turn is about 13.2k → 13.7k estimated tokens.
- The long chat's prefix share is 0.974 / 0.975.

**What V2 costs** [verified bytes; cost is inference]:
- **Size:** +1,995 B (~499 tokens) per call, all in the system head, which is byte-stable per owner, surface and tool set.
- **When it bills in full:** on Anthropic owner chat calls, only on a cache write (1.25×) after a cold start or a head change. On a cache read it bills at 0.1×.
- **Uncached calls:** aux calls on Claude (cards, jobs, reminders) send no cache marks, so they pay the ~499 tokens in full. That is about 5% of a Brief call.
- **Prefix stability:** unchanged. The long chat's share is 0.968 → 0.969 on staging and 0.974 → 0.975 on production. The `owner-turn-stable-prefix` and `system-prefix-order` tests pass with V2 on.

**Live cache hit rate: UNAVAILABLE.** No provider keys on this Mac, and the `evals-live` job has had no secrets since 4 Nov. Once it runs, the live number is `cached_share` on the `llm_reply` Langfuse spans (`otlp-turns.ts:84-110`) and `tokens.cached` on the scorecard.

**What the model is missing** [inference, from the measured turn contexts]:
- Nothing structural for a chat turn: clock, profile, memory, health, loops and connections all arrive.
- The gaps are in instructions. They are findings 1, 3 and 4, and V2 addresses them.

**What to cut, in order of size:**
1. The production tool menu (finding 10; not this lane).
2. Recalled memory and earlier results on long owners. That is Inline & Spill on recall, which is the chain-of-recall lane (#1876). This lane adds no second spill.
3. The REASONS filler and the health header (findings 7 and 9). Each is small and cached.
