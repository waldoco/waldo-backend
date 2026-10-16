# Acceptance probes for the website promises

Audit lane, 11 October 2026. One probe per promise in `WEBSITE_PROMISE_LEDGER_2026-10-10.md` §4 and §5. A probe passing on the app moves the row to `proven`; a Simulator pass is recorded as `proven (Simulator)` and never clears a device promise.

**Rules for every probe.**
- Account: a dedicated staging test account with synthetic data, never the owner's. Health readings are synthetic and no raw value is written into any ledger, comment or trace note.
- Go: a probe that signs in, sends a message, spends a model call or touches Google runs only with the owner's go for that probe. Read-only probes (`/healthz`, `GET` routes on an already signed-in test session) need none.
- Pins: record the staging release from `/healthz`, the app commit and the time (UTC) with every result.
- Evidence to capture, always: the HTTP status and receipt state or the on-screen state, a screenshot or recording with no health values visible, and the #116 comment id where it is posted. Tests are reported PASS, FAIL, NOT RUN or UNAVAILABLE at an exact SHA.
- Device probes run on a physical iPhone or Watch (L4 or Suyash). The audit lane runs none; it records what lanes report, tagged `[reported]` until it has seen the evidence.

## Health

| Promise | Surface | Preconditions | Steps | Expected receipt or state | Evidence |
|---|---|---|---|---|---|
| Recovery | app (Health Stats, app #53) | test account signed in; both agreements on; a backfill of at least 14 synthetic nights accepted | open Health Stats; pull to refresh | `GET /app/v1/health/scores` 200 with a Recovery entry, activation `candidate_unaccepted`, a zone, and a `day` equal to today or yesterday | status and the activation and `reason` fields; screenshot |
| Form | app | as Recovery, plus synthetic HR/HRV readings within the last 6 hours | upload (foreground); open Health Stats | Form present with a value, not `stale_inputs` | the `reason` field before and after the fresh upload |
| Weight | app | as Recovery; Google Calendar connected on the test account | open Health Stats | today: `calendar_demand_unavailable` (documents the gap); after the demand input lands: a value | the `reason` field |
| Sleep debt | app | as Recovery | open Health Stats | today: absent (gap); later: a sleep-debt entry in the scores response | response keys |
| Quiet flags | app | synthetic SpO2 and respiratory-rate readings with one night deviating from the rest | upload; open Health Stats and the Brief | today: nothing (gap); later: one quiet flag naming the signal, non-diagnostic copy, no raw value | screenshot |
| Training | app and chat | one synthetic workout overlapping a calendar event | upload; ask "how did my workout land today?" | today: the model answers without a Training score; later: a Training line referencing the workout and the meeting | chat row text; no raw values |
| Weather and daylight | chat | location consent granted on the test account; `get_weather` registered | ask "do I get daylight before my first call?" | a reply using daylight and weather with a receipt naming the provider | chat row; tool trace hop |
| Your history | app | 30-day backfill accepted | open All Data; tap one day | today: placeholder (gap); later: 7/30/90 dots and a day view with that day's scores and what Waldo did | screenshot |
| Bring your past | app, physical iPhone | fresh install; Apple Health has at least 30 days of data on the device | sign in; grant both agreements; connect Apple Health; wait for the runner | ingest receipts for 30 day-chunks, oldest first; Recovery not `baseline_immature` | ingest status rows (`httpStatus`), scores response, device model and iOS version |
| Background delivery | physical iPhone | as above; app backgrounded overnight | next morning before opening the app, read scores from a second session | a new ingest receipt stamped overnight | receipt timestamps |
| Consent withdraw | app | both agreements on with data stored | switch model use off; ask about health in chat; switch storage off | model use off: chat says no health shared, scores still 200; storage off: 200 with no rows and ingest refused | three responses |

## Day to day

| Promise | Surface | Preconditions | Steps | Expected receipt or state | Evidence |
|---|---|---|---|---|---|
| The Brief | app (app-only test account, never Telegram-linked) | time zone set in the app; `daily_brief` on; test clock or wait to 08:00 local | open Main chat at or after 08:00 | a Brief row in the transcript, authored by Waldo, with readable `text`; the `day` view shows `sent` for the card | transcript row id, card `sent`, time |
| The Window | app | Form available; a free stretch in the calendar | open the Brief | today: nothing (gap); later: a proposed block, and a blocked event only under a calendar `auto` grant | calendar readback |
| Prep | app | Google Calendar connected; one event 45 minutes ahead with attendees | wait for the sweep | today: nothing in the app (Telegram-only exit); later: a Prep row 35–40 minutes before the event naming attendees and open items | transcript row, time to event |
| The Heads-Up | app | as the Brief; one pattern promoted | open Main chat at or after 14:00 | today: a check-in card; later: a heads-up citing the pattern | transcript row |
| The Close | app | as the Brief; one calendar move made through Waldo today | open Main chat at or after 21:30 | a Close row with tomorrow's calendar and a "moved / protected" count equal to Waldo's own moves | transcript row, approvals list |
| The Adjustment | app | seven days of cards on the account | Sunday evening | today: nothing (gap); later: one weekly card | transcript row |
| Your best hours | app | weeks of intraday signal or a backfill | open the Brief | today: nothing (gap) | — |
| The right task | chat and app approvals | Google Tasks connected with tasks on two lists | ask "what should I do first?"; accept a proposed task change | tasks from both lists; one `google_task_change` approval; after approve, readback shows the change | approval id, receipt state, Tasks readback |
| Fewer pings | app | Gmail connected; three low-value mails and one urgent mail arriving in ten minutes | wait one sweep | today: nothing (gap); later: one surfaced mail and a batched note, with delivery never held | transcript rows and times |
| Fixed first (Patrol) | app | one past-due open loop; one standing grant | wait for the heartbeat | today: a list of past-due loops (Telegram) or nothing in the app; later: the fix applied under the grant, then one line reporting it | transcript row, activity entry with the grant id |
| Patterns | app (Spots) | ten days of synthetic health and calendar data with one repeating pattern | open Spots after the nightly run | today: placeholder (gap); later: one named pattern with its numeric delta and a confirm/dismiss control | screenshot |
| The Slope | app | four weeks of data | open the Brief | today: nothing (gap) | — |

## Talk to Waldo

| Promise | Surface | Preconditions | Steps | Expected receipt or state | Evidence |
|---|---|---|---|---|---|
| Threads | app | signed in | open Chats; start a thread | today: local drafts only (gap); later: a server thread listed on a second device | thread id on both devices |
| Follow up | app | one Brief row present | long-press the row; send "tell me more" | today: no anchor (gap); later: the reply quotes the row and names why Waldo said it | transcript rows |
| Quick replies | app | a reply that asks a yes/no | read the reply | today: text only (gap); later: a `quick_replies` part rendered as chips; tapping sends the chip text | transcript row parts |
| Charts | app | scores for seven days | ask "show my recovery this week" | today: text (gap); later: a `chart_series` part rendered | transcript row parts |
| Full history | app | 60 rows in the main chat | scroll up; tap "Load earlier" twice | pages of 20 with a stable `before:` cursor, no duplicates, no gaps; scheduled prompts not shown as the owner's own bubbles | `next_cursor` values, row count |
| Thumbs | app | one Brief row | tap down on the row | today: nothing in the app (gap); later: a rating receipt; the next Brief changes style, not facts | receipt, next Brief |

## Your rules

| Promise | Surface | Preconditions | Steps | Expected receipt or state | Evidence |
|---|---|---|---|---|---|
| Three levels | app | one area set to ask, one to auto | trigger one action in each | today: no setting (gap); later: the ask area produces an approval, the auto area executes under the grant and reports | approval list, activity entries |
| Always comes back | app (approvals, app #54) | Gmail connected; ask Waldo to send one email | open Approvals; read the exact payload; approve; then skip one browser item | `GET /app/v1/approvals` lists the `email_send` with the exact body; the decision returns `recorded`; the sent mail's Message-ID readback appears; the browser item offers approve/skip only | approval ids, receipt states, readback |
| The activity log | app (Patrol) | one approved action and one skipped | open the log | today: placeholder (gap); route: steps and trace; later: each entry with a reason and "left alone" rows | `controls?view=activity` response |
| Say it once | app | signed in | tell Waldo a preference; correct it; forget it | chat: `remember` then `replaces_id`, then forget; app: today no controls (gap); later: the memory view shows the corrected item then none | tool hops, view response |
| Your schedule | app (Schedule) | signed in | set time zone; set quiet hours; set volume | three `recorded` receipts; `day` view reflects them; a reminder inside quiet hours is held (today it is not: gap) | receipts, view response |
| Yours, always | app (Settings) | test account with data, Google connected | delete with `DELETE`; sign in again with a new invite to the same email | receipt `recorded`; old session 401; new sign-in creates an empty owner (`do_name` differs); no connections, no health rows; R2 and `auth.users` checked by L1 | receipts, session responses, L1's check |
| Export | app | as above | request export | today: nothing (gap) | — |

## Coming later

| Promise | Surface | Preconditions | Steps | Expected receipt or state | Evidence |
|---|---|---|---|---|---|
| Voice | app | microphone permission | send a voice note; ask for a spoken reply | today: text only (gap); later: transcript row with the transcription; audio reply part; spoken "yes" never commits a send | transcript parts |
| Your own routines | app | app-only test account | "remind me in two minutes"; set a weekday standing order | a reminder row in the app at the time; the standing order fires and reports in the app | transcript rows, times |
| Tomorrow, today | app | as the Close | open the Close | tomorrow's calendar preview; later: a readiness forecast marked non-medical | transcript row |
| Other agents ask Waldo | app | a second test owner with a trusted relationship | the second owner asks for availability | today: nothing (gap); later: an availability answer with no health reason exposed | both transcripts |

## Connectors

| Connector | Surface | Preconditions | Steps | Expected receipt or state | Evidence |
|---|---|---|---|---|---|
| Google connect from the app | app (Connections, app #55) | test Google account; owner's go | tap Connect Google; consent; return | `/c/<ticket>` opens with surface `app`; return lands on `waldo://oauth/complete`; `connections` view shows connected; the "connected" notice appears in the app, not Telegram (today it does not: gap) | view response before and after, notice row |
| Google Calendar | chat | connected; events on two calendars | "what's on my second calendar tomorrow?"; "move my 3pm to 4pm" | both calendars read; the move is an approval; after approve, readback and a 10-minute undo offer | approval id, readback |
| Gmail | chat | connected; a thread with 25 messages and one attachment | "summarise that thread"; "archive it" | two pages of the thread; archive: today refused (gap) | tool hops |
| Google Tasks | chat | connected; two lists | "add 'buy milk' to Errands"; "delete it" | create via approval and readback; delete: today refused (gap) | approval id |
| Google Drive | chat | connected; one 20 KB doc | "read my doc" | the first 8 KB, with a note that it is truncated | tool hop |
| Apple Watch | physical Watch and iPhone | Watch paired; Apple Health has Watch-sourced readings | as Bring your past | readings attributed to source `apple`; Watch app: today placeholder (gap) | ingest receipts, Watch screenshot |
| Weather and Location | chat | consent; tool registered | as Weather above | — | — |
| Kennel | chat | Kennel reachable | "fix the failing test in repo X" | today: fake environment (gap); later: a work unit handed to Kennel and reported back in the same conversation | work unit id |
| WhatsApp, iMessage | later | Ashish's adapter | send "hi" | today: nothing | — |

## Queue after the main-chat 503 fix (11 October, 19:30Z)

Proposed in-app probes against staging once L2's fix for the main-chat 503 is deployed. Each needs the owner's go for that probe, runs on a dedicated test account with synthetic data, and is recorded with PASS, FAIL or NOT RUN at the `/healthz` SHA. Steps that enter an emailed sign-in code are the owner's; the audit lane reads results, never the owner's account. Order is by what each later probe depends on.

| # | Probe | Who runs | Preconditions | Expected | Evidence to record |
|---|---|---|---|---|---|
| Q1 | Invite sign-up from the app (O1) | owner (code entry) | a dedicated invite for the test address; app main built from source | `needs_invite` on a bad code; `active` session with `absolute_expires_at` on a good one | session state, HTTP statuses; no code or token written |
| Q2 | Main chat send and history read | owner or L4 | Q1 | reply recorded; `GET /app/v1/chat/main` 200 with the row | status codes; the fixed failure code if 503 recurs |
| Q3 | Day view read | L4 | Q1 | cards, `schedules`, optional `latest` null, `timezone_confirmed` absent or false | the key set returned |
| Q4 | `timezone.set` then day view | L4 | Q3 | `timezone_confirmed: true` once #1066's producer lands; before that, absent | the key set; whether cards re-armed |
| Q5 | Connect Google from the app (G1) | owner (Google consent) | Q1; a test Google account | `/c/<ticket>` opens, return lands on `waldo://oauth/complete`, Connections shows the account | the receipt state; where the "connected" notice went |
| Q6 | One approval decided from the app | owner or L4 | Q5; a proposed calendar change | decision receipt 200; the change in the test calendar; Undo within 10 min | receipt digest match; readback |
| Q7 | Sign out everywhere from the console | L4 | Q1; a console session | the app's next request answers 401 | statuses |
| Q8 | Scores read on the test account | L4 | Simulator health seed (app #29) or a device run | Recovery available or an honest reason; Form `stale_inputs` after 6 h | reason codes only, no values |
| Q9 | Constellations view read | L4 | app controller for `view=constellation` | `state: 'unavailable'` with no memory tables, else a page | state and counts |
| Q10 | Delete the account, then rejoin with the same email | owner (code entry) | Q1–Q7 done; L1 ready to check read-only | `account.delete` 200 `signed_out`, or 503 `rejected` on a failed purge; `auth.users`, refresh tokens and R2 gone; a new invite works | L1's read-only counts; no ids written |
