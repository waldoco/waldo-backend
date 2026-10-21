# Consult verdicts and revised Stage 1 (Core, 10 Oct 2026, source pinned at beta-mvp 8b7cff7b / eaa2469a code)

Tags: [verified] read in source or docs this session; [inference] not verified; proposals need owner rulings where marked GATED.

## Corrections to my own earlier claims
- I said injection scoring should leave the hard list: wrong. `SCRIBE_HARD_REASONS` = canary_leak, secret_leak, health_value_leak only (packages/runtime/src/llm/provider.ts:1323) [verified]. Item dropped.
- I ordered ADR-0024 withholding after the health routes: backwards, see Q-A.
- My recovery.v1 overlapped ADR-0081 Form (sleep .5, HRV .35): retracted, see Q3.
- I called health-sync the likely ingest route: the cited condition fails, see Q5.

## Source facts
A. Owner-typed health text skips the free-text scan for internal_context/system_prompt/owner_reply (scribe/sanitiser.ts ~565-575, owner ruling 28 Sep) [verified]. Structured indicator+measurement objects still hard-deny at every destination (same comment) [verified]. A hard hit in the scanned history window rejects the whole request (my earlier read of provider.ts ~1428-1460) [verified]. Conflict: CLAUDE.md line 23 says no raw health in general transcripts [verified]. Not yet verified: whether the composer's curated health view (`derivedHealthDestinationViewSchema`, context-composer/materials.ts:299) or a pin card ever trips the structured check; no real health row has run through a turn. [inference] it is eligible. Verdict CHANGE: red test first (zone/trend/drivers view and a pinned-card item through the real sanitiser path), and if red, ADR-0024 item-level withholding lands before any health reaches a turn. Biggest risk: a stuck conversation until the item ages out.
B. OpenAI calls had no `store` (llm/openai.ts:68) [verified]; OpenAI's data-controls page says Responses API application state is kept 30 days by default (https://developers.openai.com/api/docs/guides/your-data, read tonight) [verified]. Adapter is stateless (no previous_response_id) [verified]. Fixed red-first in PR #988 (CI pending). Does not change abuse-monitoring retention or org ZDR.

## Verdicts
- Q1 CHOOSE ADR-0081 consent-bound storage; 21 Jun note superseded (owner confirms, GATED #1). Store normalised daily aggregates (35 d), derived (90 d). Risk: consent contract not unified.
- Q2 CHOOSE zone/trend/drivers in prompts; numbers on app cards via API; pin brings a number into chat. Agree; note A: owner-typed numbers already reach the model, so "no numbers in prompts" is only true for system-inserted values; owner must settle the CLAUDE.md conflict (GATED #2).
- Q3 CHANGE, agree. Form (sleep .5/HRV .35/circadian .075/motion .075) is mostly what the vision calls Recovery; Form needs circadian/motion/stress, Weight needs calendar demand. Stage 1 ships one score from sleep+HRV+resting HR as recovery.v1 (re-versioned 0081 algorithm); Form and Weight "unavailable" with reason until intraday/calendar inputs exist. Needs ADR-0081 amendment (GATED #1). Risk: renaming a ratified score. messages/tasks conflict in flows: flag, not rule.
- Q4 CHOOSE beta-mvp consent contract; split storage/compute purpose from provider-egress purpose; app writes through a backend route (GATED #3).
- Q5 DECIDED by source: the app credential is a signed console-session bearer (since the #999 follow-up under its own `appbearer.` context, not the console cookie value; channels/app-api.ts, identity/console-auth.ts), not a Supabase JWT, so ingest is a Worker `POST /app/v1/health/ingest`, idempotent upsert key (owner, source, day, metric). The app's health-sync edge function stays unproven and unused.
- Q6 CHOOSE compute in the Worker ingest path with a shared TS implementation, never in a DO, no raw logging. Risk: Worker CPU for 30-day backfill; chunk.
- Q7 CHOOSE Stage 1 routes only, separate routes, unavailable = 200 + reason enum, Idempotency-Key on POSTs, approval carries proposal digest, no-store, zod fixtures.
- Q8 CHOOSE health in volatile run context, no health Spots yet; my health-Spots proposal dropped.
- Q9 push after Stage 1; APNs token auth, Worker HTTP/2 to APNs [inference, unverified]; no health/zone words in push.
- Q12 CHOOSE Stage 1 plus one calendar approval with receipt; drop Weight, intraday Form, sources, 30 d history views. GATE: 30-day HealthKit backfill proven on a device; fallback foreground read; a seeded row only if labelled. Risk: native proof is outside my control.
- Q13 add: store:false (done, #988); 14-day sleep debt input to the ingest window; App Store 5.1.3 disclosure for LLM processing, DPDP/residency, withdrawal purge including DO-derived memory before real users (GATED #4).

## Revised Stage 1 order (estimate: Core ~35-50 h, 5-7 days; confidence 45%)
1. #988 store:false merge on green.
2. Red test: health view/pin through the real sanitiser; ADR-0024 withholding first if red.
3. Tree-interleave and failed-turn row (queued, small).
4. After rulings #1,#3 and migration approval: ingest route + tables + compute + `GET /app/v1/health/today`; consent record.
5. Today brief route; one calendar approval route with receipt.
6. Staging trace with a labelled own-account row; then device backfill.
Not started: anything needing migrations or the amendment.

## Owner rulings needed (short)
1. Amend ADR-0081: Recovery as the Stage 1 score, Form/Weight unavailable until inputs exist.
2. Owner-typed health numbers in model context/transcripts (28 Sep ruling) vs CLAUDE.md line 23: which stands.
3. Consent contract = beta-mvp's, plus approval for the health ingest migration(s).
4. Before real users: App Store 5.1.3 text, DPDP/residency, withdrawal purge scope.
5. Confirm 21 Jun "on-device only" note superseded.
