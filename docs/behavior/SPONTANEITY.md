# Spontaneity

Waldo acts on what happens in a person's day, not on a fixed timetable. This page is the design intent. The code is the source of truth.

## The problem with fixed times

A 7:30 brief and a 21:00 close assume a linear day. Real days aren't linear:

- People wake at different times, and night-shift workers wake in the evening.
- Meetings move, flights slip, and a workout runs long.

A message at the wrong moment is noise. The right moment is usually set by something that happened, not by the clock.

## What a moment can do

| Pattern | What Waldo does | Example moments |
|---|---|---|
| **Doorway** | Is ready the moment a new phase of the day starts | Waking up, leaving home, landing, a shift starting |
| **Replan** | Notices the plan broke and says what that means for the rest of the day | A meeting moves or is cancelled, a flight is delayed |
| **Capture** | Turns what just happened into next steps | A meeting note finishes, an important email arrives |
| **Absence** | Notices what should have happened and didn't | The expected reply hasn't come, you haven't left for the airport |
| **Body** | Fits the day to how the person is, without numbers or diagnoses | A short night, a workout ends, a long run of meetings |
| **Close** | Wraps up loops before they're lost | Winding down, a promise made earlier in the day |

The same idea serves very different days:

- **Nurse on night shifts:** gets a good-evening Brief when they wake at 18:40.
- **Parent:** leaving the office is the moment for the school-pickup note.
- **Sales rep:** arriving at a client is the moment for a brief on that client.

## Built

- **The Brief arrives when you wake up.**
  - When the app uploads a sleep session whose last asleep interval ended within three hours, today's Brief moves to now. It does this only if the Brief is still pending and planned within three hours.
  - The planned time stays the fallback, and quiet hours still hold the card.
  - Only a value-free "woke" notice crosses from the Worker to the owner object. The waking time stays in the health plane (ADR-0081).
  - Source: `packages/runtime/src/health/wake-notice.ts`, `pullBriefForWake` in `channels/day-cards.ts`.
- **The Brief lays out the day.**
  - After its spoken paragraph, the Brief adds a time-blocked "Your day" plan.
  - Calendar events keep their exact times. Open time is filled from goals, open loops, tasks and waiting items, with the hardest work in the best energy window when shared health names one.
  - A low-Form day gets a lighter plan, paired with one easy step or a bright spot, never a bare warning.
  - The plan is a suggestion and never claims a calendar change. Source: `SCHEDULE_RULE` in `packages/runtime/src/prompt/day-cards.ts`.
- **Already on beta-mvp before this work:**
  - Calendar-change pushes, and briefs before events.
  - Granola notes from earlier meetings with the same people.
  - Open-loop check-backs.
  - The health trigger.
  - Quiet hours and volume, per-owner opt-outs, and delivery to the app or WhatsApp.

## Not built yet

- **One tap to add the day's plan to the calendar.** Today each calendar change is its own approval card. Adding all blocks with one tap needs:
  - a new approval kind holding several changes
  - an app contract revision
  - rendering in the Waldo app
  - a multi-event apply with readback and undo.
- **Moments beyond wake-up:**
  - workout ended
  - arrived or left a place
  - a meeting note finished, giving action items after the meeting
  - a general device-moment intake whose owner-sourced text may reach the model. Today `/events/` deliberately keeps envelope text away from turns.
- **Model-scheduled check-backs** beyond the existing open-loop and reminder check-backs.

## What stays fixed

These are hard rules in code, not judgment calls:

- Each moment is handled once.
- Quiet hours and the delivery budget apply.
- Health moments carry no readings, and Waldo never quotes measurements or makes clinical calls.
- Calendar events are never moved or invented by a plan.

Everything else is the model's call: whether a moment matters, what to say and how to lay out the day. Don't add fixed rules such as "always suggest food after a workout". If a moment keeps being handled badly, fix the context or the instruction and add a scenario test.
