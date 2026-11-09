# Build plan: align the product to the site

Oct 10 2026, ~2:40 IST. Owner ruling (02:36 IST, relayed): align the product to the site. Recovery-only Stage 1 stands (00:58 ruling). Hours are my build hours, not wall time, and exclude waits. Confidence: H/M/L. Tags: [fact] read in source or a page, [opinion], [inference]. Kennel: Ashish's lane. Dependencies: B backend (me), A app agent, D Dalda deploy or migration, O owner decision.

## What source says that shapes the plan [fact]
- Google scopes today are calendar.events, freebusy, gmail read/send/compose, tasks, and read-only Drive/Docs (packages/runtime/src/connectors/google.ts:9-19). No calendar.readonly or calendarlist scope, so "all calendars" needs a scope change and a reconnect. The app is unverified, test users only (same file, header).
- Tasks read only the default list (`lists/@default`, connectors/google.ts:459).
- The calendar read tool takes one calendar_id, default primary (reads.ts:50).
- No sleep-debt, best-hours, weather or location code exists in waldo-backend TS source. No ingest route, health tables or wearable read tool exist. The derived view is Form-only until #993 (recovery.v1, open, CI running).
- Weather: Open-Meteo's free tier is for evaluation and prototyping; commercial use needs a paid licence and an API key (https://open-meteo.com/en/pricing). Price not read.

## Plan per site claim
| # | Site claim | Smallest real implementation | Deps | Hours (conf) |
|---|---|---|---|---|
| 1 | Recovery score | #993 recovery.v1 view (done locally, in CI), then a producer that computes Recovery from sleep + HRV + resting rate vs the person's own baseline, "insufficient" until enough nights | B; needs #4 data | 1 left on #993 (H); producer 6 (M) |
| 2 | Apple Watch works today | Source-agnostic ingest `POST /app/v1/health/ingest` (session auth, idempotent per sample id, source field), consent table, health tables, 90-day raw / 24-month aggregate retention, bounded read tool; pgTAP | B + O (approve the ingest/consent note) + D (apply staging migrations) + A (HealthKit reader on device) | B 10-14 (M); A unknown to me |
| 3 | Health Connect works today | Same ingest route, `source=health_connect`. Needs an Android client, which does not exist ("iPhone comes first. Android follows") | A or new Android work + O | B 0 extra; client L, not estimable by me |
| 4 | Calendar, all calendars | `calendarList` connector method, `tool_list_calendars` read tool, calendar_id on reads across calendars, red-first | B + O (scope add and a reconnect for each user) | 4-5 (M) |
| 5 | Gmail | Already works. Multi-account work/personal journeys sit in draft PRs (#919, #905, #907); review and merge in order; per-account work-hours policy later | B review; D deploy | 3 per PR (M) |
| 6 | Google Tasks | Read all lists, not only the default (scope already covers it) | B | 2 (H) |
| 7 | Weather | `tool_weather` read tool on a fixed provider, keyed by coarse location, cached per day; fold into planning context | B + O (provider and cost) + secret in vault | 4 (M) |
| 8 | Location | Stage 1: owner-set home city and timezone in console/app (no tracking). Stage 2: coarse device location sent by the app under a consent flag | B + A; Stage 2 needs O (privacy) | 3 (H) for Stage 1 |
| 9 | Sleep debt (14-day weighted) | Pure function over nightly sleep minutes vs the person's own need, weights fixed and written down, "insufficient data" under a minimum nights; exposed as a derived nonnumeric band | B after #2 | 4 (M) |
| 10 | Best hours learned | Needs weeks of hourly data. Smallest honest version: after N weeks, bands from HRV/heart-rate/activity by hour; until then the agent says it has not learned yet. Calendar suggestion on invite uses it | B after #2 and data | 12-16 (L) |
| 11 | Threads | Thread = chat id under an owner; runtime currently shares one main chat. Design note first (shared vs per-channel, Claude Q11), then migration, routes, per-turn tree reload | B + A + O | 10-14 (M) |
| 12 | Scores: Form and Weight | Stay Stage 2. Option to promote Weight early: it is calendar, task and mail density, no wearable needed | B + O | Weight 6 (M); Form 10 after more signals (L) |
| 13 | Three autonomy levels per area, log, undo | Standing-grant slice (#932) plus a per-area setting in console/app | B + A | 10 (M) |
| 14 | Ask why with sources | A run-proof explainer endpoint and card: what was read, compared, source ids | B + A | 8 (M) |
| 15 | Disconnect removes what Waldo learned from that tool | Forget-on-disconnect keyed by source | B | 6 (M) |
| 16 | Privacy/terms | App Store, DPDP, residency, purge: hard gate before any outside user (owner's earlier ruling); site pages already say "under review" | O + legal | not mine |

## Order
1. Deploy the merged queue (#985, #988, #990, #991, #992): D. Then merge #993 (B).
2. Ingest/consent note to the owner (B, 2 h to write), then on approval: migrations on staging (D), route, tables, read tool (B). In parallel A builds the device reader.
3. No-dependency work while waiting: #6 Tasks all lists; #8 Stage 1 home city; #4 code up to the scope step.
4. After ingest has data: Recovery producer (#1), sleep debt (#9).
5. Weather (#7) once O picks a provider.
6. Threads design note (#11), then build.
7. Autonomy levels (#13), why-explainer (#14), disconnect-forget (#15).
8. Best hours (#10) last; needs data to accrue.
Backend total about 75-95 build hours across 15 items [opinion, M-L]; the long pole is waiting on approvals, deploys and device data, not code.

## New owner decisions, cost, secrets
Decisions needed:
1. Google scope expansion for calendar listing and the reconnect it forces; while the app is unverified only listed test users can reconnect. (#4)
2. Weather provider and who pays. (#7)
3. Android and Health Connect: build a client, or move it off "working today". (#3)
4. Coarse device location: allowed or not. (#8 Stage 2)
5. Threads model: shared main chat or per-thread chats. (#11)
6. Promote Weight to Stage 1? Default: no. (#12)
7. Approve the ingest/consent note when I send it. (#2)
New cost: a weather provider licence if a paid plan is chosen (price unknown). Testing spend stays inside the 5-10 USD figure; no new spend otherwise.
New secrets: a weather API key only if a keyed plan is chosen, via a vault request; no others. Google reconnect uses the existing OAuth app.

## Queue status
- #993 recovery.v1 view: pushed, CI running, not merged.
- #992 merged; not deployed.
- Calendar-list, ingest/consent note: next, in that order after #993 merges, with Tasks all-lists slotted first because it has no dependency.
