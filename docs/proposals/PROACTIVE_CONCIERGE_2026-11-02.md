# Proactive Waldo: the concierge loop (design, 2 November 2026)

Status: **proposed**, for the owner's review. Nothing is built.

Evidence comes from three sources:
- the owner's Android end-to-end run on staging `37c647cd` (2 Nov);
- a source inventory of `beta-mvp` and waldo-app `main`;
- a primary-source scan of shipped proactive products (section 3).

Claims are tagged [verified], [inference] or [proposed]. Paths are under `packages/runtime/src/` unless they say otherwise.

## 1. Problem

On 2 Nov the owner asked "what's on my plate tomorrow?". Waldo answered correctly: one event, 3–4:45 pm.

It then stopped. A concierge would have opened the conversation itself: "Your day is open apart from 3–4:45. What do you want done? I can block the morning for it and check in at 2."

The owner's bar is Alfred to Batman. Waldo should know the owner's goals, job, focus and health targets. It should ask what it doesn't know, plan with the owner, act on approval, follow up, and close the day. It should do this unprompted, with health and wellness as the anchor.

Waldo already has most of the parts. What's missing is the loop that joins them. Gaps found in source at `37c647cd`, each [verified] by reading the cited lines:

| Gap | Where |
|---|---|
| The Brief gives one direction and never asks a question. The Close is told "nothing that needs an answer tonight". | `prompt/day-cards.ts:16-42` |
| Setup answers become owner claims (`kind: goal`, `health`). The GoalRecord table (ADR-0064) has no reader or writer, and `active_goals` is hard-coded `[]`. | `onboarding/first-run.ts:48-63,244`; `do-schema.ts:317-336`; `health-context.ts:251` |
| Nothing asks for missing facts after setup ("learned in the first week, in context"), and no mechanism does that learning. | `first-run.ts:282` |
| `quick_replies` exists in the contract, but no runtime code produces it. The mobile app renders only text and approval parts. | `contracts/src/app/parts.ts:40-45`; waldo-app `transcriptAdapter.ts:3-12` |
| With mail follow-ups on, the update turn loses `propose_action`. It can track a reply owed, but can't offer to send it. | `channels/update-sweep.ts:155-159` |
| The five proactive skills fire only on a message from the owner (`trigger_types: ['user_message']`). Only `document-email-preparation` also fires on the Brief. | `skills/bundled-file.ts:33` |
| Only calendar prep and the health trigger go through the delivery gate [inference from the inventory's caller list]. The gate's policy says Brief cards are dropped in quiet hours (`quiet_hours: 'drop'`); the code holds them. | `delivery-gate/gate.ts`; `packages/contracts/src/runtime/delivery-policy.ts:79-94`; `channels/owner-do.ts` card hold |

Delivery also failed on the device during the 2 Nov run:
- **Notifications:** Android notifications were off after a fresh install. No ask appeared in a setup *rerun* [verified]. Whether first-run setup asks was not checked.
- **Health data in the background:** the app holds no `READ_HEALTH_DATA_IN_BACKGROUND` grant [verified]. The Form screen says "Open Waldo after you wake so he can read your night". So Waldo likely sees health data only when the app is opened [inference: the app's sync code was not read].
- **WhatsApp:** `WHATSAPP_REENGAGE_TEMPLATE` is empty in staging [verified], so Waldo can't start a WhatsApp conversation outside the 24-hour window. The message is held and nothing is sent (`channels/whatsapp-window.ts`).

## 2. Design principles

1. **Judgement stays with the model** (CLAUDE.md). It decides what to ask, when, and whether a change matters.
   - Code guarantees only consent, quiet hours, budgets, approvals and health-value boundaries.
   - No fixed question scripts.
   - No tests that pin wording.
2. **Ask little, and in the flow of the day.** One question per touchpoint, at most, and only when the answer would change a plan. A question is always skippable and never blocks anything.
3. **Draft, then approve.** Outbound mail, calendar writes and contact go through the existing approval cards. Autonomy stays parked.
4. **A visible end.** A day has a small, owner-set budget, and Waldo says when it's done for the day.
5. **Memory the owner can see.** Goals and learned facts appear on the one memory screen (Constellations › To check), where the owner can confirm, correct or forget them.
6. **One authority.** OwnerDO stays the single writer. There's no new service and no new store of record.
   - Goals use the accepted GoalRecord table (ADR-0064).
   - Health values stay on the Supabase health plane.

## 3. What shipped products do

Sources are in the research note [^r]. Product facts below are as of Nov 2026.

| Product | Reaches out when | Asks? | Memory and goals | Acts |
|---|---|---|---|---|
| ChatGPT Pulse | Overnight run, morning cards; reads chats, memory and connected Gmail/Calendar | No. Steered by "curate" and thumbs | Saved memory | Read-only cards; ends with "that's it for today" |
| Google CC | Morning "Your Day Ahead" email; on +cc | No. You teach it by replying | "Remember" by reply | Drafts mail and calendar links |
| Poke | ~8 am overview; important-mail alerts; automations | Onboarding "bouncer" | Long-term memory | One reviewer saw it send with no approval (a counter-example) |
| Sunsama | The owner opens the daily planning ritual | "What matters today, any obstacles?" Asks only when blocked; skippable | Saved rules | Judgement calls you keep, move or discard, with undo |
| Fitbit/Gemini coach | Weekly plan; updates after waking, after a workout and before bed | 5–10 min skippable goals interview | Remembers feedback | Adapts the plan |
| Oura Advisor | Readiness messages invite you in | Owner picks tone and check-in frequency | Viewable, deletable "Memories" | Goal-based plans |
| Bevel | Scheduled check-ins the owner sets | "Check in later" | Goals, injuries, preferences | Plans |

**Patterns worth copying:**
- prepare ahead and deliver at a predictable time;
- a visible end to the day's messages;
- steer by reply rather than settings;
- memory the user can see and delete;
- draft, don't send;
- ask rarely and skippably.

**Failure modes to avoid:**
- stale or repeated items (Pulse);
- creepiness from showing off what it read in your mail (Poke);
- fragile channels, such as SMS links flagged as scams;
- staleness from preparing too early.

**Where Waldo can lead** [inference, not sourced]: none of these combines the owner's calendar, mail and body data in one loop that asks, plans and acts on approval across app and WhatsApp.

## 4. The loop

The cycle runs daily: **Know → Plan → Nudge → Act → Close → Learn**, then back to Know. Each step reuses an existing touchpoint.

### 4.1 Know: the owner model and progressive interview [proposed]

- **What the model is.** The owner model is the set of owner claims across life areas:
  - role and job;
  - current focus and projects;
  - goals with horizons (week, quarter);
  - health goals, covering sleep, training (gym or sport), diet and stress;
  - daily criteria (what makes a day good);
  - recurring commitments;
  - key people.
- **What the code supplies.** The list of areas and the owner's claims with their dates. It does not decide which areas are covered, and it does not supply questions.
- **What the model decides.** Which areas its claims cover and which are stale. At any touchpoint, also whether one missing fact would change today's plan, and if so how to ask it, phrased in context.
  - Example: "You've mentioned the gym twice. Are you aiming for three sessions a week?"
- **Where answers land.** Owner claims, through the existing memory tools. Goals land as GoalRecords (section 4.6).
- **How the owner sees it.** Everything learned appears under To check on the memory screen.
- **Scope.** The interview never re-asks onboarding answers. It recalls them instead: "You said evenings are where sleep goes wrong…".
- **Health facts.** "Sleep better" or "lose weight" is a goal, not a health value. Numeric targets that are health values (weight, resting HR) follow ADR-0081 and are stored on the health plane, not in claims.

### 4.2 Plan: the morning planning turn [proposed]

The Brief becomes a planning turn. It can ask one question and offers quick replies.

- **What it reads:**
  - today's shape (free stretches, the one meeting);
  - health state (recovery, sleep debt, load);
  - open loops and replies owed;
  - active goals.
- **What it proposes:** one to three concrete moves, each through the existing calendar approval card or `set_reminder`.
  - Examples: "Block 10:00–13:00 for the deck", "Gym at 7:30, your recovery is good", "Reply to <a contact> before lunch".
- **What it asks:** one question when the day is open or the focus is unknown. The quick replies offer the model's guesses plus "something else".
- **What the answer becomes:** an ordinary owner turn, which can confirm the proposals or write the plan.
- **Timing:** the Wake-Driven Brief design (accepted 1 Nov) stays in charge of when it lands.

### 4.3 Nudge: the check-in [proposed]

The 14:00 check-in reads progress against the morning plan. It offers one decision ("Deck block slipped; move it to 16:00?") or stays silent. The heartbeat's existing check-back on open loops is unchanged.

### 4.4 Act: event-driven offers [proposed]

| Event | Today | Proposed |
|---|---|---|
| New mail | Update card; a source-bound loop if follow-ups are on; **no `propose_action`** | The update turn may propose an action on a card: draft a reply, "reach out to X?", add an event. It stays tainted, so everything goes through `propose_action`. |
| Calendar change | Re-plan the card times; update card | Also re-check the morning plan: "your focus block now clashes, move it?" |
| Health change | One calendar change per hour, gated | Unchanged; it gains goal context. |
| Relationship upkeep | Skill used only in owner turns | Skills become available to the card and update turns. |

### 4.5 Close: the evening close [proposed]

The Close drops "nothing that needs an answer tonight". It may ask one light question: "What got done? Anything to carry to tomorrow?" Quick replies offer the plan's items.

- **What the answers do:**
  - close loops;
  - carry the rest into tomorrow's planning turn;
  - feed goal progress.
- **Weekly reset.** Once a week (the owner picks the day), a reset sweeps the backlog: open loops, replies owed and stale tasks. It reviews goals with evidence: "You aimed for 3 gym sessions; the watch saw 2."

### 4.6 Learn: goals with evidence [proposed]

- Wire the accepted GoalRecord table (ADR-0064) in OwnerDO, where the existing writer owns it.
- Setup goal claims seed it.
- The planning, check-in and close turns read active goals. The weekly reset reports progress from observable evidence: the calendar, the ledger and health scores from the health plane.
- The owner can edit, pause or drop a goal on the memory screen.

## 5. The health and wellness layer

These are the life areas where the loop goes deepest.

| Area | Uses (built) | Adds |
|---|---|---|
| Sleep | Stated sleep need; wind-down blocks behind `HEALTH_COACHING` (on in staging) | Evening close and wind-down offer tied to tomorrow's first commitment |
| Training | Training load; workout dedupe; `HEALTH_EASE_WORKOUT` (off) | Weekly training goal; planning turn schedules sessions around load and recovery |
| Recovery and stress | Recovery, Form and Weight scores; health trigger; `recovery-day` skill | Recovery shapes the day's plan (protect a light day, move a hard session) |
| Diet | **Nothing.** The contract has no dietary or hydration signal [verified, research #1813] | Read nutrition that MacroFactor, Cronometer and MyFitnessPal write to Apple Health and Health Connect. Needs an ADR-0081 amendment (new signal, Android writer rule). Cal AI and MyFitnessPal APIs are closed; Strava and Oura forbid AI use. |
| Medicines | Health plane, behind `MEDICATIONS` (off) | Reminders inside the loop once switched on |
| Watch HRV | #1812, waiting on the Samsung Sensor SDK `.aar` | Fills Recovery's variability share on Galaxy Watch |

A Fitbit-style **weekly health plan** (goals → a few scheduled sessions → adjusted daily by recovery) is the health form of the loop. It reuses 4.2–4.6 and adds no separate system.

## 6. Delivery and interruption control [proposed]

- **Budget.** All proactive kinds go through the ADR-0068 delivery gate: day cards, update cards, check-backs, mail follow-ups, health.
  - The gate's policy is reconciled with the hold-in-quiet-hours code.
  - The owner sets the budget. Default: the 3 day turns plus at most 2 event offers a day.
  - After the budget is spent, Waldo holds non-urgent items for the next turn.
- **One question in flight.** Waldo asks again only after an answer or a skip. History already shows the question, so no new store is needed. [inference: verify that card turns see their own delivered rows]
- **Channels:**
  - **App:** setup asks for notification permission, and the app renders `quick_replies` as chips. A tap sends the chip's label as an ordinary message, so no new contract action is needed.
  - **Background:** the Android `READ_HEALTH_DATA_IN_BACKGROUND` permission plus a periodic sync. iOS uses HealthKit background delivery.
  - **WhatsApp, window open:** a question goes out as interactive reply buttons (up to 3) or a list message (up to 10 rows). A tap comes back as an ordinary inbound message, the same as an app chip.
  - **WhatsApp, window closed:** only a template can go out. An approved Utility template sends the knock ("Waldo has your plan for today, reply to see it"). The real question follows once the owner replies. The owner creates the template in Meta, and the gate sets `WHATSAPP_REENGAGE_TEMPLATE`.
  - **Routing:** the "reach you on" setting keeps choosing the surface.

## 7. Build slices

Each slice sits behind a switch, defaulting to 0. The gate allocates switch names, revisions and migration timestamps.

| # | Slice | Repo | Contract and storage | Depends on |
|---|---|---|---|---|
| P1 | Card turns can ask: a tool that emits `quick_replies`; app renders chips; WhatsApp renders reply buttons or a list; notification permission in setup | backend + app | `quick_replies` exists (additive use); no migration | — |
| P2 | Planning Brief + asking Close + weekly reset (prompt and tool changes in `day-cards`) | backend | none | P1 |
| P3 | Goals: GoalRecord runtime, seeded from setup claims; goal recall; goals on the memory screen | backend + app | ADR-0064 table exists; controls revision for goal actions | P2 |
| P4 | Progressive interview: owner-model coverage list in card context; answers to claims | backend | none | P3 |
| P5 | Event offers: `propose_action` in update turns; skills in card and update turns; plan re-check on calendar change | backend | none | P2 |
| P6 | Delivery: everything through the gate; WhatsApp knock template; background health sync (app) | backend + app + owner (Meta) | gate policy reconcile | P1 |
| P7 | Diet signal from the phone stores | brain ADR + backend + app | ADR-0081 amendment, health revision, migration | owner yes |

**Tests for each slice:**
- traces asserting tool order and delivery (ask → answer → approval card → calendar write);
- quiet hours and budget, tested against a time-mocked clock;
- WhatsApp with the 24-hour window closed;
- consent withdrawn.

No assertions on wording.

## 8. Owner direction (2 Nov, after the first draft)

- **Adopt the best patterns from section 3 and improve on them.** Health follows **Bevel** and the **Fitbit/Gemini coach**: a goals interview, a weekly plan, scheduled check-ins, long-term memory of goals and injuries, and daily adjustment.
  - A Bevel teardown follows as its own research note, and its findings will extend section 5.
- **No extra creepiness control.** The approval cards already cover it.
- **Assistant first.** Waldo is a concierge and assistant first: it leads, plans and follows through.
  - The owner look-up (OSINT) must actually work at onboarding. In the 2 Nov run it produced nothing visible; that is diagnosed separately.
  - The browser is the next unlock for both the general assistant and health.

### 8.1 Adopted from Bevel and the Fitbit coach

Source: [`docs/research/bevel-fitbit-coach-teardown-2026-11-02.md`](../research/bevel-fitbit-coach-teardown-2026-11-02.md). Each item maps onto a slice.

- **Check-ins as owner-owned instruction objects** (P2): title, instruction, schedule, pause, delete. The Brief, check-in, Close and weekly reset become default check-ins the owner can edit, rather than hard-coded jobs.
- **Draft, then confirm, for plans and logs** (P2, P7): this is the existing approval card.
- **Three named update moments with one off switch** (P6): morning, after a workout, evening.
- **A skippable goals interview** (P3, P4): answers become editable goals, and it can be revisited.
- **A one-tap activity status** (P3): Active, Sick, Injured or On a break. It damps advice and nudges.
- **Honest calibration** (health UI): "calibrating" for the first days, with predicted values drawn dotted.
- **Visible memory** (the To check / Constellations screen): "ask what you've learned about me".
- **A calendar read/write split** (P2), below.

**Where Waldo goes further:**
- threshold alerts through approval cards (Bevel hasn't shipped them);
- cross-domain plans that read calendar, mail and tasks;
- plans that land on the calendar itself;
- score explanations per input, with no forbidden numbers;
- no per-message credits.

### 8.2 Waldo's own calendar [proposed, owner decision]

Planning that feels like Reclaim needs Waldo to place blocks without a card for each one. The proposal:
- Waldo writes **only to its own "Waldo" calendar**, created on connect, with every block movable and undoable.
- Every write to the owner's other calendars keeps its approval card.

This is a narrow slice of the parked standing-grant work (ADR-0086 draft), so unparking it is the owner's call.

### 8.3 Owner look-up (OSINT): why the 2 Nov run showed nothing

Source: an audit at `37c647cd`. Whether the look-up ran is not yet confirmed: it needs `GET /app/v1/findings` with the owner's session, or the Patrol activity around 04:56Z.

**The design gaps, regardless of what happened:**
1. **Too late for the tour.** The job is due 5 minutes after the grant (sooner after the first reply) and has a 10-minute deadline (`onboarding/lookup.ts:12,47`). Web findings can only reach the constellation later, through `lateWeb`.
2. **A rerun can't show web results.** `welcome.start()` does nothing when a build exists (`welcome.ts:68-70`), and a reopened web stage settles `empty` at once from the old `started_at` (`:349-352`).
3. **Findings aren't visible.** There is no findings screen, so findings can exist with no web nodes showing. The To check group (section 8) fixes this.
4. **Failures are silent:**
   - `reconcile` returns without a log on `no_name`, `held_topic` and similar codes (`owner-do.ts:5489-5505`, `machine.ts:56`);
   - the app's grant-failure alert is navigated away (`app/(onboarding)/chat.tsx:434,483,499`).
5. **A possible quote mismatch** [inference]: Brave snippets carry `<strong>` highlight markup, so a quote copied with it may fail `quote_not_on_page`.
6. **`partial` on the constellation has nothing to do with the web.** It comes from a pending forget or purge in `memory-graph.ts:14-57`.

**Fix direction:**
- When the look-up ends, send one update card ("I found N things about you, review them").
- Show findings in To check.
- Let a rerun restart the web stage.
- Log every no-op code.
- Keep the app's failure visible.
- Strip markup before the quote check.
- Let the owner paste profile links as seeds (LinkedIn/X, approved 25 Oct).

### 8.4 Browser: what is left

From the audit at `37c647cd`:

| Piece | Status |
|---|---|
| Public reader (Cloudflare) behind `browse_page` | On in staging |
| Owner sessions, typed `browse_act` and the sign-in handoff | Merged, but each owner must opt in on the console; `COMMON_BROWSER_REGISTRATION` is unset |
| Errands that submit forms | **Draft #1648**; blocked on the D5 ruling (built as 3 submits per yes) and review |
| Session-handle redaction bug | **Draft #1643**; a real bug that breaks retained sessions |
| Signing back in later | Needs the own password store (**draft #1589**, custody ADR, D7 ruling) |
| Bot walls and captchas | **Draft #1638** (Browserbase over CDP). Conflicts with the 13 Oct "Cloudflare, not Browserbase" ruling, so the owner must revisit it. The keys sit in staging unused |
| Payments | No design. Proposed: provider-tokenised cards and an approval card for every purchase |
| Browser for all testers | Operator and spend decision ($5/month cap) |

**Order** [proposed]:
1. #1643 (bug);
2. #1648 (forms) after D5;
3. browser for all testers;
4. password store;
5. escalation;
6. payments.

## 9. Decisions for the owner

1. Approve the loop and the default daily budget (3 day turns + 2 offers).
2. The Close may ask one question. This reverses the current rule.
3. Text for the WhatsApp Utility knock template. The owner submits it in Meta.
4. Diet: go on the ADR-0081 amendment for nutrition via the phone health stores.
5. Who builds the app half (chips, notifications, background sync, memory screen): Suyash or the orchestrator's lanes.
6. Is this loop what "ecosystem template" meant?
7. Waldo's own calendar without per-block approval (section 8.2).
8. Browser:
   - D5, how many form submits one yes allows (#1648);
   - revisit "Cloudflare, not Browserbase" for bot walls (#1638);
   - turn the browser on for all testers.

[^r]: [`docs/research/proactive-agents-2026-11-02.md`](../research/proactive-agents-2026-11-02.md) (2 Nov). Primary URLs are inside: OpenAI/TechCrunch on Pulse; the Google blog on CC and Gemini scheduled actions; poke.com and reviews; Sunsama help; the Google blog on the Fitbit coach; the Oura blog; Bevel help. Product claims carry the dates in that note.
