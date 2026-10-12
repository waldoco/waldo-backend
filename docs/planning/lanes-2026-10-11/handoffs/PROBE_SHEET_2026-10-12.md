# Probe sheet, 12 October 2026

**Account:** the Telegram-linked test account the owner named in the orchestrator's session. L1 holds the address; it is not written here.

**Who does what:**
- L4 sends from the Simulator, signed in as that account. The owner types the emailed code.
- L1 reads the tail.
- Each lane needs the owner's go in its own session.

**What to record:** pass or fail, reason codes and times. No health values, and no message text beyond the probe prompts.

**Never run deletion (GP-10) on this account.** It needs a throwaway account.

On a Telegram-linked account, reminders arrive in the app, but day cards, heartbeat and nightly run on Telegram [verified at `e37f60f3`: `telegram-owner-do.ts:1272-1281`, `:1337-1345`]. A day card arriving in the app needs an app-only account, or E15's app-first routing on 13 Oct.

## Now, on staging `e37f60f3` (wave 1)

| # | Pillar | Send in Main chat | Pass | L1's tail |
|---|---|---|---|---|
| 1 | P6, GP-4 | "Reply with one short sentence confirming you got this." | The reply appears under the message, and the receipt reads `completed` | No `history_conflict` and no strict-load failure |
| 2 | P4 | "Remind me in 10 minutes to stretch." | A Waldo reminder row is in Main chat within about 11 minutes, after a refresh | The reminder fires through the app runtime, with no `reminder failed` |
| 3 | P5 (#1084) | "Connect my Google." | Waldo points to Connections in the menu and never claims a button or link in chat | No connect link is minted on the app |
| 4 | P5 | Only if Google is connected: "What's on my calendar tomorrow?" | Real events are listed | The calendar read is `ok` |
| 5 | W2 (#1076, #1085) | Only if Google is connected, with a test event at 4 pm: "Move my 4 pm to 5." Tap "Not now". Ask "What's waiting on me?" Ask "Bring it back." | A card appears; "Not now" puts it off; Waldo names it; a fresh card appears | `deferred_at` is set; the raise is `shown_on` the app |

## At 16:00Z

| # | Pillar | What happens | Pass | L1's tail |
|---|---|---|---|---|
| 6 | P4 | The Close fires at its default 21:30 local, which is 16:00Z on IST | It arrives on the account's Telegram | `card:close` is armed on the Telegram channel and delivered |

## After wave 2 (about 14:00Z, with the owner's go in L1's session)

| # | Pillar | Send in Main chat | Pass | L1's tail |
|---|---|---|---|---|
| 7 | P3 | "Prep me for my 3 pm." | The meeting-prep skill loads in app chat | A skill-load line for the app turn |
| 8 | #1086 | None | No hold-row flood; each held row carries only its fixed code | `scheduled_hold` and `scheduled_drop` notes are codes |

The results feed the 17:00Z re-score of `PILLAR_SCORECARD_2026-10-12.md` and the scorecard page.
