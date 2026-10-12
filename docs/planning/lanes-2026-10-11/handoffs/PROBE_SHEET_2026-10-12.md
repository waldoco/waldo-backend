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
| 7 | P3 | "Prep me for my 3 pm." | The meeting-prep skill loads in app chat. Needs #1088 (skills on app turns), which isn't in wave 2: don't score it until #1088 deploys | A skill-load line for the app turn |
| 8 | #1086 | None | No hold-row flood; each held row carries only its fixed code | `scheduled_hold` and `scheduled_drop` notes are codes |
| 9 | P4, MUST 3 (#1087) | None. Needs an app-only account with a confirmed zone (the owner's own staging account is app-only) and a calendar event starting in 35–40 minutes | Prep arrives in app chat about 35 minutes before, as plain text with no buttons; a calendar change shows an update card | `calendarPrep` delivered through the final outbox; zero Telegram sends |

The results feed the 17:00Z re-score of `PILLAR_SCORECARD_2026-10-12.md` and the scorecard page.

## Results so far (16:25Z, from L1's whitelisted tail; #116 comment 6128149432)

- **Probe 6: not a pass yet.** The 16:00:00Z alarm composed (`composer_phase:ok ×5`, `health_context:ok:present`), but the viewer kept only 6 hops per event, so delivery can't be seen. The owner can settle it directly: did The Close arrive on the test account's Telegram at about 21:30 IST? Otherwise, retry at the next Close. The viewer keeps 16 hops plus `hops_total` since 16:15:29Z.
- **Probe 8: inconclusive.** There were 0 hold, drop or admission hops from 11:55Z to 16:15Z. That's consistent with no due job for an unconfirmed-zone app owner, but it doesn't prove the path ran.

## Rule for approval-state probes (P1, t3)

"Did it go out?" counts only when a job with 6 or more tool calls (a morning brief, for example) runs between the approval and the question. That is the everyday sequence, and the 6-row tool-result ring would lose the desk line in it (see the #1091 follow-up).

