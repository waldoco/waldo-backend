# Tiered Form: evidence base and design proposal

Date: 28 Nov 2026. Branch base: `beta-mvp` at `d9c13a6b7`. Tracking: Linear HEY-517 (parent cluster HEY-262). Linear needs `/mcp` authorisation in this session, so neither issue was read here.

Research only. No code, switch or migration is changed by this document. Every number in an example is synthetic.

**Status of this text:** candidate. It informs a later ADR-0081 amendment; it accepts nothing. Where it says "recommend", that is a proposal for the owner to rule.

## How to read the source markers

The markers match the 27 Nov evidence brief in the shared notes folder, so the two documents agree.

- **[O]** opened and read: the abstract record or official page was read in this research pass. PubMed and PMC blocked automated reads behind cookie walls, so [O] here means an abstract (mostly through Europe PMC) or a vendor page. **No full text was read for this document.**
- **[S]** snippet only: the citation and figure came from a search result or a secondary page. The paper itself was not opened.
- **[M]** from memory, unverified. Check before quoting.

Evidence grades follow the `health-protocols` skill (`packages/runtime/src/skills/bundled-text.ts`):

- **A**: several large studies or a meta-analysis agree.
- **B**: one good study, or reviews disagree.
- **C**: small, vendor-funded, or inference.
- **D**: speculative or contradicted.

A vendor page is evidence of what a vendor says it does. It is never evidence that the method works.

---

## 0. The answer in brief

1. **Today's Form has no evidence behind its weights.**
   - The runtime shares (`form.ts:10`, `recovery.ts:20`) and the weights ADR-0011 calls SAFTE-FAST-derived (`CRS_FORM_WEIGHTS`) are both uncited.
   - Neither contains a two-process or SAFTE term.
   - Daylight and movement above usual lower the score, which is the wrong direction for daylight (section 1).
2. **The literature does not supply weights for a composite readiness number, and no vendor publishes theirs.** What it does support:
   - **Directions of effect:** short or irregular sleep, building sleep debt, raised resting HR and lowered rolling HRV against the person's own baseline, alcohol, late caffeine.
   - **The rough shape of a waking day at group level:** sleep inertia, then a rise, a post-lunch dip, and later physical peaks.
   - **The value of a one-tap self-report:** subjective measures respond to training load more sensitively than objective ones (Saw 2016).
   - **One known failure of self-report:** people under chronic sleep restriction stop noticing their decline (Van Dongen 2003).
3. **Recommended design (C, section 4.3).** Form is a deterministic number built from four things, scored at the moment and forecast to bedtime:
   - the body (Recovery and the daytime state);
   - the time-of-day structure the two-process model predicts, anchored on the person's own sleep timing;
   - what the day has actually taken so far;
   - the person's own feel tap.

   **What the day still asks (Weight, by the hour) is a separate tier-2 series drawn beside Form.** It never lowers Form before it happens, and the model weighs the two. Weights start equal (unit weighting, Dawes 1979) and are learned per person from feel taps, shrunk toward the cohort. Nothing is hand-tuned.
4. **Open questions**
   - **(a)** A heavy calendar should not lower morning Form. It should shape the day plan and the capacity window.
   - **(b)** One morning tap is enough to carry Form without a wearable and to calibrate its level over weeks. It is not enough to learn the person's daily curve. That needs an occasional second tap at a varying time.
   - **(c)** When the data and the person disagree, which side wins depends on the context. Section 5 gives the rules.
5. **The word "Weight" names two things** in the briefs: the demand pillar in code, and body mass. Body mass belongs in tier 3, outside Form (section 2.9). The owner should rule on the name (section 6.2).

---

## 1. What Form is today, and what each part rests on

Read in source at `beta-mvp` `d9c13a6b7`. No tests were run for this section. Paths are under `packages/runtime/src/health/scores/` unless they say otherwise.

### 1.1 Two Forms, and neither is the one ADR-0011 describes

| | ADR-0011 and contracts | Runtime engine on staging |
|---|---|---|
| Where | `CRS_FORM_WEIGHTS`, `packages/contracts/src/health/crs.ts:226` | `FORM_WEIGHTS`, `form.ts:10` |
| Weights | sleep 0.5, HRV 0.35, circadian 0.075, motion 0.075 | Recovery 0.4, sleep midpoint 0.1, daylight 0.1, movement 0.2, daytime stress 0.2 |
| Stated basis | "own derivation from SAFTE-FAST literature, validated on 856 days of WHOOP data from one user" (ADR-0011) | None in code. The ADR-0081 amendment of 27 Oct 2026 lists the shares as "unchanged" from `form.candidate.v8`, with no citation |
| Status | `form.safte-fast.v1` is kept only as the device-fallback name (ADR-0081 amendment of 27 Oct, §3) | `form.v10` when `HEALTH_PROVISIONAL_SCORES=1`. Staging has it on (`packages/runtime/wrangler.jsonc:406`) |

Neither version contains a SAFTE or two-process term: no sleep-pressure reservoir, no circadian oscillator, no sleep inertia. ADR-0081 defers the "SAFTE-shaped alertness term" (HI-5, second part) to a 4-week shadow, so the claim that Form is SAFTE-grounded describes an intention, not the code. One user's 856 days cannot validate weights for anyone else, and ADR-0011's own Consequences say so (it asks for at least 10 users × 30 days of paired data).

### 1.2 How the runtime Form is computed (`form.v10`)

1. **Shared statistics** (`stats.ts`, `baseline.ts`).
   - Every part is a z-score against the owner's own earlier days, clamped to ±2.5 (`stats.ts:5`).
   - It is mapped to 0–100 by `50 + 20z` when higher is better, `50 − 20z` when lower is better, or `100 − 20|z|` when nearer to usual is better (`stats.ts:34–37`).
   - The provisional engine shrinks the baseline toward a population prior where one exists: resting HR from Quer et al. 2020, ln RMSSD from Natarajan et al. 2020 (`baseline.ts:17`, `:28`). Without a prior, a part joins at 7 own days (`baseline.ts:31`).
   - This part is method, not weighting, and it rests on standard Bayesian estimation (Gelman, *BDA* 3rd ed.).
2. **Recovery** (`recovery.ts:20`) is sleep 0.5, HRV 0.3, resting HR 0.2.
   - Sleep is minutes asleep over need, × 100. Need is stated by the owner, or eight hours shrunk toward the owner's nights over 14 nights and kept within 6–10 h (`baseline.ts:93–100`).
   - HRV is read on the ln scale, higher is better. Resting HR is lower is better.
   - Inside Form, Recovery's parts are scaled by 0.4, so the night contributes sleep 0.20, HRV 0.12 and resting HR 0.08 (`form.ts:94–95`).
3. **Sleep midpoint**, weight 0.1: tonight's midpoint against the owner's circular mean, scored by nearness (`form.ts:113`). It is one night against the mean. It is not a multi-night regularity index.
4. **Daylight**, weight 0.1, and **movement** (steps when movement minutes are missing), weight 0.2.
   - Both are totals so far today, compared with the same wall-clock hours of earlier days (`form.ts:114–127`).
   - Both are scored with `nearUsual`, so a day with more daylight or movement than usual scores lower than an ordinary day.
5. **Daytime stress**, weight 0.2: mean awake, non-workout hourly HR (lower is better) and hourly HRV (higher is better) against the same hours of earlier days. It needs 8 HR hours and 4 HRV hours (`form.ts:12–14`, `:129–148`).
6. **Combination**: a weighted mean over the parts present, renormalised. `coverage` is the weight present (`stats.ts:41–45`).
   - Eligibility is Recovery plus at least one daytime part (`form.ts:169`).
   - Form goes unavailable 6 hours after the newest hour of data (`form.ts:15`).
7. **Zones**: energized ≥ 80, steady ≥ 60, flagging ≥ 40, depleted below (`zones.ts:6`). A zone holds until the score moves 5 points past it (`zones.ts:10`). The code calls these "candidate bands from the app's own readiness bands" (`zones.ts:3`).

### 1.3 Through the day: curve, forecast, windows

- **Measured curve** (`form-curve.ts:9–55`). The same Form, re-run each quarter hour since waking on the hours ended by then. It adds no model.
- **Forecast** (`form-curve.ts:58–113`).
  - Each future slot adds, to the latest measured point, the owner's mean change between the same two slots on at least 7 earlier days whose wake was within 2 h.
  - It stops at the usual sleep start. The code calls it "the owner's own day shape, and no model of one" (`:58`).
  - It does not read the calendar, today's Recovery, sleep debt, or anything planned.
  - `HEALTH_FORM_CURVE` is `"0"` in the default and staging blocks (`wrangler.jsonc:155`, `:416`). ADR-0081 limits the curve to the app's calendar day view and keeps it out of model context.
- **Energy windows** (`energy-windows.ts`).
  - Mean resting HR by hour since waking across earlier days, detrended with a straight line. Runs of 2 h or more above the line are "peaks" and runs below are "dips": up to 2 peaks and 1 dip.
  - Peaks are shortened on a mixed or compromised Recovery, or on building sleep debt (`:32–33`, `:114`).
  - The code cites "a published note" (`:8`). ADR-0081 names it: a blog note by M. Lvoff (Exoplan). Section 3 returns to this source and whether anything else supports it.
- **Weight** (`weight.ts:8–11`) is a separate demand score, not part of Form.
  - Shares: calendar minutes 0.35, open-task minutes 0.3, message count 0.15, physical load 0.2. More than usual scores heavier.
  - Its shares come from a proposal note (`docs/app/RECOVERY_WEIGHT_PROPOSAL.md`) with no citation.

### 1.4 What each part rests on

| Part | Rests on | Verdict |
|---|---|---|
| Own-baseline z-scores, shrinkage priors | Standard statistics; Quer 2020 and Natarajan 2020 for the priors | Sound method |
| Recovery shares 0.5 / 0.3 / 0.2 | No citation | Invented weights |
| Form shares 0.4 / 0.1 / 0.1 / 0.2 / 0.2 | No citation | Invented weights |
| `nearUsual` on daylight and movement | No citation; contradicts the light evidence in section 2.6 | Wrong direction for daylight; arguable for movement |
| Midpoint nearness | Direction matches the regularity literature (section 2.2); one night, weight uncited | Right idea, thin form |
| Zone cut points 80 / 60 / 40 | "the app's own readiness bands" | Convention |
| Form curve forecast | Owner's own empirical day shape | Honest but blind to the day ahead |
| Energy windows | One blog note | Below this document's bar until validated |
| Weight shares | Proposal note, no citation | Invented weights |

What exists that this design can keep: the per-owner baseline machinery, method isolation (RMSSD never against SDNN), honest unavailable states, and the destination rules in ADR-0081. What has no source: every weight, the daylight and movement direction, and the energy-window method.

---

## 2. Literature review

Four reading passes ran in parallel on 28 Nov 2026, followed by a spot check of the load-bearing citations. Each row gives the figure as reported, its source and a marker. A row with no URL was not found and is listed in section 6.1.

### 2.1 Sleep pressure and the body clock: two-process model, SAFTE and FAST

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| Sleep and alertness come from a homeostatic process (S: pressure that builds while awake and discharges in sleep) interacting with a circadian process (C) | The 2016 reappraisal keeps the structure: "a homeostatic process (Process S) interacts with a process controlled by the circadian pacemaker" | Borbély et al., *J Sleep Res* 2016, [doi:10.1111/jsr.12371](https://doi.org/10.1111/jsr.12371); original Borbély 1982, *Hum Neurobiol* 1:195–204 | [O] 2016 abstract; [M] 1982 | A (structure) |
| SAFTE models a sleep "reservoir", a circadian term and sleep inertia, and outputs "effectiveness" from sleep and wake times alone | SAFTE grew from Hursh's 1996 homeostatic model and was adopted as the base for US Department of Defense work, with extensions for time-zone travel and shift work | Hursh et al., *Aviat Space Environ Med* 2004;75(3 Suppl):A44–53, PMID [15018265](https://pubmed.ncbi.nlm.nih.gov/15018265/) | [O] record; equations [M] | B |
| SAFTE effectiveness predicts accident risk in rail crews at group level | 30-day work histories before 400 human-factors and 1,000 other accidents. Effectiveness against human-factors accident risk r = −0.93 (the reports disagree on a second coefficient, 0.71). Risk rises below an effectiveness of 70 | FRA, *Validation and calibration of a fatigue assessment tool for railroad work schedules*, DOT/FRA/ORD-06/21 and ORD-08/04, [summary](https://railroads.dot.gov/elibrary/validation-and-calibration-fatigue-assessment-tool-railroad-work-schedules-summary-report) | [S] | B (group, schedules) |
| FAST's "validation" papers include software verification, which is not outcome validation | A clone checked against FAST outputs | DTIC [ADA443545](https://apps.dtic.mil/sti/pdfs/ADA443545.pdf) | [S] | n/a |
| Chronic restriction to 6 h for 14 days produced deficits equal to up to 2 nights of total sleep loss. Sleepiness ratings barely rose after the first days, and people were "largely unaware" | n = 48, randomised to 4/6/8 h in bed. PVT lapses grew near-linearly with wake time beyond 15.84 h a day | Van Dongen et al., *Sleep* 2003;26(2):117–26, [doi:10.1093/sleep/26.2.117](https://doi.org/10.1093/sleep/26.2.117) | [O] abstract | A (lab, group) |
| Vulnerability to sleep loss differs between people, is stable within a person and is trait-like | n = 21, three 36-h deprivations. Between-person spread was large next to the effect of prior restriction | Van Dongen et al., *Sleep* 2004;27(3):423–33, [doi:10.1093/sleep/27.3.423](https://doi.org/10.1093/sleep/27.3.423) | [O] abstract | B |
| Individual prediction improves with Bayesian updating on the person's own test results | 2B-Alert: individualised PVT prediction, 21 people, 62 h awake; accuracy rose as tests accrued | PMID [30033688](https://pubmed.ncbi.nlm.nih.gov/30033688/) | [S] | C (lab only) |

**What this supports.** The *shape* of a waking day can be predicted at group level: alertness falls with time awake and with debt from earlier nights, and is modulated by the body clock. The same models need a person's own data to say anything about that person.

**What it cannot support.**
- No published validation of a two-process forecast against how people feel in daily life was found.
- The SAFTE accident validation is about work schedules, not wearable readiness.
- SAFTE's parameters are fitted to group means from laboratory restriction studies.

So "grounded in SAFTE" can honestly mean only that Form's *forecast shape* takes the two-process structure. It cannot mean that SAFTE validates any weight.

### 2.2 Sleep duration, regularity and timing

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| Adults 18–60 should sleep 7 h or more regularly; need varies between people | Consensus of 15 experts; more than 9 h may suit people recovering from sleep debt | Watson et al., *Sleep* 2015;38(6):843–4 / *JCSM* 11(6):591–2, [PMC4434546](https://pmc.ncbi.nlm.nih.gov/articles/PMC4434546/) | [S] | A (consensus) |
| Sleep regularity predicts mortality better than duration | UK Biobank, 60,977 people, accelerometer Sleep Regularity Index. Quintiles above the least regular had 20–48% lower all-cause mortality. Adding duration did not improve the model | Windred et al., *Sleep* 2024;47(1):zsad253, [doi:10.1093/sleep/zsad253](https://doi.org/10.1093/sleep/zsad253) | [O] abstract | B (observational) |
| The Sleep Regularity Index is the probability of being in the same state 24 h apart, scaled to 100 for a perfectly regular sleeper | 61 students, 30 days. SRI against grades r = 0.37. Irregular sleepers had later melatonin onset | Phillips et al., *Sci Rep* 2017;7:3216, [PMC5468315](https://pmc.ncbi.nlm.nih.gov/articles/PMC5468315/) | [S] | B (small) |
| Regular sleep timing matters for health and performance; catch-up sleep on free days may help when weekday sleep is short | NSF modified Delphi, 63 papers | Sletten et al., *Sleep Health* 2023;9(6):801–20, [doi:10.1016/j.sleh.2023.07.016](https://doi.org/10.1016/j.sleh.2023.07.016) | [O] abstract | A (consensus), B (data) |
| Social jet lag (the gap between work-day and free-day sleep timing) is linked to chronotype and poorer wellbeing | n = 501, MCTQ | Wittmann et al., *Chronobiol Int* 2006;23:497–509, PMID [16687322](https://pubmed.ncbi.nlm.nih.gov/16687322/) | [S] | B |
| Sleep inertia impairs performance after waking, more after sleep loss or at a poor body-clock time | Usually 15–60 min, longer after sleep loss [figure from a secondary source] | Hilditch & McHill, *Nat Sci Sleep* 2019;11:155–65, [PMC6710480](https://pmc.ncbi.nlm.nih.gov/articles/PMC6710480/); Tassi & Muzet, *Sleep Med Rev* 2000, [doi:10.1053/smrv.2000.0098](https://doi.org/10.1053/smrv.2000.0098) | [S]; duration [M] | B |

**What this supports for Form.**
- Sleep against need belongs in Recovery.
- Multi-night debt belongs in the forecast level.
- Regularity, a multi-night property, belongs in Recovery or the daytime state. Today's code holds only a one-night midpoint (`form.ts:113`).
- The first hour after waking should be forecast low, whatever the night was.

**What it cannot support.**
- A personal sleep need taken from the population figure. Need must be the person's stated need, or learned from their nights.
- The claim that regularity *causes* the outcomes; the evidence is observational.

### 2.3 Heart-rate variability and resting heart rate

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| HRV norms depend on recording length, age and sex; short and 24-h norms are "not interchangeable"; users should build their own population norms | Overview | Shaffer & Ginsberg, *Front Public Health* 2017;5:258, [doi:10.3389/fpubh.2017.00258](https://doi.org/10.3389/fpubh.2017.00258) | [O] abstract | B |
| Day-to-day variation of ln RMSSD is large | Typical CV about 3–13% across studies; smallest worthwhile change reported around 2.4–3% in team-sport samples | Review and WHOOP water-polo study via [PMC9505647](https://pmc.ncbi.nlm.nih.gov/articles/PMC9505647/); [AIS HRV best-practice guide](https://www.ais.gov.au/__data/assets/pdf_file/0013/1130260/HRV-BPG_FINAL.pdf) | [S] | B |
| Read HRV as a 7-day rolling average and its variation, not a single day | 2 elite triathletes, 77 days: the 7-day rolling ln RMSSD and its CV tracked one athlete into non-functional overreaching (case study) | Plews et al., *Eur J Appl Physiol* 2012, [doi:10.1007/s00421-012-2354-4](https://doi.org/10.1007/s00421-012-2354-4); Plews et al., *Sports Med* 2013, [doi:10.1007/s40279-013-0071-8](https://doi.org/10.1007/s40279-013-0071-8) | [O] abstracts | C (n = 2), B (method consensus) |
| Judge changes against measurement error and the smallest important change, in training context; HR measures cannot capture all fatigue | Review | Buchheit, *Front Physiol* 2014;5:73, [doi:10.3389/fphys.2014.00073](https://doi.org/10.3389/fphys.2014.00073) | [O] abstract | B |
| HRV can *rise* in functional overreaching | 21 triathletes, 3-week overload, performance down about 9%: weekly-averaged ln RMSSD rose more than in controls | Le Meur et al., *Med Sci Sports Exerc* 2013;45:2061–71, [doi:10.1249/mss.0b013e3182980125](https://doi.org/10.1249/mss.0b013e3182980125) | [O] abstract | B |
| Meta-analysis: weekly-averaged HRV is higher in overreached athletes; resting single values show no difference | Weekly-averaged SMD 0.81 (95% CI 0.35–1.26); resting vagal SMD −0.01 | Manresa-Rocamora et al., *Scand J Med Sci Sports* 2021;31:1164–82, [doi:10.1111/sms.13932](https://doi.org/10.1111/sms.13932) | [O] abstract | B |
| Autonomic markers and training status: HR recovery and post-exercise HRV rise with both improvement and overreaching; HR acceleration is a candidate fatigue marker | 27 studies in review, 24 in meta-analysis | Bellenger et al., *Sports Med* 2016;46:1461–86, [doi:10.1007/s40279-016-0484-2](https://doi.org/10.1007/s40279-016-0484-2) | [O] abstract | B |
| Nightly RMSSD and HR from a ring agree well with ECG; error varies widely by device | Oura: n = 35, high correlation, per-night averages better than 5-min epochs. Stone 2021 (5 adults, 148 trials): Oura RMSSD MAPE 6.84%, a camera app 112% | Cao et al., *JMIR* 2022, [doi:10.2196/27487](https://doi.org/10.2196/27487); Stone et al., *Front Sports Act Living* 2021, [doi:10.3389/fspor.2021.585870](https://doi.org/10.3389/fspor.2021.585870) | [O] abstracts | B (healthy adults) |
| Each extra 10 bpm of resting HR goes with about 9% higher mortality across populations | 46 studies, RR 1.09 | Zhang et al., *CMAJ* 2016, PMID [26598376](https://pubmed.ncbi.nlm.nih.gov/26598376/) (from the 27 Nov brief) | [S] | B (between people, not day to day) |
| Alcohol dose-dependently lowers parasympathetic activity in the first hours of sleep | 4,098 employees, real-world recordings, self-reported dose | Pietilä et al., *JMIR Ment Health* 2018;5:e23, [doi:10.2196/mental.9519](https://doi.org/10.2196/mental.9519) | [S] | B (observational) |
| Daily workplace conflict predicts lower same-night HF-HRV | Diary study | [PMC9517418](https://pmc.ncbi.nlm.nih.gov/articles/PMC9517418/) (authors not captured) | [S] | C |

**What this supports.**
- Overnight RMSSD (ln scale) and resting HR read against the person's own baseline belong in Recovery. Today's code does this, with method isolation.
- The signal is the **trend** (a rolling average against baseline), not one night.

**What it cannot support.**
- A single-night HRV dip as a reason to change the day.
- "Higher HRV is always better" for someone in a hard training block (Le Meur).
- Any comparison between people.

**How it fails.**
- Missing nights: the rolling average thins; require a minimum of nights in the window.
- Device change: baselines are per source and per method; ADR-0011 already rules this.
- Alcohol, illness, heat and the luteal phase move the same signals. ADR-0085 handles the cycle phase; the model must be told the rest are possible confounds.

### 2.4 Training load

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| No evidence supports the acute:chronic workload ratio for load management or injury-risk advice | "inaccurate, noisy", creates statistical artefacts; its link with injury is not consistent | Impellizzeri et al., *IJSPP* 2020;15:907–13, [doi:10.1123/ijspp.2019-0864](https://doi.org/10.1123/ijspp.2019-0864) | [O] abstract | A (against) |
| Load measures cannot show whether a load change raises or lowers injury risk; adjust to individual responses | Ten methodological concerns | Impellizzeri et al., *J Athl Train* 2020 Part 2, [doi:10.4085/1062-6050-501-19](https://doi.org/10.4085/1062-6050-501-19); Part 1, [doi:10.4085/1062-6050-500-19](https://doi.org/10.4085/1062-6050-500-19) | [O] abstracts | A |
| A counter-view: mathematical coupling matters little in practice | Coupled and uncoupled ratios very highly correlated | Coyne et al., *IJSPP* 2019, [doi:10.1123/ijspp.2018-0874](https://doi.org/10.1123/ijspp.2018-0874) | [O] abstract | B |
| The Banister fitness-fatigue model fits a season well, but its parameters are unstable and correlated | 9 elite swimmers, R² = 0.79. Confidence intervals of the useful parameters were wide; correlated parameters made interpretation "worthless" | Hellard et al., *J Sports Sci* 2006;24:509–20, [doi:10.1080/02640410500244697](https://doi.org/10.1080/02640410500244697) | [S] | B |
| No single marker diagnoses overtraining; diagnosis is by exclusion | ECSS/ACSM consensus | Meeusen et al., *Med Sci Sports Exerc* 2013;45:186–205, [doi:10.1249/MSS.0b013e318279a10a](https://doi.org/10.1249/MSS.0b013e318279a10a) | [O] abstract | A |
| Many "overtraining" cases involve low energy or carbohydrate availability | 18 of 21 studies | *Sports Med* 2021, [doi:10.1007/s40279-021-01491-0](https://doi.org/10.1007/s40279-021-01491-0) | [O] abstract | C (narrative) |
| HRV-guided training improves vagal HRV but not performance significantly | VO2max SMD 0.20 (−0.07 to 0.47); endurance performance 0.20 (−0.09 to 0.48) | Manresa-Rocamora et al., *IJERPH* 2021, [doi:10.3390/ijerph181910299](https://doi.org/10.3390/ijerph181910299) | [O] abstract | B |

**What this supports.**
- A *description* of this week against the person's usual. The current `training-load.candidate.v1` phrase does this, with uncoupled windows (ADR-0081 amendment of 31 Oct).
- Realised training load as something that has happened to the body today.

**What it cannot support.**
- Any risk band, "sweet spot" or ratio threshold.
- A fitness-fatigue forecast of individual performance.

For the gym cohort, the model should see the load phrase and the HRV trend together, because each is ambiguous alone (Le Meur).

### 2.5 Body clock, chronotype and peak windows

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| Cognition varies with time of day, and the size differs by task | Review | Schmidt et al., *Cogn Neuropsychol* 2007;24:755–89 | [S] | B (group) |
| Synchrony effect: performance is better when the task time matches the person's preferred time | Origin traced to Hasher, Goldstein & May 2005. Early studies used clock time and ignored each person's sleep schedule | Hasher et al. 2005 (chapter) | [S] | B (group), C (individual) |
| Late chronotypes show different brain connectivity and slower morning reaction time | n = 38 | Facer-Childs et al., *Sleep* 2019;42(5), [doi:10.1093/sleep/zsz033](https://doi.org/10.1093/sleep/zsz033) | [S] | C |
| Physical performance shows diurnal variation, mostly higher in late afternoon or early evening | Pooled effects: endurance 0.23, Wingate 0.73, handgrip 0.39, jump 0.79. The paper behind these figures was not confirmed | Unconfirmed 2023 meta-analysis, [PMC10308487](https://pmc.ncbi.nlm.nih.gov/articles/PMC10308487/) | [S] | B (group) |
| Training at one time of day may shift performance toward that time; risk of bias high | Review | Bruggisser et al., *Sports Med Open* 2023, [PMC10198889](https://pmc.ncbi.nlm.nih.gov/articles/PMC10198889/) | [S] | C |
| The afternoon dip occurs without lunch and is worse after a heavy carbohydrate meal | Review | Monk, *Clin Sports Med* 2005, PMID [15892914](https://pubmed.ncbi.nlm.nih.gov/15892914/) | [S] | C |
| Most people have one or two high-capacity windows, and they differ by person | Already in the `health-protocols` skill | Chauhan 2025 (as cited in the skill) | [M] in this pass | B (per the skill) |

**What this supports.**
- A **prior** for where windows usually fall: low just after waking, a late-morning high, an afternoon dip, and physical capacity later than cognitive.
- Anchoring that prior on the person's own sleep timing rather than on clock time.

**What it cannot support.**
- A personal window from the group curve alone.
- The existing HR-based energy-window method as a measure of *capacity*. Its source is one blog note. That note's own stated limit is that "stress reads as energy", since a raised resting HR can mean arousal as well as alertness ([Exoplan note](https://mikelvoff.com/notes/exoplan-energy-algorithm), [O]). No peer-reviewed validation was found.

**Cognitive and physical windows differ.** Treat them as two windows, not one.

### 2.6 Light

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| Light shifts the clock by time of day, with no long insensitive "dead zone" during the day | Human phase response curve | Khalsa et al., *J Physiol* 2003;549:945–52, PMID [12717008](https://pubmed.ncbi.nlm.nih.gov/12717008/) | [S] | A |
| Room light before bed suppresses melatonin onset and shortens melatonin duration | n = 116; light under 200 lux vs dim light under 3 lux; duration shortened by about 90 min | Gooley et al., *JCEM* 2011;96:E463, [doi:10.1210/jc.2010-2098](https://doi.org/10.1210/jc.2010-2098) | [S] | B |
| Brighter white light raises subjective alertness in most studies, but many find no effect; few reaction-time effects | 68 studies; funded largely by Philips Lighting | Souman et al., *Behav Brain Res* 2018;337:228–39, [repository](https://repository.tilburguniversity.edu/items/a28715a0-0b8b-4df3-9e95-ad4246666564) | [S] | C |
| More daytime outdoor light goes with better mood and sleep | UK Biobank, self-reported | Burns et al., *J Affect Disord* 2021, [PMC8892387](https://pmc.ncbi.nlm.nih.gov/articles/PMC8892387) (from the 27 Nov brief) | [S] | B (association) |

**What this supports.**
- Daylight earlier in the day is neutral to good for alertness now and for sleep tonight.
- Bright light late in the evening is a risk to tonight's sleep, not to Form right now.

No source was found in which more daylight than usual makes a person less able that day. The `nearUsual` scoring of daylight (`form.ts:117`) therefore has no support and should be replaced: daylight contributes in a good direction during the day, and evening light moves the forecast for *tomorrow's* Recovery, not today's Form.

### 2.7 Cognitive load, meetings and time-on-task

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| More meetings that day go with more daily fatigue and subjective workload | One-week diary, hierarchical models | Luong & Rogelberg, *Group Dynamics* 2005;9:58–67, [PDF](https://interruptions.net/literature/Luong-GDTRP05.pdf) | [S] | B (self-report) |
| Back-to-back video meetings raise an EEG stress marker; 10-minute breaks reset it | n = 14, vendor study, not peer-reviewed | Microsoft Human Factors Lab 2021, [WorkLab](https://www.microsoft.com/en-us/worklab/work-trend-index/brain-research) | [S] | D |
| Mental fatigue lowers endurance performance through perceived effort, not physiology | Marcora 2009: n = 16, time to exhaustion 640 vs 754 s. Brown meta-analysis: 73 studies, g = −0.38. After a robust Bayesian publication-bias adjustment, the evidence is inconclusive | Marcora et al., *J Appl Physiol* 2009, [doi:10.1152/japplphysiol.91324.2008](https://doi.org/10.1152/japplphysiol.91324.2008); Brown et al., *Sports Med*, [doi:10.1007/s40279-019-01204-8](https://doi.org/10.1007/s40279-019-01204-8); Holgado et al., *Sports Med* 2023, [doi:10.1007/s40279-023-01926-w](https://doi.org/10.1007/s40279-023-01926-w) | [S] | C (fragile) |
| Ego depletion is near zero in large replications | 23 labs, N = 2,141, d = 0.04; 36 labs, N = 3,531, confirmatory d = 0.06 | Hagger et al., *Perspect Psychol Sci* 2016; Vohs et al., *Psychol Sci* 2021, PMID [34520296](https://pubmed.ncbi.nlm.nih.gov/34520296/) | [S] | A (against) |
| A single bout of exercise gives a small, short cognitive lift | Overall g = 0.097 (n = 1,034 in the abstract); duration, intensity and fitness moderate it | Chang et al., *Brain Res* 2012;1453:87–101, PMID [22480735](https://pubmed.ncbi.nlm.nih.gov/22480735/) | [S] | B (small) |
| Micro-breaks raise vigour and lower fatigue, with no significant overall performance gain | 22 samples, N = 2,335: vigour d = 0.36, fatigue d = 0.35, performance d = 0.16 (p = 0.116) | Albulescu et al., *PLoS One* 2022, [doi:10.1371/journal.pone.0272460](https://doi.org/10.1371/journal.pone.0272460) | [S] | B |
| Recovery from work needs psychological detachment, relaxation, mastery and control | Recovery Experience Questionnaire, N = 930 | Sonnentag & Fritz, *J Occup Health Psychol* 2007, [doi:10.1037/1076-8998.12.3.204](https://doi.org/10.1037/1076-8998.12.3.204) | [S] | B |

**What this supports.**
- Realised meeting load and sustained work go with feeling more tired, so a run of meetings that *has happened* may lower the felt part of Form.
- Breaks restore the feeling more than the performance.

**What it cannot support.**
- A per-meeting "drain" constant: no paper gives one.
- "Decision fatigue" as a mechanism.
- Any claim that cognitive load lowers physiology. In Marcora's study HR was unaffected.

Any drain rate from meetings would have to be learned per person from feel taps. Until then it is invented.

### 2.8 Caffeine, alcohol, food and fluid

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| About 40–300 mg caffeine improves alertness, vigilance and reaction time; repeated doses help sleep-restricted workers | Review | McLellan, Caldwell & Lieberman, *Neurosci Biobehav Rev* 2016;71:294–312, [doi:10.1016/j.neubiorev.2016.09.001](https://doi.org/10.1016/j.neubiorev.2016.09.001) | [S] | A |
| Caffeine shortens later sleep | 24 studies: total sleep −45 min, efficiency −7%. Authors suggest coffee at least 8.8 h before bed | Gardiner et al., *Sleep Med Rev* 2023;69:101764, PMID [36870101](https://pubmed.ncbi.nlm.nih.gov/36870101/) | [S] | A− |
| 400 mg caffeine 6 h before bed cut sleep by more than an hour, unnoticed | n = 12 | Drake et al., *JCSM* 2013, [PMC3805807](https://pmc.ncbi.nlm.nih.gov/articles/PMC3805807) | [S] | B− |
| 3–6 mg/kg caffeine reliably helps endurance performance | ISSN position stand | Guest et al., *JISSN* 2021;18:1, [doi:10.1186/s12970-020-00383-4](https://doi.org/10.1186/s12970-020-00383-4) | [S] | A |
| Alcohol consolidates the first half of the night and disrupts the second | 20 lab studies | Ebrahim et al., *Alcohol Clin Exp Res* 2013;37:539–49, PMID [23347102](https://pubmed.ncbi.nlm.nih.gov/23347102/) | [S] | B |
| Breakfast gives adults a small memory benefit; attention and executive results are equivocal | 38 acute studies | *Adv Nutr* 2016, PMID [27184286](https://pubmed.ncbi.nlm.nih.gov/27184286/) | [S] | C |
| Late isocaloric eating raises hunger and lowers energy expenditure | Small crossover | Vujović et al., *Cell Metab* 2022, [doi:10.1016/j.cmet.2022.09.007](https://doi.org/10.1016/j.cmet.2022.09.007) | [S] | C |
| Dehydration impairs cognition slightly, mostly above 2% body-mass loss and in heat or exercise settings | 33 studies, ES −0.21 (−0.31 to −0.11) | Wittbrodt & Millard-Stafford, *Med Sci Sports Exerc* 2018;50:2360 | [S] | B− |

**What this supports.**
- Caffeine and alcohol are **explanations** the model can offer: "a late coffee may cost tonight", "drinks last night show in the night's recovery".
- Caffeine masks sleepiness now while costing tonight, so it is a reason a feel tap may run ahead of the body.

**What it cannot support.**
- Meal timing as a Form input.
- Hydration as a desk-day input.

None of these is a Form weight. They are tier-3 context the person logs or says, used by the model.

### 2.9 Body mass trend

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| Body mass fluctuates weekly: higher after weekends, falling through the week | 80 adults, 4,657 weigh-ins | Orsama et al., *Obes Facts* 2014;7:36–47, [doi:10.1159/000356147](https://doi.org/10.1159/000356147) | [S] | B |
| Weekly fluctuation about 0.35%, Christmas rise about 1.35% | Smart-scale data, about 1,000–1,400 people per analysis | Turicchi et al., *PLoS One* 2020, [doi:10.1371/journal.pone.0232152](https://doi.org/10.1371/journal.pone.0232152) | [S] | B |
| Regular self-weighing goes with more weight loss and no psychological harm | Review | *Obesity* 2015, PMID [25521523](https://pubmed.ncbi.nlm.nih.gov/25521523/) | [S] | B |
| Energy availability cannot be measured accurately in the field; low energy availability (REDs) is diagnosed from symptoms and exclusion | IOC consensus 2023 and a 2024 critique | Mountjoy et al., *BJSM* 2023, [doi:10.1136/bjsports-2023-106994](https://doi.org/10.1136/bjsports-2023-106994) | [S] | A (consensus) |
| Acute loss above about 2% of body mass marks fluid deficit that impairs performance | ACSM position stand | Sawka et al., *Med Sci Sports Exerc* 2007 | [M] | A (if confirmed) |

**What body mass can tell Waldo.**
- A weeks-long trend, relevant to a stated body-composition goal.
- Around a training session, a crude fluid-loss estimate.

**What it cannot tell Waldo.**
- Today's readiness.
- Recovery.
- Low energy availability, which can happen with stable weight. A falling weight during a hard block is a reason to ask, not a finding.

Daily noise is of the same order as a week's real change, so a day-to-day move means nothing.

**Tier:** 3, context only, outside Form. This matches the owner's direction that a weight rise is not good news (memory, 14 Nov). It also keeps the "Weight" name free for the demand pillar, or argues for renaming one of the two.

### 2.10 Self-report against wearable readiness

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| Subjective wellbeing measures track acute and chronic training load more sensitively and consistently than objective measures, and the two generally do not correlate | 56 studies. Subjective wellbeing worsened with load increases and improved with load decreases | Saw, Main & Gastin, *BJSM* 2016;50:281–91, [PMC4789708](https://pmc.ncbi.nlm.nih.gov/articles/PMC4789708) | [O] abstract | B (heterogeneous studies) |
| A single momentary sleepiness rating (KSS) tracks EEG and attention lapses | Mean correlation with PVT lapses r = 0.56 | Kaida et al., *Clin Neurophysiol* 2006;117:1574–81, [doi:10.1016/j.clinph.2006.03.011](https://doi.org/10.1016/j.clinph.2006.03.011) | [S] | B |
| KSS is "about as sensitive and valid as objective measures" for sleep loss and night work | Review | Åkerstedt et al., *J Sleep Res* 2014, [doi:10.1111/jsr.12158](https://doi.org/10.1111/jsr.12158) | [S] | B |
| Under chronic restriction, self-rated sleepiness plateaus while performance keeps falling | See 2.1 | Van Dongen et al. 2003 | [O] abstract | A (lab) |
| Subjective and objective measures correlate differently person by person | 20 national-team athletes, one year: no, positive and negative correlations | *Sports Med Open* 2025, [doi:10.1186/s40798-025-00958-y](https://doi.org/10.1186/s40798-025-00958-y) | [S] | C |
| Combined subjective and HRV guidance beat a fixed plan in recreational runners | 10-km time −6.2% vs −2.9%; not a pure subjective-vs-HRV test | Nuuttila et al. 2022, via [dissertation](https://jyx.jyu.fi/bitstream/123456789/84165/1/978-951-39-9256-9_jyx.pdf) | [S] | C |
| Symptoms plus wearable data detect illness better than either alone | COVID-19 detection AUC 0.80 combined; symptoms alone 0.71; sensors alone about 0.72 (the paper's text is ambiguous on the last figure) | Quer et al., *Nat Med* 2021;27:73–7, [Scripps summary](https://www.scripps.edu/news-events/news/20201029-topol-radin-quer-detect/) | [S] | B− |
| False negative sleep feedback worsens how people feel the next day, not how they perform | n = 63 with insomnia. Evening alertness d = 0.79; PVT difference negligible | Gavriloff et al., *J Sleep Res* 2018, [doi:10.1111/jsr.12726](https://doi.org/10.1111/jsr.12726) | [S] | C |
| Some people chase tracker numbers at the cost of sleep ("orthosomnia") | 3 cases | Baron et al., *JCSM* 2017, [doi:10.5664/jcsm.6472](https://doi.org/10.5664/jcsm.6472) | [S] | D (cases) |
| Daily self-report compliance decays | About 1–2% per week over 9 weeks; careless answers rise over time | Tonkin et al., *JMIR* 2023, [PMC10337346](https://pmc.ncbi.nlm.nih.gov/articles/PMC10337346); *JMIR* 2023;25:e43826 | [S] | B |
| Composite readiness scores lack transparency and validation | 14 scores from 10 makers; formulas undisclosed; double counting (a bad night penalised once for sleep and again for its effect on HRV) | Doherty, Baldwin, Lambe, Burke & Altini, *Transl Exerc Biomed* 2025, [doi:10.1515/teb-2025-0001](https://doi.org/10.1515/teb-2025-0001) | [S] | B |
| Unit (equal) weights on standardised predictors often predict about as well as fitted weights out of sample, and better than judgment | Equal-weighted predictors of graduate performance correlated about 0.48 | Dawes, *Am Psychol* 1979;34:571–82, [PDF](https://www.cmu.edu/dietrich/sds/docs/dawes/the-robust-beauty-of-improper-linear-models-in-decision-making.pdf) | [S] | B |

**What this supports.**
- A one-tap feel rating is a valid, sensitive tier-2 input for acute state. It is likely the most sensitive single signal for training-load response.
- It can carry Form when nothing else exists.
- The tap must be taken **before** a score is shown (Gavriloff).

**What it cannot support.**
- Trusting the tap after several short nights.
- Trusting either side blindly: correlations differ by person, so the calibration must be personal.

### 2.11 Prior art: how vendors build their scores

These rows record what each vendor says it does. They are not evidence that the scores work. No peer-reviewed validation of any composite against performance or self-report was found (Doherty 2025).

| Vendor | Score | Inputs, as published | Combination, as published | Not published | Marker |
|---|---|---|---|---|---|
| WHOOP | Recovery 0–100 | Resting HR, HRV, respiratory rate, sleep, skin temperature, SpO2 | From the previous day and the night's sleep; a WHOOP podcast says HRV carries the most weight against 3/7/30-day averages | Formula, weights | [O] [developer docs](https://developer.whoop.com/docs/whoop-101/); podcast [S] |
| WHOOP | Sleep need | Sleep debt, previous day's strain | "based on your Sleep Debt and your previous day's activity" | Formula | [O] same page |
| Oura | Readiness | Resting HR and its timing, HRV balance, body temperature, recovery index, sleep, sleep balance, previous-day activity, activity balance | "Balance" contributors compare a 14-day weighted average with about two months | Weights, how contributors merge | [O] [support page](https://support.ouraring.com/hc/en-us/articles/360025589793-Readiness-Score) |
| Garmin | Training Readiness 1–100 | Sleep score, recovery time, HRV status, acute load, 3-night sleep history, 3-day stress history | Recomputed through the day; no weights | Weights, thresholds | [S] [manual](https://www8.garmin.com/manuals/webhelp/GUID-C001C335-A8EC-4A41-AB0E-BAC434259F92/EN-US/GUID-C21BE0C8-A08E-4DA1-B6C6-2E0E2DDDB372.html) |
| Garmin / Firstbeat | Body Battery | 24-h HRV, stress, activity, sleep | A charge drained by stress and activity and refilled by rest; the Firstbeat white paper covers the HRV stress/recovery classification only | The charge model, any validation | [S] [white paper](https://www.firstbeat.com/wp-content/uploads/2015/10/Stress-and-recovery_white-paper_20145.pdf) |
| Apple | Readiness 0–10 (Series 12, Ultra 4; Sept 2026) | Activity, overnight and daytime vitals, sleep | Against a recent baseline (at least 7 of the past 49 nights); "updates throughout the day based on calories burned, naps, and your daytime heart rate" | Formula | [S] [support 128112](https://support.apple.com/128112) |
| Apple | Vitals; Training Load | Overnight HR, respiratory rate, wrist temperature, SpO2, sleep; workout effort ratings | Vitals flags two or more metrics out of range; Training Load compares 7 days with 28 | Range construction | [S] [Vitals](https://support.apple.com/en-us/120142), [Training Load](https://support.apple.com/guide/watch/apde4c07a6cf) |
| Polar | Nightly Recharge | HR, HRV and breathing rate in the first 4 h of sleep, plus sleep | ANS charge −10 to +10 against 28 days | Weights | [S] [support](https://support.polar.com/en/nightly-recharge-recovery-measurement) |

**What the prior art teaches.**
- Every vendor reads against the person's own baseline.
- Vendors use rolling windows, typically 7, 14 and 28 days.
- Apple and Garmin update readiness through the day from daytime HR and activity, as Waldo's measured curve does.
- Garmin's Body Battery is the only published "charge" framing, and it has no published validation.
- None publishes weights, so "match WHOOP" or "match Oura" is not a specification.

### 2.12 Nudges and notification load

| Claim | Figure or quote | Source | Marker | Grade |
|---|---|---|---|---|
| A timely activity suggestion raised the next 30 minutes' steps by about 14% (35 steps), p = 0.06 | 44 adults, 6 weeks, 5 decision points a day | Klasnja et al., *Ann Behav Med* 2019;53:573–82, [PMC6401341](https://pmc.ncbi.nlm.nih.gov/articles/PMC6401341) | [S] | B− |
| The effect fades over the weeks | Named as a design risk; decay not confirmed from the abstract | same | [M] | unverified |

This supports Waldo's existing caution about proactive volume. It does not support a specific cap.

---

## 3. Every candidate input, judged

**Tier key:**
- **T1:** Form itself.
- **T2:** a named part of Form: Recovery, the daytime state, or Weight (the demand pillar).
- **T3:** a signal under a tier-2 part, or context the model sees.
- **Out:** not used.

| Input | What the evidence supports | Strength | What it cannot support | Missing or bad data | Tier |
|---|---|---|---|---|---|
| Sleep duration against need | Shorter than need lowers next-day function (Watson 2015; Van Dongen 2003) | A | A universal need; need is personal | No sleep record: Recovery cannot use it; a tap or a stated bedtime can stand in at lower confidence | T3 under Recovery |
| Multi-night sleep debt | Deficits accumulate, and people stop noticing (Van Dongen 2003) | A (lab) | Exact repayment rates; the 0.5 repayment in `sleep-debt.ts` is a modelling choice | Fewer than 10 of 14 nights: partial, already handled | T3 under Recovery, and the forecast level |
| Sleep regularity (multi-night) | Regularity predicts outcomes beyond duration (Windred 2024; Phillips 2017; Sletten 2023) | B | Causation; a one-night midpoint is not regularity | Needs about a week of nights; gaps lower confidence | T3 under Recovery (replaces one-night midpoint) |
| Overnight RMSSD (ln, rolling) | Within-person trend reflects autonomic recovery (Plews 2013; Buchheit 2014) | B | Single-night decisions; comparisons between people; "higher is always better" in overload | Night missing: rolling window thins; device change: per-method baseline (already ruled) | T3 under Recovery |
| Resting HR | Within-person elevation marks strain, illness, alcohol and heat (Buchheit 2014; Bellenger 2016) | B | Cause attribution | Same as HRV; fallback from asleep hours already exists | T3 under Recovery |
| Time awake (sleep pressure) | Alertness falls with time awake (Borbély 2016; Van Dongen 2003) | A (structure), C (magnitude for a person) | A personal rate without the person's data | Wake time unknown: use the stated usual wake, labelled | T3 under daytime state (forecast shape) |
| Body-clock phase | Time-of-day and synchrony effects at group level (Schmidt 2007; Monk 2005) | B (group) | A personal peak from the group curve | Needs sleep timing; phone-only can use stated times | T3 under daytime state (forecast shape) |
| Sleep inertia | Function is low just after waking (Hilditch & McHill 2019) | B | Duration for a person | None needed beyond wake time | T3 under daytime state |
| Daytime resting HR and HRV ("strain") | Awake resting HR above the person's usual marks arousal or strain; daily conflict lowers that night's HRV (PMC9517418) | C | Whether it means stress, excitement or caffeine; low HRV is not specific to psychological stress | Needs enough awake resting hours (code: 8 HR, 4 HRV) | T3 under daytime state |
| Realised physical load today | A hard session is acute fatigue; training load describes the week (Foster 2001; Impellizzeri 2020) | B (description) | Injury risk; ratio bands | No workout data: unknown, never "rest" (already ruled for training load) | T3 under daytime state (realised) |
| Light activity and breaks | Small, short cognitive lift from a bout of exercise (Chang 2012, g ≈ 0.10); breaks restore vigour (Albulescu 2022) | B (small) | That more movement than usual lowers Form | Phone-only steps stand in, as now | T3 under daytime state, good direction |
| Daylight | Daytime light: neutral to alerting (Souman 2018); morning light advances the clock (Khalsa 2003) | B/C | That above-usual daylight lowers Form (no source) | Missing on many devices: absent, never zero | T3 under daytime state, good direction; evening light moves tomorrow's Recovery forecast |
| Feel tap | Subjective state tracks load sensitively (Saw 2016); a single rating tracks lapses (Kaida 2006) | B | Trust under chronic restriction (Van Dongen 2003); trust after the score is shown (Gavriloff 2018) | No tap: Form from data alone; tap only: Form from the tap, labelled | T2 input to the daytime state, and the calibration outcome |
| Planned demand (calendar minutes, back-to-back runs, travel) | More meetings go with more same-day fatigue (Luong & Rogelberg 2005) | B (self-report, realised) | A drain constant; that *planned* demand lowers the body before it happens | Partial calendar coverage: say so (the day-shaping skill already does) | T2: Weight, a separate series beside Form |
| Realised demand (meetings and focus hours done) | Same as above | B | Same | Same | T3 under daytime state, once learned per person |
| Open tasks, message counts | No source links these to readiness | D | Anything about the body | n/a | T3 context for Weight; drop from any weight |
| Training load phrase (7 vs 21 days) | Description of change against usual, with uncoupled windows (Lolli 2019, as cited in ADR-0081; not opened here) | B (description) | Risk | Fewer than 21 observed days: unavailable | T3 context the model sees |
| Respiratory rate, wrist temperature, SpO2 | Shifts appear around illness (Quer 2021) | B− (detection) | Diagnosis | Already drivers, never weights | T3 drivers |
| Cycle phase (opt-in) | Luteal phase shifts HRV, RHR and temperature (ADR-0085) | per ADR-0085 | Anything beyond the baseline adjustment | Unknown phase: no adjustment | Adjusts T3 baselines only (ADR-0085) |
| Caffeine, alcohol (logged or said) | Late caffeine costs sleep (Gardiner 2023); alcohol lowers night recovery (Pietilä 2018) | A−/B | A dose rule in code | Usually unlogged: never assume | T3 context, explanations only |
| Meal timing, hydration | Weak and inconsistent for desk days | C | Any Form effect | n/a | Out of Form; context if the person raises it |
| Body mass | Weeks-long trend for stated goals; crude session fluid loss | B | Readiness, recovery, energy availability | Daily noise as large as a week's change | T3 context, outside Form |
| HR-based energy windows | One blog note; its own limit: stress reads as energy | D | A capacity window until validated against taps | Needs 7+ days per hour | T3 candidate signal for the window, to validate |
| Vendor scores (WHOOP Recovery and others) | Nothing published that validates them | D | Being treated as ground truth | n/a | Out as weights; may be shown as the vendor's own reading |

Rejected on vendor claim alone: the vendor composite scores as inputs, the HR energy-window method as a capacity measure until validated, and the Microsoft meeting-break finding as a mechanism.

---

## 4. Design

### 4.1 What Form is for

Form answers one question: **how much does this person have to give, now and for the rest of today?** It drives:
- every health-aware decision;
- the forecast;
- the capacity windows;
- when Waldo speaks.

The design keeps the owner's tiering and the repo's hard rules:
- deterministic computation in the health data plane (ADR-0081 §1);
- judgment with the model;
- raw values never in prompts, memory or logs;
- missing health never becomes invented readiness.

### 4.2 Two words to settle first

- **"Weight".** The code's Weight (`weight.ts`) is the day's demand. The research brief also says "body weight trend as a tier-2 signal". This document treats **Weight = demand** as the tier-2 pillar the owner named, because that is what the lens doc and the code mean. It puts body mass in tier 3 (section 2.9). The lens doc already flags the collision. Section 6.2 asks the owner to rule on the name; "Load" is the obvious alternative.
- **"Cognitive."** No measure in Waldo's data is cognitive. Form can claim cognitive readiness only once feel taps (and later, optional short reaction tests) show that it tracks how the person's head was. Until then the honest wording is "how much you have to give". `messaging-behavior.ts` already hides "Form" behind "The Readiness Score".

### 4.3 Three competing designs

**Design A: one charge number that includes the day ahead.** This is the lens doc's "charge" proposal, taken literally, and close to Garmin's Body Battery.

- **How it works.**
  - The morning starts from Recovery.
  - Form is drawn down by realised *and planned* demand (meetings, workouts) and refilled by rest, with a time-of-day curve on top.
  - The forecast reads the calendar, so a heavy afternoon lowers the forecast and possibly this morning's number.
- **Numbers it needs.** A drain rate per meeting hour, per workout and per hour awake, and a refill rate for breaks and naps. **No source gives any of these** (sections 2.7, 2.11). They would be invented on day one and learned later from taps.
- **Strengths.**
  - One number does everything, as the owner described.
  - It is the easiest to explain ("your battery").
- **Weaknesses.**
  - Planned demand inside Form makes "heavy days lead to low Form" true by construction, so Form can no longer be tested against outcomes. The lens doc made the same point.
  - It double counts. Anticipation already shows in morning physiology (section 5a), and the same meeting would then be counted again when it happens.
  - A cancelled meeting would move a "body" number.

**Design B: no composite; the model reads the parts.**

- **How it works.**
  - Code computes the tier-2 parts (Recovery, daytime state, Weight by the hour) with uncertainty, plus the two-process forecast shape.
  - The model writes a Form zone word and the windows each time it plans.
- **Numbers it needs.** No weights at all.
- **Strengths.**
  - No invented weights.
  - The most "judgment belongs to the model".
- **Weaknesses.**
  - It breaks ADR-0081 §1, which says Form is a deterministic, versioned backend result computed without an LLM.
  - It is not reproducible, so the app's number and the model's word could disagree.
  - It cannot be calibrated, because there is no fixed thing to calibrate.
  - It gives no real-time number for the curve or the day view.
  - It fails the owner's "single tier-1 metric".

**Design C (recommended): a body-and-moment Form, with the day ahead beside it.**

- **Form's value.** Deterministic, made of:
  1. Recovery (the night);
  2. the daytime state: time-of-day structure, daytime autonomic strain, realised load, light activity and daylight in a good direction, and the feel tap.
- **Weight.** Planned demand by the hour is a separate tier-2 series, drawn beside Form and handed to the model with it. Demand enters Form only **as it happens**: realised load today, and daytime strain if the body shows it.
- **Forecast.** The level now, plus a shape. The shape blends a two-process prior, anchored on the person's own wake time and sleep debt, with the person's own measured day shape (`form-curve.v1`) as days accrue.
- **Capacity windows.** Computed from the forecast (section 4.6). The model places tasks against Weight and the calendar.
- **Numbers it needs.**
  - Directions and shapes from the literature.
  - **Equal weights to start** (Dawes 1979).
  - A per-person calibration learned from feel taps, shrunk toward the cohort (section 4.8).
  - No drain constants.
- **Strengths.**
  - Form stays testable against how people feel.
  - Nothing is counted twice.
  - It fits ADR-0081.
  - Weights move only from evidence, and the model does the weighing of body against day.
- **Weaknesses.**
  - Two series to explain: Form, and the day's ask.
  - The capacity window depends on the model reading both.
  - Equal weights are a principled default, not a measured truth.

**Recommendation: build C.** It is the only design that satisfies "one tier-1 number", "no invented weights" and "judgment belongs to the model" together, and the only one where Form can be proven wrong.

**What would change my mind.**
- **Toward A.** After 6–8 weeks of cohort taps, the afternoon tap's residual (felt minus forecast) correlates with that morning's *planned* demand beyond what realised load and daytime strain explain. Then planned demand predicts the body, and it belongs in the forecast.
- **Toward B.** Per-person calibration never beats equal weights on held-out taps, *and* the tap alone predicts as well as Form. Form would then still need to exist as a number for ADR-0081, but the model should lean on the parts.
- **Against the two-process prior.** It does not beat the plain `form-curve.v1` empirical shape, or a flat line from now, on held-out taps and later measured Form after 4 weeks. Then drop it after the first week of history.

### 4.4 The tiers under Design C

| Tier | Part | Made of (tier 3) | Changes from today's code |
|---|---|---|---|
| 1 | **Form** now, its curve to bedtime, and the capacity windows | Recovery and the daytime state | Weights start equal and are learned. The daylight and movement directions are fixed. A self-report path is added. The forecast takes a two-process prior |
| 2 | **Recovery**: what the night brought | Sleep against need, multi-night debt, regularity (replaces the one-night midpoint), rolling ln RMSSD against baseline, resting HR | Regularity index; rolling HRV; equal weights |
| 2 | **Daytime state**: Form's own part | Time awake, body-clock phase, sleep inertia, awake resting HR and HRV, realised training load, light activity, daylight (good direction), feel tap | New: the time-of-day structure, realised load and the feel tap. `nearUsual` removed from daylight and movement |
| 2 | **Weight**: what the day asks | Calendar minutes by hour, back-to-back runs, travel, planned training; tasks and messages as context only | Moves from a daily number to an hourly series. Not folded into Form |
| 3 | Signals and context | Everything in section 3 marked T3 | Drivers, cycle phase, body mass, caffeine and alcohol stay context |

### 4.5 How Form moves through the day

**What legitimately moves Form after waking:**
1. **Time awake and the body clock.** The forecast shape: low during sleep inertia, rising to a late-morning high, an afternoon dip, then a decline into the evening, anchored on today's wake time (2.1, 2.2, 2.5).
2. **Sleep debt.** It lowers the whole curve's level and shortens the high. This is the SAFTE reservoir idea, and what `energy-windows.ts` already does with peak length (2.1).
3. **Realised load.** A hard session done lowers Form for the following hours, by a person-learned amount. A stretch of meetings done may lower the felt part once learned (2.4, 2.7).
4. **Daytime strain.** Awake resting HR above usual, or HRV below (2.3).
5. **The feel tap.** It moves Form at once (2.10).
6. **Restoring events.** A nap, or a break after a long block (2.7).

**What does not move Form:**
- the calendar ahead (it moves Weight);
- more daylight than usual;
- more steps than usual on their own;
- a vendor's score;
- body mass;
- a single-night HRV blip beyond its share of the rolling average.

**The forecast.** `forecast(t) = level_now + shape(t)`, where:
- `shape` blends the two-process prior with the person's own `form-curve.v1` shape, weighted by how many matching days support the personal shape. With fewer than 7 days, it is the prior alone, labelled provisional.
- Today's sleep debt scales the prior's level.
- A wake more than 2 h from usual shifts the prior; the existing projection already excludes such days.
- The forecast is refreshed whenever a new hour, workout or tap arrives.
- It does not read the calendar. The model sees Weight by the hour beside it.

**Destination.** ADR-0081's Form-curve amendment keeps the curve out of model context. Design C needs the model to see at least the forecast's shape in words, plus the window clock times, so this is an owner ruling (6.2). Clock times are already allowed; scores are not.

### 4.6 Finding the capacity windows

Keep two windows, because the evidence separates them (2.5): a **thinking window** and a **training window**.

1. **Prior.** From the two-process shape anchored on the person's wake time and usual sleep midpoint. Thinking peaks in the late morning; training later in the day. Labelled "typical for your sleep timing", never "yours".
2. **Personal evidence.** It replaces the prior as it accrues:
   - feel taps at varying times of day (4.7);
   - when the person's best work actually lands (blocks kept, what they say);
   - for training, when sessions felt best (Apple effort ratings or session RPE against the planned intensity);
   - the HR energy-window method as a **candidate** signal, used only once it agrees with taps for that person.
3. **Today's modifiers.** Debt and a poor Recovery shorten the window. A late wake shifts it.
4. **Placement is the model's.** It sets the window against Weight and the calendar and protects it with one move. This is how the `health-protocols` skill already reasons.

### 4.7 Without a wearable: the degradation ladder

The rule throughout: missing data never becomes invented readiness, and a tap alone can carry Form when labelled.

| Level | Has | Form is built from | Confidence the model sees | What Waldo may do |
|---|---|---|---|---|
| L0 | Overnight HRV/RHR, sleep, hourly HR | All of Recovery and the daytime state | High once personal | Everything in this design |
| L1 | Sleep record, no HRV (phone or basic band) | Sleep against need, debt, regularity, time-of-day shape, tap | Medium | Plan around sleep and timing; no autonomic claims |
| L2 | Phone only: steps, maybe screen time, stated bed and wake times | Stated sleep times (labelled), time-of-day shape, tap | Low | Lean on the tap and the calendar |
| L3 | Only a feel tap | The tap, with the time-of-day prior from the stated wake time | Low, labelled "from what you told me" | Plan from the calendar and their words. No health-triggered proactive action beyond what the tap itself supports |
| L4 | Nothing today | Unavailable | None | Plan from the calendar; never invent readiness (existing skill rule 1) |

**The tap.**
- **Prompt.** One prompt a day, once the person is up, on the surface they use.
- **Format.** Five faces or a slider: "How much have you got today?". Optional, never nagging, and missing it carries no guilt.
- **Order.** Taken **before** any score is shown (Gavriloff 2018).
- **Opportunistic taps.** An optional second "how's your head now?" when the person opens the app or replies to Waldo at a different time of day. That is what lets Waldo learn the curve's shape.

### 4.8 How a self-report corrects the model

1. **Today.** The tap is a daytime-state input with its own weight, so it moves Form immediately in its direction. It does not replace the measured parts; both are stored.
2. **Over weeks: calibration.** A per-person regression of tap on the tier-2 parts (standardised), shrunk toward the cohort fit, the same Bayesian partial-pooling idea as `baseline.ts`. It learns:
   - how much each part matters for *this* person (the weights);
   - the person's offset (some people rate everything high);
   - the time-of-day shape from taps at varying times.

   Before enough taps, the weights stay equal. A learned weight is used only once its uncertainty is smaller than its difference from equal.
3. **The one exception to the tap's authority.** When sleep debt is building over several nights, the tap's weight is reduced and the debt part keeps its pull, because the literature shows people stop noticing (Van Dongen 2003). The model is told both: "feels fine; carrying several short nights".
4. **What else counts as an outcome.** Workout effort ratings, and later optional short reaction tests, are measures of state. Accepting or declining a suggestion measures preference, not state. It must not train Form.

Persisting learned parameters per owner is new health-pattern persistence. Under the repo's constraints it needs an ADR-0081 amendment (6.2).

### 4.9 Where the numbers come from

| Number | Evidence-backed? | Source of the value |
|---|---|---|
| Directions (short sleep down, debt down, regularity up, RHR up is down, rolling HRV down is down, daylight by day not down) | Yes | Sections 2.1–2.6 |
| Own-baseline z-scores, shrinkage priors | Yes (method) | `baseline.ts`; Quer 2020, Natarajan 2020 |
| Rolling windows for HRV (about 7 days) | Partly (practice consensus) | Plews 2013, AIS guide, vendor practice |
| Forecast shape (inertia, morning rise, afternoon dip, evening fall) | Group-level shape only | Borbély 2016, Monk 2005, Hilditch 2019 |
| Size of the shape for a person | No | Learned from taps and measured curves |
| Starting weights | Principled default (equal), not measured | Dawes 1979 |
| Personal weights, offset, drain from realised load | No | Learned per person from taps and effort ratings |
| Sleep need | Floor from consensus; personal value learned or stated | Watson 2015; `baseline.ts` |
| Zone cut points 80/60/40 | Convention | `zones.ts` |
| Any planned-demand drain | No | Not used in C |

---

## 5. The three open questions

### (a) Should a heavy calendar lower Form in the morning?

**Recommendation: no.** Form starts from the body and the moment. The day ahead is Weight, a separate series the model weighs.

**Evidence.**
- Anticipation of a demanding day already shows in morning physiology. The cortisol awakening response was larger on workdays than on weekends: a mean rise of 10.5 against 3.7 nmol/l in 196 Whitehall II civil servants, with no difference in waking cortisol (Kunz-Ebrecht et al., *Psychoneuroendocrinology* 2004;29:516–28, PMID [14749096](https://pubmed.ncbi.nlm.nih.gov/14749096/), [S]).
- Fries, Dettenborn & Kirschbaum propose that anticipation of the day drives the response (*Int J Psychophysiol* 2009, [doi:10.1016/j.ijpsycho.2008.03.014](https://doi.org/10.1016/j.ijpsycho.2008.03.014), [S]).
- Work overload and worry predict a bigger weekday response (Schlotz et al., *Psychosom Med* 2004, PMID [15039505](https://pubmed.ncbi.nlm.nih.gov/15039505/), [S]).

Wearables do not measure cortisol. But whatever anticipation does to the night (shorter sleep, raised resting HR) is already in Recovery. Subtracting the calendar on top counts it twice.

**Design reasons.**
- With the calendar inside Form, "heavy days give low Form" is true by construction, and Form can no longer be validated.
- A meeting cancelled at 08:00 would change a "body" number.
- Meeting-fatigue evidence is about meetings that happened (Luong & Rogelberg 2005), and Design C counts those as they happen.

**What would overturn this.** The falsifier in 4.3: residual afternoon taps tracking that morning's planned demand.

**What the model does.** It holds both: "body: steady; day: heavy from 10 to 4". It decides which one move protects the thinking window or eases the day.

### (b) Is one feel tap a day enough signal?

**Recommendation: one morning tap is the floor, not the ceiling.**

**What one tap can do.**
- Carry Form on a day without a wearable (L3).
- Correct today's level.
- Over a few weeks, calibrate the person's offset and the weights of the larger parts.

The evidence supports a single item: KSS against PVT lapses r = 0.56 (Kaida 2006), and subjective measures track load sensitively (Saw 2016).

**What one tap cannot do.**
- Learn the person's daily curve, because one point a day at a fixed time has no shape in it.
- Detect decline under chronic restriction (Van Dongen 2003).

**Compliance.** Daily self-report decays about 1–2% a week (Tonkin 2023), so any design that needs many taps will starve.

**The arithmetic of how many taps are needed.** Illustrative and synthetic:
- Suppose a tap's day-to-day noise is σ points on a 5-point scale, and we want to detect a personal offset δ.
- Roughly n ≈ (σ/δ)² taps are needed.
- With a synthetic σ of 1 and δ of 0.5, that is about 4 taps for the offset.
- Each learned weight needs several times more, because the parts are correlated. Shrinkage toward the cohort is what makes a few weeks enough.

**So.**
- One prompted morning tap.
- An optional, opportunistic second tap at a varying time on some days, to learn the shape.
- Tap before the score is shown.
- No streaks, no guilt.

### (c) What should Waldo do when the data and the person disagree?

**Recommendation: never overwrite either side. Show both and let context decide which leads today's plan.** Both are stored, and the disagreement itself is calibration data.

| Situation | Who leads today | Why | What Waldo says or does |
|---|---|---|---|
| Person feels worse than the data | **The person** | Subjective state is more sensitive to acute load (Saw 2016). Symptoms add to sensors for illness (Quer 2021). Easing costs little | Eases the day by one move. May ask one short question if the answer changes the plan ("short night or something else?"). Never argues |
| Person feels fine; data shows **several short nights** | **The data**, gently | People under chronic restriction stop noticing (Van Dongen 2003) | Says it once, plainly, with the reason. Protects sleep tonight rather than cancelling today. The person's choice stands |
| Person feels fine; data shows **one** poor HRV night, normal sleep | **The person** | Single-night HRV is noise (Plews 2013; Buchheit 2014) | Nothing. The rolling average absorbs it |
| Person feels fine; drivers suggest illness (temperature, breathing rate up) | **Shared** | Detection is weak (AUC about 0.7) and confounded by alcohol, travel, cycle and training | Mentions it as a possibility without naming a condition. Suggests not adding a hard session. Never diagnoses |
| Person feels great; data says hard training block, HRV *up* | **Context** | HRV can rise in overreaching (Le Meur 2013) | The model weighs the load phrase with the trend; no automatic "green light" |
| Repeated disagreement in one direction | **Calibration** | Correlations differ by person (2025 *Sports Med Open*) | The per-person calibration moves, and Waldo can say it has learned from them |

**Two cross-cutting rules.**
- A bad number can cause a bad day (Gavriloff 2018), so Waldo leads with the move, not the score. This is already skill rule 4.
- The person's stated feeling is never written to memory as a measured fact. It is a dated, owner-stated reading, per `memory/health-rules.ts`.

---

## 6. Unverified, owner rulings, and scenario tests

### 6.1 What is unverified

- **Full texts.** No full text was read. Every [S] row needs its abstract or paper checked before any figure reaches product copy.
- **Not found at all:**
  - SAFTE's equations and any independent outcome validation beyond the FRA rail reports (and their two coefficients disagree);
  - Belenky 2003 findings;
  - sleep-inertia magnitudes;
  - Mirizio 2020 and Grgic 2019;
  - the author of the 2023 time-of-day meta-analysis behind PMC10308487;
  - Blume 2019;
  - any person-specific peak-window study;
  - any daily-life validation of a two-process forecast;
  - day-to-day RMSSD CV from Plews or Buchheit directly;
  - Granero-Gallegos 2020 and Düking 2021;
  - Busso 2003 and Imbach 2022;
  - Halson 2014, Hooper and McLean wellness scales;
  - Mann 2015;
  - any study that tests anticipated workload against nocturnal HRV;
  - HeartSteps decay over weeks;
  - bioimpedance validity;
  - Sawka 2007 text;
  - Samsung and Fitbit methods.
- **From memory:** Chauhan 2025 (cited by the skill), the caffeine half-life range, and the ACSM 2% figure.
- **Not read in this session:** Linear HEY-517 and HEY-262 (Linear needs `/mcp` authorisation), live staging behaviour, and the app's handling of Form.
- **Source facts read but not run:** no test was run for section 1.

### 6.2 What needs the owner's ruling

1. **Design.** C (body-and-moment Form, Weight beside it) or A (the day ahead inside Form). This document recommends C.
2. **Names.**
   - Keep "Weight" for the demand pillar and call body mass "body mass"? Or rename the pillar "Load"?
   - Body mass stays tier 3, outside Form.
3. **The tap.**
   - One prompted morning tap, an optional second, taken before the score is shown.
   - A tap alone may produce a Form labelled "from what you told me".
4. **Wording.** Form is presented as "how much you have to give", not as cognitive readiness, until taps validate it.
5. **ADR-0081 amendment scope.** This is a list of what an amendment would need. It authorises nothing.
   - the regularity index and rolling HRV;
   - the daylight and movement direction fix (a new version);
   - the time-of-day prior (HI-5, second part, under its 4-week shadow);
   - the felt-rating input (HI-10);
   - learned per-person calibration parameters, as new per-owner persistence on the health plane;
   - the forecast shape and window clock times in model context, which today's curve amendment excludes;
   - Weight as an hourly series.
6. **Energy windows.** Keep them on as a labelled candidate, or switch them off until they agree with taps.
7. **Two windows.** Separate thinking and training windows.
8. **Disagreement policy.** The table in 5(c).
9. **Contracts.** Retire `CRS_FORM_WEIGHTS` and ADR-0011's weight claim, or keep them only as the device-fallback name with the SAFTE-validation sentence corrected.

### 6.3 Scenario tests the build must pass

All values synthetic. Each test asserts on what the model is given and on what Waldo does. None pins wording.

1. **Tap only (L3).** An owner with no health data taps "low". Form is available, labelled "from what you told me", with low confidence. No health-triggered proactive action is admitted that the tap does not support. No readiness is invented.
2. **Heavy calendar, good night.**
   - Two synthetic mornings with identical body inputs, one with an empty calendar and one booked 09:00–17:00.
   - Morning Form is equal on both.
   - Weight by the hour differs, and the model's context holds both.
3. **Meetings that happened.** The booked day at 14:00, after a run of meetings with awake resting HR above usual: Form is lower than at 09:00 by more than the time-of-day shape alone.
4. **More daylight than usual.** All else equal, a day with synthetic daylight above the owner's usual never scores lower than a usual-daylight day.
5. **Chronic restriction.**
   - Five synthetic short nights, and taps say "fine".
   - Form reflects the debt, and the model is told "feels fine; carrying several short nights".
   - Waldo raises it at most once, without guilt words, and proposes protecting tonight.
6. **Single-night HRV dip.** One synthetic low HRV night with normal sleep and a "good" tap: Form moves less than one zone, and no ease-the-day move is proposed.
7. **Feels worse than data.** Normal synthetic data and a "rough" tap: today's Form moves toward the tap, Waldo proposes at most one easing move, and it asks at most one question.
8. **Late wake.** A wake 2 h later than usual shifts the forecast and both windows by about the same amount.
9. **New owner.** With fewer than 7 days of history, the forecast is the two-process prior only, labelled provisional, and no window is called personal.
10. **Stale data.** No new hour for over 6 h: Form is unavailable or stale, and the forecast is not extended.
11. **Hard session done.** A synthetic hard morning workout lowers the afternoon forecast only after the owner's own response has been learned. Before that, the model is told a session happened.
12. **Illness pattern.** Wrist temperature and breathing-rate drivers rise and the tap says "fine": the model is given the possibility, no condition is named, and no hard session is proposed.
13. **Body mass noise.** A day-to-day body-mass move within synthetic noise changes neither Form nor Waldo's behaviour.
14. **Repeated disagreement.** An owner who taps one step above the data for many days: the calibration offset moves, and Form's error on held-out synthetic taps shrinks.
15. **Score after tap.** The tap prompt is never shown after a Form score on the same surface that day.
16. **No raw values downstream.** Across every scenario, model context, memory, logs and traces contain zone words, clock times and confidence bands. No digits for any reading or score appear outside the destinations ADR-0081 allows.
