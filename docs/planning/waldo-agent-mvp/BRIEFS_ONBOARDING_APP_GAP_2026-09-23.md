# Briefs, onboarding and app gap analysis (2026-09-23)

Analysis first. Built since: routine-planned card times (91cad99) and change-driven update cards (7e958f5), see section 6.

Sources read:
- Old app Figma (prototype/reference only): nodes 724-16295, 722-15216 (onboarding), 969-2016 and 969-2021 (tier-1), plus the spec notes frame.
- waldo-app at 895ed6e4 (2026-09-21): `app/`, `src/stores/onboarding.store.ts`, `Docs/STATUS.md`, `Docs/planning/onboarding-signal-map.md`.
- waldo-backend beta-mvp at 63d8c41: `packages/runtime/src/prompt/day-cards.ts`, `channels/day-cards.ts`, `memory/core-files.ts`, `index.ts`.
- Competitors: `docs/planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md`, `docs/research/WALDO_PEER_EXPERIENCE_REVERSE_ENGINEERING_AND_BUILD_ORDER_2026-09-19.md`, and September 2026 news (links in section 4).

## 1. How the briefs should be generated

### What runs today (63d8c41)
- Three cards at fixed local times: The Brief 08:00, Afternoon check-in 14:00, The Close 21:30. All three are hardcoded in `DAY_CARDS`.
- Each card prompt contains the calendar window, the ledger and today's conversation. There is no routine, no health signal and no carryover from yesterday's Close.
- The recurrence is `daily_local` at a fixed time. It does not move on a late start, a weekend or an early first meeting.

### Proposed design
1. **Routine profile.** A backend-owned record holding wake time, wind-down time, day shape, peak hours, work start, quiet hours, timezone and preferred channel. It is seeded from onboarding and kept current from chat ("I'm up at 6 now") and observed behavior (first message of the day, first calendar event). It fits in `MEMORY_CORE` as a structured section, or in its own small table if the app needs typed reads.
2. **Times planned nightly by the model, per day.** The nightly memory run already exists. Add one step: the model gets the routine profile plus tomorrow's calendar and returns the times for tomorrow's cards as structured output. For example: Brief about 30-45 minutes after wake, earlier if the first meeting comes sooner; check-in after the peak window, or none on a light day; Close about 60-90 minutes before wind-down. The runtime arms one-shot occurrences for that day instead of a fixed daily recurrence.
   - Hard limits stay deterministic: quiet hours and never after the owner's wind-down time. No push cap (owner ruling 2026-09-23).
   - Explicit user settings win. The Figma Notification settings already have Brief time and Close time. A set time pins that card; "auto" lets the model plan it.
   - Fallback when the nightly step fails: use yesterday's times, then the onboarding wake/bedtime anchors.
3. **Content is a composed read, not a template.** Inputs per card: calendar window, open follow-ups and reminders, goals, memory core, yesterday's Close carryover (morning only), and health signals once real data exists. Each card has one job:
   - The Brief: what today looks like, the one thing to protect, one action.
   - The check-in: only what changed plus the next decision. Skip it on a quiet day (this already works).
   - The Close: done, carried over, the first things tomorrow. No new asks.
4. **Feedback loop.** Add a 1-tap reaction on each card (useful / not now / wrong). For the first 14 days, end the Brief with "How do you actually feel?" (rough / okay / sharp). This follows `onboarding-signal-map.md`. Feed the answers into the routine profile and the next night's plan.

### Backend work
- Routine profile store plus read/update tools the model can call from chat.
- Nightly planning step with a structured output schema, then one-shot scheduling (the scheduler already supports `occurrenceAt`).
- Settings override (pinned vs auto) per card.
- Brief store (id, card, text, created_at) so the app can show today's Brief and history. Today cards only go out on Telegram.

### Conflict to resolve
The app's settings screen says "The Brief is an in-app briefing, never a push (WALDO_THE_BRIEF_FLOW)". The runtime currently pushes all three cards on Telegram. Pick one: push on the chat channel, in-app only, or push a short line that links to the in-app card.

## 2. Mobile onboarding design

### What the app already has
There are 19 onboarding screens in `app/(onboarding)/`: hello, name, day shape, wake, bedtime, peak hours, caffeine, goals, stress signs, autonomy ("how much rope"), profession, connect-watch, connect-healthkit, signal-depth, permissions, notifications, legal, few-days, splash.
- Answers live in an in-memory Zustand store (`onboarding.store.ts`). The comment says they are "flushed to Supabase/profile at the end of the flow", but no write call exists in the onboarding screens. **Nothing the user answers reaches any backend today.**
- Missing from the owner's ask: how the user is feeling right now, and habits beyond caffeine (exercise, sleep habits, what restores them).

### Proposed flow (about 3 minutes of taps plus an optional 3-5 minute interview)
1. **Hello + name** (keep).
2. **Rhythm:** wake time, wind-down time, day shape, peak hours (keep all four; these anchor the brief times).
3. **What matters:** goals as chips plus one free-text line: "What do you want to be different in a month?"
4. **Right now:** "How have you been feeling lately?" (chips: running on empty / stretched / steady / good) plus optional free text. This sets tone. It is not a diagnosis and is never scored.
5. **When things go sideways** (stress signs, keep) and **how much rope** (autonomy, keep).
6. **Connect:** Google (calendar/mail) and Apple Health or Health Connect. Wearable brands only where an integration actually exists.
7. **Waldo interview (new, optional, in chat, voice or text).** Waldo asks at most 4 open questions: a normal weekday start to finish; habits that help or hurt (exercise, caffeine, screens, sleep); what's weighing on you this week; how you want Waldo to talk to you. The model extracts routine, habits, goals and open loops into memory.
8. **"Here's what I got" (new).** An editable summary of routine, goals and habits, plus the derived schedule: "The Brief around 7:15, The Close around 22:00." The user can edit or confirm.
9. **Channel + notifications + legal** (keep), then **All set:** "First Brief arrives tomorrow morning" (keep).

Move to later, in chat (progressive profiling as in the signal map): caffeine detail, profession, calendar anchors, recovery menu, exercise pattern.

### Backend work
- An authenticated app API. The runtime today exposes only the Telegram webhook and the Google OAuth callback, for one owner. It needs app identity, `POST /onboarding`, `GET/PUT /profile` (routine + settings), and an interview session over the same agent loop.
- Map the owner's app identity to the runtime owner (Telegram id today).
- Write onboarding answers into the routine profile and core memory files, with source = onboarding.

## 3. Figma vs app vs backend

Legend: **Built** = UI exists in waldo-app; **Runtime** = what the new backend (beta-mvp) provides.

| Figma screen | waldo-app | Runtime (beta-mvp) | Verdict |
|---|---|---|---|
| Onboarding sections 1-4 | Built, 19 screens, answers not persisted | Nothing | Keep; add interview + summary; persist |
| Overview: morning narrative brief | Built (`brief.tsx`, BriefDeck) on legacy Supabase `agent` function | Brief generated, sent to Telegram only | Need brief store + read API |
| Overview: checklist | Partial | Reminders + follow-ups exist, no API | Need API |
| Today's Brief calendar timeline | Built (CalendarIntelligenceCard, legacy `calendar` function) | Google Calendar read per owner | Point the app at the runtime |
| Health Stats rings, tier-1 Form/Recovery/Weight | Built; computed on device. iOS HealthKit exists; Android health/wear modules are JS stubs | Nothing | Keep iOS; Android needs native work |
| Tier-2 cards (Sleep, HRV, Resting, Motion, Stress, Stack, Signal Pressure, Task Pileup, Mind State) | Partial (`health/[metric].tsx`, 26 lines) | Nothing | Keep Sleep/HRV/Resting/Motion; defer the rest |
| The Patrol log + full log | Built on mock data (`@/mocks/waldo`) | Ledger exists | Feed Patrol from the ledger (renamed Activity) |
| The Spots + detail | Built on mock data | Nothing (pattern discovery deferred in plan) | Remove for MVP |
| Constellations | Built screen (greyed in Figma) | Nothing | Remove for MVP |
| Connectors home/detail | Built | Google only | Show Google + health source only |
| Chat list / thread | `chats.tsx` built; `chat.tsx` is a 7-line route | Chat works on Telegram only | Need app chat API (same agent loop) |
| Profile, Notification settings (Brief time, Fetch, Close time, channel) | Built (`settings.tsx`) | No settings API; times hardcoded | Need profile/settings API |
| Data & Privacy | Partial | No export/delete | Need export + delete |
| In-app Fetch alert | Not wired | No live stress detection | Defer until health data is real |

### New screens needed
1. Waldo interview (onboarding step 7).
2. "What Waldo knows": view and edit routine, goals, habits and memory. Muse and WHOOP "My Memory" both ship this.
3. Approvals inbox. The runtime already has approvals; the app has no surface for them.
4. Activity: what Waldo did and why, from the ledger. This replaces the mock Patrol.
5. Brief history (today plus past Briefs and Closes).
6. Proactivity control: one dial for how often Waldo speaks up, next to autonomy.

### What the old app shows that the build can't back today
- Form/Recovery scores on Android (native modules not written) and any HRV-driven Fetch alert.
- Spots, Constellations, Signal Pressure, Task Pileup, Mind State and the Signal Depth score.
- Spotify, Todoist and Slack connectors; Oura, WHOOP and Ultrahuman direct integrations; Discord as a channel.
- WhatsApp as a channel (runtime is Telegram only).
- Any in-app Brief, chat or settings until the runtime has an app API.

## 4. Market grounding and add/remove list

What shipped recently:
- **Meta Muse (Sep 8, 2026):** one persistent conversation plus side chats; proactive messages with controls to reduce, increase or disable; activity log; editable Memory files; Goals tab; approval cards; artifacts. https://www.testingcatalog.com/meta-introduces-muse-as-a-proactive-personal-agent/ , https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/
- **WHOOP:** "My Memory" (user-supplied context such as illness, travel, stress, medication changes) and "Proactive Check-Ins" when data warrants, plus on-demand clinicians. https://www.aidatanews.com/whoop-adds-on-demand-doctors-and-new-ai-coaching-features-pushing-deeper-into-health-care/
- **Oura:** AI Advisor; clinician chat via Counsel Health. https://ouraring.com/blog/cms-access-model/
- **Apple iOS 27 Health:** AI insights and a daily readiness score (reported). https://gadgets.beebom.com/news/apple-revamps-health-app-ios-27-with-ai-insights-new-readiness-score
- **Poke:** messaging-native assistant (iMessage, WhatsApp, Telegram) with an Oura integration; acquired by Cognition. https://softwareontheweb.com/product/poke , https://www.xix.ai/ainews/why-cognition-bought-poke-ai-personality-is-becoming-a-competitive-advantage.html
- Internal note (COMPETITOR_RESEARCH.md): health-aware help alone is not unique. Waldo has to win on reliably joining body, calendar and action.

### Add
| Add | Why |
|---|---|
| Routine-driven brief times (section 1) | Fixed 08:00/21:30 is wrong for anyone off that schedule; the owner asked for it |
| Waldo interview + "Here's what I got" | Captures habits and feelings that taps miss; the confirm step builds trust (Muse editable memory) |
| "What Waldo knows" editable memory | Muse Memory files and WHOOP My Memory set this expectation |
| Proactivity dial | Muse ships reduce/increase/disable; this is the user's control over volume, since there is no push cap |
| Activity (ledger) + approvals inbox | Muse's activity log and approval cards make background work legible; the runtime already has the data |
| 1-tap card feedback + 14-day feeling check | Cheap ground truth to tune briefs and health reads |
| User context notes (sick, travelling, bad week) | WHOOP My Memory; changes how briefs read the day |

### Remove or defer (revised by the owner 2026-09-23 17:49; see section 9)
| Item | Status | Why |
|---|---|---|
| Spots, Constellations | **Keep: core product** | Short-term and long-term memory/patterns, visible to the user and the agent alike. Design: SPOTS_CONSTELLATIONS_AND_DERIVATIONS.md |
| Fetch alerts | **Keep: the proactive brand** | Update cards are the first Fetch mechanism |
| Signal Pressure, Task Pileup, Mind State, Signal Depth score | Rework before shipping | The owner is working on derivations; see the worksheet in SPOTS_CONSTELLATIONS_AND_DERIVATIONS.md section 5 |
| Spotify, Todoist, Slack, Discord | Defer until the core loop is proven | Richer behavior and mindset signal later |
| Wearables | Prioritize HealthKit (Apple Watch), Health Connect, Samsung, WHOOP | Owner priority |
| Clinical | **Advise and redirect, no hard block** | Basic information with a notice and a physician redirect; no personal dosing |

## 5. Decisions for the owner (rulings in section 7)
1. Brief delivery: push on the chat channel, in-app only, or a short push that links to the in-app card?
2. Brief times: model-planned per day with user pin/auto override (proposed), or user-set only?
3. Onboarding answers: write to the new runtime (proposed) or to the legacy Supabase profile?
4. Accept the remove/defer list as is?
5. Build order: routine profile + dynamic times first (backend only, testable on Telegram now), then the app API?

## 6. Built since, and owner direction (2026-09-23)

### Built
- **Routine-planned card times (91cad99).** At 03:00, after the memory update, the model plans today's card times from memory and today's calendar. Cards are one-shot per day, recorded in `day_plan` with a reason. Defaults stay as the fallback.
- **Update cards (7e958f5).** The 10-minute sweep reads calendar changes (updatedMin, next 48h) and new primary-inbox mail. The model decides whether to send a short "Update" card. Code enforces the limits: only between The Brief and The Close. The 3/day cap shipped in 7e958f5 was removed after the owner ruled there is no push cap. Every change is recorded in `update_cards` and folded into the next main card's `<updates>` section.

### Owner direction: health context as an input (future scope, when the app API lands)
- Health signals from Apple HealthKit (and Health Connect), plus whatever can be derived from them (Form, Recovery, sleep, HRV, resting HR, weight, activity), become inputs to:
  - the update sweep: a meaningful change in body state is a trigger, the same way a calendar change is;
  - the nightly card-time plan: for example, a later Brief after a short night, or a lighter check-in on a low-recovery day;
  - the content of every main card.
- Requirements this puts on the app API work:
  - a health ingest endpoint with source, time window and freshness per signal;
  - derived values computed backend-side under the accepted health ADRs;
  - a compact "body today" context the planner and cards can read;
  - absent or stale data stated as absent, never guessed.
- Clinical acts stay gated, as today.

### Standing philosophy: bounded model judgment
Every model decision gets three things:
- **instructions**: what the task is;
- **criteria**: what good looks like;
- **boundaries**: what it must never do, and the hard limits enforced in code.

The model reasons within those, the way a good nutritionist, personal manager or health coach would think for the user. It is never a free-form prompt. It also does not get rigid rules for judgment calls. Deterministic checks are reserved for hard safety and product lines: quiet hours, the Brief-to-Close window for update cards, sent-card fencing, clinical gating and format validation. Current examples are `DAY_PLAN_INSTRUCTION` and `updateCardPrompt`. New planners, including the health-aware ones, follow the same shape.

## 7. Owner rulings (2026-09-23, settled)
1. **Data home: the new Supabase only.** Onboarding answers and all user data are built from scratch in the new Supabase. Nothing from the legacy Supabase project or its edge functions (`agent`, `calendar`, `health-sync`, `insights`, `oauth-google`) carries over. The app keeps its frontend and some logic, repurposed onto the new backend.
2. **Brief delivery: both.** In-app is the rich version, linked, with visual elements and a quiz-like feel. The user's preferred channel (Telegram today; WhatsApp or others later) gets the card too. This replaces the app's old "in-app, never a push" note.
3. **Card times: user-set or auto.** Each card can be pinned to a time or left on auto, where the model plans it from routine and calendar (91cad99 already does auto). The pin setting is owed by the settings API.
4. **No push cap.** The only hard limits are quiet hours, wind-down and the Brief-to-Close window for update cards.

## 8. Apple Health (iOS 27 / Watch Series 12) and what Waldo can use

Checked 2026-09-23.

### What Apple shipped or announced
- **Watch Series 12 / Ultra 4 Health Sensing System:** heart rate every 5 seconds all day; HRV as often as every 5 minutes (24x more often). Two HRV views: Recovery HRV (daily stress and recovery) and overall HRV. Overnight vitals now include Recovery HRV against a personal baseline, plus a new daytime vitals view. https://www.apple.com/newsroom/2026/09/apple-advances-health-and-fitness-capabilities-using-apple-intelligence/
- **Readiness:** a 0-10 daily score from recent activity, vitals and sleep score, with a recommendation (Recover / Pace Yourself / Ready / Go For It). It updates through the day and shows its drivers. It is Apple's direct answer to WHOOP Recovery. (same source)
- **Redesigned Health app:** Insights tab, For You recommendations, and a Longevity tab with Health Age (VO2 max, resting HR, sleep, HRV, optional labs). It ships later in 2026, US English first; it is in the iOS 27.2 developer beta. https://9to5mac.com/2026/09/16/ios-27-2-introduces-apple-health-app-overhaul-heres-whats-new/
- **HealthKit in iOS 27:** a new RMSSD HRV quantity type (the only new quantity type; SDNN was the only HRV type since iOS 11). Workout heart-rate and cycling-power zones become a structured HealthKit type. https://www.themomentum.ai/blog/apple-watch-series-12-ios-27-rmssd-healthkit , https://developer.apple.com/videos/play/wwdc2026/207/

### What a third-party app can read via HealthKit
| Signal | Readable? | Note |
|---|---|---|
| Heart rate (now denser on Series 12) | Yes | Apple has not said how much of the 5-second stream is written to HealthKit; measure on device |
| HRV SDNN | Yes | As before |
| HRV RMSSD (new type) | Type exists | Apple has not confirmed the Watch writes it; verify on a Series 12 |
| Resting HR, respiratory rate, wrist temperature, SpO2, sleep stages, workouts, VO2 max, weight | Yes | Existing types |
| Workout zones (new) | Yes | Structured type in iOS 27 |
| Readiness score | **No** | Computed by Apple; no HealthKit type found |
| Health Age, Longevity analyses, Insights | **No** | Computed by Apple |
| Sleep score (0-100) | Not confirmed | No HealthKit type found. Apple documents its inputs (duration, bedtime consistency, awake interruptions), so Waldo can compute its own from sleep stages |
| Recovery HRV vs overall HRV split | Unclear | Probably maps to RMSSD vs SDNN, but Apple has published no mapping |

Sources for the "not exposed" rows: Momentum (above) and https://www.fitmesh.fit/en/blog/will-new-apple-health-replace-other-apps . Both are secondary sources that read Apple's docs; confirm on device before relying on them.

### What this changes for Waldo under the hood
1. **Switch recovery math to RMSSD when present.** RMSSD is the industry-standard recovery HRV and is steadier over short windows. Use RMSSD against the user's own baseline, fall back to SDNN, and never mix the two in one baseline.
2. **Denser HR and HRV makes daytime state real.** Daytime HRV every few minutes lets the update sweep notice a real stress or recovery shift during the day (a trigger, per section 6) instead of only overnight.
3. **Rebuild Form on raw inputs, not Apple's scores.** Readiness and Health Age can't be read, so Waldo computes its own Form/Recovery from overnight RMSSD vs baseline, resting HR vs baseline, sleep (duration, consistency, interruptions, stages) and recent load (workout zones, activity).
   - This is also a chance to fix the known gap: the app's `canonical.ts` weights Recovery where accepted ADR-0081 weights Sleep.
   - Waldo's value is joining that body read with the calendar and the day's decisions. Apple's Readiness stays inside the Health app and never touches the calendar.
4. **Don't compete on a number; explain the day.** Apple now gives every Series 12 owner a free readiness score. A second score is weak. What Waldo can do that Apple doesn't is say what the body read means for today's meetings, when to push, and what to move.
5. **Card timing.** A short or late night (sleep stages) moves the auto Brief later. A low-recovery day gets a lighter check-in. This follows the bounded-judgment rule in section 6.
6. **Weight.** HealthKit body mass is readable, and nothing new changed there. Keep weight as a trend, framed as context, not a goal (per the signal map's "never diet-app energy").
7. **Out of reach:** Apple's Readiness, sleep score and Health Age values; Apple's own recommendations; and anything from the new Health app UI. Waldo can mirror the ideas, not read the outputs.

### To verify on a device
Series 12 / iOS 27, before building the health ingest: whether RMSSD samples are written; the actual HR sample density in HealthKit; and whether any readiness or sleep-score type appears in the SDK.

## 9. Owner direction 2026-09-23 17:49 and build order

Reversals and rulings are in the table in section 4. The Spots/Constellations design, Fetch and the score worksheet are in https://github.com/waldoco/waldo-backend/blob/beta-mvp/docs/planning/waldo-agent-mvp/SPOTS_CONSTELLATIONS_AND_DERIVATIONS.md

Build order while the owner reads. This is the lead's judgment: foundation first, each step testable on Telegram before the next.
1. **Clinical advise-and-redirect.** Replace the medication/dose halt with a notice and a physician redirect in the reply. The prompt keeps the "no personal dosing or medication changes" line.
2. **Spots v0 in the runtime.** A typed spot store with evidence refs. The memory updater and the Fetch sweep emit spots, and the nightly run promotes them to constellation nodes and edges. Chat can answer "what have you spotted" and "why". This moves to the new Supabase when it exists.
3. **Agent harness hardening for the E2E.** Add an owner-only command to fire any card or Fetch on demand, a run-trace view per turn, and one end-to-end checklist run on Telegram.
4. **Web console v0** (Worker-served, owner-authenticated by Telegram login or an email OTP):
   - connectors (Google OAuth connect/disconnect, status);
   - memory, Spots and Constellations view with correct/forget;
   - card settings (pin or auto);
   - files (upload/share into Waldo's context);
   - activity/ledger.
5. **WhatsApp channel.** Needs a Meta WhatsApp Business number and token from the owner.
6. **Waldo-to-Waldo.** A peer channel between two owners' Waldos with explicit per-person permissions. Comes after the console, since permissions need a UI.
7. **New Supabase + app API.** Onboarding, profile, health ingest, and app reads of briefs, spots and chat. Needs the new Supabase project credentials from the owner.

Blocked on the owner for this list: Google OAuth creds (Fetch, connectors), Meta WhatsApp creds (step 5), new Supabase project (step 7).

## 10. Siri AI (iOS 27) and Waldo

Checked 2026-09-23.

- **What shipped (Sept 14, iOS 27, English beta):** Siri AI, a rebuilt conversational Siri with personal context across messages, mail and photos, onscreen awareness, and systemwide app actions. Third-party apps take part through App Intents. Models are Apple Foundation Models built with Google Gemini, running on device and on Private Cloud Compute. https://www.apple.com/newsroom/2026/09/siri-ai-a-profoundly-more-capable-and-personal-assistant-is-here/
- **Developer surface (WWDC26):** App Intents with App Schemas/Entities for natural-language actions and questions, the Spotlight semantic index, onscreen-awareness annotations, content transfer, and AppIntentsTesting. https://developer.apple.com/videos/play/wwdc2026/240/ , https://developer.apple.com/videos/play/wwdc2026/343/ , https://developer.apple.com/videos/play/wwdc2026/344/
- **Siri Extensions / model delegation (letting another AI answer inside Siri):** hooks exist in iOS 27 code but are not enabled, and may be EU-only. Don't plan on it. https://9to5mac.com/2026/09/14/ios-27-code-shows-you-may-be-able-to-replace-siri-ai-with-claude-or-chatgpt-poll/

### What Waldo can do with Siri
1. **Be callable from Siri** through App Intents in the iOS app: "Ask Waldo …", "What's my Brief?", "Log how I feel", "What have you spotted today?", "Move my next meeting" (through Waldo's approval flow). Siri AI can then chain Waldo actions with other apps.
2. **Be findable:** index Briefs, Spots and Constellation nodes as App Entities in the Spotlight semantic index, so Siri's personal-context answers can include Waldo's content, subject to the user's permission.
3. **Onscreen awareness:** annotate Waldo's views so "explain this" or "remind me about this" works while a Brief or Spot is on screen.
4. **Log Siri interop back into Waldo:** every Siri-invoked Waldo intent goes through the app to the backend, so it lands in episodes and the ledger like any other turn. Waldo's memory stays whole.

### What Waldo can't do
- Read Siri's personal context, Siri conversation history or Apple's computed scores. There is no API for any of them.
- Replace Siri's brain, unless Apple enables Extensions and Waldo qualifies.

**Positioning:** Siri AI is the OS assistant. Waldo is the health-aware chief of staff, reachable from inside Siri. That's a distribution gain, not a threat, as long as Waldo's value (body plus calendar plus memory, joined) stays in Waldo.
