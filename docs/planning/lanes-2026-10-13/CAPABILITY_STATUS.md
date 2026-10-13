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

Pending. The audit is still running.
