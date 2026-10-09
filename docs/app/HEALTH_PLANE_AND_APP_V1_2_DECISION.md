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
