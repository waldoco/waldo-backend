# Prompt and context audit

**Pinned to:** `waldoco/beta-mvp` at `38ff097bf`. Companion to `docs/architecture/HARNESS_MAP_2026-11-04.md`.

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

4. **Surface turns miss two facts that surface-less turns get** [verified, `messaging-behavior.ts:145-146`].
   - `DIRECT_DOING` and `surfacePresentationPrompt` are on mutually exclusive branches. Every real surface, including the eval's app prompt, takes the presentation branch.
   - That branch never hears:
     - the steer line ("The owner can send a new message while you work…");
     - that approved changes can be undone. The 10-minute window is real (`approvals.ts:64`, `UNDO_WINDOW_MS`).
   - The `send_email` signature rule is not missing: the tool description carries it (`rt/tools/live/google.ts:676`).
   - Fix in V2: the steer line joins Doing for every turn, and undo is named in "Being ahead of them".
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

9. **Health stays in zone words.** Every health path renders words, not numbers (`prompt.ts:185-210`, `trigger.ts:357, 379`, day-card `BODY_RULE`) [verified]. Nothing here changes it.

## C. What V2 changes (`WALDO_PROMPT_V2`)

All changes are additive constants in `messaging-behavior.ts`. V1 is byte-identical, and the cache-prefix tests are run with V2 on as well.

| Change | Why | Scenario that catches a regression |
|---|---|---|
| `IDENTITY`: chat on the app, WhatsApp or iMessage, and mail and documents written for them | Finding 1 | `w01-email-draft-structure`, `w02-document-structure` (new) |
| New "Writing for where it lands" (chat / email / document) | Finding 1; owner brief | `w01`, `w02`, and the existing voice set `v01`–`v08` (chat brevity) |
| New "Being ahead of them": plan, propose, ask only the owner's decisions, act within a shown grant with receipt and undo, "Own what's open" | Findings 2–4; owner brief | `p01-plan-the-afternoon` (new), plus `v03`, `e1`, `r2`, `h03` |
| The steer line moves into Doing for every turn | Finding 4 | owner-turn steer tests (behaviour unchanged) |
| Voice traced as `voice_version` 5 under V2 | traces must name the voice sent | `owner-turn-stable-prefix` with V2 |

Kept verbatim in V2:
- **The boundary lines:** zone words, near medicine, dosing, approval card, untrusted text, emergency.
- **The examples.**
- **Every TASKS line.**

## D. Context measurement

See §E (filled from `pnpm --filter @waldo/runtime eval:context`).
