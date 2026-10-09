# What it takes to a first working Waldo app: staged plan (opinion + estimates)

Labels: [fact] checked in source/live; [estimate] my guess, working hours of focused engineering, not calendar; [opinion] judgment.
Website re-read (https://heywaldo.in, public page): promise is "reads your health data every day, turns it into a plan, briefs through the day, asks yes/no only on what is yours, shows what he read, lets you take access back". The demo-defining loop is: wearable data -> Waldo knows the day -> plan/brief -> user sees why.

## Where we really are [fact]
- Working and merged: OTP sign-in/session/signout, shared text chat (history, send, retry) on the agent (merged in beta-mvp; NOT deployed, staging runs 44fc58ca).
- Agent has the read half of health: derived daily context RPC into the composer, zone/trend only. Write half (HealthKit -> health_context_daily) lives in the app repo's edge function, unproven by me.
- App: design done, ~80% dummy; app agent already removed fake data and tracked each item (can work now / needs Core / later).
- Missing on Core: all structured routes (Today, Waiting, Activity, Spots/graph, connections, settings, files, sessions), push, auth/start, health routes.

## Stage 1 - "Health + chat demo" (see RECOVERY_WEIGHT_PROPOSAL.md: owner wants Recovery and Weight included; estimate there supersedes Form-only numbers)
Scope (opinion: this is the cut):
1. Deploy eaa2469a+ and apply two pending migrations (Dalda).
2. Health: one consent contract; HealthKit background read in the app; upload; derived Form row (ADR-0081 Form only; Recovery/Weight shown "unavailable"); `GET /app/v1/health/today` + `/history` + `/sources` read-only; agent already reads zone/trend in chat turns; "Ask Waldo about this card" pin.
3. Chat as is, plus failed-turn row, mandatory client_message_id, auth/start, shared chat tree fix.
4. One structured surface: Today = the agent's morning brief persisted as cards from real run output (`GET /app/v1/today`), with "why" (sources read). No approvals yet.
5. Honest unavailable states everywhere else.
Not in stage 1: push, Waiting approvals, Patrol, Spots/graph UI, connections OAuth, files, session table, forecasts, Fetch (stress interventions).
Dependencies: Dalda deploy+migrations (blocked on his Keychain now); owner rulings on consent contract and Form-only (doc section 4); native proof of HealthKit on a real iPhone (app agent; needs device + Apple dev setup, I cannot verify); one staging own-account trace. Push not needed if the demo is foreground.
Core work [estimate]: health routes + composer wiring + tests 10-14 h; Today brief route + persisted cards 8-12 h; chat hardening (tree fix, failed row, auth/start, idempotency) 8-10 h; integration/trace fixes 6-10 h. Total ~32-46 h = about 4-6 working days for me, running in parallel with the app agent's wiring (~3-5 days). Confidence: 55% (main unknowns: whether the app's health-sync actually works, consent contract mismatch, Dalda deploy latency; those are outside my control and could add days).
Risks: unknown state of app-side ingest; consent contract conflict; HealthKit background delivery lag (~2 h worst case, fine for daily context, not for the Fetch); Dalda deploy is a manual single point; real-data privacy (own account only).

## Stage 2 - "Structured parity"
Scope: Waiting approve/skip/undo (reuse console actions), Activity/Patrol, Spots + Constellation graph and forget (reuse console feature semantics), settings (timezone, schedule, proactivity), connections (OAuth state binding first), files, session table + sessions/devices, push (APNs register + sender behind the delivery gate), nightly Spots from health, morning/midday proactive briefs, Recovery/Weight once algorithms are ratified.
Dependencies: owner rulings (session numbers, Recovery/Weight algorithms), Apple key at run time (not in chat), migration approvals, Dalda deploy per wave.
[estimate] Core 60-90 h (7-11 working days) plus app wiring 5-8 days; confidence 40% (bigger design items: forget exit, OAuth, uploads, push each need a note first). Roughly two to three weeks calendar with deploy waits.

## Can I build it? [opinion]
Core side: yes, both stages, in this order; routes are thin because the agent, console actions and health context already exist (reuse, not new logic). I cannot do: HealthKit native proof on a phone, Apple push credentials, the deploys/migrations (Dalda), hosted consent decisions. Those are the schedule risk, not the code.

## Recommendation [opinion]
Cut at Stage 1 for demo day. Start first, today, in parallel: (a) ask Dalda/parent to unblock deploy+migrations; (b) owner rules on consent contract and Form-only; (c) I start health routes red-first against the existing context RPC while the app agent proves HealthKit ingest on a device; (d) keep chat hardening (tree fix, failed row) as filler between waits. Queue change: health contract leads; #973 stays held; ADR-0024 withholding moves after health routes because health is the demo, unless the owner objects. If the app's ingest function is found broken or consent cannot be settled soon, fallback is a staged own-account day row so the agent-reads-health demo still works while ingest is fixed.
