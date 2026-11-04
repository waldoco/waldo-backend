# Waldo health use cases: what is real, what is not

Written 31 Oct 2026, checked against `origin/beta-mvp` at `6c7cd4636`. For the owner and Suyash (app lane).

This page is the one place for health use cases and their status. It replaces the scattered April–October documents (the map is in section 4). It describes what the code and config do today. It is not a roadmap and it authorises nothing.

How the statuses were checked: source (`git grep`), `packages/runtime/wrangler.jsonc` (`env.staging.vars` and the defaults), `packages/runtime/evals/nightly/staging-profile.ts`, and the open PRs on 31 Oct. **LIVE-staging means the flag or setting is on in the staging config on `beta-mvp`.** It does not mean the deployed Worker runs this commit. This pass did not check the deployed SHA.

## 1. The honest claim

Waldo is not unique at any single health feature. Lifestack and Vora plan a day around wearable data and the calendar. Folk logs meal photos and reads Strava. Poke has an Oura recipe. WHOOP, Oura, Google, Bevel and Apple all coach on the same data. Nobody should say "no other agent does this" about one feature.

The defensible claim is the loop, not a feature. Body state, calendar and life context, memory, permissioned action, and follow-through, run together for one person, owned by that person. The brain gap analysis calls it "consumer-owned daily decisioning from body state + life context + memory + permissions" and says it is narrower than "AI health coach" and narrower than "AI for your day". The plain version: a score changes, Waldo sees what is on the day, and Waldo asks to move one thing. The person approves, and Waldo follows through.

That claim is still unproven in use. The backend's own competitor research says "Waldo's claim must be demonstrated, not asserted" and gives no basis to call health-aware assistance unique.

Sources:
- [Brain competitive gap analysis, §11 "Gap Verdict"](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/marketing/waldo-competitive-gap-analysis-2026-06-27.md). Lifestack and Vora are named direct threats.
- [Brain evidence table](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/marketing/waldo-competitive-evidence-table-2026-06-27.md). Rows for Lifestack and Vora.
- [Brain problem-pool audit, 13 Aug 2026](https://github.com/Pin4sf/waldo-brain/blob/main/03-References/research/conviction-embed-waldo-problem-pool-convergence-field-audit-2026-08-13.md). The Poke Oura recipe.
- [Backend competitor research, 11 Oct 2026](planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md), "Claims to reject or qualify". Folk meal photos and Strava; Poke and Oura.

## 2. Use cases and status

**Status words:**
- **LIVE-staging:** on in the staging config on `beta-mvp`.
- **DARK:** built, flag off. The flag is named.
- **PARTIAL:** some of it is built.
- **PLANNED:** a decision or design exists, with no (or unmerged) code.
- **DEFERRED:** a ruling says "later".
- **DROPPED:** decided against.

Nothing is DROPPED today. The "body looks off" note is not queued and not decided either way (see §3).

| # | What the person experiences | Status | Evidence | Source doc | Competitors, honestly |
|---|---|---|---|---|---|
| 1 | **Health trigger.** A readiness change meets something coming up in the next day (a meeting, a task). Waldo sends one approval card proposing a plan change. Nothing runs in real time: at most one check an hour. | **LIVE-staging.** No wrangler flag. It is an owner setting, `health_proposals`, on by default. | `health/trigger.ts`; wiring in `channels/owner-do.ts` (`healthTrigger`); `channels/schedule-preferences.ts`. A skipped-card brake asks after 3 skips a week. | BUILD_DIRECTION wave 4; ADR-0081 | Lifestack and Vora plan around calendar plus wearable. A card that waits for approval before any calendar change is the difference. Not shown to be unique. |
| 2 | **Health-only note.** On a day with nothing booked, a change that is worth it gets one short update card. | **DARK.** `HEALTH_SOLO_NOTICE=0` on staging and production. Turns on only after the judged evals pass. | `health/trigger.ts` (`soloNotice`); `owner-do.ts:4849`; evals h24 and h25 in `evals/nightly/brief-health-scenarios.ts`. The runbook says h20–h25 must pass the judged nightly run first. Whether they have passed was not checked. | `docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md` | Oura and Apple send "your body shifted" notes. Waldo's is framed the same way and refused if it names a reading. |
| 3 | **Health-aware day planning.** The Brief and chat plan with Recovery, Form and Weight in words, sleep debt in words, and up to four energy windows (peak and dip hours from the owner's own resting heart rate across the day). | **LIVE-staging.** Behind `HEALTH_PROVISIONAL_SCORES`: `1` on staging, `0` on production and by default. With it off, the earlier candidate engine runs and there are no energy windows. | `health/scores/index.ts` (`dailyScoresFor`); `energy-windows.ts`; `channels/health-context.ts`; `context-composer/prompt.ts` (`renderEnergyWindows`). Evals h20 to h23 cover the Brief with and without health, and after sharing is withdrawn. | ADR-0081 amendment of 27 Oct; BUILD_DIRECTION | This is where Lifestack, Vora and Rise sit. The extra part is calendar changes through approval cards. The energy-window method follows a published note (Exoplan). |
| 4 | **Pre-meeting note.** Before a meeting, a short note with context. | **LIVE-staging, but calendar-only, not health-aware.** `CALENDAR_GROUNDED_PREP=1` on staging, `0` by default. | `channels/event-briefs.ts`; `owner-do.ts:4927`. The file reads no health. Its only health code stops a title that carries a reading from going out. | `docs/proposals/MEETING_PREP_RELATED_MAIL_ADR.md` | Plain meeting prep is common. Do not describe it as a health feature. |
| 5 | **Weight** (how heavy the day is against the person's usual). | **PARTIAL.** | The provisional version, `weight.v5` (on when `HEALTH_PROVISIONAL_SCORES=1`), gives Weight from any one component that has a baseline: meetings, or physical load. It does not need a calendar. The earlier `weight.candidate.v4` does need one. **Message counts and task minutes are not wired:** `health/producer.ts:415` sets both to `null`. Rest blocks Waldo made do not count; deep-work blocks do. `health/scores/weight.ts`, `health/calendar-demand.ts`. | ADR-0081 amendment of 27 Oct (HI-6 counts deferred) | WHOOP Strain and Bevel Strain measure body load. Weight measures the day's demand against the person's usual. This pass did not look for a competitor that scores it, so do not claim none does. |
| 6 | **Form** (how the body is holding up through the day). | **LIVE-staging as `form.v9`.** The alertness term from SAFTE-FAST is **DEFERRED** to a 4-week shadow run. | `health/scores/form.ts`; `PROVISIONAL_ALGORITHM` in `health/scores/recovery.ts`. The server's Form score (`form.v9`) is not a SAFTE-FAST model; no function in `packages` computes one. The legacy name `form.safte-fast.v1` survives as the device-fallback label (`health-context.ts`, ADR-0081 §4). Form is built from Recovery, sleep midpoint, daylight, movement and stress. ADR-0081 §7 defers the alertness term (HI-5, second part). | ADR-0081 amendment of 27 Oct | TrainingPeaks uses "Form" for something else (Fitness minus Fatigue). Say so when comparing. |
| 7 | **Form through the day.** A measured curve and a projected curve over the calendar day, plus a stress trend. | **PLANNED.** The ADR is accepted (27 Oct, later amendment) with a switch, `HEALTH_FORM_CURVE`, default off. There is no code for it on `beta-mvp`. | `git grep -i` finds no `HEALTH_FORM_CURVE`, `form-curve`, `form_curve` or `stress_trend` in `packages`. The app's calendar day view (waldo-app #168) is separate. | ADR-0081 later amendment of 27 Oct | Garmin updates readiness through the day. |
| 8 | **Training load, and the daily training target.** "Room for a hard session at 6pm; tomorrow is back to back." | **PLANNED.** Storage is merged (#1737). The load producer (#1738, `HEALTH_TRAINING_LOAD`, default `0`) and coach reads (#1739) are open. The training target has no code or PR yet. | `HEALTH_TRAINING_LOAD` is not in `wrangler.jsonc` on `beta-mvp`. | ADR-0081 amendment of 31 Oct | Bevel (Target Strain) and Athlytic (daily exertion target) do the target. Fitting it to the calendar is the Waldo part. |
| 9a | **Queued idea 1: rest mode.** The owner turns it on when ill or travelling. Waldo pauses training targets and lightens the day. | **PLANNED.** No new health storage. | No code. Owner ruling of 31 Oct: start the lane after revision 5 lands. | Section 3 doc (owner's claude.ai research) | Oura Rest Mode. |
| 9b | **Queued idea 2: sleep need and debt, with bedtime and wind-down on the calendar.** | **PARTIAL.** Sleep debt is computed (`sleep-debt.v2`), stored on the derived row (accepted as AW-7, ADR-0081 25 Oct §5) and reaches the model in words. Bedtime and wind-down blocks are **PLANNED**. A sleep-need estimate for free nights (HI-12) is DEFERRED. | `health/scores/sleep-debt.ts`; `health/producer.ts` (`sleepDebtOf`); `health-context.ts` (`sleepDebtWords`). The 31 Oct note that "storing a sleep-debt value needs ADR review" is already covered by AW-7. Only a new sleep-need value would need it. | ADR-0081 §7 | WHOOP (need grows with strain and debt), Rise, Bevel (Sleep Bank). |
| 9c | **Queued idea 3: training target fitted to the schedule.** | **PLANNED.** Builds on row 8. | None. | As above | As row 8. |
| 9d | **Queued idea 4: energy curve over meetings.** Deep work at the peak, admin in the dip. | **PARTIAL.** Energy windows exist (row 3). The chronotype question at setup is not built. Which task goes in which window is the model's call. | `health/scores/energy-windows.ts`. | ADR-0081 amendment of 27 Oct | Rise. |
| 10 | **Patterns across sleep, meetings and mail.** "Late meals line up with lower recovery." | **DEFERRED. Open owner decision (§5).** | The brain launch contract says health-pattern mining is deferred. ADR-0081 §7 defers HI-11 (the pattern catalogue and day labels). The owner asked for it on 23 Oct ("built properly", with a bounded contract or ADR). The proposal sits on the unmerged #1472. No pattern code under `packages/runtime/src/health` (checked by grep). | Launch contract; ADR-0081; #1472 | The research pass found no vendor planning around the calendar. Oura and Apple compare tags in trends. |
| 11 | **Health admin from mail.** Refills, appointments, tests, insurance. | **PLANNED.** No runtime code. | BUILD_DIRECTION calls it the first deep vertical (wave 5). `git grep` for refill and health admin finds nothing in `packages/runtime/src`. | `docs/planning/BUILD_DIRECTION_2026-10-21.md` | Nobody was found with it as a consumer feature in this pass. Not checked exhaustively. |
| 12 | **Meal and workout logging.** "Log lunch." "I ran 5k." | **LIVE-staging.** No flag: the tools `log_meal`, `log_workout` and `list_health_logs` are registered in the owner object. Not exercised end to end by this pass. | `channels/health-log.ts`; `owner-do.ts:170`. | `docs/planning/waldo-agent-mvp/HEALTH_SPEC_2026-09-27.md` (legacy) | Not unique. Folk logs meal photos. |
| 13a | **Wearables: Apple Health.** | **LIVE-staging** for ingest. No flag. The app collects. | `packages/contracts/src/app/health-ingest.ts` (source `apple`). | BUILD_DIRECTION | Standard. |
| 13b | **Wearables: Health Connect (Android) and Samsung.** | **PARTIAL.** Ingest of the sources (`health_connect`, `samsung`) is accepted with no flag. The Android client is in the app lane and was not checked here. | `health-ingest.ts` source enum. | BUILD_DIRECTION wave 4 | Standard. |
| 13c | **Wearables: WHOOP.** | **DARK.** Client, mapper and routes exist. They run only if `WHOOP_CLIENT_ID`, `WHOOP_CLIENT_SECRET` and `WHOOP_REDIRECT_URI` are set. The runbook says production has none, "WHOOP comes later" (owner ruling, 22 Oct). Whether staging has them as secrets was not checked. | `health/providers/whoop-*.ts`; `HEALTH_PROVIDER_SOURCES_V1 = ['whoop']`. | Production alpha runbook | n/a |
| 13d | **Wearables: Oura.** | **DEFERRED.** Not connected, though BUILD_DIRECTION puts it in wave 4. A pure mapper only. It reads and stores nothing. | `health/providers/oura-map.ts` says so: the Oura API terms bar using its data with an AI model outside Oura's own MCP server, and bar storing it without written consent. BUILD_DIRECTION still says Oura connects through its cloud API. That is stale. | — | Poke advertises an Oura recipe. Its page was empty on 11 Oct. |
| 14 | **Detailed Apple Watch data.** | **PARTIAL.** Revision 3 signals are stored. Five of them reach the model as drivers (breathing rate, wrist temperature, blood oxygen, awake time in the night, walking heart rate; `health/scores/drivers.ts`). Sleep stages, VO2 max and heart-rate recovery are stored and readable through the `get_health` tool, but feed no score or driver. ADR-0081 (31 Oct) accepts VO2 max, heart-rate recovery, deep sleep and REM as driver subjects; they are not built. Revision 5 detail (zones, power, cadence, effort, body composition, stand hours) has its contract (#1736) and storage (#1737) merged. Capture in the app (waldo-app #185) is an open draft. So none of it flows from a real phone yet. | `HEALTH_COACH_REVISION_V1 = 5` in `health-ingest.ts`; `tools/live/health.ts` for what the model can read. | ADR-0081 amendments of 25 Oct and 31 Oct | Apple's own apps and WHOOP show this detail. Waldo's chance is using it in the plan. |
| 15 | **Guard rails.** | **LIVE-staging** (no flag; code-enforced). No numbers in notifications. No diagnosis. Health sharing is optional per person, and missing or withdrawn health is never invented. Raw values live only in the Supabase health plane. | `health/trigger.ts` refuses a card or note that carries a reading (`numericHealthIn`, `egress_refused`). `scribe/sanitiser.ts`. Evals h21, h22. ADR-0081 and ADR-0082. | `.claude/rules/security-checklist.md` | WHOOP and Oura show numbers. Not showing them in a push is a choice, not a gap. |

## 3. What others do, and what we borrow

The owner's research is the "What other health coaches do" section of the [claude.ai status doc](https://claude.ai/artifact/UbWc2fXEVMeXmBZ7CcqRfN), read through the Docs connector on 31 Oct. It opened 23 vendor help pages and reviews. WHOOP's own pages refused access, so the WHOOP row leans on developer docs and press. Some items are marked unverified in the source.

What everyone shares: a morning readiness score against your own baseline, a load number, a sleep need, and a chat coach. The doc's view is that Waldo's chance to be different is the calendar: planning the actual day around the score.

| App | What it does | Worth borrowing |
|---|---|---|
| WHOOP | Recovery, Strain, sleep need that grows with strain and debt, AI Coach | Sleep need that responds to strain and debt |
| Oura | Readiness, Symptom Radar and Rest Mode, Advisor with reviewable memories | Careful early-warning wording, Rest Mode, owner-set tone and frequency |
| Athlytic | Recovery, daily exertion target, alerts | Use HealthKit history to skip calibration |
| Bevel | Recovery, Strain, Energy Bank, Target Strain, Sleep Bank | A strain target that follows recovery |
| Garmin | Training Readiness through the day, Body Battery | One short plain line per band |
| Apple | Vitals note when several metrics are out of range, training load in words | A next-morning outlier note, load in words |
| TrainingPeaks | Fitness, Fatigue, Form = Fitness minus Fatigue | Nothing. Their "Form" is a different thing from ours. |
| Rise | Sleep need and debt, energy curve, timed nudges | Energy peaks and dips over the day |
| Eight Sleep | Health Check, acts on its own from a workout tag | Acting from a tag (careful: acts without asking) |

The doc ranks additions by value for effort. The owner queued four on 31 Oct, to start after revision 5 lands (#1737 to #1739 and app #185): rest mode, sleep need and debt with bedtime and wind-down on the calendar, a training target fitted to the schedule, and an energy curve over meetings.

Not queued:
- **"Your body looks off" note.** Highest risk and closest to diagnosis. If it is ever built, copy Oura's and Apple's framing: "shifted, not why", morning after, not medical, never name a condition.
- **Load in plain words**, a **weekly review** in the Close, **tags and habit effects** (needs the patterns decision), **caffeine and light cut-offs**, and **cycle-aware coaching** (special-category data; "later, if at all").

Where Waldo can lead, in the doc's words: none of the features found in this pass plan around the person's calendar, mail and goals. It says this was not checked exhaustively.

## 4. Document map: current and legacy

**Current. Read these.**

| Document | Why |
|---|---|
| This page | Use cases and status |
| [`docs/planning/BUILD_DIRECTION_2026-10-21.md`](../planning/BUILD_DIRECTION_2026-10-21.md) | Owner decisions and wave order. It wins over the September plan and the pinned launch contract where they conflict. Two lines are stale (Oura, §2 row 13d). |
| [ADR-0081](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/Architecture%20Decision%20Records%20(ADR)/0081-health-derived-fields-form-crs-computation-authority.md), with its 25, 27 (two) and 31 Oct amendments | The accepted rules for scores, inputs, windows and what is deferred |
| [Brain launch contract](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md) | Scope authority. Its 21 Sep revision defers health-pattern mining. |
| [Brain gap analysis](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/marketing/waldo-competitive-gap-analysis-2026-06-27.md) and [evidence table](https://github.com/Pin4sf/waldo-brain/blob/main/01-Waldo/marketing/waldo-competitive-evidence-table-2026-06-27.md) | The defensible claim |
| [`docs/planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md`](../planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md) | Vendor claims as of 11 Oct, and the "do not call it unique" list |
| [`docs/proposals/HEALTH_BASELINE_HISTORY_2026-10-28.md`](../proposals/HEALTH_BASELINE_HISTORY_2026-10-28.md) | Baseline and history design |
| `docs/ops/PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md`, `packages/runtime/wrangler.jsonc` | Flags and their defaults |

**Superseded or legacy. Do not use for use cases or status.**

| Document | Why it drifted |
|---|---|
| [`docs/planning/waldo-agent-mvp/HEALTH_SPEC_2026-09-27.md`](../planning/waldo-agent-mvp/HEALTH_SPEC_2026-09-27.md) | Telegram-first health coach spec (an owner verification draft) |
| [`docs/app/RECOVERY_WEIGHT_PROPOSAL.md`](../app/RECOVERY_WEIGHT_PROPOSAL.md) | Says Form is the only accepted algorithm. ADR-0081 has since accepted more. |
| [`docs/planning/lanes-2026-10-11/instinct/01-health-score-calculations.md`](../planning/lanes-2026-10-11/instinct/01-health-score-calculations.md) | A lane brief for the first pure score module |
| Brain `03-References/competitive-landscape-may-2026.md`, the "moats" | May 2026. Moat 1 is Telegram and WhatsApp delivery. The June gap analysis narrowed the claim. |
| Brain ADR-0042 (Spot), ADR-0071 (four pillars), ADR-0072 (Fetch) | The launch contract supersedes the Brief, Spot and Fetch scope. Still marked `accepted`. |
| Brain `01-Waldo/engineering/agent-soul/context-health.md` | 18 Apr 2026 |

Also stale, not edited here: `docs/app/CLAUDE_CONSULT_PACK.md` and `docs/app/HEALTH_PLANE_AND_APP_V1_2_DECISION.md` repeat "Form is the only accepted algorithm".

**Not on `beta-mvp`.** `HEALTH_INTELLIGENCE_V2_2026-10-23.md` exists only on the branch of unmerged draft PR #1472 (`claude/health-intelligence-v2`). Its decisions HI-1 to HI-15 were largely accepted by the owner on 23 and 27 Oct. Do not cite the file as merged.

## 5. Drift and open decisions

1. **Patterns.** The brain launch contract (21 Sep) defers health-pattern mining, and ADR-0081 §7 defers HI-11. The owner asked for pattern learning on 23 Oct, "built properly", with a bounded contract or ADR. The backend `CLAUDE.md` on `main` calls "supported pattern awareness" a core launch capability. These disagree. **Owner decision:** keep deferred, or write the bounded ADR and un-defer.
2. **Weight and the calendar.** ADR-0081 (27 Oct) says a calendar is not required. The code agrees only on the provisional path. The earlier path, and the comment above `weightScore` in `health/scores/weight.ts`, still say "without it there is no Weight". Task and message counts are not wired. Decide whether to wire them or drop them from the Weight docs.
3. **ADR-0042, 0071, 0072** are still `accepted` in the brain, while the launch contract supersedes the scope they set.
4. **Launch contract pin.** Backend `main`'s `CLAUDE.md` pins the contract at its 17 Sep revision (`be08c4a`). Brain `main` has the 21 Sep revision (`7145a75`). `beta-mvp`'s `CLAUDE.md` already says BUILD_DIRECTION wins over the pinned contract. `docs/README.md` still links the 17 Sep revision.
5. **India-first and Telegram.** BUILD_DIRECTION says global-first and India "is not the launch frame". Telegram is a team test channel that retires. Older docs still say India-first (the Sep capability matrices and build plan) or Telegram-first (`HEALTH_SPEC_2026-09-27.md`, the May competitor landscape).
6. **Oura.** BUILD_DIRECTION says Oura connects through its cloud API. The code says it cannot, because of Oura's terms. Fix the direction doc when the owner next edits it.
7. **Two "Form"s.** Waldo's Form is not TrainingPeaks' Form. Pick words for the app and the site.

## 6. Brain follow-ups

Not done from this session. Waldo-brain was not touched.

1. Flip ADR-0042, ADR-0071 and ADR-0072 to superseded (or add a status note) per the launch contract.
2. Add a pointer from the launch contract to this page for health use cases and status.
3. Mark the "moats" in `competitive-landscape-may-2026.md` as superseded by the June gap analysis.
4. Add a status banner to `agent-soul/context-health.md`.
5. If the owner chooses to un-defer patterns, an ADR-0081 amendment for HI-11 with its privacy-notice line. Edit the launch contract line that defers it.
6. Repin the backend entrypoints to the 21 Sep contract revision.
7. Note in ADR-0081 that Oura cannot connect while its API terms stand.

## What this page does not cover

- Whether the staging Worker is deployed at `6c7cd4636`, or whether judged evals h20–h25 have passed.
- Android client state, WHOOP secrets on staging, and the app's UI. Suyash owns those.
- Competitor claims beyond the cited sources.
