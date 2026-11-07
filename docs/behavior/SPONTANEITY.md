# Spontaneity

Waldo acts on what happens in a person's day, not only on a fixed timetable. This page records the design intent. The code is the source of truth.

## The problem with fixed times

A 07:30 Brief and a 21:00 Close assume a linear day. Real days aren't linear:

- People wake at different times, and night-shift workers wake in the evening.
- Meetings move, flights slip, and a workout runs long.

A message at the wrong moment is noise. The right moment is usually set by something that happened, not by the clock.

## One proactive layer

Every unasked message goes through the proactive layer and its one set of owner limits:

- `PROACTIVE_GATE` covers consent, quiet hours, one question in flight, the daily budget, the gap, and the day from the Brief to the Close.
- Triage acts ahead and holds the day shape (`PROACTIVE_ACT_AHEAD`).
- Waldo's own look (`PROACTIVE_INTERVENTIONS`).

New moments are inputs to that layer, never a second path to the owner.

## Built

- **The Brief arrives when you wake up (`WAKE_BRIEF`).**
  - An app health upload, or a WHOOP sync, that commits a night whose last asleep interval just ended tells the owner's object `woke: true` and nothing else. The waking time never leaves the health plane (ADR-0081). Source: `health/wake-notice.ts`.
  - A Brief still to come then gets one model turn. The model reads the time, the weekday, quiet hours, routine and calendar, and decides whether the owner is up for the day or awake at 03:00 or after a nap. It sends the Brief now or earlier, or keeps it. Source: `wakeTarget`, `parseWakeReply` and `applyWake` in `channels/day-cards.ts`.
  - Code holds only the hard limits:
    - never later than planned;
    - only a Brief that is still pending, not pinned, not set by the owner, and not due yet;
    - the daily Brief on;
    - model-use health consent live when the notice arrives;
    - at most `WAKE_BRIEF_TURNS_PER_DAY` turns a day.
  - No time of day is barred. An evening wake can bring forward a Brief still to come today, such as one the day plan put in the evening for a night shift. Once today's Brief has gone, a later wake has nothing to move.
  - The new time is written on the plan row with the reason "moved earlier". The owner's day for unasked messages (`dayPlanBook.window`) therefore opens with it on every surface. The content-free morning push follows the Brief's delivery as before.
  - What the owner object keeps: when the Brief moves, its new send time, on the plan row and in its delivery, places the wake within `WAKE_BRIEF_FRESH_MIN` before it. Nothing it keeps or logs names a wake: the turn runs and logs as a day re-plan, and logs only a failure.
  - With no wearable, health not shared, or consent revoked, the Brief goes at its planned time.
- **The Brief lays out the day (`BRIEF_DAY_PLAN`).**
  - After its spoken paragraph, the Brief (recap or planning) adds a "Your day" time-blocked plan.
  - Calendar events keep their exact times. Open time is filled from goals, open loops, tasks and waiting items.
  - A dip in shared health gives a lighter plan, paired with one easy step, never a bare warning.
  - The plan is a suggestion and never claims a calendar change. Source: `SCHEDULE_RULE` in `prompt/day-cards.ts`.
- **One tap adds the plan to the calendar (`CALENDAR_PLAN`, approvals revision 9).**
  - `propose_calendar_plan` puts a plan's new blocks on one `calendar_plan` card: 2 to 12 blocks on one local day, on the owner's own primary calendar, with no guests. It only proposes. The planning Brief offers it.
  - Approving is one tap in chat, like a single block. The add is all or nothing:
    - each block is its own effect, with a fixed event id;
    - a block added before another failed is removed again, and the card reads not done;
    - a block that can't be shown removed leaves the card's outcome unknown, naming it. Once a removal has begun, or the plan's first block has started, approving again never adds: it reads the calendar back and says what is on it.
  - Undo removes every block that is still as the plan wrote it.
  - An app build below revision 9 never gets the card; its chat carries the card's words and asks it to update.
  - Source: `channels/calendar-plan.ts`; the `calendar_plan` branch of the approval desk.

- **Arrived home or at the gym (`ARRIVAL_LOOK`, device-context ADR §9).**
  - The owner names home and the gym on their phone, which keeps those places. When it arrives at one, its place upload says `arrived: home` or `gym`; only the word travels, and nothing stores it.
  - For a reading observed within the hour, while the owner lets Waldo's model read place, the owner's object brings Waldo's look to now, as a move to another city does. The look is told an arrival is a reason to look, not a reason to speak, and keeps every limit of the look.
  - Source: `channels/app-device-context.ts`, `health/zone-change-route.ts` (`placearrived`), `channels/interventions.ts` (`LookCause`), migration `20261107100000`.

## Not built: follow-ups for the proactive layer's seams

- **Workout ended, and meeting ended or meeting notes ready.** These are inputs to the proactive layer's look (`intervention-review`) or triage, under `PROACTIVE_GATE`. They are not a separate `/signals` route with its own budget.
- **Left a place.** Only arriving home or at the gym brings a look forward (above). Leaving one does nothing yet.
- **Model-scheduled check-backs.** A "look again at HH:MM" belongs on the look's own one-shot schedule (`nextLookAt`), under the same limits.
- **Oura and other cloud wearables.** Only the app upload and WHOOP say `woke` today.

## What stays fixed

These are hard rules in code, not judgment calls:

- Each moment is handled once.
- Quiet hours and the owner's limits apply.
- Health moments carry no readings or times, and Waldo never quotes measurements or makes clinical calls.
- A plan never moves or invents calendar events. Only the owner's tap adds blocks.

Everything else is the model's call: whether a moment matters, what to say, and how to lay out the day. Don't add fixed rules such as "always suggest food after a workout". If a moment keeps being handled badly, fix the context or the instruction, and add a scenario test.
