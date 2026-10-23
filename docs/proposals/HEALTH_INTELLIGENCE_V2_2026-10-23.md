# Health intelligence v2: scores, backfill, patterns and the agent feed (ADR-0081 amendment proposal)

**Status.** Proposal for the owner, 23 October 2026. Nothing here is built, migrated or deployed, and no code that changes a score starts until the owner accepts the decisions in §8.

**If accepted:**
- §4.3's retention change, the new health-plane records (§3.1.3, §4, §5) and the provisional-score rule (§3.1) are published as one dated, append-only ADR-0081 amendment in waldo-brain. It is combined with #1399's amendment if that hasn't been published yet.
- `docs/foundation/accepted-adrs.json` is then regenerated.
- The launch contract's "minimum evidence and retention must be calibrated/documented in the bounded health design" is answered by §4 and §5.

**What it answers.** The owner's rulings of 23 October 2026:
1. Health is Waldo's most important vertical.
2. Provisional scores from day 1, labelled "your baseline is being calculated" until day 14.
3. Backfill as much history as possible.
4. Recovery, Form, Weight and the rest brought to industry practice: WHOOP, Oura, Samsung, Garmin, Fitbit and Google. The aim is published method shapes, not their exact formulas.
5. Learn the owner's physiological patterns properly.
6. Feed it all to the agent.

**Read for this note:**
- waldo-backend `beta-mvp` at `8c45f38a`: `health/scores/*`, `health/producer.ts`, `health/trigger.ts`, `channels/health-context.ts`, `contracts/src/app/health-ingest.ts`, and the health migrations through `20261022170000`.
- #1399's proposal at `0a251675`.
- ADR-0081 at waldo-brain `c9219839`.
- The launch contract at its CLAUDE.md pin `be08c4af`.
- `docs/app/HEALTH_PLANE_AMENDMENT.md`.
- heywaldo.in and heywaldo.in/how-it-works, read in a browser on 23 October.
- The orchestrator's `handoff/HEALTH_MEMORY_PRACTICES_2026-10-22.md`, treated as leads.

**Tags:**
- **[verified]:** read in source at the pins above.
- **[Vn] / [P-…]:** an opened vendor page or paper, listed in §12.
- **[inference]:** reasoned, not observed.
- **UNCONFIRMED:** looked for in a primary source and not found.
- **[proposed]:** this note's recommendation.

**How the sources were read.**
- Six research passes ran in parallel, one per vendor group, one on norms and shrinkage, one on backfill limits and one on alertness models. Each read primary pages and recorded what it opened.
- The numbers that enter a formula were re-opened by hand for this note: Natarajan Table S2, Quer 2020's 65.5 ± 7.7 and 3.03 bpm, BDA3 eq. 2.12 and the scaled inverse-χ² prior, Oura's readiness windows, and the two HealthKit characteristic types.
- Some vendor pages were read through a summarising fetcher; §12 says which.

## 1. Short version

**Waldo today [verified]:**
- Every score waits for 14 usable days in the last 30 and shows nothing until then.
- Apple's SDNN is ignored by Form's stress part.
- Weight needs a calendar.
- Tasks and messages are wired as inputs but are always `null`.
- Sleep need is the owner's own average, so chronic short sleep reads as no debt.
- Sleep debt is computed and thrown away.
- The ingest SQL silently drops any sample older than 90 days.
- Nothing learns patterns.

**The industry [§2]:**
- No vendor waits 14 days. Oura and Apple score from the first night and learn in the background. WHOOP greys out 4 days. Apple, Fitbit and Samsung need about 7 nights for their baselines.
- Firstbeat (Garmin), Samsung and Fitbit seed with age and sex.
- No vendor composite has published external validation.

**v2 in one paragraph [proposed].**
- **One shared baseline:** a conjugate-normal shrinkage of each signal's usual and spread toward a population prior (§3.1). Scores start on night 1 against people of the owner's age and sex, become the owner's own within days, and carry a "provisional" label until 14 days of their own data, or on day 1 if their history was backfilled.
- **Per-method HRV:** never converted; Apple SDNN gets no population prior.
- **Weight without a calendar,** with tasks and messages wired.
- **A sleep need** that isn't circular, and a debt that repays slowly.
- **A SAFTE-shaped alertness-by-hour term in Form,** run as a shadow first.
- **24 months of daily aggregates** with a full deletion story.
- **A closed catalogue of statistically tested patterns** the owner can see, correct and delete.
- **A `HealthPlanningContext`** that gives the model dated, worded statements. Code computes and the model judges.

### 1.1 What this changes in earlier decisions

| Earlier decision | Changed to | Why |
|---|---|---|
| #1399 §2 rule 1: "never population norms" | Population priors are allowed, for the provisional window only, through §3.1. After 14 days the personal data dominates. | 23 Oct ruling 1 |
| #1399 §4.4: "7 h is context, never a coded default" | The NSF age range is the prior for sleep need (§3.5) | 23 Oct ruling 1; the circular-need problem |
| #1399 §4.6: "don't lower 14-of-30" | Kept for the `personal` label. Early scores use a wider predictive spread, not a smaller sample (§3.1). | Answers its SE argument directly |
| D5 of 10 Oct: 30-day backfill | Up to 24 months, as daily aggregates beyond 90 days (§4) | 23 Oct ruling 3 |
| Launch contract §5: "cannot manufacture scores for … insufficient … states" | Unchanged in substance. A provisional score is computed from the owner's own measured night against a labelled reference. No reading still means no score. | Reconciled, not overridden |
| ADR-0081 §3: normalised daily inputs 35 days, derived 90 days | Daily aggregates and derived rows 24 months, patterns 24 months (§4.3). Mostly already approved in scope by HEALTH_PLANE_AMENDMENT, but never published in Brain. | Needs the Brain amendment |

## 2. How the leading wearables do it

**How to read this section.**
- One block per score family. Each block has the vendors, then Waldo today, then Waldo v2 (§3).
- Every vendor cell cites a page in §13 that was opened and read on 23 October 2026. A cell with no citation is marked UNCONFIRMED (looked for, not found on an opened page) or [inference].
- None of these vendors publishes a full formula. This compares method *shapes*: inputs, windows, cold start and gaps.

**The finding that matters most.** Nobody waits 14 days. The vendors split two ways.

| | Vendor | First score |
|---|---|---|
| **Show from night one, learning in the background** | Oura | Sleep and Readiness the morning after the first night [V12]. Readiness contributors take up to two weeks to learn [V10]. |
| | WHOOP | Recovery greyed out for 4 days [V2]. |
| | Apple | Sleep Score after a single night [V40]. |
| **Withhold until about 7 nights** | Apple | Vitals typical range after 7 nights [V34]. Readiness needs 7 of the last 49 nights [V36]. |
| | Fitbit | Readiness after 7 nights [V49]. |
| | Samsung | Vitals after 7 nights [V44]. |
| | Garmin | HRV status at about 3 weeks; a 7-night rolling average shows from night 7 [V21][V22]. |

Two more points cut across both camps:
- **Population defaults are normal.** Firstbeat (Garmin) requires age, sex, height and weight before it analyses anything, and uses them to seed HRmax and VO2max until recorded data replaces them [V30][V31]. Garmin's "Poor" HRV status is judged against an age-normal range [V21]. Samsung weights Energy Score factors by age and sex [V42]. Fitbit's Sleep Score targets are by age and sex [V51]. Oura's Sleep Balance compares with the owner's baseline *and* with age recommendations [V10].
- **No vendor composite is externally validated.** Peer-reviewed validation exists for sensor inputs: WHOOP HRV against ECG with n = 6 [P-Bellenger 2021], and Oura sleep staging with 106 people [P-Altini 2021]. None was found for any composite Recovery or Readiness score. "Industry practice" here therefore means a convergent *shape*, not a proven formula.

### 2.1 Recovery / readiness

| Product | Inputs | Baseline length | New user | Missing data |
|---|---|---|---|---|
| WHOOP Recovery (0–100 %) | HRV (RMSSD, deepest sleep), resting HR, Sleep Performance, respiratory rate. HRV carries most weight; exact weights unpublished [V1][V2]. API also lists skin temperature and SpO2 [V3]. | UNCONFIRMED (no opened page states a day count) | Greyed out for the first 4 days while it estimates the normal range [V2]. | Score object exists only when `SCORED`. `UNSCORABLE` when there isn't enough data [V4]. Withheld, not computed from fewer inputs [inference from the schema]. |
| Oura Readiness (0–100) | 9 contributors: resting HR (lowest of the night), HRV balance, body temperature, recovery index, sleep, sleep balance, sleep regularity, previous-day activity, activity balance [V10]. | Long-term = 2 months. HRV balance = 14-day average (recent days weighted more) against a 3-month average [V10]. Balance contributors = 14-day weighted against 2 months [V11]. | Score from the first morning [V12]. "Can take up to two weeks" to learn averages [V10]. | Withheld in low-battery overnight mode; a night the ring was off is lost [V13]. Scoring from fewer contributors: UNCONFIRMED. |
| Garmin HRV Status / Training Readiness | HRV status: 7-day average of overnight HRV against a personal baseline range [V21]. Readiness: last night's sleep score, recovery time, HRV status, acute load, 3-night sleep history, 3-day stress history [V23]. | HRV baseline about 3 weeks [V21][V22]. Readiness windows as listed. | "No status" until a 7-day average exists; a 7-night average shows from night 7 [V21][V22]. Readiness cold start UNCONFIRMED. | "No status" when there is too little data [V21]. |
| Apple Vitals / Readiness (0–10, Series 12 and Ultra 4) | Vitals: overnight HR, respiratory rate, wrist temperature, SpO2, and sleep duration or (newer watches) overnight HRV [V34]. Readiness: activity (calories, effort, Training Load), vitals status, sleep score and recent sleep [V35]. "Recovery HRV" sampled as often as every 5 min overnight [V37]. | Vitals typical range from 7 nights [V34]. Readiness: at least 7 of the past 49 nights [V36]. | Needs age, height and weight entered, plus 7+ nights [V35][V36]. Out-of-range classification is built on Apple Heart and Movement Study data [V38]. | Unstated [V34][V35]. Vitals notifies only when two or more metrics are out of range [V34]. |
| Samsung Energy Score | Previous-day activity against typical (acute:chronic idea), 7-day sleep duration and consistency, sleep latency, sleeping HR and HRV against long-term trends. Weights vary by age and sex [V42]. Samsung's own pages list the inputs three different ways [V42][V43]. | "Long-term" length UNCONFIRMED. Sleep is a 7-day average [V42]. | "A few days" of wear [V43]. Vitals baseline after 7 nights [V44]. | UNCONFIRMED |
| Fitbit Daily Readiness | HRV (RMSSD), resting HR, the past week's sleep. Activity was removed in the current version [V49][V50]. | First baseline from 7 nights; "about a month" recommended. Rolling window UNCONFIRMED [V49]. Health Metrics personal range: up to 30 days [V50]. | No score until 7 nights [V49][V53]. | Withheld if sleep is under 3 h or too restless [V49]. |
| **Waldo today** `recovery.candidate.v1` | Sleep against need 0.5, overnight HRV 0.3 (one method per baseline), resting HR 0.2 (`recovery.ts:10`) | 14 usable days within the last 30 (`stats.ts:1-2`) | `baseline_immature` for 14 days. No number. | No sleep means no score. HRV or resting HR missing: renormalised over the present weights, coverage reported (`stats.ts:39-43`). |
| **Waldo v2** `recovery.candidate.v3` (§3.2) | Same three shares. HRV method fallback from #1399. Sleep is compared with the new sleep need. | Window 60 days, mature at 14 days. Day 1 onward: own data shrunk with a population prior. | Provisional from the first night, labelled until 14 mature days | As today, plus explicit owner day exclusions (§5.4) |

### 2.2 Strain / load / exertion

| Product | Inputs | Baseline length | New user | Missing data |
|---|---|---|---|---|
| WHOOP Strain (0–21, logarithmic) | Mainly time in heart-rate zones, plus estimated muscular load. Resets at midnight. Day Strain is not the sum of workout strains [V5]. Target set from Recovery [V5]. | "Calibrated to your own cardiovascular baseline". Day count UNCONFIRMED [V5]. | UNCONFIRMED | UNCONFIRMED |
| Oura Activity score | 6 contributors on 24 h and 7-day windows. Training volume in MET-minutes per week. Daily goal from Readiness, age, height, weight and sex [V15]. | Rolling 24 h and 7 days. No learning period stated [V15]. | Available immediately [V12]. | UNCONFIRMED |
| Garmin acute load / Training Status | EPOC-based. Acute load is a weighted sum over "the last several days"; an activity's effect is gone after 10 days. Load focus over 4 weeks [V24]. | Several days, and 4 weeks for focus [V24]. A 7:28 ratio for Garmin is UNCONFIRMED. | Status after about a week; "No Status" until VO2max results accrue over 2 weeks [V24]. | Activities not on the primary device are excluded [V24]. |
| Apple Training Load | Workout effort (1–10, estimated from age, height, weight, HR, GPS and elevation) times duration [V38]. | Last 7 days against the previous 28 days [V39][V38] | UNCONFIRMED | UNCONFIRMED |
| Fitbit Cardio Load / Target Load | TRIMP from activity heart rate, age, resting HR and sex. All activity counts, not only workouts [V48]. | Target: 7 days against about 4 weeks. The same page also says 2 weeks [V48]. | First target after 7 days and nights; 28 days recommended [V48]. | Not addressed [V48] |
| Samsung | An activity acute:chronic comparison inside Energy Score [V42]. No standalone load score found. | UNCONFIRMED | — | — |
| **Waldo today** `weight.candidate.v3` | Demand, not physiology: calendar busy minutes 0.35, tasks 0.3, messages 0.15, physical load 0.2. Tasks and messages are always `null` (`producer.ts:250`). | 14 of 30 days | No Weight without a calendar, or for 14 days | Renormalised. No calendar: unavailable (`weight.ts:13`). |
| **Waldo v2** `weight.candidate.v5` (§3.4) | The same four shares, with tasks and messages actually wired. Physical load is #1399's energy-based input. | 60-day window | Physical load and calendar provisional from day 1 (personal-only spread, §3.1) | Any one present component gives a Weight, with coverage shown |

### 2.3 Sleep

| Product | Inputs | Baseline length | New user | Missing data |
|---|---|---|---|---|
| WHOOP Sleep Score / Sleep Need | Score: duration against need, consistency, efficiency, Sleep Stress (HR, HRV and respiration in sleep) [V9]. **Need = baseline + strain + sleep debt − naps** [V6]. Debt carries into the next nights [V7]. | Planner uses 28 days of typical sleep [V6]. Baseline need "learned from the day you begin" [V6]. | Learns from day 1 [V6]. Exact calibration UNCONFIRMED. | UNCONFIRMED |
| Oura Sleep Score | 7 contributors: total sleep, efficiency, restfulness, REM, deep, latency, timing [V16]. Mostly population (AASM) references [V16]. | Sleep balance and regularity: past 2 weeks [V10]. | From the first night [V12] | A main sleep needs at least 3 h [V14] |
| Garmin Sleep Score / Sleep Coach | Duration against an age-dependent 7–9 h, stages, awake time, sleep stress (HRV) [V25]. Need from sleep and activity history, HRV status and naps [V26]. Firstbeat requires age, sex, height and weight [V31]. | UNCONFIRMED | Chooses a sleep schedule at setup [V25] | UNCONFIRMED |
| Apple Sleep Score (0–100) | Duration 50, bedtime consistency 30 (last 13 nights), interruptions 20 [V40] | 13 nights for consistency [V40] | After any night worn at least 1 h [V41]. Consistency with fewer than 13 nights is undocumented. | UNCONFIRMED |
| Samsung Sleep Score / Bedtime Guidance | Stage durations and movement, compared with the same age and sex [V47]. Need from the past 3 days [V45]. | 3 days for guidance [V45] | Sleep coaching needs 7 days, including a workday and a day off [V45]. | UNCONFIRMED |
| Fitbit Sleep Score | Duration, time to sound sleep, sound sleep, restlessness, awakenings, interruptions. Targets by age and sex [V51]. | No personal baseline stated [V51] | First night | No stages, no score [V51] |
| **Waldo today** `sleep-debt.candidate.v1` | 14-night recency-weighted shortfall against need. Need = owner-confirmed or own 14-night average (`sleep-debt.ts`). Computed but never persisted. | 14 nights | Need is `baseline_immature` for 14 days | Any missing night: `partial`, no figure |
| **Waldo v2** `sleep-need.candidate.v1` + `sleep-debt.candidate.v2` (§3.5) | Need: age prior shrunk toward the owner's longer nights, or the owner's own figure. Debt: 14 nights, surplus repays slowly. | 60 nights for need, 14 for debt | Need from night 1 (prior), provisional | Debt from at least 10 of 14 nights including last night, coverage shown |

### 2.4 Stress

| Product | Inputs | Baseline length | New user | Missing data |
|---|---|---|---|---|
| WHOOP Stress Monitor (0–3) | HR and HRV against a personal baseline. Motion separates exercise [V8]. | Past 14 days [V8] | UNCONFIRMED | UNCONFIRMED |
| Oura Daytime Stress / Resilience | HR, HRV, motion, temperature. 15-min updates while still [V17]. Resilience: 14-day weighted [V18][V19]. | Rolling personal baseline; at least 5 days and nights [V18]. Resilience: 5 of the last 14 days (10 for new members) [V19]. Cumulative: 21 of 31 days [V20]. | No data for 5–7 days [V17] | Gaps during movement, sleep and poor fit [V17]. "Not enough data" state [V20]. |
| Garmin all-day stress (0–100) | HRV during inactive periods [V27]. Firstbeat: HR up and HRV down against the individual's resting level [V30]. | Firstbeat seeds HRmax and VO2max from age, sex, height, weight and activity class, then updates from data [V30]. | Population-seeded [V30] | Segments with more than 75 % artefacts are "unrecognized" [V30] |
| Apple | No all-day stress score found | — | — | — |
| Samsung stress | HR (plus "other factors"). No baseline described [V46]. | UNCONFIRMED | — | Unavailable at extreme HR [V46] |
| Fitbit Resilience / Body Responses | Responsiveness (HR, HRV, EDA), exertion balance, sleep [V52] | UNCONFIRMED | UNCONFIRMED | UNCONFIRMED |
| **Waldo today** (inside `form.candidate.v4`) | Awake, non-workout hours' mean HR. RMSSD hourly HRV only, so **Apple SDNN is ignored** (`form.ts:35`). | 14 of 30 days, matched hours | Unavailable for 14 days | Fewer than 8 hours of HR: no stress part |
| **Waldo v2** (inside `form.candidate.v6`) | #1399's sedentary HR, plus hourly HRV of whichever method the day has, against that method's own baseline | 60 days | Personal-only, joins at 7 days (§3.1) | As today |

### 2.5 Body battery / energy

| Product | Inputs | Baseline length | New user | Missing data |
|---|---|---|---|---|
| Garmin Body Battery (0–100) | HRV, stress, sleep, activity, scaled by VO2max. Charges in rest, drains with stress and activity [V28][V29]. No Firstbeat white paper exists for it [V33]. | UNCONFIRMED | UNCONFIRMED. Firstbeat's underlying stress/recovery method is population-seeded [V30]. | UNCONFIRMED |
| Samsung Energy Score | See 2.1. Described as an "energy reservoir" model [V42]. | — | "A few days" [V43] | UNCONFIRMED |
| WHOOP, Oura, Apple, Fitbit | No equivalent found; the nearest are Recovery and Readiness [inference from the pages read] | — | — | — |
| **Waldo today** `form.candidate.v4` | Recovery 0.4, movement 0.2, stress 0.2, sleep midpoint 0.1, daylight 0.1. Live all day against the same hours of earlier days. | 14 of 30 | Unavailable for 14 days | Renormalised; stale after 6 h without data |
| **Waldo v2** `form.candidate.v6` (§3.3) | Today's inputs, plus an alertness-by-hour component from the owner's own sleep timing (two-process shape). This replaces the static midpoint term. | Midpoint history 60 days | Provisional from day 1 | As today |

## 3. Waldo's scores v2 [proposed]

**Version names.** The names below stack on what other lanes already hold: #1399 has `recovery.candidate.v2`, `weight.candidate.v4` and `form.candidate.v5`, and the freshness lane (#1401, merged) has `form.candidate.v4`. This proposal claims `recovery.candidate.v3`, `form.candidate.v6`, `weight.candidate.v5`, `sleep-need.candidate.v1` and `sleep-debt.candidate.v2`, and records the claim in the shared notes folder. Each version stays `candidate_unaccepted` until a review receipt exists, as today (`scores/types.ts:64`).

**What doesn't change.**
- The 0–100 mapping: `50 ± 20z`, clamped at |z| 2.5 (`stats.ts:3-35`).
- The zone bands, and the held-zone rule (`zones.ts`).
- Per-source computation and the source rank (`producer.ts:33`).
- Per-method HRV.
- Renormalisation over the components that are present, with coverage reported.

These are out of scope because nothing in §2 argues for changing them, and changing them would move every owner's zones at once.

### 3.1 The shared baseline: day 1 onward, shrunk toward the owner

This replaces "14 usable days within 30, or nothing" (`stats.ts:1-2`, `recovery.ts:20-23`) for every component. One module, `health/scores/baseline.ts`, gives every component the same centre and spread.

**Inputs.**
- The owner's own values for this source, signal and method over the last **60 days**, read from the daily aggregates in §4. Owner-labelled `ill` and `travel` days are left out (§5.4).
- A population prior where §3.1.2 says one is defensible.

**Why 60 days.** It matches Oura's two-month "long-term" [V10]. It is longer than Fitbit's 30-day personal range [V50] and Garmin's roughly three weeks [V21]. It is shorter than Apple Readiness's 49-night look-back plus history [V36]. A longer window steadies the spread estimate, and the 24-month aggregates in §4 make it affordable. The window is a constant, checked against §7.2.

**Model.** This is the conjugate normal model [P-Gelman BDA3] (§2.5–2.6, eq. 2.12, and the scaled inverse-χ² prior on the variance). It works on the component's natural scale: ln for HRV, bpm for resting HR, minutes for sleep.

```text
prior on the person's usual:   μ ~ N(μ0, τ²)        τ = between-person SD
prior on night-to-night SD:    σ² ~ Inv-χ²(ν0, σ0²)  σ0 = typical within-person SD, ν0 pseudo-nights
owner data: n values, mean ȳ, sample variance s²

σ̂² = (ν0·σ0² + (n−1)·s²) / (ν0 + n − 1)                (n ≥ 1; σ̂ = σ0 when n ≤ 1)
k   = σ̂² / τ²
centre = (k·μ0 + n·ȳ) / (k + n)                          (= μ0 when n = 0)
var_c  = 1 / (1/τ² + n/σ̂²)
z      = (today − centre) / sqrt(σ̂² + var_c)             predictive spread, then the existing ±2.5 clamp
```

**What it does in practice.**
- On night 1 (n = 0) the reading is placed against people of the owner's age and sex. The spread is about √(τ² + σ0²), wide, so only a genuinely unusual reading leaves the middle zones.
- The personal centre takes over fast, because between-person spread is far larger than night-to-night spread. For resting HR, k ≈ (3.03/7.7)² ≈ 0.15 [P-Quer 2020] (arithmetic mine), so the owner's own mean carries 87 % of the weight after one night and 95 % after three.
- The night-to-night spread is the slow part. It needs ν0 + n to be dominated by n. That is the honest reason the label stays until day 14.

**Answer to #1399 §4.6.** That section argued against lowering 14-of-30 because a 7-sample SD has a relative standard error of about 0.29. This design does not lower the bar for calling a baseline personal. It scores early nights against a predictive spread that is wider than the personal one (it includes `var_c` and the prior's σ0), so early z-scores are smaller, not noisier. The label stays until 14 days of the owner's own data. #1399 §2 rule 1 ("never population norms") and §4.4 ("7 h is context, never a coded default") are superseded **for the provisional window only** by the 23 October ruling. After 14 days the prior's weight is small, but it is never exactly zero.

#### 3.1.1 The label

Each pillar on the derived row gains:

```text
baseline: {
  state: 'provisional' | 'personal',
  personal_days: <smallest n across its used components>,
  needed: 14,
  prior: 'age_sex' | 'adults' | 'none',
}
```

- **When it reads `personal`.** A pillar is `personal` when every used component has n ≥ 14. This depends on how much data exists, not on account age. An owner whose history was backfilled (§4) is `personal` on the first morning, as "Bring your past" promises. `prior: 'adults'` means the owner didn't share age or sex.
- **What the owner sees.** The app shows "your baseline is being calculated" while the state is `provisional`. That is the owner's wording from the 23 October ruling, and the app owns the copy.
- **Old builds.** The key is new, and `healthScoresV1Schema` is a strict object. So the key is served only to builds naming the next free health revision (§9). A build below it receives the same pillar as `unavailable` / `baseline_immature`, which is what it gets today. An installed build therefore never shows a prior-anchored number without its label.
- **The model.** It gets the same label in words (§6). Under `auto`, the health trigger stays a shadow run while Recovery is provisional (§6.3).

#### 3.1.2 Which components get a population prior

| Component | Prior | Values used (source) | Before 14 personal days |
|---|---|---|---|
| Overnight RMSSD (Health Connect, Apple RMSSD from iOS 27, WHOOP) | Yes | μ0 = ln(median) and τ = ln(P75/P25)/1.349, from Fitbit PPG 06:00–07:00 by 5-year age band and sex [P-Natarajan 2019] (Table S2). For example, age 40 is a median of 37 ms (F) and 38 ms (M). σ0 = 0.20 ln units, ν0 = 7 (UNCONFIRMED, see below). | Provisional from night 1 |
| Overnight SDNN (Apple today) | **No** | Apple documents SDNN without a measurement window [P-Apple SDNN doc]. Ultra-short SDNN agrees poorly with 5-minute values [P-Munoz 2015][P-Shaffer 2017], and no SDNN→RMSSD conversion was found. Seeding it from RMSSD or 5-minute norms would invent a reference. The one Apple Watch validation found agreed with a chest strap used beat-to-beat data from the Breathe app (n = 20) [P-Hernando 2018], not the background SDNN samples. | Personal-only. Joins at 7 nights, the industry's common minimum [V34][V44][V49], with σ0 replaced by a t-predictive spread. Day-1 Recovery for an Apple owner uses sleep and resting HR. |
| Resting HR | Yes | μ0 = 65.5, τ = 7.7, σ0 = 3.03 bpm (2.90 men, 3.10 women), ν0 = 7 [P-Quer 2020]. Age and sex explain only 6 % of between-person variance there, so the RHR prior is all-adults by sex, not by age. | Provisional from night 1 |
| Sleep against need | Yes, through need (§3.5) | NSF adults 7–9 h, older adults 7–8 h [P-Hirshkowitz 2015]; AASM "7 or more" [P-Watson 2015] | Provisional from night 1 |
| Sleep midpoint, daylight, movement, sedentary HR, hourly HRV, calendar minutes, tasks, messages, physical load, and #1399 drivers (respiratory rate, temperature, SpO2, walking HR) | No defensible personal-scale prior was found, or the prior would be a lifestyle norm, not physiology | — | Personal-only, joins at 7 days (t-predictive spread). Calendar, tasks and messages come with history from Google at connect time (`calendar-demand.ts` reads past days), so they are usually mature on day 1. |

**The σ0 for ln RMSSD is the weakest number here.**
- Buchheit's "~12 %" day-to-day figure is from athletes' 5–10 minute morning recordings. It doesn't say whether the CV is of raw RMSSD (ln SD ≈ 0.12) or of the ln value [P-Buchheit 2014].
- No general-population nightly figure was found.
- 0.20 is the conservative choice: a larger spread gives smaller early z-scores.
- With τ ≈ 0.5, k stays below 0.2 across 0.12 to 0.25, so the choice moves the spread, not the centre.
- §7.2 calibrates it, and the owner's own data replaces it as n grows.

**Window mismatch.** Natarajan's priors are 06:00–07:00 five-minute medians, not whole-night averages. They are the closest published wearable window, not a match. Daytime supine 5-minute ECG norms sit well below them, for example RMSSD 35.4 ± 18.5 ms for women aged 35–44 [P-Voss 2015], so a prior only means something within its own window. The prior is therefore labelled `age_sex` in the DTO, never presented as "normal for you".

#### 3.1.3 Where age and sex come from

Today no age or sex field exists anywhere in the backend.

- **Source:**
  - On iOS, HealthKit's characteristic types `dateOfBirth` and `biologicalSex` [V68], read once with permission. The phone sends a 5-year age band, never the date.
  - On Android, the person answers two optional onboarding questions. A Health Connect equivalent was not verified (UNCONFIRMED).
  - Either can be changed or cleared in settings.
- **Storage:** `waldo.health_profile` (owner, `age_band`, `sex` in `female` | `male` | `not_shared`, `sleep_need_minutes` confirmed by the owner, `updated_at`). It sits in the health plane under storage consent and is deleted with the account and on storage withdrawal.
- **Not shared:** the all-adults prior. For RMSSD that is a pooled median with τ widened by the age spread [inference]. For RHR the prior barely changes.

### 3.2 Recovery: `recovery.candidate.v3`

| | v1 (today) | v3 |
|---|---|---|
| Shares | Sleep 0.5, HRV 0.3, resting HR 0.2 | Unchanged |
| Sleep | Asleep ÷ need × 100; need = confirmed or own 14-night mean | Asleep ÷ **sleep need v1** (§3.5) × 100 |
| HRV | One method; dropped if that method's baseline is immature | #1399 v2 fallback (RMSSD if mature, else SDNN), with §3.1 baselines. RMSSD provisional from night 1; SDNN from night 7. |
| Resting HR | One baseline for all methods | Per method (#1399 v2), with §3.1 baseline from night 1 |
| Baseline | 14 of 30 | §3.1: 60-day window, label until 14 |
| Illness signals | — | Drivers, not weights (#1399 AW-3, unchanged) |

**Considered and not taken:**
- **Previous-day activity as a Recovery input.** Oura [V10] and Apple [V35] use it. Fitbit removed it from Readiness [V49], and WHOOP folds strain into sleep need instead [V6]. Waldo already has load in Weight and in sleep need (§3.5). Adding it to Recovery too would count the same day twice.
- **A 7-day HRV balance inside the score.** Oura [V10] and Garmin [V21] use one. Waldo keeps it as a trend driver and pattern (§5.1), so the morning number stays about last night, as WHOOP's does [V2], and the model sees the trend separately.

### 3.3 Form: `form.candidate.v6`

**What v6 changes over v4/v5:**
1. **Stress HRV per method.** The stress part takes hourly HRV of whichever method the day has, against that method's own baseline, instead of RMSSD only (`form.ts:35`). Apple owners get an HRV-informed stress part for the first time. Sedentary HR stays as #1399 v5 defines it.
2. **§3.1 baselines.** Personal-only components join at 7 days. The Recovery part is provisional from night 1.
3. **An alertness-by-hour term replaces the sleep-midpoint term.**
   - **Today:** a static "how far is last night's midpoint from usual" (`form.ts:68-72`). It says nothing about *when* in the day the owner is sharpest. The website promises exactly that: "10:30–12:30 is your sharpest stretch", and Form "live all day, from Circadian, Motion and Stress".
   - **v6:** a SAFTE-shaped expected effectiveness E(t), the model ADR-0011 already grounds Form in. It uses the published equations and defaults [P-Hursh 2004]:
     - a sleep reservoir that fills during the owner's actual sleep intervals and drains about 1 % per waking hour;
     - a two-harmonic circadian term `cos(2π(T−p)/24) + 0.5·cos(4π(T−p−3)/24)`, scaled 7 % to 12 % by the reservoir deficit;
     - sleep inertia for up to 120 minutes after waking.
   - **Phase anchor:** p comes from the mean sleep midpoint of the last 5 nights. The 5-night midpoint predicted melatonin onset within 1 h for 92 % of young adults [P-Martin & Eastman 2002] (abstract). Placing SAFTE's circadian minimum at the habitual sleep midpoint is [inference] from the paper's worked example (00:00–08:00 sleep, p = 18:00), not a published rule.
   - **Uncertainty:** about ±1 h phase, more for very early or late types [P-Hursh 2017].
   - **Why SAFTE:** it is the best documented of the three candidate models, with every equation and default printed. The three-process model doesn't print its circadian acrophase default [P-Akerstedt 2004]. The two-process model describes sleep timing, not waking alertness [P-Skeldon 2025]. SAFTE's combined reservoir and circadian curve produces the early-afternoon dip that reviews of attention report at about 14:00–16:00 [P-Valdez 2019].
   - **Score:** the component score is E(t) mapped linearly from 70 % to 100 % onto 0–100. The anchor 70 is a candidate constant [inference]; SAFTE's 4-hours-a-night example bottoms near 64 % [P-Hursh 2004].
   - **Share:** 0.15, taken from midpoint 0.1 and daylight 0.1 → 0.05.
4. **The personal curve takes over.** Once an `hour_profile` pattern is supported (§5.1), its peak window is reported beside E(t) in the prompt. The shape is a prior, and the owner's own hours win. This is §3.1's idea applied to the time of day.

**Shadow first.** v6 is computed beside v5 for 4 weeks and stored only in a shadow field, which no reader shows. The switch happens only if the §7.3 bar holds. This is the riskiest change here, because SAFTE's parameters are fitted to laboratory performance, not to a wrist-derived "right now" score [P-Hursh 2004][P-Hursh 2017].

### 3.4 Weight: `weight.candidate.v5`, and Weight without a calendar

| | v3 (today) | v5 |
|---|---|---|
| Calendar | Required; no Weight without it (`weight.ts:13`) | Optional |
| Tasks | Input exists, always `null` (`producer.ts:250`) | Count of the owner's Google Tasks due or overdue that local day, at a 06:00 local snapshot. A count, not minutes, because tasks carry no duration. The field is renamed, which is why the version bumps. |
| Messages | Input exists, always `null` | Count of mail received in the local day from Gmail metadata (no bodies). Counted by the owner DO and kept beside calendar busy minutes. Value-free, not health data. |
| Physical load | Minutes (v3), then active energy (#1399 v4) | #1399 v4 unchanged |
| Availability | Calendar with a mature baseline | Any one component with a §3.1 baseline. Coverage shows what was missing, for example 0.2 when only physical load is present. |

**Without a calendar** the owner still gets Weight, from physical load and whatever of tasks and messages exists, at reduced coverage. That is the website's "Without one, Waldo leans on your calendar, work and patterns", and its converse. With nothing at all, Weight is `unavailable` / `calendar_demand_unavailable`, as today.

**HR-based training load** would be closer to WHOOP [V5], Fitbit [V48] and Garmin [V24]: Banister TRIMP per workout from average HR, HRmax and resting HR. It is **not proposed here**. It needs workout average HR on the wire, and #1399 already chose energy for v4. It is listed as a follow-up candidate once v4 has run (HI-6).

### 3.5 Sleep need and sleep debt

**`sleep-need.candidate.v1` (new).**
- **Today's problem:** need is the owner-confirmed figure or the owner's own 14-night mean (`recovery.ts:26-29`). A chronically short sleeper's debt is therefore about zero. In Kitamura 2016, habitual home sleep was 7.37 h against an estimated optimum of 8.41 h, and 13 of 15 participants carried debt [P-Kitamura 2016].
- **Proposal:**
  - **Prior:** the age-band midpoint of the NSF range, 8 h for adults and 7.5 h for older adults [P-Hirshkowitz 2015], with τ = 0.5 h [inference; Kitamura's individual optima spanned 7.3–9.3 h].
  - **Personal estimate:** the mean of the owner's free nights in the last 60. A free night is one not followed by a calendar event before 10:00 local, or Friday and Saturday nights when there is no calendar. This is the MCTQ idea that free-day sleep is less constrained [P-Roenneberg 2019]. Free-day sleep also contains repayment, so it can overstate need [inference]. That's why it is shrunk with κ = 14 nights, not used raw.
  - **Override:** an owner-confirmed figure (health profile) wins outright.
  - **Bounds:** the result is clipped to 6–10 h [inference].
- **Industry shape:**
  - WHOOP adds strain and debt to a baseline need, and subtracts naps [V6].
  - Garmin adjusts need for HRV status, load and naps [V26].
  - **v1 deliberately does not adjust daily need for load**, because no opened source gives the size of that adjustment. The model sees load and debt side by side instead.

**`sleep-debt.candidate.v2`.**

| | v1 | v2 |
|---|---|---|
| Window | 14 nights, recency weight 1 to 0.5 | Unchanged. The website promises "weighted over the last 14 days". |
| Need | Confirmed or own mean | Sleep need v1. Debt is tracked, never felt: under restriction, deficits kept growing while self-rated sleepiness levelled off [P-Van Dongen 2003]. |
| Surplus | Earns nothing back | Repays debt at half rate: a night above need subtracts 0.5 × surplus from the running shortfall, never below 0. "One long night counts it, without calling the debt paid" (website). One recovery night doesn't restore performance after restriction, even at 10 h in bed [P-Banks 2010][P-Belenky 2003], and 1 h of debt took about 4 days to recover [P-Kitamura 2016]. The 0.5 rate is a design choice [inference], tuned in §7.1 S2. |
| Missing nights | Any missing: `partial`, no figure | A figure when at least 10 of 14 nights are observed, including last night. The shortfall is scaled by total weight ÷ observed weight, and coverage is reported. Fewer: `partial`, as today. |
| Persisted | No | Yes (#1399 AW-7, accepted) |

## 4. Backfill and retention

### 4.1 What the platforms allow

| Platform | How far back | How to read it in bulk | Constraint |
|---|---|---|---|
| HealthKit | No documented cap. A first anchored query with no anchor returns every matching sample in the store [V54]. | `HKStatisticsCollectionQuery` gives daily sums and averages for quantity types. Apple warns it can be slow on large stores, so page by quarter [V55]. | **iOS 27** lets the person grant only a recent window. `getEarliestAuthorizedSampleDate(for:)` reports it per type, and Apple says data before it is unknown, not absent [V56]. The store is encrypted while the phone is locked, so a background read can fail [V57]. |
| Health Connect | 30 days before the first permission grant by default. Reinstalling resets that window [V58]. | `aggregateGroupByPeriod` for daily rollups. Raw reads page at 1,000 records [V58][V59]. | `PERMISSION_READ_HEALTH_DATA_HISTORY` lifts the 30 days, gated on `FEATURE_READ_HEALTH_DATA_HISTORY` [V60]. Read quotas are stricter in the background; no numbers are published [V61]. |
| Samsung Health Data SDK | No lookback stated (UNCONFIRMED) | Daily grouping is supported [V62] | No HRV type is listed [V62] |
| WHOOP v2, Oura v2 | Full history reachable by paging [V63][V64] | — | WHOOP terms bar "permanent copies" unless the data owner authorises it [V65]. Oura's agreement bars retention beyond "strictly necessary" and any use with an AI model except through its MCP server [V66]. **Neither is backfilled into durable storage by this proposal** (HI-9). |

**Today's code silently drops old data.** The ingest SQL ignores any sample whose end is more than 90 days old (`20261022170000_health_per_sample_rejection.sql:96`). The retention sweep deletes raw samples past 90 days (`20261011220000_health_retention_sweep.sql`). Older history can't be carried as raw samples, and #1399's 30-day backfill (D5 of 10 October) is the most that survives today. The website already promises more: "Your watch has years of you on it. Import them, and Waldo starts from your real usual" ("Bring your past", heywaldo.in/how-it-works, read 23 October).

### 4.2 Proposal: two tiers, one writer [proposed]

| Tier | Holds | Kept | Written by |
|---|---|---|---|
| Raw samples (`waldo.health_samples`, exists) | Hourly windows, points, nightly readings, sleep intervals | 90 days (unchanged) | `waldo.health_ingest` |
| **Daily aggregates** (`waldo.health_daily_aggregates`, new) | One row per owner, source, signal, method and local day: value, the count behind it, unit, consent epoch, origin (`rollup` or `backfill`) | 24 months (733 days, the same cut derived rows use) | `waldo.health_ingest` only: a rollup of the day's raw samples on each write, and phone-computed daily values for days older than 90 days |

**Which signals get a daily aggregate.**
- The nightly ones: sleep asleep minutes and stage totals, sleep midpoint, overnight HRV per method, resting HR per method, respiratory rate, SpO2, and wrist temperature per method.
- Daily sums: steps, active energy, exercise minutes, daylight minutes and workout minutes.
- Daily means: the sedentary heart rate (#1399 §4.3).

These are the inputs every baseline and pattern in §3 and §5 reads. Hourly shape older than 90 days is not kept. The hour-of-day patterns in §5 keep only their fitted profile, not the hours behind it.

**How the backfill runs.**
- **Phone side:**
  - The phone reads history per type, from the authorised start date (iOS 27) or the history permission (Health Connect), back to at most 24 months.
  - It computes daily values with the platform's statistics or aggregate queries, using the same reducers it uses for live nights.
  - It sends them oldest first, in batches of at most seven days (D5), at health revision 3 or later so that one bad day costs one sample (AW-6).
- **What it sends:**
  - Within the last 90 days, it sends raw samples as today, and the rollup fills the aggregates.
  - Older than 90 days, it sends `daily_aggregate` samples (a new sample kind at the next health revision). SQL writes these to the aggregate table only, never to `health_samples`.
- **Recording the window:** The phone records the authorised window per type. The backend records the earliest day it holds per signal, so "no data before X" is never read as "no change before X".
- **Recompute:** When a backfill batch lands, the producer recomputes only today and yesterday, as now. Older days get no score rows. Scores are never recomputed retroactively for history (decision HI-8). The aggregates feed baselines and patterns, not past scores.

**Reading.** Baselines read up to 60 days from the aggregate table through a new signed `health_daily_read`. That also removes the 8,000-row series cap (#1399 §10) from the baseline path. The 90-day hourly read stays as it is for Form's same-hours comparison.

### 4.3 The retention amendment [proposed, needs the owner and a Brain amendment]

**What is already approved.** HEALTH_PLANE_AMENDMENT's "90 d raw / 24 mo aggregate" recommendation was approved in scope by the owner. It reads "Daily aggregates and scores: while the account is active, at most 24 months".

**What isn't, and what this asks for:**
- ADR-0081's matrix in Brain still says normalised daily inputs are kept 35 days and derived rows 90 days (ADR-0081 §3, Brain `c9219839`), and Brain has no published amendment for this.
- This proposal asks for a dated, append-only ADR-0081 amendment covering four things:
  1. a "daily aggregate" field class: owner-only, numeric, 24 months, never in prompts, DO, R2, memory, traces or logs;
  2. the derived row at 24 months, which the code already does;
  3. pattern records (§5): 24 months;
  4. the health profile (§3.1): until the owner changes it or deletes the account.
- `accepted-adrs.json` is regenerated after.

**Is 24 months enough?** The website says "years" twice: "Your watch has years of you on it" and "Keeps the honest record: days, months, years". Reading years and deleting all but 24 months on arrival collects more than is kept, which is a data-minimisation problem under GDPR Art. 5(1)(c) [V67]. So the phone reads at most what is kept. 24 months covers two of every season, which is what yearly patterns need. Longer needs a new notice and a separate decision (HI-7).

### 4.4 Deletion story

Every new table joins every existing deletion path by name. A pgTAP test proves each path covers every table.

| Trigger | Today | Adds |
|---|---|---|
| Age: daily sweep, `waldo.health_retention_apply` / `waldo.health_retention_sweep` | Raw samples and requests past 90 days; derived rows and basis past 733 days | Aggregates and patterns past 733 days. The sweep's `exists` predicate gains both tables. |
| Storage-consent withdrawal, per source (`waldo.health_consent_withdraw`, `20261021150000…sql:248-252`) | That source's samples, anchors and requests, and every derived row | That source's aggregates and every pattern; patterns are refitted from whatever remains. When the last storage consent goes, the health profile and day labels go too. |
| Account deletion (`waldo.delete_owner`, ADR-0055) | Derived rows and logs explicitly; samples by the `owner_id` foreign-key cascade | New tables key on `owner_id … on delete cascade`, and the function also deletes them explicitly, so the pgTAP test does not depend on the cascade alone |
| The owner deletes a range ("forget 3–10 March", or "that wasn't me wearing it") | Not possible | Day labels (§5.4) mark the days excluded; their aggregates are deleted; patterns refit |
| The owner deletes a pattern | — | The row is deleted and a value-free suppression key (kind and subject) is kept for 90 days, so the same pattern isn't re-learned the next night |
| Model-use withdrawal only | Nothing deleted (owner ruling, 10 October) | Unchanged |

No aggregate or pattern value goes to DO SQLite, R2, memory, logs, traces or metrics. The prompt gets only §6's dated statements.

## 5. Pattern learning: the bounded contract [proposed]

This builds on launch contract §5. That section requires:
- a protected `HealthPattern` record carrying window, support, missingness, method/version, uncertainty, feedback and state (candidate, supported, dismissed, expired);
- predefined comparisons;
- computation that "establishes an association and the model explains it";
- no causal claims and no small-sample certainty;
- an ADR-0081 extension before persistence.

This section is that extension.

### 5.1 What is learned: a closed catalogue

The code computes statistics and decides statistical support. Whether a pattern matters today, and what to do about it, stays with the model. Each kind has a fixed test and a fixed sentence template (§6.2).

| Kind | Subject | Test (deterministic) | Minimum evidence before `supported` | Website promise it serves |
|---|---|---|---|---|
| `personal_range` | Each daily signal in §4.2, per source and method | Shrunk centre and spread (§3.1); this is "your usual" | 14 days; `candidate` before that | "against your own usual" (Quiet flags) |
| `weekday_rhythm` | Sleep minutes, sleep midpoint, resting HR, overnight HRV, Weight, calendar minutes | Day-of-week effect: one-way comparison of the weekday's mean against the owner's other days, Welch t, with Benjamini–Hochberg control across the catalogue at q = 0.1 | 6 occurrences of that weekday and 42 days in total | "This Tuesday is shaping up like the last three" (The Heads-Up) |
| `hour_profile` | Form, stress heart rate, movement by local hour | Mean by hour over matched days, with a smoothed peak and trough window and a confidence interval for the peak | 21 days with at least 12 hours of intraday data each | "10:30–12:30 is your sharpest stretch" (The Window) |
| `trend` | HRV (ln), resting HR, sleep minutes, respiratory rate, wrist temperature | 7-day mean against the 60-day baseline (Oura's HRV-balance shape [V10]), plus a 28-day Theil–Sen slope with a bootstrap interval | 28 days | "Shows how far you've come" |
| `driver_frequency` | Each #1399 driver | How often the driver was `outside` in the last 60 days, compared with the share the owner's own range implies | 30 days | "Quiet flags" |
| `association` | A fixed list of pairs, below | Paired comparison of the next-day outcome on exposed against unexposed days. Mean difference with a bootstrap 90 % interval; BH-controlled. Never phrased causally. | 28 paired days, at least 8 of them exposed | Spots and constellations ("Stress, Sleep, Caffeine") |

**Association pairs, version 1.** Each is "on days after X, Y tends to be…". The list is closed; adding a pair is a version bump.

| Exposure | Next-day outcome |
|---|---|
| Sleep midpoint later than usual by an hour or more | Recovery |
| Sleep under need by an hour or more | Form in the afternoon |
| Weight `heavy` or `peak` | That night's sleep minutes |
| Physical load above usual | Next morning's HRV and resting HR |
| A workout after 19:00 | That night's sleep minutes and HRV |
| Calendar minutes after 18:00 above usual | That night's sleep midpoint |
| Daylight below usual | That night's sleep midpoint |
| An owner-labelled day (§5.4) of kind `alcohol`, `late_meal`, `caffeine_late` or `travel` | Next-morning Recovery |

**Why caffeine and alcohol can enter only through owner labels.** The website's "Excess Caffeine" spot needs an exposure no sensor measures. The owner can label a day in chat or in the app ("had wine last night"), and the model may propose that label from what the owner said. The label is stored as owner-stated (§5.4). No code infers it from text, which follows the CLAUDE.md judgment rule.

**What is never learned:**
- conditions, diagnoses, cycle or ovulation estimates, mood (#1399 AW-8 deferred State of Mind), or any sensitive trait;
- anything from clinical tier-C types.

This holds the launch contract's line against "automatic sensitive-trait inference".

### 5.2 Where it lives

`waldo.health_patterns` sits in the health plane, owner-only and RLS'd. Its only writer is the signed `waldo.health_patterns_write`.

**Row:**
- `owner_id`
- `kind`, `subject`
- `source`, `method`
- `algorithm_version` (`pattern.<kind>.v1`)
- `window_start`, `window_end`
- `support_n`, `missing_n`
- `effect`: numeric, kind-specific; for example weekday mean difference and its interval, or peak hour and its interval
- `q_value`
- `state`: `candidate` | `supported` | `dismissed` | `expired`
- `first_supported_at`, `last_confirmed_at`
- `feedback`: `none` | `confirmed` | `rejected`
- `owner_note`: owner-written text, at most 280 characters
- `updated_at`

**Lifecycle:**
- A nightly pattern job runs as an owner-DO schedule entry, like `health-recompute`. It reads aggregates through `health_daily_read`, computes in `health/patterns/*` (pure functions, like `health/scores/*`), and writes through the RPC.
- Thresholds are met: `supported`.
- Support lost for 14 consecutive nights: `expired`. Expired rows are deleted after 60 days.
- The owner rejects: `dismissed`. A dismissed pattern never reaches the model and isn't re-proposed for 90 days.

**Limits:**
- At most 40 supported patterns per owner. Above that, the strongest by |effect| / interval width are kept. This bounds the prompt and the review UI.
- No pattern is written from fewer days than its row says.

### 5.3 What the owner sees, corrects and deletes

These are the product-practice baseline from the 22 October memory-practices survey (`handoff/HEALTH_MEMORY_PRACTICES_2026-10-22.md` on the orchestrator's Mac; its claims were treated as leads). Every surveyed product lets the user view, edit and delete what it keeps and turn it off. Deleting a source there often leaves residue in chat history.

**What the owner can do:**
- **See:** `GET /app/v1/health/patterns` (next health revision) lists each pattern's sentence (§6.2), window, support and state. The console mirrors it.
- **Correct:**
  - "That's right" sets `feedback = confirmed`, which the model sees as owner-confirmed.
  - "That's not right" sets `dismissed`, with an optional note. The note is the owner's own text and reaches the model only as the reason it was dismissed.
- **Delete:** removes the row and keeps the suppression key from §4.4.
- **Turn off:** one switch stops pattern learning and deletes all patterns. Scores keep working.

**Chat.** All of these are also tools for the model (`health_pattern_feedback`), so "stop telling me about Mondays" works in conversation. The tool writes through the same RPC. Forget and deletion therefore reach the health plane, not just DO memory.

### 5.4 Day labels: corrections that feed baselines

`waldo.health_day_labels` holds `owner_id`, `day`, `label` (`ill`, `travel`, `alcohol`, `late_meal`, `caffeine_late`, `not_me`, `device_off_wrist`, `other`) and `source` (`owner_app`, `owner_chat`).

**What each label does:**
- `ill` and `travel` days are left out of baselines and patterns, so a temporary state never resets "your usual". Oura says its readiness accounts for menstrual-cycle and pregnancy changes [V11]. Owner labels are Waldo's simpler, owner-driven version of that [inference].
- `not_me` and `device_off_wrist` days have their aggregates deleted.
- The other labels are exposures for §5.1.

**How labels are written.** A label proposed by the model needs the owner's yes before it is written. It is a stored health statement, so it follows the 22 October ruling on owner-stated readings: owner-stated, dated, deletable.

### 5.5 Why this is not a judgment rule

- **Code computes association statistics and labels their support with fixed words.** A t-test with false-discovery control is a description of the data, like the zone bands.
- **The model decides relevance and meaning, and must not claim a cause.** The sentence templates never say "because". The launch contract's "the computation establishes an association and the model explains it" is followed literally.
- **Owner feedback is input, not a rule.** A dismissed pattern is a fact about what the owner said, not a filter on topics.

## 6. Feeding the agent [proposed]

### 6.1 What reaches the model, and how

Launch contract §5 names the shape: a `HealthPlanningContext` added over the existing composer, not a new memory authority. It carries:
- availability;
- source window;
- version;
- trend and allowed drivers;
- user-reported energy;
- limitations;
- expiry;
- consent epoch;
- opaque evidence references.

Today `toContextHealthMaterial` (`channels/health-context.ts:84-188`) carries zone words, trend, freshness, drivers and tags. v2 fills the contract's fields from stored rows only:

| Field | Source | Example in the prompt |
|---|---|---|
| availability + baseline state | Each pillar's `baseline` (§3.1) | `Recovery solid (provisional: personal baseline day 5 of 14).` |
| version | `algorithm_version` per pillar. **Fixes a mislabel:** the view today hard-codes `form.safte-fast.v1` / `recovery.v1` (`health-context.ts:144-145`), while rows are `*.candidate.v*`. This is recorded here and fixed in P5. | — |
| trend and drivers | #1399 drivers, plus `trend` patterns (§5.1) | `HRV below your usual for 6 nights.` |
| sleep debt and need | `sleep_debt` (AW-7, §3.5) | `Sleep debt building over 14 nights; need about 8 h (estimated).` |
| supported patterns | `health_patterns` with state `supported`, at most 6 per turn, ranked by relevance to the turn's purpose (calendar planning, sleep question and so on) | `Since 4 Sep: Mondays your resting heart rate runs higher than other days (supported, 7 Mondays).` |
| day labels | `health_day_labels` for the last 7 days | `Owner said they were ill on 21 Oct.` |
| limitations | Coverage, missing signals, history start | `No HRV from this watch before 2 Oct.` |
| expiry | `rowFreshness` (exists) | unchanged |

### 6.2 Sentences: dated, worded by code, judged by the model

The brief asks for "dated, qualitative statements".
- Each pattern kind has one template, filled from the row: subject phrase, direction word, weekday or hour range, a start date, and a support word (`emerging` below `supported`, `supported`, `owner-confirmed`).
- Templates carry no cause words ("because", "leads to", "makes you").
- **Numbers.** Owner ruling 2 of the amendment lets the owner's own derived values reach model context, so a template may name a weekday, an hour range or a count of occurrences. It never names a raw reading.
  - The raw values behind a pattern stay in the health plane.
  - The model reads them on demand with `get_health`, or with a new `get_health_pattern(id)` that returns the row's numbers within the same destination rules as `get_health`.
- **Not in memory.** Patterns never enter DO memory. They are read live each turn, as the derived row is today. That keeps one store and one deletion path, and satisfies the CLAUDE.md line that memory keeps only qualitative patterns: here memory keeps none.

### 6.3 Seams in other lanes' files (named, not edited here)

- **`health/trigger.ts:319-320` `resolveHealthMode`.** Under `auto`, a run goes live once a Recovery zone exists and an earlier day exists. That rule assumes an immature baseline gives no zone. With provisional scores a zone exists from day 1.
  - **Proposal:** `auto` reads the stored `baseline.state` and stays a shadow run while Recovery is provisional.
  - **Why:** this keeps the owner's setting meaning what its comment says, "watches quietly until their own baseline exists".
  - `live` still fires on provisional zones, and the model sees the label.
- **`channels/health-context.ts`.** It returns material from day 1 and must thread the baseline label. That is the P5 change, in that lane's file and with its agreement.
- **Trigger wake on drivers.** #1399's P6 still belongs to the freshness lane. Pattern changes do not wake the trigger in v1. They reach the model on its next turn or scheduled run.

## 7. Evaluation [proposed]

No vendor composite has published external validation (§2), so "as good as or better than" can't be shown by citing anyone. It has to be measured. Three layers do that, cheapest first.

### 7.1 Synthetic physiology scenarios (CI, deterministic)

- **Where they live.** A generator in `packages/runtime/test/health-scenarios/` produces owner histories from published distributions (§3.1's priors and within-person spreads), then injects a known physiological event.
- **How each is checked.** Each scenario asserts direction, timing and labelling, never an exact score. That way a later weight change doesn't rewrite every fixture.
- **Data.** Synthetic values only (WHOOP terms §4, and the CLAUDE.md fixture rule).

| # | Scenario | Injected | Must hold |
|---|---|---|---|
| S1 | Acute restriction | 3 nights at 5 h after 30 nights at need | Recovery falls each night; debt rises monotonically; Form's alertness term drops in the afternoon; nothing reads `excellent` |
| S2 | Recovery sleep | S1, then 2 nights at need + 1.5 h | Debt falls but is not zero after one night (§3.5); Recovery returns to `solid` or better by night 2 |
| S3 | Illness onset | RHR +6 bpm, ln RMSSD −0.25, respiratory rate +1.5, wrist temperature +0.6 °C over 2 nights | Recovery `mixed` or worse; drivers name all four; no pattern formed from those days once labelled `ill` |
| S4 | Overreaching | Physical load +60 % for 10 days; HRV 7-day mean drifting −0.15 ln | `trend` pattern for HRV becomes `supported` by day 28, not before |
| S5 | New owner, typical | Day 1 to 21 of a median 35-year-old | Scores exist from night 1, labelled provisional to day 14. Agreement with the eventual mature score: zone agreement and mean absolute difference rise and fall respectively as days accrue (§7.2) |
| S6 | New owner, atypical | Endurance athlete with RMSSD at the 95th percentile | Day 1 shows `excellent` against the prior, then converges to the owner's own `solid` as the baseline shrinks in. The label states the reason ("compared with people your age"). |
| S7 | SDNN-only Apple owner | No RMSSD ever | HRV feeds Recovery and stress against SDNN's own baseline; never a population SDNN prior unless HI-3 accepts one |
| S8 | Method switch | RMSSD appears on night 40 | No HRV gap (#1399 AW-2 fallback); SDNN baseline untouched |
| S9 | Missing nights | 5 random nights missing of 14 | Debt available with coverage at 10 of 14; withheld at 9 of 14 |
| S10 | Weekday rhythm present | Mondays RHR +3 bpm | `weekday_rhythm` supported after 6 Mondays; not at 3 |
| S11 | **No rhythm (null)** | Identical weekdays, 200 seeds | Supported patterns across the whole catalogue at or under the q = 0.1 FDR bound. This is the false-pattern test. |
| S12 | No calendar | Physical load only | Weight available with coverage 0.2 and `calendar` named as missing |
| S13 | Travel | Midpoint shifts 6 h over 2 days, labelled `travel` | Midpoint and alertness terms follow the new phase within about 5 nights; labelled days are left out of baselines |
| S14 | Backfill | 18 months of aggregates arrive on day 1 | No provisional label from the first morning; patterns available on day 1 where their evidence is met |

**Property tests (fast-check):**
- monotonicity: more sleep never lowers Recovery, all else equal;
- higher resting HR never raises it;
- bounds of 0–100;
- per-method isolation: an SDNN value never changes an RMSSD baseline;
- shrinkage limits: n = 0 gives the prior, and as n grows large the personal value wins.

### 7.2 Calibrating the shrinkage (offline, before any constant is fixed)

- **Measure.** Sample 2,000 synthetic owners from the §3.1 priors. For each day d from 1 to 30, compare the provisional score with the score the same night gets once 60 days of baseline exist.
- **Accept** the prior strengths (κ, ν in §3.1) that give zone agreement of at least 70 % by day 7 and at least 85 % by day 14, with no zone flips that are only artefacts of the prior.
- **Report.** The curve goes in the implementation PR.
- **Caveat.** This checks internal consistency, not physiological truth. It is only as good as the priors, which is why §7.3 exists.

### 7.3 Comparison with the owner's own data

| Source | How | Allowed? |
|---|---|---|
| The owner's Samsung watch through Health Connect | Waldo's scores run on the owner's own Samsung readings, with Samsung Energy Score read by the owner on the watch | **Yes for computation.** Energy Score itself is exposed by the Samsung Health Data SDK [V62]. Using it as a comparison label is an owner decision (HI-10). |
| The owner's WHOOP | WHOOP terms bar using WHOOP Data to "create, test, train, or improve" an AI or ML system [V65], and the wearables lane already ruled WHOOP data out of evals and tests | **Not through the API.** Option: the owner writes down their WHOOP Recovery each morning by hand into a private eval sheet. That is the owner's own observation, but it is still WHOOP output, so it needs the owner's read of the terms (HI-10). |
| The owner's felt rating | A one-tap morning "how do you feel, 1–5" in the app or chat for 4 weeks, stored as a day label | **Yes.** It is owner-stated. It is also the only label that matches what Waldo is for. |

**Metrics, per pillar:**
- Spearman correlation and zone agreement with each comparison label;
- day-to-day volatility: the standard deviation of daily changes, where a lower one at equal correlation is better;
- the share of provisional days whose zone matched the later mature zone.

**Bar to accept a candidate version.** Correlation with the felt rating is no worse than v1's on the same days, and volatility is no higher. This makes "better than" a measurement with a falsifier, not an adjective.

## 8. Owner decisions

| # | Decision | Recommendation | If no |
|---|---|---|---|
| HI-1 | Provisional scores through §3.1's shrinkage. The label follows baseline maturity, not account age. Builds below the new revision keep `baseline_immature`. | **Yes** | Scores stay hidden for 14 days, against the 23 Oct ruling |
| HI-2 | Health profile: age band and sex from HealthKit characteristics (iOS) or onboarding (Android). Optional, editable, stored in the health plane. | **Yes**. Without it every owner gets the wider all-adults prior. | All-adults priors only |
| HI-3 | Apple SDNN: no population prior and no conversion. Personal-only, joining at 7 nights. Day-1 Recovery for Apple owners uses sleep and resting HR. | **Yes**. The alternative, seeding from Fitbit's 5-minute SDRR, uses a different window and device. | Name the alternative explicitly, and it is labelled `prior: adults_sdrr` |
| HI-4 | Baseline window 60 days; `personal` at 14 days; personal-only components join at 7 | **Yes** | Keep 30 days |
| HI-5 | Form v6: per-method stress HRV, plus a SAFTE-shaped alertness term replacing the midpoint term, **shadow for 4 weeks** before it shows | **Yes, shadow first**. Ship the stress-HRV change even if the alertness term is declined. | Form v5 plus the SDNN fix only |
| HI-6 | Weight v5: calendar optional, tasks and messages wired as counts. HR-based TRIMP load left as a later candidate. | **Yes** | Weight stays calendar-only |
| HI-7 | Retention: daily aggregates and patterns for 24 months; the phone reads history to the same 24 months | **24 months now**. "Years", as the website says, needs a new notice and its own decision. | 90 days only, and "Bring your past" can't be kept |
| HI-8 | Backfilled days get Recovery and sleep-debt rows for the last 90 days only (labelled `backfilled`, never zone-change events), so "Your history" (7/30/90 dots) works from day 1. Form and Weight aren't reconstructed. | **Yes** | History starts at install |
| HI-9 | WHOOP and Oura: no durable backfill; live use only, under each provider's terms, pending the owner's or legal's read of WHOOP §4 and Oura §3(m)/§4 | **Yes** (no backfill) | Legal read first |
| HI-10 | Evaluation labels: a one-tap morning felt rating (owner-stated) for 4 weeks; Samsung Energy Score as a comparison; WHOOP Recovery by hand **only** after the owner reads WHOOP §4 | **Felt rating and Samsung yes; WHOOP owner's call** | Synthetic scenarios only |
| HI-11 | The pattern contract in §5: closed catalogue, FDR q = 0.1, minimum evidence per kind, 40-pattern cap, day labels, see/correct/delete, an off switch | **Yes** | No pattern learning; the website's patterns promise stays unmet |
| HI-12 | Sleep need v1 (age prior shrunk toward free nights) and debt v2 (half-rate repayment, figure from 10 of 14 nights) | **Yes** | Need stays the owner's own average |
| HI-13 | One Brain ADR-0081 amendment covering #1399 and this note, published before the first migration of either | **Yes** | Two amendments, two reviews |

## 9. Contract, migrations and PR order (after acceptance)

**Rules for every PR:**
- small and red-first;
- synthetic fixtures only;
- valid and invalid Zod pairs for every schema change;
- the full wall at its head;
- migrations numbered above the newest on `beta-mvp` at rebase, and applied by the owner on staging only after review.

| PR | Content | Depends on | Touches |
|---|---|---|---|
| Q1 | Contract, next free health revision (§3.1.1): `baseline` on pillars; `daily_aggregate` sample kind; health profile DTO and route; patterns list, feedback and day-label DTOs and routes. App-lane announcement first (additive-only rule). | #1399 P1 | `contracts/src/app/health-ingest.ts` (or a new `health-patterns.ts`) |
| Q2 | Migrations: new tables `health_daily_aggregates`, `health_profile`, `health_patterns`, `health_day_labels`. RPCs `health_daily_read`, `health_patterns_write`/`_read`/`_feedback`, `health_day_label_write`. `health_ingest` gains the rollup and routes daily samples older than 90 days to aggregates instead of ignoring them. The deletion paths in §4.4, with a pgTAP test per path and per table. | Q1; #1399 P2 | `supabase/migrations/*`, registry, pgTAP |
| Q3 | Scores: `scores/baseline.ts`; recovery v3, sleep need v1, debt v2, weight v5. Producer reads aggregates and the profile, and writes `baseline`. Form v6 is computed into a shadow field only. | Q2; #1399 P3 | `health/scores/*`, `health/producer.ts` (after the freshness lane's and #1399's producer changes) |
| Q4 | Owner DO wiring: tasks and messages counts beside calendar busy minutes | Q3 | `health/calendar-demand.ts` neighbour, owner-DO hunk |
| Q5 | Agent feed: `HealthPlanningContext` fields in `toContextHealthMaterial`, the version mislabel fix, `get_health_pattern`, `health_pattern_feedback`; `resolveHealthMode` reads `baseline.state` | Q3 | `channels/health-context.ts`, `health/trigger.ts`. Both are other lanes' files; done with those lanes' agreement. |
| Q6 | Pattern job: `health/patterns/*` (pure) plus the owner-DO schedule entry | Q2, Q3 | new files |
| Q7 | Form v6 switch from shadow to live, if the §7.3 bar holds | 4 weeks of Q3 | `scores/form.ts` |
| App lane | Backfill reader, profile questions, the provisional copy, the patterns view, the felt rating | Q1 | waldo-app |

**Coordination:**
- The Apple Watch lane builds #1399's accepted items now. Q1–Q3 stack on its P1–P3 and never edit its open files.
- The Android lane's Health Connect reader is where the history permission (§4.1) and the onboarding age and sex questions land. That is the app lane's work, announced through Q1.

## 10. Falsifiers: the first red tests

**Q1 (contract):**
- A health=N-1 client's `/scores` never contains `baseline`.
- A provisional pillar served to it is `unavailable` / `baseline_immature`.
- A `daily_aggregate` sample with a day inside the last 90 days is refused, because raw samples carry those days.

**Q2 (SQL):**
- A sample older than 90 days lands in aggregates and not in samples. Today it is silently ignored.
- Per-source withdrawal deletes that source's aggregates and all patterns.
- `delete_owner` leaves no row in any new table, even with the cascade disabled in the test.
- The sweep deletes aggregates older than 733 days.
- A pattern row with `support_n` below its kind's minimum is refused.

**Q3 (scores):**
- n = 0 gives the prior centre.
- RHR with n = 3 puts at least 95 % weight on the owner (k ≈ 0.15).
- An SDNN night never reads an RMSSD prior.
- A backfilled owner with 14 mature days is `personal` on day 1.
- A short sleeper at 6 h a night for 30 nights has non-zero debt under need v1, and about zero under v1's own-average need. This is the regression the change fixes.
- Weight with only physical load is available at coverage 0.2.
- The sleep-debt surplus credit never takes debt below 0.

**Q6 (patterns):**
- S11's null scenario stays within the FDR bound.
- A dismissed pattern isn't re-proposed within 90 days.
- No pattern on fewer days than its minimum.

## 11. Not verified, and open questions

**Not observed:**
- No device, staging or production run supports any statement here about how these scores behave on real owners.
- The staging database wasn't inspected.
- The SAFTE term, the shrinkage constants and the debt credit have only been reasoned about. §7 is how they get tested.

**UNCONFIRMED in primary sources:**
- WHOOP's Recovery baseline length.
- Samsung's Energy Score window and missing-data rule.
- Fitbit's rolling Readiness window after the first 7 nights.
- Garmin's chronic-load window and Body Battery formula.
- Apple's SDNN measurement window.
- A general-population figure for night-to-night ln RMSSD spread.
- The published (not preprint) Natarajan tables.
- A Health Connect equivalent of HealthKit's date of birth.
- Numeric Health Connect read quotas.
- SAFTE's mapping from habitual sleep timing to its phase p. §3.3 uses an inference from the paper's example.

**Open for legal:**
- WHOOP terms §4 ("permanent copies"; testing an AI system).
- Oura's agreement §3(m) and §4 (retention, use with AI models).
- Whether the privacy notice draft must name daily aggregates and patterns. [inference: yes, as new categories of processing]

## 12. Sources

All accessed 23 October 2026. "Fetcher" means the page was read through a summarising fetch tool rather than as raw text.

**WHOOP:**
- [V1] Respiratory rate and Recovery (podcast 84 write-up), whoop.com/us/en/thelocker/podcast-84-recovery-update/
- [V2] How WHOOP Recovery works (podcast 40 write-up), whoop.com/us/en/thelocker/podcast-40-whoop-recovery-maximize-readiness/
- [V3] Developer docs, WHOOP 101, developer.whoop.com/docs/whoop-101/
- [V4] Developer docs, Recovery, developer.whoop.com/docs/developing/user-data/recovery/
- [V5] How does WHOOP Strain work?, whoop.com/us/en/thelocker/how-does-whoop-strain-work-101/
- [V6] How much sleep do you need (Sleep Planner), whoop.com/us/en/thelocker/how-much-sleep-do-i-need/ (keyword-filtered read)
- [V7] Sleep debt explained, whoop.com/us/en/thelocker/what-is-sleep-debt-catch-up/
- [V8] Introducing Stress Monitor, whoop.com/us/en/thelocker/introducing-stress-monitor-a-new-way-to-monitor-manage-stress/
- [V9] Four sleep metrics (podcast 383 write-up), whoop.com/us/en/thelocker/sleep-capodilupo-whoop-metrics-rested/

The WHOOP support site is login-gated and wasn't read.

**Oura** (support.ouraring.com/hc/en-us/articles/…):
- [V10] Readiness Contributors, 360057791533 (re-read by hand)
- [V11] How Your Readiness Score is Determined, 360025589793
- [V12] Set Up an Oura Ring, 4411128662291
- [V13] Troubleshooting Gaps in Sleep Data, 39695406607507
- [V14] Sleep Score, 360025445574
- [V15] Activity Contributors, 360055901214
- [V16] Sleep Contributors, 360057792293
- [V17] Daytime Stress, 21205822135315
- [V18] Oura, Innovating Health white paper v3 (2024), PDF (partial)
- [V19] Resilience, 25358829055251
- [V20] Cumulative Stress, 45979919957395

**Garmin and Firstbeat:**
- [V21] Garmin manual, Heart Rate Variability Status, www8.garmin.com/manuals/webhelp/GUID-0F89E6A5-…/GUID-9282196F-…
- [V22] Garmin blog, What is HRV? (HRV Status), garmin.com/en-SG/blog/general/heart-rate-variability-hrv/
- [V23] Garmin manual, Training Readiness, www8.garmin.com/manuals/webhelp/GUID-31D23DBB-…/GUID-C21BE0C8-…
- [V24] Garmin Forerunner 965 manual, Training Status, www8.garmin.com/manuals-apac/webhelp/forerunner965/…/GUID-8224236E-…; plus the blog post "Training Status and how to use it"
- [V25] Garmin blog, How Garmin calculates sleep score, garmin.com/en-US/blog/?p=34517
- [V26] Garmin manual, Sleep Tracking (vivoactive 6), …/GUID-70D41BFB-…
- [V27] Garmin manual, HRV and Stress Level, …/legacy/EN-US/GUID-9282196F-…
- [V28] Garmin blog, Body Battery, garmin.com/en-MY/blog/?p=166
- [V29] Garmin manual, Body Battery (vivoactive 6), …/GUID-87E1392B-…
- [V30] Firstbeat, Stress and Recovery Analysis Method Based on 24-hour HRV (2014), firstbeat.com/wp-content/uploads/2015/10/Stress-and-recovery_white-paper_20145.pdf
- [V31] Firstbeat, A Sleep Analysis Method Based on HRV (2019), PDF (partial)
- [V33] Firstbeat white-paper index, firstbeat.com/en/science-and-physiology/white-papers-and-publications/

support.garmin.com returned 403.

**Apple:**
- [V34] Apple Support 120142, Track your overnight and daytime vitals
- [V35] Apple Support 128112, Understand your readiness score
- [V36] Apple Watch User Guide, Use the Readiness app
- [V37] Apple Newsroom, September 2026 health and fitness (Recovery HRV)
- [V38] Apple Newsroom, June 2024, watchOS 11 health and fitness insights
- [V39] Apple Watch User Guide, Track your training load
- [V40] Apple Watch User Guide, View your sleep score
- [V41] Apple Support 108906, Track your sleep on Apple Watch

**Samsung:**
- [V42] Samsung Newsroom, 27 June 2024, Samsung and University of Georgia on Energy Score (read raw)
- [V43] Samsung US support ANS10003272, Galaxy AI features on Watch7/Ultra (fetcher)
- [V44] Samsung US support ANS10013280, Track your Vitals (fetcher)
- [V45] Samsung Health app page (NZ) (partial)
- [V46] Samsung US support ANS10001394, Measure your stress level (fetcher)
- [V47] Samsung AU support, Monitoring your sleep (fetcher)

**Fitbit and Google** (support.google.com/fitbit/answer/…, all via the fetcher):
- [V48] Cardio Load and Target Load, 15402655
- [V49] Readiness score, 14236710
- [V50] Track your vitals, 14236917
- [V51] Sleep Score, 14236513
- [V52] Stress, Resilience and Body Responses, 14237928
- [V53] Morning Brief, 15344549

**Platforms and terms:**
- [V54] HealthKit, `HKAnchoredObjectQuery`
- [V55] HealthKit, `HKStatisticsCollectionQuery`
- [V56] HealthKit, `getEarliestAuthorizedSampleDate(for:completion:)` and Authorizing access to health data (iOS 27)
- [V57] HealthKit, Protecting user privacy (encrypted when locked)
- [V58] Health Connect, Read raw data (30-day rule, paging)
- [V59] Health Connect, Aggregate data
- [V60] Health Connect, `HealthPermission` / `HealthConnectFeatures` (history and background permissions)
- [V61] Health Connect, Plan to avoid rate limiting
- [V62] Samsung Health Data SDK overview and data types (no HRV type; Energy Score type)
- [V63] WHOOP API v2 reference, pagination and rate limits
- [V64] Oura API v2 OpenAPI 1.42
- [V65] WHOOP API Terms of Use
- [V66] Oura API and MCP Agreement (effective 8 June 2026)
- [V67] GDPR (EUR-Lex 32016R0679), Art. 5(1)(c), (e) and Art. 9
- [V68] HealthKit, `HKCharacteristicTypeIdentifier.dateOfBirth` and `.biologicalSex` (iOS 8.0), re-read by hand

**Papers:**
- [P-Natarajan 2019] Natarajan A, Pantelopoulos A, Emir-Farinas H, Natarajan P. Heart rate variability with photoplethysmography in 8 million individuals. bioRxiv 10.1101/772285 v1, Table S2 and scaling table, re-read by hand. Published as Lancet Digit Health 2020;2:e650–7; the published tables returned 403.
- [P-Quer 2020] Quer G et al. Inter- and intraindividual variability in daily resting heart rate… PLoS One 15(2):e0227709. doi:10.1371/journal.pone.0227709. Full text, re-read by hand.
- [P-Gelman BDA3] Gelman A et al. Bayesian Data Analysis, 3rd ed., §2.5 eq. 2.12 (normal with known variance) and §2.6 (scaled inverse-χ² for the variance). PDF text, re-read by hand.
- [P-Voss 2015] Voss A et al. Short-term HRV: influence of gender and age. PLoS One 10:e0118308. Full text, tables.
- [P-Shaffer 2017] Shaffer F, Ginsberg JP. An overview of HRV metrics and norms. Front Public Health 5:258. Full text.
- [P-Munoz 2015] Munoz ML et al. Validity of (ultra-)short recordings for HRV measurements. PLoS One 10:e0138921. Abstract.
- [P-Buchheit 2014] Buchheit M. Monitoring training status with HR measures. Front Physiol 5:73. Full text.
- [P-Hernando 2018] Hernando D et al. Validation of the Apple Watch for HRV measurements… Sensors 18:2619. Full text.
- [P-Apple SDNN doc] Apple, `HKQuantityTypeIdentifier.heartRateVariabilitySDNN`
- [P-Watson 2015] Watson NF et al. Recommended amount of sleep for a healthy adult (AASM/SRS). J Clin Sleep Med 11:591–2. Full text.
- [P-Hirshkowitz 2015] Hirshkowitz M et al. NSF sleep duration recommendations. Sleep Health 1:40–3. Abstract.
- [P-Kitamura 2016] Kitamura S et al. Estimating individual optimal sleep duration and potential sleep debt. Sci Rep 6:35812. Full text.
- [P-Van Dongen 2003] The cumulative cost of additional wakefulness. Sleep 26:117–26. Abstract.
- [P-Belenky 2003] Patterns of performance degradation and restoration during sleep restriction and recovery. J Sleep Res 12:1–12. Abstract.
- [P-Banks 2010] Neurobehavioral dynamics following chronic sleep restriction. Sleep 33:1013–26. Abstract.
- [P-Roenneberg 2019] Roenneberg T et al. Chronotype and social jetlag: a (self-)critical review. Biology 8:54. Full text, formula section.
- [P-Hursh 2004] Hursh SR et al. Fatigue models for applied research in warfighting. Aviat Space Environ Med 75(3 Suppl):A44–53. Full text (pre-publication proof).
- [P-Hursh 2017] Hursh SR, Balkin TJ, Van Dongen HPA. Sleep and performance prediction modeling. Principles and Practice of Sleep Medicine, 6th ed., ch. 72. Full text.
- [P-Akerstedt 2004] Åkerstedt T, Folkard S, Portin C. Predictions from the three-process model of alertness. Aviat Space Environ Med 75(3 Suppl):A75–83. Full text.
- [P-Skeldon 2025] Skeldon AC, Dijk D-J. The two-process model from a mathematical perspective. npj Biol Timing Sleep. Full text (χ_w 18.2 h, χ_s 4.2 h).
- [P-Martin & Eastman 2002] Sleep logs of young adults predict DLMO. Chronobiol Int. Abstract.
- [P-Valdez 2019] Valdez P. Circadian rhythms in attention. Yale J Biol Med. Full text.
- [P-Bellenger 2021] Bellenger CR et al. Wrist-based PPG assessment of HR and HRV: validation of WHOOP. Sensors. Full text via fetcher.
- [P-Altini 2021] Altini M, Kinnunen H. The promise of sleep. Sensors 21:4302. Abstract.

The research notes behind this section (one file per pass, each with what it opened and its gaps) were working files for this session. They aren't committed, because they carry long excerpts. Any claim can be re-checked against the URLs above.
