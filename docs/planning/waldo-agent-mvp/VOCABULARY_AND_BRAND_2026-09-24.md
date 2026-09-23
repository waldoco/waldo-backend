# Waldo vocabulary and brand reference (2026-09-24)

This doc compares the words used in three places. Figma is not in this pass; it will be added when the owner shares the files.

Sources:
- **WaldoBrain.** From Pin4sf/waldo-brain I pulled text from 37 HTML pages: the System Viewer brand and tech glossaries, the Technical Brief, Founder Canvas, the Form/Recovery/Weight metric map, the harness deepwiki pages, and the Build Brief. I also read `01-Waldo/design/brand-standards.md` and "Rebrand, Nomenclature & Mascot Pivot".
- **Planning docs** in waldo-backend: the brainstorm list section 3 and the reconciliation doc section 4.
- **The brief**: the owner's 2026-09-24 build brief, Part 2, sections 1-11.

Nothing here is changed in code or prompts until the owner rules on the "Needs ruling" rows.

## 1. Terms the owner sees

| Term | WaldoBrain meaning | The brief | Status |
|---|---|---|---|
| Waldo | The dalmatian agent. The mascot is the brand symbol, not the voice. Tagline "Already on it." | Same. "The dog never speaks." Casing is Waldo or waldo, never WALDO. | Agreed |
| The Brief | Umbrella name for 4 variants (morning, midday, evening, event). Sits at the top of Overview and is never pushed. | The morning card only. The other cards are Check-in, The Close and Prep. | **Needs ruling** |
| Morning Wag | Brand word for the morning Brief. Kept in copy and the SOUL_MORNING file name (ADR-0015). | Retired. Use The Brief. | **Needs ruling** |
| Check-in | Not a term. WaldoBrain has "The Intervention", an overload check-in card. | The midday card. | New in the brief. The Intervention is dropped without a mention. |
| The Close | Evening review, in the app only. | An evening card, also sent on Telegram. | Channel differs. The code already sends it on Telegram. |
| Prep | Not a term. It was the "event" variant of The Brief. | A card before a meeting (was "pre-event brief" or "event brief"). | New name. The code says `event-briefs`. |
| The Fetch | A stress alert: stress confidence of at least 0.60 held for 10+ minutes, max 3 a day, 2h cooldown. Found by The Sniff. | The brand for all unscheduled proactivity. Each one has a trigger, a why-now line, a stop control and feedback. No cap (owner ruling of 17:49). | Much wider meaning. **Needs ruling:** does the stress alert keep its own name? |
| The Adjustment | Waldo moved a meeting, blocked time or deferred a task. Undo is always there. | A change to the day, always an Effect. | Agreed |
| The Handoff | The day plan synced to the calendar: "Sync it" / "Walk me through it", explore, plan, act. | Listed in the vocabulary block but not defined. | **Needs ruling.** The brainstorm list proposed using Handoff for open loops. |
| The Window | A focus block Waldo puts on the calendar. | Listed but not defined. | Agreed (keep the WaldoBrain meaning) |
| Spot | A single observation in 6 categories. Confidence of 0.80+ makes it eligible for the home screen. | An inferred claim. Actions: right, not quite, forget. When the owner confirms one, it moves into the Profile. | Compatible. The brief adds actions, WaldoBrain adds categories. |
| The Constellation | A long-term pattern map from day 30+. Clusters are named by Waldo ("Wednesday Peak"), and the user can't rename them. The first one gets its own push. It has a share card. | Observational links. Correct and forget reach it. It never claims cause. | Mostly compatible. **Needs ruling:** can the user rename or forget a cluster? The brief implies yes; WaldoBrain says no. |
| The Patrol | (a) The action-log screen. (b) An internal background consolidator inside Dreaming Mode that runs "Patrol passes" (ADR-0017). | The Activity screen only. There is no 24/7 job. | The brief drops meaning (b). Low risk, since (b) was internal. |
| Profile ("About you") | Not a term. The nearest thing is the core memory files. | Generated from stated or confirmed claims. It replaces "core memory". | New. Engineering-side. |
| Open loop | The Technical Brief keeps three states: agent session, outcome verification, open loop. | Same three states. | Agreed |
| The Slope | A 4-week trajectory: better or worse? | Not mentioned. | **Missing from the brief** |
| Waldo Moods | 6 dalmatian visual states tied to the Form zone. | Not mentioned. | **Missing from the brief** (app and Figma scope) |
| Thread, inline rich card, context card, prompt chips | Chat-surface terms from WALDO_CHAT_FLOW | Not mentioned. | App scope. Keep them. |
| Approval card buttons | [Do it] / [Not now] / [Modify] | "Exact approval card" | **Needs ruling.** The live Telegram cards say Approve / Change / Skip. |

## 2. Body and day

This is the biggest conflict. WaldoBrain's metric map (which follows ADR-0011) and the System Viewer glossary say:
- **Form** is "what can you do right now?", cognitive readiness 0-100. Form = Recovery×0.50 + HRV/CASS×0.35 + Circadian×0.075 + Motion×0.075.
- **Recovery** is "what did last night give you?". Recovery = Sleep×0.50 + HRV×0.25 + resting HR trend×0.15 + respiratory rate×0.10. It is fixed at wake.
- **Weight** is "what is today asking of you?": total demand, with a higher score meaning a heavier day. Target: Load + Stack + Signal + Task + Mind. The current app uses Day Strain / 21 × 100.
- **Load** is cardio load on a 0-21 scale, and it is one part of Weight.
- **Motion** is a Tier 2 card under Form.
- Overview shows Form, Recovery and Weight as three rings.

The brief says:
- Form is body capacity.
- **Load is day demand.**
- **Weight is body mass only.**
- Recovery is a driver of Form, not a headline.
- It retires "Today's Weight (as demand)" in favour of Load.
- Signal Pressure and Task Pileup become drivers of Load, not scores.
- There is no Mind State score, and Readiness and CRS are retired from user copy.

**Needs ruling**, because the choice changes app screens and Figma:
1. Is the demand score called Weight (WaldoBrain) or Load (the brief)?
2. Is Recovery a headline ring or only a driver?
3. Is Form described as "cognitive readiness" (WaldoBrain, and one of the brand-standards owned words) or "body capacity" (the brief)?

Both sides agree on four things:
- Scores come from code, never from the model (the brief adds that numeric Form only appears once it has been validated).
- Readiness is not a Waldo word.
- Compare the owner to their own normal, not to the population.
- Detailed health stays out of channel messages.

## 3. Internal terms

| WaldoBrain | The brief | Note |
|---|---|---|
| Dreaming Mode (6 phases, nightly) | Consolidation | Rename. The code uses `dreaming` as a schedule kind. |
| The Sniff (stress detection engine) | Not mentioned | Needed if the stress Fetch survives. Keep it internal. |
| Heartbeat | Wake | Rename |
| Hands, Facets | Skill | The brief agrees with brainstorm list section 3 |
| L0/L1/L2 | Say which: data tier, context tier or initiative level | Agreed with brainstorm list section 3 |
| Pup / Pro / Pack | Plan names, used in billing only | WaldoBrain also uses "Pack" for teams. Flag it. |
| — | Run, Occurrence, Admission, Projection, Evidence level, Release ladder | New in the brief. Engineering only, so no ruling needed. |

## 4. Voice

The two sources agree on:
- Wit lands once, then stops.
- Always give the reason.
- Never self-congratulate.
- Silence is the default.
- "Already on it."

WaldoBrain's brand standards add:
- The "Open Waldo, shift to Alfred, close Alfred-dry" formula, at 40% Alfred and 60% friendly.
- An 8th-grade reading level.
- Owned words: biological intelligence, cognitive readiness, signal, before, pattern, baseline, capacity, reads, intervention, already knows.
- Locked voice lines, such as the Fetch line "Waldo did a thing. Your 2pm and 3pm swapped...".

Conflicts:
- **Greeting.** The brief says "Good morning", not "Morning". The locked WaldoBrain example starts "Morning. Bit of a rough night...". **Needs ruling.**
- **Banned words.** The brief bans: wellness, mindfulness, optimize, hustle, journey, holistic, empower, unlock, leverage, deep dive, circle back. WaldoBrain bans: wellness, wellbeing, mindfulness, holistic, optimize, AI-powered, health tracker, health app, unlock your potential, burnout (as a self-descriptor), monitors, tracks, smart/intelligent (standalone), hustle, empower. Proposal: ban the union of both lists. That is an engineering call unless he objects.

## 5. Positioning

The two sources frame Waldo differently:
- **Early WaldoBrain brand:** "Health on autopilot." "The biological intelligence layer."
- **The Technical Brief** (newer): "a private personal agent that carries your health context, priorities, commitments, boundaries and outcome history", with Kennel as the first surface.
- **The brief:** "One durable Waldo per person... more done within what their body and day can take."

The brief matches the Technical Brief, and health comes first in both. Worth one line of confirmation from the owner. The code follows the Technical Brief framing today.

## 6. What the code says today

These code names still use the old words and change once the rulings above land:
- `update-cards` (would become Fetch / change sweep)
- `event-briefs` (Prep)
- the `dreaming` schedule kind (consolidation)
- `MEMORY_CORE` and friends (Profile)
- the `brief` card id with midday and close variants

Renaming is cheap and happens after the ruling.
