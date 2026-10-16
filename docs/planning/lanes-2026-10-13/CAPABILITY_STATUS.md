# Waldo capability status, 13 Oct 2026

These are read-only audits from source, plus the staging log tail. Each claim is tagged [verified] (seen in source or the tail) or [inference]. Nothing here was run on a device unless it says so.

- App `main`: `7d0ea15b`.
- Backend `beta-mvp`: `6ddbd85e`.
- Staging: `77d7329c`.

## C. App wiring (app `7d0ea15b` against backend `6ddbd85e`)

**Short answer:** every client method the app has is wired. These are the gaps:
- **Five surfaces the backend serves that the app never calls:**
  - chat cancel (Stop);
  - chat rating;
  - `controls?view=activity` (Patrol);
  - device register and revoke;
  - `health/scores?day=` (Body history).
- **The rest are backend gaps.**

| Area | Screen | Data source | State |
|---|---|---|---|
| Home | Home | scores, controls day, approvals, Main-chat watch | Wired, with placeholders, and with the load bug below |
| Home | Brief | — | Backend gap: the text (`cards[].latest` is never filled). The day cards themselves are served. |
| Body | health, health consent | `/health/scores`, `/health/consents` | Wired |
| Body | per-metric detail, health data | — | Backend gap: no timestamped series. Day history (`scores?day=`) is unwired. |
| Body / Watch | wearable, connect watch | HealthKit, paired Watch | Local |
| Waldo | chat | history, send, receipt, inline decisions | Wired. Cancel and rating are unwired. |
| Chats | chats list | Main chat plus local drafts | Contract-only (threads aren't served) |
| Approvals | approvals | list, decisions | Wired |
| Patrol | patrol | — | Unwired: activity `runs` are served but never requested |
| Spots | spots | — | Reads unwired (memory views are served). Confirm, dismiss and forget are backend gaps: not in the actions enum. |
| Memory | constellations | constellation and memory views | Wired |
| Settings | settings, schedule, account, connectors | session; day, account and connections views and their actions | Wired |
| Settings | gallery | — | Dead route |
| Auth | agent sign-in | code, verify, session | Wired |
| Onboarding | connect HealthKit | HealthKit, consents, ingest | Wired |
| Onboarding | 17 stubs | — | Orphaned. Profile is console-only. Wake, bedtime, notifications and permissions could use actions already served [inference]. |

**Placeholders still shown:**
- the Brief text and the calendar line on Home: no backend route;
- the Patrol and Spots cards;
- "profile, devices, invites, export" in Settings;
- Weight's "not calculated yet": the server reason `calendar_demand_unavailable`;
- the dimmed "New chat": threads;
- "Dark: Coming soon": the owner's call.

**Home not loading** [verified by the App lane on the Simulator; the fix is app #106]:
- Home made one all-or-nothing first read, gated on three shared stores. If any other screen's first read landed first, the parts not yet read stayed on "Reading…" with no Try again.
- A failed day read, followed by a remount, also stuck.
- Nothing re-reads scores or day cards on focus, on foreground or at a day change, nor after a health ingest. New scores and the next day's cards appear only after a relaunch.

**Design system in the app:**
- Tokens are generated from Brain's design tokens.
- The component kit is thin:
  - 9 components in `components/ui`;
  - the screen scaffold is still in `components/prototype`;
  - most styling is inline NativeWind.
- Reanimated 4.1.7 is used in 6 files.
- **Missing:**
  - skeleton loading states (loading is text only);
  - pull-to-refresh outside chat;
  - a shared empty-state component;
  - push: `expo-notifications` is installed but never imported.

**Push contract conflict** [verified in the contract]: device registration accepts only APNs and FCM tokens, and its pattern rejects `ExponentPushToken[…]`. The owner ruled Expo Push, so the contract needs an additive change before E.

## A. Proactivity, day planning and calendar

| Capability | Built | Live on staging (tail, 11 Oct 21:33Z → 13 Oct ~05:14Z) | Gap |
|---|---|---|---|
| **Day cards** | Yes: Brief 08:00, Check-in 14:00, Close 21:30. Each composes events, the ledger, today's transcript and memory, plus health through the composer. A nightly model plan re-times them, and owner pins win. They go to app Main chat, with a Telegram copy if linked. | 3 `day_card` and 9 `day_plan` ok. The 08:00 IST Brief ran on 13 Oct. | A card is skipped on the model's SKIP, the plan's skip, `daily_brief` off, a slot that has passed, or an unconfirmed zone. Quiet hours hold a card until the heartbeat releases it. |
| **Health-aware planning** | Partial. Card turns get zone words for Recovery, Form plus trend, and Load, gated on live consent. Without consent there's no invented score. | `health_context` present 29, absent 9 | The plan's timing ignores health. Load is likely unavailable [inference]. |
| **Calendar tools** | `query_calendar`; `query_availability` (free windows); `propose_calendar_change` (create, move or cancel, running on approval); pre-event prep (a 10-minute sweep with a 40-minute lead; on in staging) | 6 calendar queries; no change proposals; no prep sweep seen | No decline or RSVP. Prep has not been seen running. |
| **Calendar demand → Weight** | Yes: busy minutes from Google free/busy, through a signed call to the owner object | Not observable | Prove one live `calendar_demand` hop |
| **Proactivity engine** | `heartbeat_tick` every 30 min, with no model call: past-due loops (up to 3), re-notifying after 4 h, and releasing held cards. Follow-ups and prep pass a gate: kill switch, opt-out, Google, volume and quiet hours. | 175 heartbeats and 179 machine turns ok; no heartbeat delivery; 3 reminders | No pattern nudges. Quiet hours are off by default. |
| **Patrol** | A runs ledger (heartbeat, reminder, standing order, event). The `patrol` schedule kind has no executor. | Served to the app as `controls?view=activity` `runs` (see C), but unwired | App wiring; a product read of each run kind |
| **Spots** | Nightly consolidation and claim promotion | 5 `nightly_memory` and 5 `constellation` ok. Served to the app through constellation memory views (see C). | Reads need app wiring. Confirm, dismiss and forget need backend actions. |
| **Push** | No. Contract, policy and a candidate custody migration only; no sender. | None | All of it, plus the Expo token contract change (see C) |

**The wake bug: confirmed in source, narrower than first reported** (not reproduced).
- **Mechanism:** an app send pulls the single alarm to now + 250 ms. The drain then ends in `rearmSharedAlarm(storage, null, now)` (`telegram-owner-do.ts:792`), which can call `deleteAlarm()`.
- **A normal send recovers.** But a duplicate send (the same `client_message_id`), or a drain finishing inside 250 ms, loses the alarm. Cards, heartbeat and the nightly run then stop until the next app send.
- **Fix [proposed]:** `scheduler.rearm()` at that line, with a duplicate-send test. Ansh's lane has a committed wake fix that isn't opened as a PR yet.

**Reconciled:**
- The four approval-decision 503s in the tail were all the P1 email sends before #1115, whose outcome was unknown. They don't block every approval.
- Patrol and Spots *are* reachable through `controls`, per C.

## B. Health plane, background sync and scores (why Form and Weight are unavailable)

**Bottom line:** there's no background sync. iOS uploads only while the app is open, at most every 10 minutes (`useHealthIngest.ts:12-16`). Form and Weight fail for three reasons:
1. stale stored rows;
2. no qualifying data from an iPhone alone;
3. logic gaps.

| Score or path | Requires [verified in source] | Likely state, iPhone only or Simulator | Fix and owner |
|---|---|---|---|
| iOS upload | The app in front | Only while open; there's only an entitlement, no background code | N4 lane (running) |
| Android, Watch | — | Samsung gives a snapshot only; upload is iOS-only; the Watch app only displays | App lane, later |
| Recovery | Last night's time asleep and its midpoint; 14 earlier nights; HRV or resting heart rate with 14 days of history | `missing_sleep`: an iPhone alone records only time in bed, and those nights are dropped [inference] | Owner: the data source; App lane: hints |
| Form (`form.candidate.v2`, live) | Recovery's inputs; the newest hourly reading under 6 h old; 8+ hours today and on 14 earlier days | `missing_sleep`, then `intraday_inputs_unavailable`: hourly readings need a Watch [inference] | Backend lane |
| Weight | Meeting minutes today and on 14 earlier days, but only on days with health readings (`producer.ts:206,211`) | No row at all, so `no_readings` | Backend lane: stop tying Weight to health days |
| Calendar demand | Google free/busy through a signed Worker call; the availability and calendar_list scopes | Wired end to end but never run. The 401s in the tail were L1's unsigned probes, which is expected. | Owner: connect Google with both scopes |
| Sleep debt | 14 nights | Computed, then dropped: not stored and not in app.v1 | Backend lane |

**Correctness bugs:**
- **Form scores 100 on missing data** [verified]. `dayTotal` counts a missing value as 0 (`form.ts:25`). Heart-rate-only hours give z = 0 against an all-zero history, so the score is 100. That's invented readiness, which CLAUDE.md forbids. **Backend: fix first.**
- **Stress ignores Apple's HRV:** it accepts only RMSSD, and Apple reports SDNN (`form.ts:30`).
- **Stored scores never age:** they're always marked `fresh`, and nothing recomputes them. Between app opens, Form keeps its last value.
- **The live account's stored row** predates Weight: the last uploads were at 13:24Z on 12 Oct, and Weight shipped at 19:34Z. Scores recompute only when an upload adds samples.
- **Zone clipping:** on hold. #1083 (Form `safte-fast.v2`) is parked. It makes HRV required, so iPhone-only owners would lose Form, and the owner wants ADR-0081 amended first.

**Body screen words:**
- Weight still says the calendar isn't used "yet", which has been false since #1089.
- The missing-sleep and missing-resting texts don't say what fixes them.
- The "stale" and "expired" labels can never appear.

**Getting scores on the Simulator, in priority order:**
1. **The owner** decides whether seeded Simulator Health data is allowed under the real-data rule. With no data there's no upload, and no score.
2. **App lane:** seed 15 or more days of sleep stages, HRV, resting heart rate and 8+ hourly readings a day. The keychain watermark then limits uploads to the last 24 h.
3. **Backend lane:** connect Google with both scopes, and check the `calendar_demand` and `weight_demand` codes.
4. **App lane:** fix the Weight text, add hints to use a Watch or a sleep app, and re-read scores after each upload.
5. **Backend lane:** count missing values as missing, not 0; age stored scores; decide #1083.

## The owner's top blockers, combined

1. **Invented readiness (backend, fix first):** Form scores 100 when data is missing.
2. **The wake bug (backend):** a duplicate send can stop every scheduled card until the next message. The fix is committed in Ansh's lane.
3. **No background sync (N4 lane, running).** Stored scores never age, and Weight is tied to health days (backend). Sleep debt is dropped (backend).
4. **The app is unwired to data it already has:** Home load (#106), Patrol runs, Spots reads, chat Stop and rating, Body history, device registration.
5. **Backend routes are missing:**
   - the Brief text (`cards[].latest`);
   - the calendar line;
   - health detail series;
   - profile;
   - the Spots actions;
   - threads;
   - push (sender plus Expo token contract).
6. **Owner decisions:**
   - seeded Simulator Health data versus the real-data rule;
   - connect Google with the availability and calendar_list scopes for the test account;
   - the deploys;
   - whether the Watch ships;
   - B2's migration.
