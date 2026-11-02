# Bevel and Fitbit/Gemini coach teardown (2026-11-02)

Tags: [fetched] = page read; [snippet] = search excerpt only; [inference] = my reading. Help-center paths are on `https://help.bevel.health/en/articles/<id>`. Product facts are as the pages stated them on 2026-11-02; Google's coach has since been renamed "Google Health" coach [snippet], so check current behaviour before copying details.

## Evidence gaps (read first)
- No Reddit threads were retrievable, so there is no Reddit sentiment here. Substitutes: Bevel's feedback board, Trustpilot (4 reviews), and third-party reviews.
- Bevel's onboarding questions are not documented. The help center has no onboarding-question article, and the app was not run.

## Bevel

**1. Onboarding and user model**
- The help center documents no goal/injury intake [fetched]. The user model builds in three ways:
  - Settings: sleep, nutrition and water goals under Customization > Goals (10417217) [fetched].
  - Chat: the assistant's "Long-term memory stores your goals, injuries, and preferences" (11586817) [fetched].
  - Behaviour over time: scores need about 30 days to personalise stress and energy [fetched, 11258369].
- A third-party teardown calls onboarding "34-step", with the paywall late [snippet, unverified].
- Users complain onboarding doesn't explain the metrics. Bevel's feedback board lists it "Planned" at 73 votes. Commenters ask for exercise history, because the app flagged overtraining for a light trainer, and for pregnancy/menopause questions [fetched, feedback.bevel.health/feature-requests/p/improve-onboarding-to-bevel].
- An Activity Status label (Active / Sick / Injured / On a Break) "contextualizes" data. The page does not say how it changes scores [fetched, 11251073].

**2. Scores and data sources**
- **Recovery**: 1-100%, computed once each morning from six inputs [fetched, 11258177]:
  - Sleep Score, HRV, resting HR, wrist/body temperature, respiratory rate and SpO2.
  - Uses sleep-session HRV. Weights and thresholds are not published.
  - It is explained as "ready to train harder" versus "focus on rest".
- **Strain**: active (workouts) plus passive (background HR), intensity and duration [fetched, 11257857].
  - Roughly 0-100% but can exceed it, with logarithmic scaling.
  - Cardio Load and Muscular Load compare 7 days with 6 weeks, with about 10 qualifying days to calibrate [fetched, 14206721].
- **Sleep**: 0-100%, with Poor under 70, Normal 70-85, Excellent over 85 [fetched, 11258625].
  - Inputs: time asleep, deep and REM versus target, HR dip, efficiency, continuity.
  - Deep target depends on age and sex. Sleep Need uses sleep goal, recent strain and debt.
- **Stress** (1-100) is physiological, not emotional, from HR, HRV, movement and time of day [fetched, 11258369].
- **Energy Bank** carries over between days. Stress and sleep drive it, with non-linear charge and drain. A dotted line predicts energy when the watch is off [fetched, category-page summary of 10581377].
- **Sources**: Apple Watch, Oura, Garmin, Amazfit and Google Health are named on the homepage [fetched]. CGM sync (Dexcom, Libre) comes from TechCrunch [fetched]. Health Connect is not named anywhere I read. The smart alarm needs Apple Watch [fetched].
- Reviewer complaint: scores are "opaque" on outlier days, with no per-input contribution shown [fetched, autonomous.ai].

**3. Bevel Intelligence (BI)**
- **Check-ins** (12308801) [fetched]:
  - Created by chat, or via Check-ins > + with a title, free-text instructions and a schedule.
  - Frequency: once, hourly, daily, weekly or monthly, with days, time and end date.
  - Edit, pause and delete are supported. No cap is stated.
  - Proactive check-ins arrived in BI V2 (3.0.0), manual ones in 3.0.6, and in-app BI notifications in 3.2.6 [fetched, 11194113].
- **Summaries**: "daily, weekly, and monthly trend summaries" are listed as capabilities [fetched, 11586817]. A morning report and a weekly synthesis are user-set check-ins, not built-in schedules [fetched, feedback.bevel.health "Proactive Weekly Synthesis" and "morning report" threads, both marked Complete by Bevel staff on 27 Apr 2026].
- **"Check in later"** is not a documented feature. A one-time check-in covers it [inference].
- **Memory and Files** (11586881) [fetched]:
  - Files are Bevel-generated: Memories, Plans, Notes (check-in summaries), Logs, Artifacts and Core (profile/personality).
  - Users can view and filter them, and delete a file or memory by asking or via the three-dot menu. Editing contents is not documented.
  - The only documented way to correct a wrong answer is a thumbs-down (11586753).
  - Ghost Mode is a temporary chat with optional persistent-knowledge access, auto-expiry of 30 min to 24 h, and a default-to-ghost toggle (12969857).
- **Personality**: Friend, Commander, Guardian or Data Nerd, plus custom instructions (11586945) [fetched].
- **Plans**: multi-week plans (for example half-marathon) "adjust to recovery" [fetched, 11586817].
  - Built only through BI from goal, frequency and deadline. The result is a draft, and "creating the draft alone does not schedule the workouts" (14207169) [fetched].
  - How plans adapt after creation is not documented there.
- **Calendar**: read access to Google or iCloud, with per-calendar selection. This is separate from writing planned workouts to a dedicated "Bevel Health" calendar. Calendar data is "anonymized before it is sent to LLM providers" (12969921) [fetched].
- **Stated limits**: no diagnosis, dosing or therapy, and no control of the app or devices. It cannot yet send real-time notifications or edit sleep, nutrition data or goals [fetched, 11586817].

**4. Nutrition** (category page, 11247745, 11248065) [fetched]
- Logging methods: photo Capture, camera-roll Import, barcode Scan, typed Describe, Search, My Foods, and BI chat.
- BI proposes entries in a "Food Cart" and nothing is logged until the user confirms.
- The Nutrition Score is locked until about a third of the calorie goal is logged. Food Quality contributors are six positives and five negatives (sugar, sodium, red/processed meat, alcohol). Glucose impact needs a CGM.
- The score works only with food logged directly in Bevel, and users can switch off up to four contributors.
- Micronutrients appear only as BI "gap analysis"; the help pages I read don't detail them.

**5. Training** (Fitness and Strength Builder categories) [fetched]
- Strength Builder covers routines, set types, a plate calculator and auto-populated weights, with 700+ exercises per the App Store. The Apple Watch app records only strength workouts [fetched].

**6. Notifications and proactivity**
- There is no notifications help article [fetched, Bevel Basics gap list].
- Proactive output exists through check-ins, which BI notifies about in-app.
- Real-time alerts are not shipped. The stress-notifications request has 1.4k votes and is "Planned (tbd)", with requests for threshold, direction and haptic controls, and complaints of 10-30 minute reporting lag [fetched, feedback.bevel.health/feature-requests/p/stress-notifications].

**7. Pricing**
- Free: all scores, nutrition, strength and the Apple Watch app. Pro ($14.99/mo or $99.99/yr) adds BI, Health Records, Biological Age and Training Plans (11583937) [fetched].
- BI has a weekly credit allowance whose size is unstated. Extra packs run 350 credits for $4.99 up to 4,200 for $49.99 [fetched, App Store listing]. Typical costs on the Standard model are about 1 credit per message, 5 per food log and 10 per detailed check-in, and roughly 3x that on the Upgraded model (12741505) [fetched].
- Earlier pricing was $6/mo or $50/yr (TechCrunch, Oct 2025) [fetched]. Reviews say prices rose in 2026 [fetched, autonomous.ai].

**8. Praise and complaints**
- Praise:
  - Polished, scannable dashboard that is "more actionable than Apple Health alone" [fetched, kiledjian.com].
  - Smart alarm and sleep score trusted, and habit-to-score links changed behaviour [fetched, autonomous.ai].
  - 4.8 stars from 18K App Store ratings [fetched, apps.apple.com listing].
  - Trustpilot has 4 reviews at 3.5, mostly positive on the free tier. Bevel hasn't invited reviews [fetched].
- Complaints:
  - Generic advice, slow responses and context lapses from the coach [fetched, kiledjian, no frequencies].
  - Opaque scores, vague insights when data is missing, and iOS-only operation [fetched, autonomous.ai].
  - No live alerts.
  - Credit metering: that credits "run out too fast" is my inference from the cost table, not a sourced complaint.

## Fitbit / Gemini personal health coach (public preview, Oct 2025)

- **Goals interview**:
  - The first run is a 5-10 minute text chat (voice dictation works) about motivations, goals, preferences and equipment, and it "can be skipped and returned to" [fetched, blog.google public-preview post].
  - Engadget says it also covers injuries and medical history [fetched].
  - Tom's Guide measured just under 20 minutes for the interview and about 20 minutes to generate the plan [fetched, tech.yahoo.com].
  - Answers go into "Coach Notes", viewable and deletable in the Health tab [fetched, Engadget]. Google's current help says you can ask the coach to list what it has learned [fetched, support.google.com/googlehealth/answer/17053789].
- **Weekly plan**: a multi-week plan with weekly targets on the Fitness tab, and a weekly notification of recommendations [fetched, blog.google; support.google.com/fitbit/answer/16961408]. Progress is judged weekly, not daily [fetched, Engadget].
- **Adaptation**: "My knee is bugging me, can you adjust my plan?" is Google's own example, and busy days and late nights are covered [fetched, blog.google]. Users can also use Adjust buttons, edit reps/sets manually, link a watch workout to a planned session, or "Leave plan" [fetched, support page].
- **Update moments**: wake-up, after a workout and before bed on the Today tab [fetched, blog.google]. Google's help describes them as a morning sleep/readiness message, a post-workout breakdown and an evening recap, switchable off under Settings > Coach > "No Coach insights" [fetched, support page]. Unprompted insights sometimes arrive days after a question, and thumbs-up requests more of them [fetched, blog.google hands-on].
- **Limits**: Fitbit Premium only, US first and then more countries [fetched/snippet]. Nutrition, hydration, menstrual health and the Stress Score were missing at launch [fetched, blog.google].
- **Complaints**: community thread titles report disappearing coach notes and chats, and the coach "constantly bringing up old information" [snippet; the threads redirected and were not read].

## Adopt list for Waldo

1. **Check-in as a user-owned instruction object.** Fields: title, free-text instruction, schedule (once to monthly, days, time, end date), pause, delete. It is created by chat or form. Source: Bevel 12308801 [fetched].
2. **Morning report and weekly synthesis as check-ins, not hardcoded jobs.** One mechanism covers both. Source: Bevel feedback board threads [fetched].
3. **Visible, filterable memory.** Typed files (Memory, Plan, Notes, Logs, Core) with delete-by-asking and an "ask what you've learned about me" command. Sources: Bevel 11586881; Google support page [fetched].
4. **Ghost chat.** A temporary conversation with a TTL and an optional "use my memory" toggle. Source: Bevel 12969857 [fetched].
5. **Draft, then confirm, for plans and logs.** Bevel's Food Cart and "draft doesn't schedule". This maps directly onto approval cards. Source: Bevel 11247745, 14207169 [fetched].
6. **Activity status** (Active / Sick / Injured / On a break) as a one-tap context switch that damps advice and nudges [inference on effects]. Source: Bevel 11251073 [fetched].
7. **Three named update moments with a single off switch**: morning, post-workout, evening. Source: Google support page [fetched].
8. **Skippable, voice-friendly goals interview** that stores answers as editable notes and can be revisited. Source: blog.google, Tom's Guide [fetched].
9. **Conversational plan adaptation** with weekly targets, manual edit and "leave plan". Source: Google support page [fetched].
10. **Calendar read/write split.** Choose which calendars are readable, and write only to a dedicated calendar. Source: Bevel 12969921 [fetched].
11. **Honest data gaps.** Calibrating states, a minimum of about 30 days or 10 qualifying days, and a dotted line for predicted values. Source: Bevel 10581377, 14206721 [fetched].
12. **Personality presets** saved as a user file, with free-text overrides. Source: Bevel 11586945 [fetched].

### Where Waldo can do better
- **Real-time and threshold alerts through approval cards.** Bevel has not shipped them despite 1.4k votes. Waldo can offer user-defined, per-owner-scoped alerts (threshold, direction, quiet hours) behind a bounded standing grant, with no invented readiness when data is stale.
- **Cross-domain context.** Bevel reads calendars but neither product reads mail or tasks. Waldo can move a hard workout away from a late-night meeting, propose a hotel-gym session from a travel confirmation, and shift a morning report when sleep was cut short. Each is an approval card with a frozen intent and a receipt.
- **Plans that land on the calendar.** Bevel syncs planned workouts to a separate calendar, and only moves or deletes sync back (12969921). Waldo can propose the free slot, ask, write the event, and reconcile later.
- **Memory with provenance and edit.** Bevel's docs describe delete only, and Fitbit users report vanishing and stale notes. Waldo can show source, confidence and a correct-in-place action. Health-derived memory stays separate and consent-bound.
- **Score explanations.** Add per-input contribution, which the Bevel reviewers lacked, without surfacing forbidden numeric values (per the privacy rules). This is a design question, not a copy-over.
- **No per-message credit anxiety.** Bevel meters a detailed check-in at about 10 credits, which taxes proactivity. Waldo should budget proactive work per owner, transparently.
- **Keep the boundaries.** No diagnosis or dosing, matching Bevel's stated limits. Health sharing remains optional per user.
