# The general wake, and one `wake()` entry for every run Waldo starts (28 November 2026)

> **Status: Proposed, design note only. Revised again on 28 Nov for the owner's rulings on the design page's open questions (its section 8): one model, reviews as a baseline, a cost limit, volume removed, and inward undoable changes with no card.** This is slice 4 of HEY-377 (one agent loop). It is revised to match the orchestrator's design page, *How Waldo wakes and thinks: design for the general wake* (Linear, 28 Nov, proposed), and the findings it rests on, *Why Waldo feels weak when it wakes* (Linear, 28 Nov; staging logs in waldoco/waldo-app#257). It builds on [MODEL_SET_WAKES_2026-11-16.md](https://github.com/waldoco/waldo-backend/pull/2157) §3.2 and §3.7 and on what has been built since: full tool reach (#2230, merged), model-set wakes (#2234), the follow-up bounds proposal (#2235), the outside-content mark following what a run reads (#2238), and the calendar now frame (#2239). Code references are to `packages/runtime/src` at #2234's head `17904ba88`; line numbers (≈) are approximate. Each build step below is its own draft PR behind its own switch, off by default.

## The problem

Each run Waldo starts is a stateless, narrow job. It starts cold, sees a slice, answers one question and leaves nothing for the next run.
- Overnight on staging (Worker `0928eb2f`, six owners), 224 of about 250 wakes ended at a code check before any model call.
- The look, the only run that looks across the plate, ended `blocked` in 4 of 10 reader tasks after one `read_drive` call failed (`auth_failed`), and chose `none` in 5 of 6 deciding runs.
- The look's reader cannot read health or memory (`tasks/profile-tools.ts`), so it cannot join the body to the plate. Its decider may only answer `act`, `say` or `none`. Its brief ends "nothing is normal" (`prompt/machine-jobs.ts`).
- Nothing runs when the owner opens the app (`channels/app-today.ts` reads stored text only).

On top of that, every entry picks its own prompt, tool list, taint, model role and limit checks, and ends its own way. So a due follow-up waits because a message cap was reached, though looking costs the owner nothing; one run kind acts while an identical one cards; and nothing records, in one place, why Waldo woke and what came of it.

## Today's entry points [verified, `channels/owner-do.ts`]

| Run | Entry | Taint at start | Limits checked | How it ends |
|---|---|---|---|---|
| Day cards (Brief, Close, others) | `ledgerJob` (≈5595) from the card executor (≈6755) | `'external'`; `'as_read'` with #2238 when the prompt is own text | Quiet hours and volume before; the card's own skip | Card text, or `SKIP` |
| Brief body revision | `ledgerJob` (≈6122) | `'external'` | `quiet()`, `reachesOut()` before | Revised card, or a code |
| Loop check-back (heartbeat) | `heartbeatTick` scan, then reader worker, then `heartbeatApplier` turn (≈5918) | `'external'` (the worker read) | Quiet hours, volume, 4 h cooldown, `held_daily_cap` **before the run** | Message or `checkBackReply` null |
| Waldo's own follow-up wake | One-shot heartbeat entry (`armFollowupWake`, #2234); same tick as above | As above | As above | As above |
| Owner reminder | `responder.remind` (`owner-turn.ts` ≈1373) | Clean, `runOrigin 'waldo'` | None before; the outbox after | Message, or the floor text |
| Reminder set after outside content | `responder.prompt(..., 'external')` (≈5719) | `'external'` | None before | Message |
| Standing order | `responder.prompt` (≈5774) | Clean | `confirm_first` holds changes (#2234) | Report |
| Triage (update sweep) | `responder.prompt` (≈6544) | `'external'` | `interrupts` budget, after | Update card or note |
| The look (intervention) | `interventionReview` (≈6650) enqueues a reader worker; `interventionApplier` (≈6574) decides | `'external'` | `interrupts.book.hold` **before the worker** and again at send | `act` / `say` / `none` JSON |
| Health trigger | `runHealthTrigger` `decide` (≈6182), **no tools** | n/a (decision) | `budget.admit` **before the model** | A structured decision |
| Pre-activity spot, calendar prep | `decide` (≈6367, ≈6407), no tools | n/a | Their own | A structured decision |
| Mail follow-up | `ledgerJob` (≈6510) | `'external'` | Its own | Message |
| Announcements | `responder.prompt` (≈6627), no tools | `'external'` | `interrupts.book.hold` before | Decision |

There are at least 13 entries, 4 limit placements and 3 ending shapes. Only some write a `background_runs` row, and none records a reason and an outcome together.

## What this note proposes

Two things, built in this order.

1. **The general wake.** One run whose job is "look at everything and decide what this person needs", with the same starting context and the full tool set every time. It replaces the look first, then the other entries fold into it.
2. **One entry, `wake(reason)`.** The plumbing that every entry shares: one run, one outcome row with a reason and its cost, and no count of messages. This was the whole of the first version of this note. It now carries the general wake rather than a prompt per reason.

### The principle

**Code establishes facts; the model judges meaning.** Code may say "three mails arrived, the 4 pm meeting moved, last night is scored, the app was opened". Code may not say "none of that matters". Deterministic rules stay only where a guarantee is needed: authority, egress, the health fences, credentials, the owner's own off switches (follow-ups off, quiet hours), and the health facts in code (below). There is no daily count of messages and no volume setting (owner ruling, 28 Nov): how often to reach the owner is the model's call, from what they have already heard today and how they answered.

### What one wake starts with (the same for every wake)

The order serves the provider's prompt cache (owner ruling: one model, used to its maximum, with the per-owner cache kept). The orientation comes first and is the same for every wake; then what moves slowly (goals, what is open, the day cards, the day so far); then what moves fast (the rest of today's calendar, what changed); the moment and why it woke come last.

- **What changed** since the last wake: the reason it woke (a cadence, a move or arrival, later the merged events of step 3), the update changes not yet folded into a card, and the rest of today's calendar.
- **The body in words,** as the composer already gives the Brief, with how fresh the data is. No new formatter that prints readings.
- **Open items:** the loops, reminders, waiting approvals and Waldo's own follow-ups (`promptLedger`).
- **What Waldo already said today and what the owner answered:** the day cards and the day so far.
- **Waldo's own notes** from earlier wakes (step 2).
- **The owner's standing instructions:** standing orders and stated preferences, as every run already reads them.

It fetches the rest on demand: mail threads, history, memory, health series, files. The web stays as the egress fences allow for a run over outside content (#2238 changes the mark, not the fence).

### How it can end, one outcome row each, with a reason

| # | Outcome (design page §5) | How in the loop | In PR 1 |
|---|---|---|---|
| 1 | An inward, undoable change, said on the Home card | The change's own tool | **Carded.** Ruled yes (decision 3); built as its own PR on #2238, see below |
| 2 | Update the Home card | A Home card tool | Step 4 (app contract first) |
| 3 | A note to memory, or to its own notes | `remember`; the notes tool (step 2) | `remember` |
| 4 | A follow-up for itself | `open_loop` (#2234) | Yes |
| 5 | Tell the owner now | `end_run` `send` | Yes |
| 6 | Ask one question | `end_run` `ask_owner` | Yes |
| 7 | Nothing, with the reason | `end_run` `nothing_to_send` | Yes |

The outcome is derived from the `end_run` choice plus the effect tools that succeeded (names only), so `end_run`'s contract does not change. The reason is the model's `end_run` reason. It is stored in the wake's own outcome table, not in `background_runs.summary` (code-written lines only), with the run's outside mark. A reason that holds a health reading is stored as a fixed "withheld" line (a deterministic check, allowed as a health safety boundary). The table is listed in the forget inventory.

The row also records what the run cost: the model, the number of calls, tokens in, cached and out, and the dollar figure (`llm/pricing.ts` `modelCost`). It sums the loop's reply calls only. Billed failed attempts and side calls (the owner-words check, delegation) are not counted, so it is a lower bound.

**What holds a wake.** Only the owner's own settings: follow-ups turned off, and their quiet hours. These hold the whole wake before it runs, not only its message: a card the run raised reaches the owner as a chat message on Telegram and WhatsApp (`approvals.ts`), so a wake held only at send could still interrupt them. Both are checked again when the run decides to speak, since quiet hours may begin while it runs. This replaces the first version's "the look is never held". What it no longer means is held by a count: there is none. The 27 Nov night rule (sleep focus and the learned sleep window) belongs to the limits work and applies where that lands.

### Waldo's own notes ("what I'm watching")

A short per-owner page every wake reads and rewrites: what it is watching, what it concluded last time, what it expects next. Words only, never a reading: a note that holds a health reading is refused at write time. The owner can read and correct it. HEY-318.

### One inbox with merging

Mail, calendar, a health upload, a phone arrival and an app open each write an event. One wake per short window reads every pending event. App open starts a wake only if something changed since the last wake, or the last wake is older than a configured age. A health fact computed in code (a scored night, a value outside the owner's usual range, ADR-0081) always produces a wake. Code never decides that an event does not matter.

### The Home card as an outcome

Served additively (`app.v1` is additive only), proposed as its own route because `appTodayV1Schema` is strict. The shape is posted on waldoco/waldo-app#257 for the app lane before it is built.

### `wake(reason)`

```ts
type WakeReason = Readonly<{
  kind: 'look' | 'event' | 'standing_review' | 'day_card' | 'follow_up' | 'check_back' | 'owner_reminder' | 'standing_order' | 'health' | 'prep' | 'announcement';
  ref: string;                             // the entry, loop, card or event batch it is about
  asked: 'owner' | 'standing' | 'waldo';   // who asked for this run at all
  shown: 'own' | 'outside';                // whether the caller vouches for everything it puts in the prompt
}>;
type WakeOutcome = 'spoke' | 'asked' | 'followed_up' | 'noted' | 'carded' | 'nothing' | 'held' | 'failed';
```

- **One run, one outcome.** `wake` composes the run through the existing ContextComposer and `createOwnerResponder` (no second brain), runs `runToolLoop` once, and records exactly one outcome row: the kind, the ref, the outcome, the reason, the tools called (names only) and the cost. `held` means the owner's own settings held it.
- **No count holds a wake.** The daily budget, volume, the gap and the 4-hour re-notify do not apply to wakes. The owner's follow-ups setting, their quiet hours and their heartbeat preference are their own off switches, not judgments, and they stay.
- **Reviews are a baseline, not a limit** (owner ruling). The wake's regular look and, later, the standing reviews come round on their own. A wake that wants another look sooner, or at a set minute, leaves itself a follow-up (`open_loop`, #2234), which wakes it then. No fixed count of reviews is kept in code.
- **Authority comes from `asked`; the mark from `shown` and the reads (#2238).** `owner` is an owner reminder recorded with the owner's ask (#2239). `standing` is a standing order, `confirm_first` held. `waldo` is everything else: changes go on the owner's card and egress is fenced.
- **One model** (owner ruling: "stick to one model", because switching models loses the per-owner prompt cache). Every wake runs on the chat model. The role stays configuration (`WAKE_MODEL_LOOK`, default `plans`: the chat model at planning effort), not a model name in code. No cheaper model first.
- **Cost** (owner ruling): **$15 a person a month is the target to measure against. The existing $50 spend ceiling is the hard stop.** The earlier $4.50 is withdrawn. Each wake's cost goes on its row, and a running total per owner month is logged with each wake. The admin console's spend section has the owner's whole model spend. No stop is added under $50.

## Build order, each test-first from a real miss

1. **PR 1: the general wake replaces the look** (`GENERAL_WAKE`, default `"0"` everywhere). One brain run under `asOwnerJob`, no reader worker; the starting context above; the full tool set through `find_tools`; no count; one outcome row with its cost.
   - Scenarios: Drive not connected and the run still returns what it found; one tool fails and the run still ends with `end_run`; follow-ups off holds the wake before it runs; volume low changes nothing.
1b. **Inward, undoable changes with no card** (ruled yes), as its own draft PR stacked on PR 1 and #2238, with its own security review. See "Decision 3" below.
2. **PR 2: Waldo's own notes,** read and rewritten by every wake, in the forget inventory.
3. **PR 3: one inbox with merging,** with app open.
   - Scenarios: 20 mails in an hour produce one wake; the app opened twice in a minute produces one wake; nothing changed produces no run; a scored night always produces a wake.
4. **Home card as an outcome,** after the app lane answers on #257.
5. **Fold the remaining entries** into `wake(reason)`, in this order: follow-ups and check-backs (`held_daily_cap` moves to the send); owner reminders and standing orders; day cards, brief body, triage, mail follow-up and announcements; then the health and prep decisions as tool-using wakes with their pre-model gates removed. Each behind `WAKE_ENTRY_<STEP>`.

### What it sits on

PR 1 is based on `beta-mvp` with #2234 merged (`b6c9fbfc7`). It takes none of #2235, #2238 or #2239, so a no on any of them leaves it standing. Step 1b needs #2238. Once they merge:
- **#2238** lets a wake whose starting context is all the owner's own text start unmarked (`'as_read'`). Most wakes see an invite or a mail and start marked anyway.
- **#2239** puts today's calendar in the owner turn's now frame from the update sweep's cache. The wake reads the calendar live with the day cards' `calendarRead`, since it runs over outside content anyway and may see titles; it can move to the cache once #2239 lands.
- **#2235** widens follow-up bounds. The wake's `open_loop` uses whatever bounds are merged.

## Where this note differs from the design page, and why

1. **Outcome 1 (an inward, undoable change with no card) is ruled yes, but reaches little at first** (see "Decision 3").
2. **"Stale" on app open is a cost debounce, not a judgment.** It is a configured age, with the reason stated as cost. Whether the open matters is still the model's call once a wake runs.
3. **One model** (ruled): no cheaper model first. The role stays configuration.
4. **The per-job change checks do not all go.** The update sweep's "nothing changed" is a fact in code, and the design page's own scenario wants "nothing changed produces no run". What goes is each job's own prompt and its "does it matter" gate. The sweep's change detection becomes the inbox's mail and calendar producer.
   - But **124 mail signals produced 0 changes** overnight (HEY-363, HEY-380), cause not traced. An inbox fed by that sweep inherits the blindness, so that bug needs a root cause before PR 3 relies on it.
5. **The look's cadence stays in PR 1** (`PROACTIVE_REVIEW_EVERY_MIN`, inside the owner's day) as the baseline. The wake extends it with its own follow-ups. Three standing reviews plus event wakes wait for the inbox.
6. **Volume is gone; follow-ups off and quiet hours hold the wake before it runs.** The design page proposed "wakes still look silently". A card from a silent look still reaches the owner as a message, so a held wake does not run. Its outcome row says `held`.
7. **Skills say the opposite of the ruling in places** ("Silence is a good outcome: most looks end in nothing"). The wake's prompt does not say so, but rewriting skills is HEY-261, not this slice.

## Tests (to write first)

- **A trace assertion per kind:** reason, tools called, outcome row. Exactly one outcome per run, including a provider failure (`failed`) and a cancelled run.
- **The owner's own settings hold it.** Follow-ups off or quiet hours: no run, a `held` row; quiet hours that begin during the run hold its message.
- **A tool for an unconnected service is not offered,** and one failed tool does not end the run (HEY-367).
- **Authority per `asked`:** the registry-wide gate table from `wake-tool-reach.test.ts` runs against a wake's context and answers as for any run over outside content.
- **The mark per `shown`,** as in #2238.
- **Scenario cases** from the real misses (above), and cases 1 to 10 of the 16 Nov note §7.2 once each entry folds in.

## Falsifiers

- If owners who switch the wake on start muting Waldo or turning follow-ups off, the model is reaching out more than they want without a count; measure unasked messages a day per owner from the outbox, the week before and after.
- If the month's wake total on staging puts the baseline near or above $15 a person, the cadence, the starting context or the cache order needs work before more wakes are added.
- If any `asked: 'waldo'` wake makes a change without a card, the authority split is wrong; the registry-wide test should catch it first.
- If wakes on staging still end in `nothing` almost every time once they can see the body and memory, the starting context is not the cause; look at the prompt and the skills next.

## Decision 3: inward, undoable changes with no card

Ruled yes on 28 Nov, scoped as said: inward and undoable only. Contacting others, spending, deleting and anything not undoable still wait for the owner. The outside-content rules of #2238 still apply to where the arguments came from.

What that means in code: #2238's mark follows what a run reads. So a wake may make such a change with no card only while it is unmarked, before its first outside read, and only if its whole starting context is the owner's own text (`'as_read'`).

**Finding for the owner:** a wake's starting context almost always holds someone else's words (a mail change, an invite, a delivered message in the last day), so it starts marked. Read strictly, the ruling covers very little of what wakes do. Reaching further would mean judging where each argument came from, call by call. That is a new provenance design, not a switch, so I have not invented one.

The change is built as its own draft PR on PR 1 and #2238, with its own security review, so it can be judged apart from PR 1.

## Which Waldo-started calls still use the small model (for the "one model" ruling)

Staging today, at #2234's head. `roleModel` is the chat model when `WALDO_STRONG_ROLES = "1"` (staging) and the small model when `"0"` (production). Nothing below is changed by this work.

| Call | Where | Model on staging | Model on production |
|---|---|---|---|
| A reminder set after outside content, firing | `owner-do.ts` ≈5726, no role | **small** | small |
| The legacy event brief (Telegram only) | `owner-do.ts` ≈6428, no role | **small** | small |
| Chain compaction | `owner-turn.ts` `compactChain` | **small** | small |
| Thread titles, progress notes, the reaction choice | `owner-turn.ts` | **small** | small |
| Light chat (`WALDO_LIGHT_CHAT`, off) | `owner-turn.ts` | (off) | (off) |
| Past the spend ceiling, every run | `ownerRoutePolicy` clamp | **small** | small |
| Nightly memory, sources, outcomes, constellation, day plan, migration, welcome, owner-words check | `roleModel` | chat | **small** |
| Check-backs, standing orders, prep decisions, mail follow-up (`'decides'`) | owner-do | chat | **small** |
| Task workers | `tasks/worker-loop.ts` `taskModel` (strong when `WALDO_STRONG_ROLES`) | chat | **small** unless deep |
| Day cards without planning flags | owner-do ≈6797 | chat (act-ahead and capacity are on) | **small** for some cards |
| Day cards with planning, the look, triage, the brief revision, health decisions, owner reminders, announcements | owner-do | chat | chat |

The overnight logs show the small model (`gpt-6-luna`) in 3 Brief, 4 look and 7 reader calls on staging. All three run on the chat model by role there. So those calls are the provider's fallback ladder or the spend clamp, not a role choice. [inference: the log lines carry `fallback_fired`, which I have not read for these calls.]

## Open rulings for the owner

1. Does "one model" cover the calls in the table above that still use the small model? Production would need `WALDO_STRONG_ROLES = "1"`, and the always-small calls would each need a change.
2. Health words in a wake's reason: readings with numbers are withheld, but words ("recovery is low") are kept in the per-owner outcome table, which a forget reaches. Keep, or keep no free-text reason?
3. How far a fired owner reminder carries the owner's say-so: inward writes only, or sends too (#2239).
4. Owners who said no through volume `low` or a daily count of 0: the wake no longer reads either, so they would get wake messages. Move them to follow-ups off, or accept it as part of removing volume?
5. Turning `GENERAL_WAKE` on in staging.

## Rollback

Every step is behind its own switch. With a switch off, that entry runs its current path unchanged. The outcome table and the notes table are additive and created lazily on first write, as `loops` is, so there is no migration reservation.

## Impact surface

- **Code:** a new `channels/wake.ts` module, a wiring block in `channels/owner-do.ts`, later `heartbeat.ts`, `heartbeat-job.ts`, `owner-turn.ts` `prompt`/`remind`.
- **Authority:** unchanged in PR 1; step 1b carries decision 3.
- **Messages:** no count; the owner's follow-ups setting and quiet hours hold a wake.
- **Persistence:** an additive outcome table and a notes table, both in the forget inventory.
- **Contracts:** none until the Home card, which is additive on `app.v1`.
- **Cost:** wakes no longer stop at a budget check before the model, so model runs per owner rise. Each wake's row carries its cost.
