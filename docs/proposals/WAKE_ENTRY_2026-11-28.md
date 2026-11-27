# One `wake()` entry for every run Waldo starts (28 November 2026)

> **Status: Proposed, design note only.** This is slice 4 of HEY-377 (one agent loop). It builds on [MODEL_SET_WAKES_2026-11-16.md](https://github.com/waldoco/waldo-backend/pull/2157) §3.2 and §3.7, and on what has been built since: full tool reach (#2230, merged), model-set wakes (#2234), the follow-up bounds proposal (#2235), the outside-content mark following what a run reads (PR B), and the calendar now frame (PR C). Code references are to `packages/runtime/src` at #2234's head `17904ba88`; line numbers (≈) are approximate. No code here; implementation starts only on the owner's go.

## The problem

Every run Waldo starts enters `OwnerDO` by its own path. Each path picks its own prompt, tool list, taint, model role and limit checks, and ends its own way. The owner sees the result as inconsistency:
- a follow-up that is due waits because a message cap was reached, though looking costs them nothing;
- one run kind acts while another identical one cards;
- nothing records, in one place, why Waldo woke and what came of it, so the evals and the learning loop cannot see a pattern.

## Today's entry points [verified, `channels/owner-do.ts`]

| Run | Entry | Taint at start | Limits checked | How it ends |
|---|---|---|---|---|
| Day cards (Brief, Close, others) | `ledgerJob` (≈5595) from the card executor (≈6755) | `'external'`; `'as_read'` with PR B when the prompt is own text | Quiet hours and volume before; the card's own skip | Card text, or `SKIP` |
| Brief body revision | `ledgerJob` (≈6122) | `'external'` | `quiet()`, `reachesOut()` before | Revised card, or a code |
| Loop check-back (heartbeat) | `heartbeatTick` scan, then reader worker, then `heartbeatApplier` turn (≈5918) | `'external'` (the worker read) | Quiet hours, volume, 4 h cooldown, `held_daily_cap` **before the run** | Message or `checkBackReply` null |
| Waldo's own follow-up wake | One-shot heartbeat entry (`armFollowupWake`, #2234); same tick as above | As above | As above | As above |
| Owner reminder | `responder.remind` (`owner-turn.ts` ≈1373) | Clean, `runOrigin 'waldo'` | None before; the outbox after | Message, or the floor text |
| Reminder set after outside content | `responder.prompt(..., 'external')` (≈5719) | `'external'` | None before | Message |
| Standing order | `responder.prompt` (≈5774) | Clean | `confirm_first` holds changes (#2234) | Report |
| Triage (update sweep) | `responder.prompt` (≈6544) | `'external'` | `interrupts` budget, after | Update card or note |
| Intervention look | `interventionApplier` (≈6580) | `'external'` | `interrupts` budget | Message |
| Health trigger | `runHealthTrigger` `decide` (≈6182), **no tools** | n/a (decision) | `budget.admit` **before the model** | A structured decision |
| Pre-activity spot, calendar prep | `decide` (≈6367, ≈6407), no tools | n/a | Their own | A structured decision |
| Mail follow-up | `ledgerJob` (≈6510) | `'external'` | Its own | Message |
| Announcements | `responder.prompt` (≈6627), no tools | `'external'` | `interrupts.book.hold` before | Decision |

There are at least 13 entries, 4 different limit placements and 3 ending shapes. Only some write a `runs` row, and none writes a reason and an outcome together.

## Proposal

### `wake(reason)`, one function in `OwnerDO`

```ts
type WakeReason = Readonly<{
  kind: 'day_card' | 'follow_up' | 'check_back' | 'owner_reminder' | 'standing_order' | 'triage' | 'intervention' | 'health' | 'prep' | 'mail_follow_up' | 'announcement';
  ref: string;                 // the entry, loop, card or batch it is about
  asked: 'owner' | 'standing' | 'waldo';   // who asked for this run at all
  shown: 'own' | 'outside';    // whether the caller vouches for everything it puts in the prompt
  text: string;                // the reason's own prompt section
}>;
type WakeOutcome = 'spoke' | 'quiet' | 'asked' | 'deferred' | 'acted' | 'held';
```

- **One run, one outcome.** `wake` composes the run through the existing ContextComposer and `createOwnerResponder` (no second brain). It runs `runToolLoop` once and records exactly one outcome row with the reason's kind, the ref and the tools called (names only), in the run ledger the learning loop already reads. `held` means the run wanted to speak and the owner's limits deferred it.
- **The look is never held; the message is.** Quiet hours, volume, the 4-hour re-notify and the owner's daily budget for unasked messages (`held_daily_cap`, the `PROACTIVE_GATE` budget) are checked **when the run decides to speak**, at the outbox, not before it looks. A run over budget records `held` and puts its point on the next card instead.
  - This resolves the disagreement in #2235: follow-ups always wake at their minute, and the owner's own limit still binds every unasked message.
  - Volume `low` keeps today's meaning (no unasked nudges) by holding every send. Whether a `low` owner's wakes should look at all is a decision below.
- **Authority comes from `asked`; the mark comes from `shown` and the reads (PR B).**
  - `asked: 'owner'` is an owner reminder recorded with the owner's own message (PR C, pending the scope question). It runs as that message's turn would, with the owner's words read back by reference and today's behaviour if they were forgotten.
  - `asked: 'standing'` is a standing order, as today, `confirm_first` held.
  - `asked: 'waldo'` is everything else. It acts as a run over outside content: changes go on the owner's card and egress is fenced. Its mark starts clear only when `shown: 'own'`.
- **Decisions get tools.** The health trigger and prep decisions become wakes with the lean menu instead of no-tool structured answers. Their deterministic pre-model gates (`HEALTH_WAKE_REASONS`, the pre-model `budget.admit`) are removed, as the 16 Nov note planned. This is the step that most changes behaviour, so it ships last.

### Order of folding

Each step ships behind `WAKE_ENTRY_<STEP>`, staging on, production off, with `0` as the rollback.

1. **Follow-ups and check-backs.** The heartbeat apply and the one-shot follow-up wake call `wake({ kind: 'follow_up' | 'check_back' })`. `held_daily_cap` moves from the tick to the send. This is the smallest change that ends "a due follow-up waits for the cap".
2. **Owner reminders and standing orders.** These fold in as `asked: 'owner' | 'standing'`, carrying PR C's reminder authority if it is ruled.
3. **Day cards, brief body, triage, interventions, mail follow-up and announcements** become `wake` calls with `shown` set by their callers' existing own-text checks.
4. **Health trigger and prep decisions** become tool-using wakes. Their pre-model gates are removed.

## Tests (to write first)

- **A trace assertion for each kind:** reason, tools called, outcome row. Exactly one outcome per run, including on a provider failure (`quiet` with a code) and a cancelled run.
- **The look is not held.** A follow-up due while the daily budget is spent runs at its minute, records `held`, and sends nothing. The next card carries its point.
- **Authority per `asked`:**
  - a `waldo` wake cards `set_reminder`;
  - an `owner` reminder runs it;
  - a `standing` `confirm_first` fire refuses it.

  The registry-wide gate table from `wake-tool-reach.test.ts` runs once per `asked` value.
- **The mark per `shown`,** as in PR B: an `own` wake that reads mail records its follow-up as outside.
- **Scenario cases 1 to 10 of the 16 Nov note §7.2,** run through `wake` and compared with today's outcomes.

## Falsifier

If folding step 1 changes the owner-visible message count on staging by more than the follow-ups it un-holds, the send-time budget check is wrong. Measure the unasked messages a day per owner, from the outbox, for the week before and the week after. Also, if any `asked: 'waldo'` wake runs a change without a card, the authority split is wrong; the registry-wide test should catch that before staging.

## Decisions for the owner

1. **The owner's daily budget at send time, not before the look** (from #2235). It is proposed here; it needs a yes.
2. **How far a fired owner reminder carries the owner's say-so:** inward writes only, or sends too (PR C question).
3. **Whether a clean Waldo-started run may make inward, undoable changes without a card** (`set_reminder`, `open_loop` for the owner, `log_*`). Under the 12 Nov "act and undo" direction this would be the next unlock after PR B. Today these are carded, and PR B keeps them carded.
4. **Volume `low`:** do wakes still look (silently), or not run at all?

## Rollback

Every step is behind its own switch. With a switch off, that entry runs its current path unchanged. The outcome rows are additive. The table is created lazily on first write, as `loops` is, so there is no migration reservation.

## Impact surface

- **Code:** `channels/owner-do.ts` entries, `channels/heartbeat.ts`, `heartbeat-job.ts`, `owner-turn.ts` `prompt`/`remind`, and the run ledger.
- **Authority:** unchanged until decisions 2 and 3 are ruled.
- **Messages:** the owner's limits bind at send.
- **Persistence:** one additive outcome table.
- **Contracts:** none; the app reads outcomes later, through its own additive contract.
- **Evals:** the nightly trial gains per-kind outcome assertions.
