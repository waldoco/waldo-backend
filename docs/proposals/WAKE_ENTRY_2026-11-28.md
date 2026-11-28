# The general wake, and one `wake()` entry for every run Waldo starts (28 November 2026)

> **Status: Proposed, design note only.** This is slice 4 of HEY-377 (one agent loop). It is revised to match the orchestrator's design page, *How Waldo wakes and thinks: design for the general wake* (Linear, 28 Nov, proposed), and the findings it rests on, *Why Waldo feels weak when it wakes* (Linear, 28 Nov; staging logs in waldoco/waldo-app#257). It builds on [MODEL_SET_WAKES_2026-11-16.md](https://github.com/waldoco/waldo-backend/pull/2157) §3.2 and §3.7 and on what has been built since: full tool reach (#2230, merged), model-set wakes (#2234), the follow-up bounds proposal (#2235), the outside-content mark following what a run reads (#2238), and the calendar now frame (#2239). Code references are to `packages/runtime/src` at #2234's head `17904ba88`; line numbers (≈) are approximate. Each build step below is its own draft PR behind its own switch, off by default.

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
2. **One entry, `wake(reason)`.** The plumbing that every entry shares: one run, one outcome row with a reason, the owner's limits checked when the run decides to speak, never before it looks. This was the whole of the first version of this note. It now carries the general wake rather than a prompt per reason.

### The principle

**Code establishes facts; the model judges meaning.** Code may say "three mails arrived, the 4 pm meeting moved, last night is scored, the app was opened". Code may not say "none of that matters". Deterministic rules stay only where a guarantee is needed: authority, egress, the health fences, credentials, the owner's own off switches and limits on unasked messages, and the health facts in code (below).

### What one wake starts with (the same for every wake)

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
| 1 | An inward, undoable change, said on the Home card | The change's own tool | **Carded.** No card needs decision 3 below; #2238 keeps it carded |
| 2 | Update the Home card | A Home card tool | Step 4 (app contract first) |
| 3 | A note to memory, or to its own notes | `remember`; the notes tool (step 2) | `remember` |
| 4 | A follow-up for itself | `open_loop` (#2234) | Yes |
| 5 | Tell the owner now | `end_run` `send` | Yes, limits at send |
| 6 | Ask one question | `end_run` `ask_owner` | Yes, limits at send |
| 7 | Nothing, with the reason | `end_run` `nothing_to_send` | Yes |

The outcome is derived from the `end_run` choice plus the effect tools that succeeded (names only), so `end_run`'s contract does not change. The reason is the model's `end_run` reason. It is stored in the wake's own outcome table, not in `background_runs.summary` (code-written lines only), with the run's outside mark. A reason that holds a health reading is stored as a fixed "withheld" line (a deterministic check, allowed as a health safety boundary). The table is listed in the forget inventory.

Limits on unasked messages apply only to outcomes 5 and 6, at send time.

### Waldo's own notes ("what I'm watching")

A short per-owner page every wake reads and rewrites: what it is watching, what it concluded last time, what it expects next. Words only, never a reading: a note that holds a health reading is refused at write time. The owner can read and correct it. HEY-318.

### One inbox with merging

Mail, calendar, a health upload, a phone arrival and an app open each write an event. One wake per short window reads every pending event. App open starts a wake only if something changed since the last wake, or the last wake is older than a configured age. A health fact computed in code (a scored night, a value outside the owner's usual range, ADR-0081) always produces a wake. Code never decides that an event does not matter.

### The Home card as an outcome

Served additively on the app's today route (`app.v1` is additive only). The shape is posted on waldoco/waldo-app#257 for the app lane before it is built.

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

- **One run, one outcome.** `wake` composes the run through the existing ContextComposer and `createOwnerResponder` (no second brain), runs `runToolLoop` once, and records exactly one outcome row: the kind, the ref, the outcome, the reason and the tools called (names only). `held` means the run wanted to speak and the owner's limits held it.
- **The look is never held; the message is.** Quiet hours, volume, the 4-hour re-notify and the owner's daily budget for unasked messages (`held_daily_cap`, the `PROACTIVE_GATE` budget) are checked when the run decides to speak. A run over budget records `held`. This resolves the disagreement in #2235: follow-ups wake at their minute, and the owner's own limit still binds every unasked message. The owner's heartbeat preference stays a gate before the run: it is their own off switch, not a judgment.
- **Authority comes from `asked`; the mark from `shown` and the reads (#2238).** `owner` is an owner reminder recorded with the owner's ask (#2239). `standing` is a standing order, `confirm_first` held. `waldo` is everything else: changes go on the owner's card and egress is fenced.
- **The model role per wake kind is configuration, not code,** with today's roles as the defaults.

## Build order, each test-first from a real miss

1. **PR 1: the general wake replaces the look** (`GENERAL_WAKE`, default `"0"` everywhere). One brain run under `asOwnerJob`, no reader worker; the starting context above; the full tool set through `find_tools`; the holds moved from before the look to the send; one outcome row.
   - Scenarios: Drive not connected and the run still returns what it found; one tool fails and the run still ends with `end_run`; the look runs while the daily budget is spent and records `held`.
2. **PR 2: Waldo's own notes,** read and rewritten by every wake, in the forget inventory.
3. **PR 3: one inbox with merging,** with app open.
   - Scenarios: 20 mails in an hour produce one wake; the app opened twice in a minute produces one wake; nothing changed produces no run; a scored night always produces a wake.
4. **Home card as an outcome,** after the app lane answers on #257.
5. **Fold the remaining entries** into `wake(reason)`, in this order: follow-ups and check-backs (`held_daily_cap` moves to the send); owner reminders and standing orders; day cards, brief body, triage, mail follow-up and announcements; then the health and prep decisions as tool-using wakes with their pre-model gates removed. Each behind `WAKE_ENTRY_<STEP>`.

### What it sits on

PR 1 stacks on #2234 only. It takes none of #2235, #2238 or #2239, so a no on any of them leaves it standing. Once they merge:
- **#2238** lets a wake whose starting context is all the owner's own text start unmarked (`'as_read'`). Most wakes see an invite or a mail and start marked anyway.
- **#2239** puts today's calendar in the owner turn's now frame from the update sweep's cache. The wake reads the calendar live with the day cards' `calendarRead`, since it runs over outside content anyway and may see titles; it can move to the cache once #2239 lands.
- **#2235** widens follow-up bounds. The wake's `open_loop` uses whatever bounds are merged.

## Where this note differs from the design page, and why

1. **Outcome 1 (an inward, undoable change with no card) is not built until decision 3 is ruled.** #2238 keeps such changes carded for Waldo-started runs, and the 27 Nov ruling keeps approval for anything that reaches other people. PR 1's wake puts such a change on the owner's card.
2. **"Stale" on app open is a cost debounce, not a judgment.** It is a configured age, with the reason stated as cost. Whether the open matters is still the model's call once a wake runs.
3. **Cheaper model first for event wakes conflicts with the 27 Nov "no pre-classifier" ruling,** as the design page itself says. I build the role per wake kind as configuration, default the wake to the role the look uses today, and leave the choice to the owner (open ruling 1).
4. **The per-job change checks do not all go.** The update sweep's "nothing changed" is a fact in code, and the design page's own scenario wants "nothing changed produces no run". What goes is each job's own prompt and its "does it matter" gate. The sweep's change detection becomes the inbox's mail and calendar producer.
   - But **124 mail signals produced 0 changes** overnight (HEY-363, HEY-380), cause not traced. An inbox fed by that sweep inherits the blindness, so that bug needs a root cause before PR 3 relies on it.
5. **The look's cadence stays in PR 1** (`PROACTIVE_REVIEW_EVERY_MIN`, inside the owner's day). Moving to three standing reviews plus event wakes waits for the inbox, since only then do event wakes catch what the cadence catches today (open ruling 2).
6. **Volume low and follow-ups off:** the wake still looks and records its outcome; every unasked send is held. This is the design page's proposal for open ruling 5, and it is what PR 1 does behind its switch.
7. **Skills say the opposite of the ruling in places** ("Silence is a good outcome: most looks end in nothing"). The wake's prompt does not say so, but rewriting skills is HEY-261, not this slice.

## Tests (to write first)

- **A trace assertion per kind:** reason, tools called, outcome row. Exactly one outcome per run, including a provider failure (`failed`) and a cancelled run.
- **The look is not held.** A wake while the daily budget is spent runs, records `held`, and sends nothing.
- **A tool for an unconnected service is not offered,** and one failed tool does not end the run (HEY-367).
- **Authority per `asked`:** the registry-wide gate table from `wake-tool-reach.test.ts` runs against a wake's context and answers as for any run over outside content.
- **The mark per `shown`,** as in #2238.
- **Scenario cases** from the real misses (above), and cases 1 to 10 of the 16 Nov note §7.2 once each entry folds in.

## Falsifiers

- If moving the holds to the send changes the owner-visible unasked messages a day by more than the runs it un-holds, the send-time check is wrong. Measure from the outbox for the week before and the week after.
- If any `asked: 'waldo'` wake makes a change without a card, the authority split is wrong; the registry-wide test should catch it first.
- If wakes on staging still end in `nothing` almost every time once they can see the body and memory, the starting context is not the cause; look at the prompt and the skills next.

## Open rulings for the owner

1. Event wakes: the cheaper role first with hand-up, or always the larger role with a longer merge window.
2. Standing reviews per day: three plus the nightly and weekly passes (design page proposal), replacing the look's cadence once the inbox lands.
3. A cost target per owner per month. Until it is measured per run (HEY-252), the design page's $6 to $18 is an estimate.
4. May a wake make inward, undoable changes with no card (decision 3 of the first version)?
5. Under volume `low` or follow-ups off, do wakes still look silently (proposed: yes)?
6. The owner's daily budget at send time, not before the look (from #2235).
7. How far a fired owner reminder carries the owner's say-so: inward writes only, or sends too (#2239).
8. Turning `GENERAL_WAKE` on in staging.

## Rollback

Every step is behind its own switch. With a switch off, that entry runs its current path unchanged. The outcome table and the notes table are additive and created lazily on first write, as `loops` is, so there is no migration reservation.

## Impact surface

- **Code:** a new `channels/wake.ts` module, a wiring block in `channels/owner-do.ts`, later `heartbeat.ts`, `heartbeat-job.ts`, `owner-turn.ts` `prompt`/`remind`.
- **Authority:** unchanged until rulings 4 and 7.
- **Messages:** the owner's limits bind at send.
- **Persistence:** an additive outcome table and a notes table, both in the forget inventory.
- **Contracts:** none until the Home card, which is additive on `app.v1`.
- **Cost:** wakes no longer stop at a code check before the model, so model runs per owner rise. PR 1 reports the count at the staging cadence.
