# Claude consult pack: Waldo health plane, app v1.2 and staged plan

Hand this whole file to Claude. It contains the questions, status, then the full decision doc, Recovery/Weight proposal and staged plan.

## Numbered questions for the consult

1. Storage: on-device only (21 June note) vs consent-bound server storage (ADR-0081, 35 d raw / 90 d derived). Confirm ADR-0081 governs for a beta where the agent must use health daily. What minimum is stored?
2. Prompt boundary: keep zone/trend/drivers only (no numerics in prompts, numbers in chat after a pin), or allow numerics for the owner's own beta account? What breaks in agent quality with zone-only?
3. Form/Recovery/Weight: are the proposed `recovery.v1` and `weight.v1` definitions defensible? Weight as load (higher worse) or capacity? Stack needs calendar: ship in stage 1 or 2?
4. Consent contract: app `user_consents(consent_kind, granted, v1)` vs beta-mvp `consent_class/status/int version` with age/purpose evidence. Which wins, migration path, and what is the minimum for own-account demo ingestion?
5. Ingest route: reuse the app's `health-sync` Supabase edge function vs a new Worker `POST /app/v1/health/ingest`. Which, given auth (app credential vs Supabase JWT), idempotency, and consent check location?
6. Computation location: backend authority (ADR-0081) with device fallback: confirm; where does it run (Supabase function, Worker, DO), and trigger (on ingest vs nightly)?
7. Routes v1.2: confirm the list in HEALTH_PLANE_AND_APP_V1_2_DECISION.md section 6: shape, pagination, error/unavailable semantics, idempotency, versioning, whether to use one `/app/v1/today` aggregate or separate routes.
8. Agent-to-app: how health feeds turn context (daily context at turn start), nightly Spots (derived input only, two distinct days rule), proactive triggers (brief times, Fetch threshold/lag), delivery via app vs Telegram/WhatsApp for health-bearing messages (ADR-0081 external-channel eligibility).
9. Push: APNs provider, token registration, quiet hours, what a push may contain (no health values).
10. Sessions: 15 min credential / 7 d idle / 30 d absolute with rotation and reuse detection: ok? Table design review.
11. Chat tree: shared `main` chat across channels vs per-channel chats; read-only labelled channel rows; AG-UI card parts (extensible contract).
12. Demo-day cut: is Stage 1 (health + chat + Today) the right cut; what would you drop or add; what is the fallback if native HealthKit ingest is not proven by demo.
13. Anything load-bearing we missed (privacy, App Store health-data rules, deletion/export, data residency).

## Honest status of what is unverified
- App-side `health-sync` function and writer behaviour: claim only (waldo-app 895ed6e4 notes), not re-read or run by Core.
- Staging: nothing after release 44fc58ca is deployed; two migrations pending (Dalda). No real wearable data has gone end to end.
- Website: read https://heywaldo.in again (fetched 9 Oct late night). Promise points used: health data as main context turned into a plan; proactivity (briefs through the day, speaks up when it matters); agency (acts, asks yes/no only on what is the user's, "nothing sent" until approved); transparency (shows what it read and why, user can take access back); one agent across Telegram/WhatsApp/iMessage/app with the app as the elevated surface (health sync, structured cards, push, approvals). The site's sample scenarios are illustrative, not product facts.

---
# Attached: decision doc
# Waldo health plane and app contract v1.2: decision doc (proposal)

Status: PROPOSAL for the owner. Nothing here is built, pushed or merged. Staging only. Session table, health plane and any migration stay the owner's rulings.
Prepared by the Waldo core agent, 9 Oct 2026 (late night). Evidence is tagged: [source] read in docs/code, [live] checked on a running system, [claim] reported by someone else, [unverified].
Tags for work: local / pushed / merged / deployed / live-proven. Everything below is "not started" unless it says otherwise.

## 0. Short version

1. The promise (website, brain docs): Waldo reads your body data every day, knows the day you are having, plans around it, acts with "nothing hidden", and speaks up when it matters. Health sync is therefore the thing no messenger can do and the thing the demo has to show.
2. Most of the health-plane decisions are already written as accepted ADRs (0010 HealthKit background delivery, 0081 backend-owned Form computation and privacy matrix, 0082 device cache). Several conflict with what the owner just asked for or with older notes. Those conflicts are the real doubts (section 4).
3. The backend already has the read half: a signed, owner-scoped RPC (`waldo.health_context_read`) that feeds a derived daily health context into the turn composer (redacted to zone and trend before any prompt). It has run on staging as a hop (`health_context`) in turn traces. The write half (HealthKit to Supabase) lives in the companion app repo (`health-sync` edge function) and is not proven live by me.
4. What is missing for "health ingestion working" in the app: the app does not have a path that is deployed and proven end to end: phone HealthKit read, upload, derived Form/Recovery/Weight row, agent reading it, app showing it. Section 5 lists the order.
5. Doubts for the owner: section 4 (ten items, each with my recommendation). One Claude consult on those is reasonable.

## 1. Sources read

- Brain repo (Pin4sf/waldo-brain), read-only: ADR-0081 (health-derived fields, Form/CRS authority), ADR-0010 (HealthKit background delivery), ADR-0002 (DO plus Supabase health), engineering/agent-soul/context-health.md, meetings 2026-06-21 (form/recovery/weight architecture; health scores), the 13 app-task-flows (Health Stats, Tier 1 detail, Chat, Notifications, Onboarding, Settings, Connectors, Home, Brief, Patrol, Spots, Constellations, Complete flow). Base: https://github.com/Pin4sf/waldo-brain/tree/main
- This repo (waldo-backend, beta-mvp eaa2469a): supabase/migrations 20260928160000 (health context read), 20260928182541 (daily-only table), 20260930134308 (access hardening), docs/planning/waldo-agent-mvp/HEALTH_CONTEXT_ACCESS_REPAIR.md, context-composer/materials.ts, console.ts, app-api.ts, docs/ops/RCA_OWNER_DO_CPU_RESET_2026-10-09.md.
- Website (public page only): https://heywaldo.in ("Life happens. Waldo handles it."; reads watch/WHOOP/Oura data daily and turns it into a plan; plans around a rough day; briefs through the day; shows what he accessed and lets users take access back; "Nothing sent" until the user says yes).
- Not found/not read: a "final vision/productivity" document the owner said he may reshare (waits on him); the older backend repo outside waldo-backend (I found no separate path; brain repo ADR backlinks name it); the app repo's own health code beyond what HEALTH_CONTEXT_ACCESS_REPAIR.md quotes (source at waldo-app 895ed6e4, not re-read).

## 2. What the product must show (from the website and brain)

- Health data is the main context: sleep, heart rate, recovery, turned into a plan for the day (train easier, move a meeting, protect focus).
- Proactive: morning/midday/afternoon briefs; interventions when stress or load spikes (The Fetch, The Adjustment); asks yes/no only where the decision is the user's.
- Transparent: shows what it read and why; user can revoke access.
- App-only extras a messenger cannot give: HealthKit read in the background, push, structured Today/Brief cards, Form/Recovery/Weight views, approvals (approve/skip/undo), graph of Spots/Constellations, one place for connections and settings.

## 3. What exists today

Backend [source]:
- Derived daily health context table `public.health_context_daily` (form, recovery, weight, tier2, drivers, confidence, freshness, tags), owner RLS, forced; service role writes. Staging-applied per the repair note (claim; hosted ledger not read by me today).
- `waldo.health_context_read`: signed router RPC from the owner's DO; returns derived pillar scores and the previous day's form score; runtime redacts to zone/trend before prompts (ADR-0024 / 0081). Hop `health_context` appears in staging traces (RCA 9 Oct, live-proven at that time for the hop, not for real data).
- Agent tools for logging health (meals/workouts) exist as owner-entered logs (health_logs migration 20260927), separate from wearable data.
- Console has no health view; app-api (#982/#983) has no health route.
App/companion repo [claim from the repair note]: `health-sync` edge function ingests with a consent check; app computes a local Form/CRS (ADR-0081 says that becomes fallback only).
Deployed state: staging release 44fc58ca [live, 8:56 PM]; nothing since is deployed. No real wearable data has been proven through to a turn by me.

## 4. Doubts and rulings needed (owner), each with my recommendation

1. Form vs Recovery vs Weight. ADR-0081 defines only Form (`form.safte-fast.v1`: sleep 0.50, HRV 0.35, circadian 0.075, motion 0.075; zones 80/60/40; unavailable unless sleep and HRV plus one of circadian/motion). Recovery and Weight have flows and a table column but no accepted algorithm in 0081. Ask: is Form the single score that drives agent decisions in v1, with Recovery and Weight shown only when their algorithm is accepted? Recommendation: yes. Ship Form first (algorithm exists, golden vectors planned); show Recovery/Weight as "unavailable" until their algorithms are ratified. This also matches the removal of fake charts in the app.
2. Where health data lives. Meeting 2026-06-21: "Health data stays on-device, exported on demand, never auto-synced." ADR-0081 (accepted 10 Jul): consent-bound Supabase rows (raw/normalized 35 days, derived 90 days), computed server-side. These contradict. Recommendation: ADR-0081 (later, accepted) governs; confirm with the owner because the owner's promise (agent uses health every day) cannot work with on-device only.
3. Who computes scores. ADR-0081: one deterministic backend authority, no LLM, app computes only a labelled "local estimate" fallback. The app's existing engine becomes fallback. Recommendation: accept; the app agent already preserved canonical algorithms and removed fake ones.
4. What reaches the model. ADR-0081 matrix: no raw or numeric health values in prompts, DO, R2, memory or traces; zone, trend, named drivers, freshness, confidence allowed in a trigger-scoped prompt; numeric derived value in chat only after the user pins that card in the thread. The owner wants "health as the main context". Recommendation: keep the matrix for v1 (zone + drivers + trend carries most of the planning value and is already built), and ask the owner whether to allow numbers in chat by default for the owner himself during beta (a matrix change needs an ADR amendment).
5. Consent and age gate. The repair note records an unresolved cross-repo consent contract conflict (app `user_consents.consent_kind/granted/v1` vs beta-mvp `consent_class/status/integer version`) and says first-ingest auto-recording is "not certified as sufficient consent". ADR-0081 requires verified age/consent and consent epoch before first read or write. Recommendation: no real user health ingestion before one consent contract is chosen; for the demo, use the owner's own account with consent recorded in the beta-mvp form. Needs the owner's pick of which contract wins (I recommend beta-mvp's).
6. Ingest route. HealthKit data is on the phone; the only sanctioned path is app background delivery plus anchored queries (ADR-0010), then upload. Options: (a) keep the app repo's `health-sync` Supabase edge function (exists, claim); (b) a new Worker route `POST /app/v1/health/ingest` with the app credential. Recommendation: (a) for the demo (least new backend), with the beta-mvp consent record checked server-side; (b) later when the session table exists. Needs the app agent to confirm the function is deployed and what it writes.
7. Retention and deletion. ADR-0081: raw/normalized 35 days, derived 90 days, provider staging 24 h, consent withdrawal purges everywhere, export includes raw and derived. Recommendation: accept as the beta rule; deletion across stores must pass ADR-0055. Ties to the forget-exit work (open).
8. Proactive triggers. The Fetch needs sustained stress confidence (>= 0.60 for 10+ minutes) and tolerates up to about 2 hours background-delivery lag (ADR-0010: "near-real-time, not real-time"). Recommendation: v1 demo uses daily context plus morning/midday briefs; Fetch only after real data has flowed a week. Needs the owner to accept the lag in copy.
9. Spots/Constellations from health. Today Spots come only from conversation. Recommendation: after ingest works, feed derived daily context (not raw) into the nightly pass as a read-only input so patterns like "sleep dips before release weeks" can form; require the same two-distinct-days rule.
10. Push. Not wired (APNs registration and sender absent; a delivery gate with an APNs policy exists in code). Needed for briefs and the Fetch. Recommendation: after ingest and a staging proof; owner must supply the Apple key at run time (never in chat).

## 5. Proposed order for demo day (a plan, not a build wave start; queue order unchanged)

Current queue stays first: deploy and migrations by Dalda, #973 hold, tree-interleave fix, ADR-0024 item-level withholding, failed-turn visible row.
Health lead items (propose to start after the owner's rulings 1-6):
A. Prove the read half with real rows on staging: one synthetic owner-consented day row in `health_context_daily` (owner's own account), then a turn that shows the zone-level health context in a trace. No new code needed if staging is deployed; this is a test, needs the deploy first.
B. Confirm the app's ingest edge function and consent write on staging (app agent); decide ruling 5.
C. App contract v1.2, health first: `GET /app/v1/health/today` (derived Form with zone, drivers, freshness, confidence, algorithm version, provenance labels; "unavailable" with reason when inputs are missing), `GET /app/v1/health/history?days=7|30` (derived rows only), `GET /app/v1/health/sources` (data-source status, opaque). All bearer-authenticated with the existing app credential; read-only; backed by `health_context_read`-style signed RPCs, not a new table.
D. Wire the agent: the turn composer already reads the derived context; add the app channel to the same read and a pin-to-chat route so numeric values only enter chat after a pin (ADR-0081).
E. Nightly Spots input and proactive brief (morning brief reading Form zone and calendar) after A-D proved.

## 6. App contract v1.2 proposal (all other features; bearer app credential, read-first)

Builds on v1.1 (auth start/verify/session/signout, chat main history and send). Each route: owner-bound from the credential, never from the client; honest `unavailable` states; no fixtures.
- Today/Brief: `GET /app/v1/today` (brief cards from persisted owner state, with source labels), `POST /app/v1/today/cards/{id}/pin|unpin`.
- Waiting: `GET /app/v1/waiting`, `POST /app/v1/waiting/{id}/approve|skip|undo` (calendar approval is not email-send approval, same restriction as the console).
- Patrol/activity: `GET /app/v1/activity` (task and run list, read-only, console `/console/runs` equivalent).
- Memory: `GET /app/v1/memory/spots`, `GET /app/v1/memory/constellation` (nodes, edges, evidence ids), `POST /app/v1/memory/spots/{id}/confirm|dismiss|forget`, `POST /app/v1/memory/nodes/{id}/forget` (same forget semantics and honest incomplete result as the console).
- Settings: `GET/POST /app/v1/settings/day` (timezone, quiet hours, schedule set/reset, proactivity), profile.
- Connections: `GET /app/v1/connections`, connect/disconnect start routes (OAuth completes in a browser, state bound to the session; OAuth state binding red test first).
- Files: list, download receipt, upload lease, remove.
- Sessions/devices/account: `GET /app/v1/sessions`, revoke one/all; device pair/revoke/query; account delete (explicit confirmation); invites/admin stay role-gated and out of the mobile app.
- Chat: `chat_id` is always `main`; client_message_id mandatory; long-poll on cursor (~25 s); read-only labelled Telegram/WhatsApp rows; typed parts extensible (unknown parts ignored) for AG-UI cards later; no threads (owner ruling: sessions later); proactive dedicated chats allowed later.
- Auth: add `POST /app/v1/auth/start` (identical response for known/unknown email). Session lifetimes 15 min credential, 7 d idle, 30 d absolute need the session table (owner ruling; not built).
- Push (later): `POST /app/v1/push/register` (device token), sender behind the delivery gate.
Estimated effort and risk are not given because I have not scoped each route against its DO store; each is a small PR with a red test, bigger ones (connections OAuth, files upload, forget exit) need a design note first.

## 7. Risks

- Real health data before one consent contract exists would break ADR-0081's own precondition (and privacy).
- Nothing since 44fc58ca is deployed; every statement about the app channel, derived health reads and the new routes is merged-only until Dalda's deploy and a staging trace.
- The health context RPC has only been shown as a trace hop, not with real data.
- The owner's "health as main context" vs the ADR matrix (no numerics in prompts) can feel like a thinner agent in demos; zone/driver language must carry it.
- The consent and ingest pieces live in another repo/lane (app plus Supabase edge functions); I cannot verify or change them from here.

## 8. What I need from the owner (short list)

1. Ruling 1: Form as the single decision score in v1.
2. Ruling 2/3: confirm ADR-0081 (server-side computation, consent-bound Supabase) overrides the 21 June "on-device only" note.
3. Ruling 4: numbers in chat for the owner during beta, or zone-only.
4. Ruling 5: which consent contract wins (I recommend beta-mvp's) and that no real-user ingestion starts before it.
5. Ruling 6: reuse the app's `health-sync` edge function for the demo.
6. Session numbers (15 min / 7 d / 30 d) and the session table, already pending.
7. The "final vision/productivity" doc if he wants it folded in; and a staging-only window with his consent for the real-data trace (his own account).

---
## Recovery and Weight: what is missing and a proposed definition (proposal, owner/Claude to ratify)

What exists [source: brain flows + ADR-0081]: Form is the only accepted algorithm (`form.safte-fast.v1`). Recovery and Weight have UI specs and DB columns (`recovery`, `weight`, `tier2` jsonb in `health_context_daily`) but no accepted formula, weights, zones, freshness rules or golden vectors. ADR-0081 says any new algorithm/version needs a registry entry and fixtures.
Recovery per flows: Tier 2 = Sleep (duration, deep%, REM%, efficiency, bedtime vs baseline, sleep debt flag) and Resting State (resting HR trend, respiratory rate, wrist temp deviation, SpO2 only if < 95%; HRV is shared with Form).
Weight per flows: Tier 2 = Load (Day Strain 0-21, TRIMP-derived) and Stack (meeting density, back-to-back count, boundary violations; needs the Calendar connector). Task pileup and signal pressure are excluded.
Proposed v1 definitions (opinion, deterministic, backend-computed, same authority/privacy as Form):
- `recovery.v1` = 0.55 sleep_quality + 0.45 resting_state, each 0-100 vs the user's own 14/30-day baseline (never population norms): sleep_quality from duration vs need, efficiency, sleep debt; resting_state from overnight RMSSD and resting HR deviation from baseline (respiratory rate/temp/SpO2 only as flags, not weights). Unavailable unless sleep plus one of HRV/resting HR exist. Zones reuse 80/60/40.
- `weight.v1` (load on the person, higher = heavier) = 0.6 physical load (Day Strain from HR zones, normalised to baseline) + 0.4 schedule stack (meeting minutes, back-to-back count, outside-hours blocks from the calendar). If no calendar, schedule part is "unavailable" and weight shows load only with reduced confidence. Direction matters: label it "load", do not mix with the Form "higher is better" scale.
- Each must ship with: registry entry, golden vectors, freshness (reuse 6 h / 36 h / 72 h), confidence rules, destination matrix rows (zone/trend only to prompts; no numerics, as ADR-0081).
Added time [estimate]: algorithms + golden fixtures + registry + tests 10-14 h; compute path if backend computes (today only the app computes) 8-12 h; calendar-derived stack inputs 4-6 h. About +22-32 h (3-4 working days). Stage 1 becomes Core ~55-75 h (7-9 days), confidence 40%. Cheaper cut if time is tight: ship Recovery in stage 1 (sleep and resting HR are already HealthKit inputs), Weight load-only; Stack (calendar) in stage 2.
Open for Claude: are the weights/definitions above defensible, and should Weight be "load" (higher worse) or a capacity score?

---
# Attached: staged plan (Form-only numbers superseded by the Recovery/Weight section)
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
