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

Pending. The audit is still running.

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
