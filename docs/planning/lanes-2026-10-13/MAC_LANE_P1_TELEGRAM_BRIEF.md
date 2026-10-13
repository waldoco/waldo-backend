# Mac lane P1: the baseline scenarios on Telegram (diagnostic only)

Launched by the Mac orchestrator on 13 Oct 2026, about 20:45Z.
- **Why Telegram:** the app re-run (P0) stopped at 20:16Z, when the Air's app session hit its fixed 12-hour expiry. A human must sign in again, so the app can't be tested tonight.
- **What this run is for:** it is diagnostic only. Telegram evidence proves nothing about owner promises (Bible law 10), and the app stays the main surface. It also checks that the Telegram path survived the `v6` rename (staging release `7ba2e7f9`, since 19:27Z).
- **Owner's word:** before sleeping, the owner allowed testing on Telegram as needed.

## Where

- Telegram Web in the built-in browser: tab `tab-6`, the chat with the "Waldo (staging)" bot (@sf_poster_bot), signed in as the owner.
- **Use only that bot chat.** Never open, read or quote any other chat, and never message anyone else.
- **Never copy links, tokens or console URLs** from the chat; earlier bot messages contain one-time console links. Summarize replies in your own words.
- Don't paste screenshots anywhere.

## Traces

Run the same staging tail as P0: `MAC_LANE_P0_RERUN_BRIEF.md`, with its double `fromjson` parse. Write it to a new file, `p1-tail.jsonl`, in the scratchpad. Never quote raw lines, and stop the tail at the end.

## Scenarios

Send these texts exactly, one at a time, and wait for each reply: poll about every 10 s, for at most 3 minutes.

1. S2: What's on my calendar tomorrow, and where's a free hour after lunch?
2. S3: Honestly today was rough. Everything slipped and I'm behind on all of it.
3. S4: Can you book me a table for two tonight somewhere nearb. This is the baseline's exact, truncated text; send it as-is.
4. S5: For a long flight, which is better: Sony WH-1000XM5 or Bose QC Ultra? Check current prices.
5. S6: Email Sam that the meeting room moved to 4B.
6. S8: What do you still need from me today?
7. S9: Let me know if I get a reply from the agency this week.
8. S7: Check back with me in 5 minutes about whether I've drafted the launch email. Then send nothing for 7 minutes, waiting in chunks of 2 minutes or less, and read what arrives.
9. S1c, the recall check before forgetting: Who is my main contact for the Q4 launch?
10. S1b: Please forget that Priya is my main contact for the Q4 launch.
11. S1c again: Who is my main contact for the Q4 launch? Expected: it no longer knows. Saying it was asked to forget is fine.

**Clean-up:** if S9 or S7 set a reminder dated after tonight, ask Waldo to cancel that one reminder, and confirm the reply.

**Rules:**
- Approve, send or confirm nothing. If Waldo offers to email Sam or proposes any action, don't approve it; reply "Not now".
- Seed no data.

## Output

Write `p1-telegram-scorecard.md` in the scratchpad. It has:
- one row per scenario: the verdict (PASS, PARTIAL or FAIL), the turn time, model calls, tools with timings, errors and a one-line reason;
- a column for the Phase 0 app baseline (#1103 6152381089), noting that the surface differs;
- the trace ids.

Then a short summary covering:
- whether the Telegram path works after `v6`;
- whether S5's browse tool fails;
- whether the S7 check-back echoes or does real work;
- whether forget works;
- any regression.

Rules: no subagents, keep each tool call under about 2 minutes, and don't post on #1103. Report back to the orchestrator.
