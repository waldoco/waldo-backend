# Bringing health, fitness and nutrition apps into Waldo (research, 1 November 2026)

Status: research only. Nothing here is built, decided or approved; it names no owner ruling. No developer program was joined, no account created and no terms accepted. Vendor documents were fetched on 2026-11-01, and several changed between June and October 2026. This is a reading of contract text, not legal advice.

Tags: **[verified]** = read on a vendor, Apple or Google page, or in this repository at `fd7aaa535` (`beta-mvp`). **[inference]** = reasoning from those. **[not confirmed]** = no primary source found. Effort: **S** days, **M** weeks, **L** months or gated by a contract. Effort excludes contract revision, ADR-0081 review and consent copy unless stated.

## 1. Recommendation

1. **The vendors' own AI terms decide what Waldo can use, more than technical access does.** In 2026 the largest sources wrote AI clauses into their API terms. A direct API integration can be technically easy and still unusable by an LLM agent. Details are in section 3.
2. **Read what the phone health stores already hold, but it is not free.** Per app it is the cheapest path (S), and the vendor API agreements attach to the vendor's API, not to data the user's phone holds [inference]. It still needs three things first:
   - a duplicate rule for overlapping signals (section 5);
   - new additive signals for nutrition and hydration, which `healthSignalV1Schema` does not have today;
   - an ADR-0081 writer and matrix amendment, with a separate sensitivity decision for cycle data.
3. **Do not build against these APIs for an LLM agent:** Strava, Oura REST, Eight Sleep, and TrainingPeaks (closed to new partners). **Do not buy an aggregator now:** the aggregators do not shield Waldo from provider AI terms, and Strava and Oura bar aggregators from AI use outright.
4. **Order:**
   - 0: get written answers from WHOOP, and from Garmin if Garmin stays in scope (section 7).
   - 1: audit and dedupe workouts already readable from HealthKit.
   - 2: nutrition and hydration through the stores.
   - 3: a bounded Health Connect widening.
   - 4: direct clouds, starting with Polar and COROS.
   - 5: cycle, last, as its own decision.

   Full ranking in section 10.

## 2. What Waldo has today

| Fact | Source |
|---|---|
| The contract accepts four sources: `apple`, `samsung`, `health_connect`, and one cloud provider, `whoop`. | `packages/contracts/src/app/health-ingest.ts:18-20` |
| Oura is a pure mapper, deliberately unwired: nothing connects to Oura, stores its data or accepts it as a source, because the Oura API agreement bars AI-model use outside Oura's MCP server and bars storage without written consent. | `packages/runtime/src/health/providers/oura-map.ts:3-9` |
| WHOOP is a cloud OAuth provider. Scopes are `offline read:profile read:sleep read:recovery read:workout`. Consent copy 3 tells the owner that Waldo stores the WHOOP data and that an AI model provider processes it. | `packages/runtime/src/health/providers/whoop-client.ts:11`; `health-ingest.ts:22-27` |
| Signals Waldo can store: sleep (duration, efficiency, midpoint, stages), overnight and window HRV, resting HR, HR window, SpO2, respiratory rate, steps, active energy, workouts (with zones, effort, distance, power), wrist temperature, VO2 max, HR recovery, `mindful_duration`, `body_mass`, `body_fat_percentage`, `lean_body_mass`, `stand_hour`. **There is no dietary, hydration or cycle signal.** | `health-ingest.ts:289-294` |
| Android reads Health Connect filtered to Samsung Health only (`com.sec.android.app.shealth`). The producer accepts a Health Connect row as a canonical score only when every scored reading's writer is Samsung Health. Other writers are computed as `candidate_unaccepted`. The reason given is that raw records are not deduplicated, so mixing writers would double-count steps. | `supabase/migrations/20261031120000_health_coach_signals.sql:230`; `packages/runtime/src/health/producer.ts:323-335`; sibling note `android-health-connect-2026-11-01` (app PR 202) |
| Source ranking and confidence: `apple > oura > whoop > health_connect > samsung`, confidence 1 / 0.85 / 0.8 / 0.6 / 0.6. ADR-0081 says unknown or unvalidated sources cannot enter the canonical v1 score. | `producer.ts:70`, `producer.ts:323-325`; ADR-0081 line 57 (Brain) |
| The iOS native read queries workouts from **every** writer, with no source filter. Each workout row carries the writer's bundle id. Sleep picks one source's night to avoid summing overlapping records; hourly totals use HealthKit's own cross-source merge. | `waldo-app/modules/health/ios/HealthKitManager.swift:246`, `:389-395`, `:711-715` |
| I found no session-level duplicate rule for workouts in `training-load.ts` or `producer.ts` (grep for overlap and dedup finds only sleep and window overlap). | [verified by grep; I did not read every line] |
| The health plane's own rulings: the owner's readings may reach model context and owner-channel replies (ruling 2). Blocked: third-party egress unless the owner asks to share a specific item, externally tainted content, logs, audit records, R2 summaries and browser jobs. Raw readings are kept 90 days. Provider requests set `store: false`. | `docs/app/HEALTH_PLANE_AMENDMENT.md` |
| ADR-0081 requires, for any new field, source, destination, surface, retention period or algorithm version, an explicit matrix or registry change with contract fixtures. | ADR-0081 line 120 (Brain) |

This differs from the brief's wording ("raw values never go into prompts"). The amendment lets the owner's own readings reach model context. The hard blocks are DO memory for bulk readings, R2, logs, traces in production, and third-party sends.

## 3. The terms landscape

Four vendors restrict AI use of their API data. I read each clause on the vendor's own page, in raw page text for Strava, Oura and WHOOP.

| Vendor | Document, effective date | What it says about AI | Consequence for Waldo |
|---|---|---|---|
| Strava | API Policy, 2026-06-01 (the separate Agreement page has no AI text) | §5.3 bars using Strava data in "development, training, evaluation, or operation" of any AI application, including "ingestion into a context window". §5.10 bars making the data available to "AI Application providers", even with user consent. §5.16 bars aggregators, pass-through proxies and MCP servers over the API. §3.5 makes Strava's own MCP the only agent interface, for a subscriber's personal use. §5.5 bars a persistent index (vectors, embeddings), §6.2 caps caching at seven days. | **Blocked** for an LLM agent. Do not build before written permission from Strava. |
| Oura | API and MCP Agreement, 2026-06-08 | §4(d): LLM use only through Oura's MCP Server, and the API may not be used to "prompt" an AI model. §4(c): applies "regardless of whether a User has purportedly consented". §2(c): aggregators may pass no Oura data to any AI. §3(m): no storing or caching MCP data without separate written consent. | **Blocked on the REST API.** The MCP route has no public docs [not confirmed]. Terra's blog of the same period matches. |
| WHOOP | API Terms of Use, 2026-10-06 | The prohibitions in §4 apply "unless expressly authorized by the WHOOP Data owner". They bar using WHOOP data to "create, develop, test, train, fine-tune or improve" an LLM or other AI model, and bar building databases or "permanent copies". They do not name inference or prompting. Third-party exposure needs explicit opt-in. | Waldo's consent copy 3 was written for this authorization [inference: it matches the clause]. Training is not Waldo's use. Whether prompting counts, and whether the 90-day store counts as "permanent copies", is for counsel and WHOOP in writing. I cannot see whether these clauses are new. |
| Garmin | Developer Program Agreement, Rev B | The global agreement has no AI clause. §4.1(b) limits data use to "format and display". §5.2(o) bars passing data to third-party platforms Garmin has not approved. The brand guide requires attribution on AI-derived output. An AI-consent clause (§15.10) appears only in the China-entity agreement. | Possible but legally fragile. Which agreement an applicant is shown is [not confirmed]. |

Not read: Polar, Wahoo and Withings agreements have no AI clause in the text I read. COROS's partner API terms are not public. Google Health's three policies have no AI clause. The Limited Use rule restricts transfers to what a visible user-facing feature needs, with consent.

**The store path is not clean either.** Apple's HealthKit rules allow sharing with a third party only with express permission, and only if that party also provides a health or fitness service to the user. App Review 5.1.2(i) requires disclosing sharing with "third-party AI" and getting explicit permission. Google Play requires explicit informed consent for any third-party sharing, with heightened scrutiny for reproductive health. Waldo already sends consented health data to a model provider, so these are existing open questions, not new ones. Counsel should answer whether an LLM provider counts as a "health or fitness service".

## 4. Path comparison

| Path | Cost | Coverage | Terms exposure | Residency and DPA |
|---|---|---|---|---|
| **Phone health stores** (HealthKit, Health Connect), read on device and uploaded by the app | None per app | Whatever the user's apps write. Strong for workouts and weight; nutrition for MyFitnessPal, MacroFactor, Cronometer; mindfulness for Headspace and Calm. Gaps: Flo (not sent to Health), Cal AI (not documented), nothing for Strava on Android | Apple and Google rules above; the vendors' API terms do not attach [inference] | Same path as today's consent (copy 2); no new processor |
| **Direct vendor APIs** | Free today, each reserves the right to charge | Rich recovery data where open: WHOOP, Polar, COROS, Withings, Google Health. Closed or hostile: Strava, Oura, TrainingPeaks, Eight Sleep. Garmin gated | The vendor's agreement applies in full (section 3) | Each vendor is a new source needing consent copy, as WHOOP has (copy 3) |
| **Aggregator** (Terra, Junction, Rook, Thryve) | $300 to $499 a month entry (section 8) | Broad cloud coverage, but Apple Health and Health Connect each need the aggregator's SDK in the app | Does not remove provider AI terms: Strava §5.16 and Oura §2(c) bar aggregators outright. Terra's DPA makes the customer indemnify Terra for provider claims | Thryve EU-only; Junction US or EU (Belgium); Terra regions not pinned [not confirmed]. Another sub-processor for special-category data |
| **Vendor MCP** | Varies | Strava (personal use only), COROS (open to builders), Withings (Withings+ users) | Strava's bars commercial use. Withings and Oura: whether a backend may be the client is [not confirmed] | Data enters the model path under the vendor's terms; does not fit a persisted health plane |

## 5. The store path in detail

**What each store can carry.** Record types are from Apple's and Google's own pages [verified]:

- **Nutrition.** HealthKit has dietary types for energy, protein, carbohydrates, fats, sugar, fibre, sodium, caffeine, water and micronutrients. Health Connect has `NutritionRecord` (same nutrient set, plus `mealType`) and a separate `HydrationRecord`.
- **Workouts.** HealthKit has `HKWorkout`, `HKWorkoutRoute` and effort scores (iOS 18). Health Connect has `ExerciseSessionRecord` with `ExerciseRoute`.
- **Cycle.** HealthKit has menstrual flow, intermenstrual bleeding, cervical mucus, ovulation tests, contraceptive, pregnancy and lactation. Health Connect has seven cycle types (period, flow, mucus, ovulation test, intermenstrual bleeding, sexual activity, basal temperature) and no contraception or pregnancy type.
- **Mind.** HealthKit has `mindfulSession`. Health Connect has `MindfulnessSessionRecord`, added in SDK 1.1.0 and gated by a feature check.
- **Provenance.** Every HealthKit sample carries the writing app's bundle id. Every Health Connect record carries `dataOrigin.packageName` and a recording method.

**Gotchas that change the design:**

- HealthKit cannot tell "denied" from "no data". Treat an empty read as unknown, never as "the owner does not track this".
- Health Connect reads only the last 30 days before first grant unless `READ_HEALTH_DATA_HISTORY` is granted, and background reads need their own permission. Google publishes no numeric read limits.
- Written data is thinner than the cloud API. WHOOP writes no HRV and no recovery score to Apple Health, and writes no HRV to Health Connect, so the cloud API is the only way to get WHOOP's RMSSD. Oura writes HRV to Health Connect only. Apple's native HRV is SDNN; baselines must stay per method, as the contract already requires.
- Meal timing mostly does not arrive. MyFitnessPal writes meal summaries without timestamps to Apple Health, and meal-level calories to Health Connect.

**Two separate problems, with different fixes:**

1. **Overlapping signals** (workouts, steps, heart rate, energy). A run can arrive from the Watch, from Strava's "Send to Health" and from Garmin Connect. iOS already reads every writer's workouts (`HealthKitManager.swift:389`) and uploads them with the bundle id. Nothing I found collapses duplicates, so a duplicated session counts twice in training load [inference from the grep above; test before relying on it]. On Android the Samsung-only filter exists for this reason. Widening needs a written rule: which writer wins per signal, what counts as the same session (overlap in time, same type), and how a losing writer's row is kept or dropped.
2. **Non-overlapping new signals** (nutrition, hydration, caffeine, cycle). There is no duplicate problem, but none of these exists in `healthSignalV1Schema`. Each is an additive app contract revision (the app lane must hear before new enum values), a destination and retention row in ADR-0081's matrix, and consent copy that names the category. Cycle data is special-category and, on Android, draws extra Play review. It needs its own owner decision, not just an enum value.

**HealthKit confidence.** The producer keys confidence on `apple` (1.0) and treats Health Connect as a transport that is trusted only for Samsung Health. HealthKit rows written by Oura, WHOOP or a manual-entry app would currently inherit the Apple weight [inference from `SOURCE_CONFIDENCE`]. Before scored signals widen on iOS, ADR-0081 needs the same per-writer rule it has for Health Connect.

## 6. Per-app findings

Each row covers access path, useful data, terms that limit us, effort for a direct integration, and ADR-0081 impact. "Store" means the data the app writes to Apple Health or Health Connect, from the vendor's own help page.

### Training

| App | Access | Useful data | Terms that block or limit | Effort | ADR-0081 |
|---|---|---|---|---|---|
| **Strava** | Self-serve OAuth, webhooks; Standard tier 10 or 9,999 athletes, Extended case by case; needs a Strava subscription. Store: writes route, type, distance, time, calories to Apple Health; Health Connect [not confirmed] | Activities, HR and power streams, `suffer_score`. No sleep or HRV | §5.3, §5.10, §5.16, §5.5, §6.2 (section 3). Free today, may charge | L, legal. Technically S-M | Not a source to add. Workouts Strava writes to Apple Health reach Waldo as a store path |
| **Garmin Connect** | Business Starter form (immediate access, push only, no backfill) or Enterprise; Personal API is own-data only. The program was reported paused and reopened [secondary]; status [not confirmed]. Store: Apple Health and Health Connect writes [not confirmed from Garmin] | Health API: steps, sleep, HR, stress, pulse ox, body battery, body composition, BP. HRV and VO2 max not named on public pages | Display-only licence (§4.1(b)), third-party bar (§5.2(o)), attribution on AI-derived output | L | New cloud source needs an amendment. Via store, a validated Garmin writer |
| **Polar** | Self-serve OAuth, webhooks, any Flow user. Store: Flow writes workouts, sleep, HR in workouts and weight to Apple Health; workouts, route, sleep stages, VO2 max and resting HR to Health Connect | Exercises, HR zones, continuous HR, Nightly Recharge (HRV-related), Sleep Plus Stages, SleepWise, Cardio Load, VO2 max | No AI clause. Data to external sources only with explicit member permission; Polar credit required; scope clause says the app should extend the Polar experience [inference: grey for a general agent] | S-M | New cloud source |
| **COROS** | Official MCP with self-serve OAuth, no approval, single-user scope, polling only. Partner API needs an application and an established platform. Store: Apple Health only (steps, HR, sleep, distance) | HRV, resting HR, sleep, stress, VO2 max, recovery status, training load, race predictions | No AI clause found; COROS names "AI coaching apps" as an intended use. Partner terms not public | M via MCP | New cloud source; MCP data is polled, so retention is Waldo's |
| **Wahoo** | Self-serve OAuth; Sandbox then reviewed Production; webhooks. Store: workouts to Apple Health and Health Connect | Workouts, power, NP and TSS, cadence. No sleep or HRV | No AI clause. No transfer to third parties beyond what the user, the agreement or your privacy policy allows; delete within 48 hours on request | S-M | New cloud source; narrow value |
| **TrainingPeaks** | Partner-only; the form says new partners are not being accepted. Apple Health: workouts flow in, steps and sleep do not [snippet only] | Metrics (HRV, weight, sleep quality), planned workouts, zones. Free athletes get little | No AI clause, but the application asks how you use AI. Caches only per cache header, default seven days; no permanent copies | L, unknown start | Not available |

### Nutrition

| App | Access | Useful data | Terms that block or limit | Effort | ADR-0081 |
|---|---|---|---|---|---|
| **Cal AI** | No API found. Does not document writing to Apple Health or Health Connect: its FAQ and privacy policy describe reading steps. The Android FAQ names Google Fit | Calories and macros, if reachable | ToS bans reverse engineering and competitive analysis | Direct: n/a. Store: only if a device test shows dietary samples | Needs a one-day device test: log a meal, check Apple Health > Nutrition > Data Sources. MyFitnessPal acquired it on 2026-03-02 |
| **MyFitnessPal** | OAuth2 API exists, but "We are not accepting requests for API access at this time." Store: Apple Health gets meal summaries with most nutrients (no caffeine, no vitamin A, no timestamps) and weight; Health Connect gets meal-level calories, water and cardio. Only data after connecting | Energy, macros, weight | ToS bans scraping and limits use to personal use | Direct L, blocked. Store S | New dietary signals, meal-level only |
| **Cronometer** | No public API; select partners only. Store: Android exports food and water (documented list); iOS exports "13 different nutrients" not named by the vendor | Energy, macros, micronutrients, water, biometrics | §10(b) bars using its Content or Services for AI training or ML models. Written against Cronometer's own content [inference: not user data in the store] | Direct L. Store S (Android), S-M (iOS) | New dietary signals; check iOS nutrient list on a device |
| **MacroFactor** | No API found. Both stores: writes nutrition and weight, reads weight; opt-in; 30-day backfill on connect | Calories, macros, weight | ToS §7.4(11) bars automated collection for ML or AI training, against its Services | Store S | New dietary signals |

### Sleep and body

| App | Access | Useful data | Terms that block or limit | Effort | ADR-0081 |
|---|---|---|---|---|---|
| **Oura** | Public OAuth2 plus webhooks; 10-user cap until approved; Gen3 users without membership lose API access. Store: writes active energy, HR, mindful minutes, respiratory rate, sleep stages, steps, weight, workouts to Apple Health; HRV, sleep and workouts to Health Connect | Sleep stages, readiness, temperature deviation, resilience, stress, VO2 max. HRV method not named in the API docs | §4(d), §4(c), §2(c), §3(m) (section 3). §4(a)(xiii) bars charging users for MCP or API functionality; §4(a)(ix) bars products that replicate Oura | L, and needs Oura's written consent | The contract has no `oura` source; the mapper stays unwired. ADR-0081 already ranks Oura at 0.85. Via the store, Oura-written rows need the writer rule in section 5 |
| **WHOOP** (already integrated) | Public OAuth2 plus webhooks; tiers Sandbox 10, Build 100, Growth 1,000, Scale 5,000, then unlimited, each reviewed. Not yet used: `read:cycles` (day strain, steps added 2026-09-23) and `read:body_measurement` (weight, max HR) | Recovery RMSSD, sleep with `sleep_needed` breakdown, SpO2, skin temperature | Section 3. No webhooks for cycles or body, so these need polling. Existing owners must re-consent to new scopes [inference] | S for the two scopes | Extends an existing source; new scopes need consent copy review |
| **Withings** | Public OAuth2, no contract; free plan 10 users then app review. **Accounts created from 12 or 13 Oct 2026 need Withings+ to share with any third-party app**, including exports to the stores. Store: category list for Apple Health; Health Connect write list [not confirmed] | Weight, body composition, sleep with overnight HRV, steps, HR. ECG, AFib, SpO2, AHI sit in the Advanced Biomarkers contract | 2018 API terms have no AI clause; AI training rights are sold only in the contract plan | M | New cloud source. The Withings+ gate hits new owners at connect time |
| **Fitbit / Google Health** | The legacy Fitbit Web API ends 2026-11-02 (Fitbit's page says 2026-10-30). Replacement: Google Health API on Google OAuth. Restricted scopes need verification and an annual third-party security assessment; 100-user cap until then | Sleep, RMSSD HRV (SDNN variant too), resting HR, SpO2, skin temperature, VO2 max, ECG. No readiness or BP | No AI clause. Limited Use: transfers only for a visible user-facing feature, with consent | L | New cloud source; compliance lead time is the cost |
| **Eight Sleep** | No official API; only reverse-engineered clients. Store sync is mentioned, data types not listed [not confirmed] | Sleep stages, HR, HRV, temperature | ToS (2026-09-16) bars automated collection and using Pod data as ML training data | Not recommended | Go through the stores |

### Cycle and mind

| App | Access | Useful data | Terms that block or limit | Effort | ADR-0081 |
|---|---|---|---|---|---|
| **Flo** | No public API. iOS help says logged menstruation "will not be sent to the Health app". Health Connect write [not confirmed]. Google says Flo data shared with Google Health "will not be made available to other apps" | Cycle phase, symptoms | ToS not read | iOS: not viable. Android: M and uncertain | Cycle needs its own decision |
| **Clue** | No API. Writes period and flow to Apple Health only (write-only, no backfill). No Health Connect path documented. Manual JSON export | Period dates and coarse flow; phase must be computed | ToS not read | iOS S. Android not viable | Special-category data; own consent line |
| **Headspace** | No API. Writes mindful minutes to Apple Health and Health Connect behind a toggle | Session time and duration | ToS not read | Store S; `mindful_duration` already exists | Fits today's signal |
| **Calm** | No API. Writes mindfulness to Apple Health, and to Health Connect since July 2026, behind a toggle. Guided sessions only | Session time and duration | ToS not read | Store S; fits `mindful_duration` | Fits today's signal |

## 7. What to ask vendors in writing

Do this before any build that depends on the answer. Use each vendor's official channel only.

- **WHOOP.** Does persisting derived scores for 90 days count as "permanent copies"? Does prompting a hosted LLM with the owner's own data, under the owner's express authorization, fall outside the "AI model, application, or system" prohibition? WHOOP's app approval page says to use the developer dashboard channel.
- **Garmin**, if kept in scope. Is passing data to a model provider "format and display", and does §5.2(o) cover it? Is the Starter form live?
- **Oura.** Is there an Oura MCP onboarding path for a consumer app backend, and a written consent for storage? Only worth asking if Oura data is a priority; Waldo can already get some Oura data through the stores.
- **Strava.** An exception under Policy §3.2 is possible in principle (the policy invites contact); the outcome is unknowable, so do not plan on it.

## 8. Aggregators

| | Terra | Junction (formerly Vital) | Rook | Thryve |
|---|---|---|---|---|
| Entry price | From $499 a month ($399 annual per FAQ), 100,000 credits, 200 credits per connected source per month | $300 a month, 500 users | $399 a month, 750 users | €499 a month, 500 users, two-week storage |
| Residency | US, UK and EU sub-processors; pinning [not confirmed] | Team region US or EU (Belgium), fixed at creation | Not stated | EU data centres only |
| Compliance claims | SOC 2 and BAA on Enterprise; DPA with customer indemnity for provider claims | Launch plan explicitly has no BAA, SOC 2 or ISO 27001; those are Enterprise | "HIPAA-aligned"; signs BAAs; no SOC 2 or ISO claim found | ISO 9001 and 27001, GDPR |
| Apple Health, Health Connect | Own mobile SDK required | Own mobile SDK required | Own SDK required | Own SDK modules |
| Strava | Needs your own Strava app | Bring your own OAuth app; Enterprise | Not confirmed | Your own OAuth client [secondary] |
| Garmin | Needs your own Garmin program | Needs Garmin Developer Program | Listed | Listed |
| Sub-processors of note | Anthropic and OpenAI for AI-assisted support, anonymised | Not read | Not read | Not named |

Junction's rename is confirmed by secondary sources only. Rook's and Thryve's per-provider coverage was not confirmable.

Why not now: they add a fee, an SDK and a sub-processor for special-category data, and they do not change the provider terms that gate Strava, Oura and WHOOP. Revisit only if a product need appears for several clouds Waldo cannot approve for itself. Terra marks Garmin, Strava and WHOOP as needing your own credentials even through Terra.

## 9. MCP servers

- **Official:** Strava (`mcp.strava.com/mcp`, read-only, subscribers, personal use only). COROS (`mcp.coros.com/mcp`, builders welcome, reads and writes plans). Withings (`mcp.withings.com/mcp`, Withings+ only, 16 read and 4 write tools). Terra's hosted data MCP and admin MCP. Junction's docs-only MCP. Oura's agreement names an Oura-operated MCP Server, but I found no public page.
- **Community only:** Garmin, WHOOP, Fitbit and Google Health, Withings, MyFitnessPal, Cronometer, MacroFactor, Eight Sleep, Apple Health export. Several scrape or use reverse-engineered APIs with the user's login. A community MCP that holds a user's tokens is third-party custody outside Waldo's per-owner authority root and consent model, and several likely breach the vendor's terms [inference]. Straiker reported malicious clones of an Oura MCP [secondary]. Not suitable for a product.
- **MCP cannot be the persisted path.** Strava bars an MCP client for commercial use, Oura forbids caching MCP data, and Withings and COROS intend per-user connectors. Waldo's health plane persists readings, so MCP is at best a live read for an owner who adds the connector themselves.

## 10. Ranked order

| # | Step | Gain | Effort | Gate |
|---|---|---|---|---|
| 0 | Written answers from WHOOP (and Garmin if in scope); counsel read on the Apple "health or fitness service" rule | Removes the main legal unknowns for sources already in use | S | None |
| 1 | **Audit what iOS already reads from other writers.** Check which bundle ids appear in the owner's staging workouts; add a session-duplicate rule and a writer rule for HealthKit | Strava, Garmin Connect, Polar, Wahoo, COROS and Oura workouts, with no per-app work, once duplicates are handled | S-M | ADR-0081 writer amendment; app lane |
| 2 | **Nutrition and hydration through the stores.** Add additive signals for energy, protein, carbohydrates, fat, water, caffeine; read both stores; consent copy names nutrition | MyFitnessPal, MacroFactor, Cronometer (Android first), and Cal AI if the device test passes | M | App contract revision; ADR-0081 matrix; consent copy |
| 3 | **Bounded Health Connect widening.** Allow-list named writers per signal (workouts from Polar and Wahoo; weight; mindful minutes). Keep Samsung-only for scored overlapping signals | Android parity for workouts and mindfulness | M | Same amendment as step 1 |
| 4 | **Direct clouds, in this order:** Polar (S-M, no AI clause), COROS via MCP (M), WHOOP cycles and body (S, after step 0), Withings (M, Withings+ gate for new accounts), Wahoo (S-M, narrow). Google Health and Garmin (L) only if a need appears | Recovery-grade data without wearables-only coverage | S-M each | Each is a new source: consent copy, source ranking, fixtures |
| 5 | **Cycle.** Clue on iOS through HealthKit (S), Android and Flo unresolved | Cycle awareness | S-L | Owner decision on a special-category data class, consent copy, Play review |
| — | Strava, Oura REST, TrainingPeaks, Eight Sleep, aggregators | — | — | Do not build; revisit if terms or permission change |

What would change this order: written permission from Strava or Oura; Garmin confirming that its data may reach a model provider; a Withings+ decision for owners; the Cal AI device test failing, which drops it from step 2.

## 11. ADR-0081 and contract implications

Each item needs an amendment with fixtures, not a commit. Nothing here has been drafted.

1. **Writer rule for HealthKit**, matching the Health Connect rule: which bundle ids may feed which scored signal, and at what confidence. Without it, third-party writers inherit Apple's 1.0 [inference].
2. **Session-duplicate rule** for workouts and a per-signal rule for steps, energy and HR across writers.
3. **New signals:** dietary energy and macros, water, caffeine; later cycle. Each needs a matrix row for destination, retention (the amendment's 90-day raw and 24-month aggregate rule is the starting point), prompt eligibility and external-channel eligibility.
4. **Cycle** as a separate special-category class, with its own consent line and its own prompt eligibility, because the owner's health-model grant should not silently widen to it.
5. **Each new cloud source** extends `healthSourceV1Schema`, `HEALTH_PROVIDER_SOURCES_V1` and the consent copy table, and adds a row to the source confidence table in ADR-0011 and ADR-0081.
6. **Provider retention clauses** (Strava seven-day cache, TrainingPeaks seven-day cache, Oura "strictly necessary", WHOOP "permanent copies") conflict with a 90-day raw store. Any provider that is added needs its own retention setting, not the default.

## 12. Verification status

**Observed in this session:** the repository files and lines cited; ADR-0081 in the Brain clone; the app's HealthKit reader; the Strava API Policy and Agreement, Oura API and MCP Agreement, and WHOOP API Terms in raw page text. Training, nutrition, sleep and aggregator pages were read by research agents, with the clauses above re-checked by me. Where an agent read a page only through a fetch summariser, its own file says so.

**Not confirmed:**
- Oura's MCP Server URL, and whether a third-party backend may be its client.
- Whether WHOOP's 2026-10-06 clauses are new.
- Garmin's program status, and which agreement an applicant is shown.
- Cal AI's health-store writes, and the Cronometer iOS nutrient list.
- Withings' exact Withings+ price and its Health Connect write list; the 12 versus 13 October date.
- Rook and Thryve per-provider coverage, Terra's region pinning, and Health Connect's numeric read limits.
- ToS of Flo, Clue, Headspace and Calm.
- Whether sync to the stores needs a paid tier for MyFitnessPal, Cronometer, MacroFactor, Flo, Clue, Headspace or Calm.

**Not done:** no device test, no vendor contact, no legal review, no code. MCP repository stars, licences and recency are directory-reported, not opened.

## 13. Sources

Fetched 2026-11-01.

- Strava: https://www.strava.com/legal/api_policy, https://www.strava.com/legal/api, https://developers.strava.com/docs/getting-started/, https://support.strava.com/en-us/articles/15402024-apple-health-and-strava
- Oura: https://cloud.ouraring.com/legal/api-agreement, https://cloud.ouraring.com/v2/docs, https://support.ouraring.com/hc/en-us/articles/360025438734-Apple-Health-Integration
- WHOOP: https://developer.whoop.com/api-terms-of-use/, https://developer.whoop.com/docs/developing/app-approval, https://support.whoop.com/s/article/Apple-Health-Integration
- Garmin: https://developer.garmin.com/gc-developer-program/overview/, https://developerportal.garmin.com/sites/default/files/Garmin%20Connect%20Developer%20Program%20Agreement.pdf
- Polar: https://www.polar.com/accesslink-api/, https://www.polar.com/en/legal/polar-api-agreement
- COROS: https://support.coros.com/hc/en-us/articles/53181619102996-Build-on-COROS-MCP, https://github.com/coroslab/COROS-MCP
- Wahoo: https://cloud-api.wahooligan.com/, https://www.wahoofitness.com/wahoo-api-agreement
- TrainingPeaks: https://api.trainingpeaks.com/request-access, https://help.trainingpeaks.com/hc/en-us/articles/234441128-TrainingPeaks-API
- Withings: https://developer.withings.com/llms.md, https://static.withings.com/content/api/plans/plans.html, https://www.withings.com/en-us/policies/terms-of-service
- Google Health: https://developers.google.com/health, https://developers.google.com/health/app-verification, https://developers.google.com/health/policies/health-api-developer-terms-and-conditions
- Eight Sleep: https://www.eightsleep.com/terms-of-service/
- Nutrition, cycle, mind: https://myfitnesspalapi.com/, https://support.myfitnesspal.com/hc/en-us/articles/360032271092-Apple-Health-connection-and-syncing, https://support.cronometer.com/hc/en-us/articles/22731903751316-Health-Connect, https://help.macrofactorapp.com/en/articles/102-integrations, https://www.calai.app/faq, https://help.flo.health/hc/en-us/articles/34890229122068-How-to-import-data-from-the-Health-app-to-Flo-iOS, https://support.helloclue.com/hc/en-us/articles/20199556038813-Can-I-export-my-data-from-Clue-to-Apple-Health-or-Apple-Health-to-Clue, https://help.headspace.com/hc/en-us/articles/115003793088-How-do-I-connect-Headspace-to-the-iOS-Health-App, https://support.calm.com/hc/en-us/articles/115005140814-How-to-Sync-the-Calm-App-with-Apple-Health-Track-Mindfulness-Minutes
- Aggregators: https://tryterra.co/pricing, https://tryterra.co/dpa, https://www.junction.com/pricing, https://docs.junction.com/api-details/regions.md, https://www.tryrook.io/pricing, https://www.thryve.health/pricing
- Apple and Google: https://developer.apple.com/app-store/review/guidelines/, https://developer.apple.com/documentation/healthkit, https://developer.android.com/health-and-fitness/health-connect/data-types, https://support.google.com/googleplay/android-developer/answer/12991134
