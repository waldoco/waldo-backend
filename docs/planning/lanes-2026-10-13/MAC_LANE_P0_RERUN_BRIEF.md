# Mac lane P0: re-run the Phase 0 baseline after the deploy

Launched by the Mac orchestrator on 13 Oct 2026, about 20:15Z, on the owner's word before sleep: "test on current app and telegram as per need". Staging moved from `ea41bb0e` to `7ba2e7f9` at 19:27Z, a jump of 22+ merges plus the `v6` rename. This run measures what changed against the Phase 0 baseline (#1103 6152381089), and catches regressions.

## Device and access

- **Device:** the iPhone Air Simulator `3C3634A0-90F2-46B5-A032-BEF0CE128D6E`. It runs the installed app build `7e09317c`, signed in as the owner. Use the iOS Simulator control tool, with screenshots, taps and text.
- **If the app is signed out,** stop and report. A human signs in once per device. Never type codes or passwords.
- **Telegram is diagnostic only** (Bible law 10). This run is app-only.

## Traces

Start a staging tail in the background before the first message, from `packages/runtime` in any checkout of this repo:

`npx -y wrangler@4 tail --env staging --format json | jq -c --unbuffered '{t:.eventTimestamp, o:.outcome, logs:[.logs[]?.message|tostring], ex:[.exceptions[]?.name]}' > <scratch>/rerun-tail.jsonl`

- **Steps per turn:** `.logs[]? | (try (fromjson | .[0] | fromjson) catch null) | select(type=="object" and .hop != null)`. The logs are stringified arrays, so parse them twice.
- **Stop the tail** when you finish.
- **Never quote raw tail lines anywhere.** They carry owner ids.

## The scenarios

Scroll up in the app's chat to the nine baseline messages, sent 17:06 to 17:48Z on 13 Oct (22:36 to 23:18 IST), and **reuse their exact text**. Then send them one at a time, in the baseline order:

1. S1, the memory plant
2. S2, the calendar
3. S3, listening first
4. S4, booking
5. S5, research
6. S6, ask versus assume
7. S8, what needs me
8. S9, watch
9. S7, the check-back, last

**Known texts:**
- S2: "What's on my calendar tomorrow, and where's a free hour after lunch?"
- S3: "Honestly today was rough. Everything slipped and I'm behind on all of it."
- S5: "For a long flight, which is better: Sony WH-1000XM5 or Bose QC Ultra? Check current prices."
- S7: "Check back with me in 5 minutes about whether I've drafted the launch email."

**S1:** recall already passed at 19:59Z after the deploy, so send S1 again only if its fact is no longer recalled.

**Rules while sending:**
- Wait for each reply before the next message: poll with screenshots about every 10 s, for at most 3 minutes per turn.
- After S7, send nothing for 7 minutes. Then read what the check-back delivers.

**After S7, two extra turns:**
- **S1b, forget:** "Please forget that Priya is my main contact for the Q4 launch."
- **S1c, check:** "Who is my main contact for the Q4 launch?" Expected: it no longer knows. Saying it used to, but was asked to forget, is fine.

## Rules

- Tap no approvals, seed no data, and message nobody else. If an approval card appears, leave it.
- Never record health values, email contents, the staging URL or the test account's email in any output.
- No subagents. Don't post on #1103; the orchestrator posts.
- Keep every tool call under about 2 minutes, so the run never looks stalled.

## Output

Write `rerun-scorecard.md` in your scratch directory and report it back to the orchestrator. It has one row per scenario:
- the baseline verdict and turn time, from 6152381089;
- the re-run verdict (PASS, PARTIAL or FAIL) and turn time;
- model calls;
- tools, with timings;
- errors;
- a one-line reason.

It also lists the trace ids. Then give a short list of regressions, what improved, and what is unchanged. In particular, check whether S5's `browse_page` still fails, whether S7 still echoes, and whether the turn times moved.
