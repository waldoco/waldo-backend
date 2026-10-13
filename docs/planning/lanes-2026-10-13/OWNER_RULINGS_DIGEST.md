# Owner rulings digest, as of 13 Oct 2026, 14:38Z

This digest lets cloud sessions follow the owner's rulings. The full notes live in the orchestrator's memory on the owner's Mac, which cloud sessions can't read. Rulings decide what is wanted; source and tests decide what is shipped. Where a later ruling conflicts with an earlier one, the later one wins.

## Standing rulings (10–12 Oct, summarized)

- **App-first, one brain.** The app chat is the core; other surfaces are extensions. Telegram is a dev surface. Threads live in the app and console only.
- **Ship every website promise,** honestly. Sole writer per aggregate, connector scope as approved.
- **The real-data rule:** the app shows only what's served. As of 13 Oct this is narrowed: sample data is allowed only when labelled (see Suyash below). No TestFlight for now.
- **Three scores.** Form keeps stress, through an ADR amendment. Health strip versus the history plane is ruled separately. Replies are stored as written.
- **Time zone:** the owner-set zone wins. The device zone auto-writes only over the default 'UTC'.
- **Onboarding:** invite-only; Google sign-in with verified-email linking; arm on first app use. No Apple sign-in for beta.

## 13 Oct (the owner was awake from about 04:18Z)

1. **App first, Telegram aside.** Feature-complete on the Simulator first; phones later.
2. **The browser runs on Cloudflare, not Browserbase.** #1110 admits app owners onto the Cloudflare paths, with Browserbase off.
3. **Threads ("session chats"): yes.** Build the runtime for the existing app.v1 threads contract.
4. **Push: yes.** Expo push stacks on B2 (the 30-day session, #1133), and the owner applies its migration.
5. **The three tabs:** Home, Body and Waldo.
6. **Seeded Simulator Health data** only on a separate app-only test owner. Never on the shared test account, and never on the Air, which is the owner's own account.
7. **The Apple Watch ships,** with real data or an honest unavailable state. Phone-to-Watch scores: yes, bounded. Scores only, no raw readings, only while storage consent is live, never logged, cleared on sign-out or withdrawal.
8. **Calendar QA:** "QA" events only, with no attendees, at most 3 a day, on the test account only, all through Waldo's approval card. The events stay in place.
9. **Home matches the website's example screens** within the design system. Home order:
   1. a swipeable updates stack, where the Brief is always present (a status line when nothing is new);
   2. "Waldo is carrying", hidden until outcomes are served;
   3. "Needs your yes or no";
   4. To send;
   5. the Ask Waldo bar.
10. **Patrol and Spots** open from Settings rows and chat's inline cards, not from Home.
11. **Buttons:**
    - Buttons name their effect ("Move to Thu 11:00", "Send with Gmail"). The soft no is "Skip", and a final no reads "Not doing".
    - "Done" only after the action is checked; "Unconfirmed" when the outcome is unknown.
    - "Checked N things" shows the specific lines, never a count.
    - Examples that need a connector we don't have are hidden.
    - Inline draft editing comes later; edit in chat for now.
12. **The Brief's sleep chip** may show a raw sleep duration. The chip carries a ref, and the app.v1 read fills its label from the health plane at read time. The model and the stored card text never hold the number, and it isn't logged. Needs an ADR-0081 destination note.
13. **The C trail** may name events and emails in the app. Its storage needs a bounded contract review first.
14. **The mic:** a speech package is approved for the Ask Waldo bar. Propose an on-device recognizer first. **Undo:** decisions made from Home show an Undo window.
15. **Sweep cards:** Waldo fetches the latest across connected tools and posts update cards. Build after #1119.
16. **Google publishing and verification come later.** The Google Workspace work is with Ansh's cloud lane.
17. **The agent's health read tool (`get_health`): yes.** Check consent on every call, and never log values.
18. **Time zone,** 10:31Z, agreed:
    - store UTC instants and the owner's IANA zone, and convert at the edge;
    - the app's health upload uses the saved zone;
    - test travel by changing only the Simulator's or the app's zone;
    - audit every backend "today".
19. **#1147: yes, for staging only.** Gmail, Calendar and Drive-metadata reads go through Google's Developer Preview MCP servers without a per-read button. Production is unchanged, and the gate still applies. The owner deletes the staging secret and runs both deploys.
20. **Suyash's design pass: yes.** Sample data must carry a visible "Sample" label and live only in `src/prototype/`.
21. **iMessage becomes the messaging surface, and Telegram is retired,** eventually. Keep Telegram until iMessage has carried real use. #1095 is a draft, and the Mac host (Ashish) is the critical path.
22. **The memory and proactive-logic audit:** planned for after the reset. The owner approves the scope.

## 13 Oct afternoon (about 14:15Z to 14:38Z)

23. **App work is stopped for now.** Suyash is making UI/UX changes and mapping what doesn't work; afterwards, each item is made to work with the backend. The open app PRs stay unmerged at their heads. Nothing that needs a new app pin is emitted (#1167 stays held). Hand-off 2 must be safe for the installed app.
24. **The focus is Waldo's backend capabilities and the agent loop itself.** The pains, in the owner's words, are "loses context", "weak follow-through" and "judgment" (asks when it should act, or assumes when it should ask). Slow turns were not picked, so latency comes after these.
25. **The nightly model-graded eval on staging: yes.**
    - It runs on a separate test owner with synthetic data, and a model grades the outcomes.
    - The scorecard goes to #1103, with no health values in the output and a bounded number of model calls per night.
    - It starts from the 20-task set, plus recall and check-back scenarios.
26. **The conversation compaction ADR: yes, draft it.** The owner reviews it before anything is built. The transcript keeps every row.

## Still open (ask the owner)

- The other health destinations: chat pins, approval details, charts, health-derived Spots.
- Whether Waldo's own consent should gate on-phone display reads.
- Standing grants for Patrol's "fixes small problems overnight".
- Staging trace capture of health-log tool input and output.
- How approvals work in chat after a decision: (i) or (ii). The orchestrator recommended (ii), `approval_ref`.
