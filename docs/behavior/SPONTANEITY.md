# Spontaneity

How Waldo acts on what happens in a person's day instead of on a fixed timetable. The code is the source of truth (`packages/runtime/src/channels/owner-signals.ts`, `proactive-owner.ts`); this page describes the behaviour it is built for.

## The problem with fixed times

A 7:30 brief and a 21:00 close assume a linear day. Real days aren't linear: people wake at different times, meetings move, flights slip, kids get sick, a workout runs long. A message at the wrong moment is noise, and the right moment is usually set by an event, not a clock.

Waldo therefore listens for **moments**: something that happened, reported by the person's devices or apps. For each one it asks a single question: *does this change anything for them, and is there something useful I can say or prepare right now?* Often the answer is no, and Waldo stays quiet.

## What a moment can do

Across very different days, the useful responses fall into six patterns.

| Pattern | What Waldo does | Example moments |
|---|---|---|
| **Doorway** | Be ready the moment a new phase of the day starts | Waking up, leaving home, arriving at work, getting in the car, landing, a shift starting |
| **Replan** | Notice that the plan broke and say what it means for the rest of the day | A meeting moves or is cancelled, a flight is delayed, rain on a run day, a school closure |
| **Capture** | Turn what just happened into next steps while it is fresh | A meeting note or call recording finishes, a voice memo, an important email arrives |
| **Absence** | Notice what should have happened and didn't | No wake-up by the usual time, the reply you were waiting for hasn't come, you haven't left for the airport |
| **Body** | Fit the day to how the person actually is, without numbers or diagnoses | A workout ends, wind-down starts, a short night (the person says so), a long run of back-to-back meetings |
| **Close** | Wrap up loops before they're lost | Winding down for bed, the end of a work block, a promise made earlier in the day |

**Absence** is the hardest, because nothing arrives to trigger it. That's what check-backs are for (below).

## Different days, same mechanism

| Person | Moment | What helps |
|---|---|---|
| Founder | The calendar says 15:00, but the notes app reports the meeting at 17:00 | Action items right after the note finishes, plus "your 15:00 seems to have moved" |
| Nurse on rotating shifts | Wakes up at 18:40 before a night shift | A *good-evening* brief: handover time, the commute, eating before the shift. A fixed "morning" brief would land while they sleep. |
| Parent | Leaves the office at 15:10 | "Pickup is at 15:30, and the swim kit is still in the car." Later, check back at bedtime to confirm the form is signed. |
| Field sales rep | Arrives at a client's car park | A short brief on that client from memory. When they drive off, ask for two lines of notes and draft the follow-up. |
| Student | Lecture recording ends | Three bullets and the deadline mentioned at the end of the lecture |
| Frequent traveller | Plane lands, airline reports a gate change | Connection time, which way to walk, and whether the dinner meeting still works |
| Runner in training | Long run ends at 11:00, lunch meeting at 12:30 | Eat something small now, since lunch is in 90 minutes. No calorie numbers. |
| Freelancer | Email from a client with "invoice" in it | Whether it matches what they were owed, and a draft reply for them to send |

None of these need custom code. The sender names the moment (`source` and `event`) and attaches whatever it knows (`detail`, `context`). The model works out the rest from that, the conversation and memory.

## Check-backs: Waldo sets its own next look

Spontaneity also means knowing when to look again. After any proactive turn the model may ask to look again at a local time within the next 24 hours: when a meeting should be over, before someone needs to leave, or to see whether an expected reply arrived. It can do this while saying nothing now. When the check-back comes due, Waldo runs another proactive turn with its own reason as context.

This covers Absence moments without polling every connector all day.

## What stays fixed

These are hard bounds, not judgment calls:

- **Once per moment.** Waking up and winding down happen at most once per local day. Other moments dedupe by the sender's id, or by identical content within the hour.
- **A morning safety net.** If no wake-up arrives by the morning deadline, Waldo sends the morning message anyway, once. A late wake-up after that stays quiet.
- **Budget.** At most 12 proactive model calls a day, failures and check-backs included, and at most 6 pending check-backs.
- **Health boundary.** Body-state moments come only from a closed list (`woke_up`, `wind_down`, `workout_started`, `workout_ended`) with no free text and no numbers. Waldo never quotes measurements and never makes clinical calls.
- **Honesty.** Waldo never invents events it wasn't given. When it hasn't heard something, it says so.

Everything else is the model's call: which moments matter for this person, whether to speak, what to say, and when to look again. Do not add fixed rules like "always send a nutrition tip after a workout over 30 minutes". If a moment keeps being handled badly, fix the context or the instruction, and add a scenario test.

## Where moments come from today

Signals arrive at `POST /signals` ([setup](../ops/PROACTIVE_SIGNALS.md)). With no app work, an iPhone Shortcuts automation can send most of the moments above:

- **Health and routine:** Sleep Focus on and off, wind-down, an Apple Watch workout starting or ending, an alarm stopped.
- **Place and movement:** arriving at or leaving a location, connecting to CarPlay, joining a Wi-Fi network, the Driving Focus.
- **Communication:** an email or message from a chosen sender, a work Focus turning on or off.
- **Content:** sharing a note, recording or document to a "Send to Waldo" shortcut.

Any service that can send a web request (an automation platform, a notes app with webhooks) can send the same body.

Not built yet: direct connectors that produce moments without the person setting anything up (Google Calendar change watching, Gmail, Granola), and the Waldo app's own HealthKit background delivery. All of them should feed this same `/signals` path, not a parallel one.
