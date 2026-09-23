# Waldo vocabulary and brand (final, 2026-09-24)

The owner ruled on every open conflict on 2026-09-24. This doc is now the one source for Waldo's product words, voice and brand. Planning docs, prompts and app copy follow it. Figma brand files get folded in when the owner shares them.

Sources: the owner's rulings of 2026-09-24 (via WhatsApp), WaldoBrain (`01-Waldo/design/brand-standards.md`, the Voice Solidification and Alfred formula notes, the System Viewer glossary, the Form/Recovery/Weight metric map), and the 2026-09-24 build brief.

## 1. Body and day

| Term | Meaning | Rules |
|---|---|---|
| **Form** | The owner's body capacity right now. The one headline score. | Computed in code, never by the model. A number only shows once it is validated for this owner. |
| **Load** | What the day is asking of the owner: its demand and pressure, compared with their own normal. | Meetings, tasks, messages and commitments drive it. Signal pressure and task pileup are drivers, not separate scores. |
| **Recovery** | What last night gave back. A driver of Form, not a headline. | Fixed at wake. |
| **Weight** | Body mass only. | Never used for day demand. |
| **The Slope** | The 4-week trajectory: is the long arc going up or down? | Shown weekly, never alarmist. |

Retired from owner copy: Readiness, Readiness Score, CRS, "Today's Weight" as demand, Mind State score. The WaldoBrain rings become Form / Load / Recovery.

Always compare the owner to their own normal, never to population averages. Detailed health stays out of channel messages.

## 2. The daily rhythm

| Term | Meaning |
|---|---|
| **The Brief** | One main, living brief for the day. In the morning it is the anchor. In the app it sits on top of a swipeable stack: the main brief first, then smaller sub-briefs and context cards (a new learning, a spot, a prep for a meeting). An on-demand "catch me up" is the Brief rendered now. |
| **Check-in** | The midday update of the same Brief: only what changed. |
| **The Close** | The night close of the Brief: what happened, what carries over, tomorrow. |
| **Prep** | A context card before a meeting or event. One card in the Brief stack. |
| **Morning.** | The greeting. Not "Good morning". |

Retired: Morning Wag, "Daily Brief" as a separate product, "Afternoon check-in".

## 3. Proactivity

| Term | Meaning | Rules |
|---|---|---|
| **Fetch** | The run itself. Every few minutes Waldo sweeps the owner's tools, accounts, plugins and health for anything new. Detection is cheap code; the model only runs when something actually changed. | No model call on a timer when nothing changed. Every Fetch output has a trigger, a why-now line, a stop control and feedback. |
| **Fetch alert** | What a Fetch surfaces: a meaningful change or a new spot. | Owner feedback (Useful / Not useful) tunes what gets sent. Quiet hours and volume are the owner's. |
| **Body-state Fetch** | The old WaldoBrain stress alert, now one Fetch type. | Opt-in after baseline validation. Same threshold logic. |
| **Intervention** | A critical check-in when Load runs hot or the body needs protecting. It can come out of a Fetch or stand alone. | Targeted, timed, protective. Rare. |
| **The Sniff** | Internal name for the stress detection engine. | Never in owner copy. |

## 4. Doing things

| Term | Meaning | Rules |
|---|---|---|
| **Handoff** | Something actionable a Fetch turned up that Waldo offers to do or takes on for the owner. | Tracked as an open loop until it is done or dropped. The "Waldo took care of it" and "Waldo is on it" surfaces show handoffs. |
| **Open loop** | The tracking record behind a handoff or any "I'll do it later". | Shown in the ledger under "Waldo is on". |
| **The Adjustment** | A change Waldo makes or proposes to the day, such as moving a meeting. | Always an approved Effect. Undo where the provider allows it. |
| **The Window** | A focus block Waldo guards on the calendar. | |
| **Sync to calendar** | A button, not a noun. | |
| **Approval buttons** | **Do it / Modify / Not now** | Replace Approve / Change / Skip. |
| **Activity** | The screen that shows what Waldo did and why, from the ledger. | Replaces the mock Patrol log. |

## 5. Memory

| Term | Meaning | Rules |
|---|---|---|
| **Spot** | One thing Waldo noticed. Starts as an inferred claim. | Owner actions: that's right, not quite, forget. Confirming moves it into the Profile. |
| **The Constellation** | The long-term memory layer: a graph of patterns across weeks. | Waldo builds, names and maintains it. The owner can't rename clusters but can correct or forget them. It never claims cause. |
| **Profile** ("About you") | Generated from what the owner said or confirmed. Replaces the old core memory files. | Inferred claims never enter it on their own. |

## 6. Personality and surfaces

- **Waldo** is the agent. Written Waldo or waldo, never WALDO. Tagline: "Already on it."
- **The mascot** is a Dalmatian with a bow tie: smart but goofy, head tilted, one ear up. It is a brand symbol and never speaks.
- **Waldo Moods** are the avatar's states, tied to the owner's Form zone. Pure personality, no information the owner needs.
- **App chat:** threads, the AG-UI pattern, inline rich cards, prompt chips, and generative forms instead of plain-text questions.
- **Plans:** Pup / Pro / Pack, billing only.

## 7. Voice

The formula: open Waldo, shift to Alfred, close dry. About 60% friendly, 40% Alfred. In back-and-forth chat the register moves fully to Alfred: precise, unhurried, never clinical.

Rules:
1. Always give the reason.
2. Wit once, then stop.
3. Never self-congratulate. The action speaks.
4. Always offer the door.
5. Silence is the default. No filler check-ins or encouragement.
6. 8th-grade reading level. No exclamation marks, no slang sign-offs.
7. Greeting: "Morning." (owner ruling 2026-09-24; overrides the older "Good morning" rule).
8. An agent that knows when not to speak: when Form is low, say less.

Banned words: wellness, wellbeing, mindfulness, holistic, optimize, AI-powered, health tracker, health app, unlock (your potential), burnout as a self-descriptor, monitors, tracks, smart or intelligent on their own, hustle, empower, journey, leverage, deep dive, circle back.

Owned words: signal, before, pattern, baseline, capacity, reads, already knows.

Locked lines (updated to the current vocabulary):
- Brief: "Morning. Bit of a rough night, your sleep was short by about 40 minutes. I've nudged your 9am to 10:30. Nothing drastic. The rest of your day looks good."
- Adjustment: "Waldo did a thing. Your 2pm and 3pm swapped, the harder one's now when you're sharper. You can undo it if you want, but you probably don't."
- Spot: "Spotted something. Your Wednesdays are quietly your best day, consistently. I've been saving your hardest work for then. It appears to be working."
- Strong action: "Last night was a difficult one. I've cleared your morning and pushed your first meeting to 10:30. I'd suggest a light start."

## 8. Internal terms

| Old | Now |
|---|---|
| Dreaming Mode | Consolidation (the nightly pass) |
| Heartbeat | Wake |
| Hands, Facets | Skill |
| The Patrol (background engine) | Fetch |
| L0/L1/L2 | Say which: data tier, context tier or initiative level |

## 9. Code names that still use old words

User-facing strings were updated with this ruling. These identifiers stay until a cleanup pass (label `post-mvp-cleanup`):
- `update-cards` / `update_card` (Fetch alerts)
- `event-briefs` (Prep)
- the `dreaming` schedule kind (Consolidation)
- `card:midday` (Check-in)
- `spots` in console HTML ids and `supporting_spots` columns
