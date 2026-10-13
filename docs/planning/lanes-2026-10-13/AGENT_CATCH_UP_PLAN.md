# Catching up to Instinct: where Waldo is behind, and the plan

**As of 13 Oct 2026, 16:51Z, from the Mac orchestrator, for the owner and the cloud sessions.**

**Frame (owner rulings 23–29):**
- The app is paused while Suyash reworks its UI.
- iMessage becomes the surface.
- The work is the agent itself, ordered by the owner's three pains: context, follow-through and judgment.

**Sources:** the evidence matrix in [`WALDO_VS_INSTINCT_CAPABILITY_GAP_2026-10-13.md`](../../research/WALDO_VS_INSTINCT_CAPABILITY_GAP_2026-10-13.md); the harness comparison (#1169); open PRs as of 16:40Z; `beta-mvp` at `aae96328`. Staging still runs `ea41bb0e`.

## 1. Where we are behind

### On the surface: iMessage and onboarding
1. **iMessage isn't live.**
   - The backend connector is merged but default-off (#1017 and #1162, merged by Ashish at 15:46Z without a gate review).
   - The host's real send is disabled, and the host has never talked to the real backend (`waldo-imessage-host` #1).
   - Still to come: the owner steps, the physical setup (a Waldo Apple Account on the Intel iMac), and switching the connector on.
2. **Onboarding is per owner and runs through the console.** The steps today:
   1. an admin invites by email;
   2. the user signs in to the app with an email code;
   3. someone pairs a host Mac with a one-use invitation;
   4. someone sets the exact sender, with a one-use challenge;
   5. someone confirms.

   Each owner needs their own bridge. With Instinct, you text a number. The missing pieces:
   - **A shared Waldo line:** one bridge, with each sender's handle routed to its owner (`WALDO_NUMBER_SETUP.md` step 4, not built).
   - **Text-first onboarding:** an invite code by text, consent capture, and Google connect by link. This needs a design and an ADR (handle-to-owner identity binding, consent, Art. 9).
3. **Proactive work doesn't reach iMessage.** The Brief, reminders, check-backs and standing orders go to the app plus a Telegram copy (`owner-do.ts:1517`). Ruled yes at 15:13Z; not built.
4. **Approvals on iMessage show only in the app** (`owner-do.ts:2133`). Ruled: an app link now, numbered replies later. Not built.
5. **Photos and voice notes over iMessage:** what reaches the model is unverified. Telegram does it (`telegram-media.ts`), and the app takes text only.

### In the agent loop (the three pains)
- **Context.**
  - The window keeps about 100k tokens and drops the oldest turns with no summary (#1169 §4.4). Compaction ADR: yes, not drafted yet.
  - What the nightly pass learns doesn't reach the model (#1149, in review).
  - Memory has no person kind, so there are no people or birthdays (ruling needed).
  - Claims have no world-time validity window (#1169 §11.3).
- **Follow-through.**
  - The wake fix (#1128) is merged but not deployed.
  - An uncaught throw in the alarm handler has no fallback re-arm (#1169 §3.2).
  - Wakes have no single arbiter (§3.1).
  - Repeated schedule failures are never shown to the owner.
  - The heartbeat lists past-due loops without a model call.
  - There are no general watchers ("watch X, tell me when Y").
  - Patrol has no executor (needs a standing-grants ruling).
  - Push to the app needs the owner (#1177, #1133).
- **Judgement.**
  - The ask-versus-assume threshold leans towards assuming.
  - There's no listen-first or challenge-without-taking-over line.
  - Limits are disclosed only reactively.
  - **There is no eval**, so none of this is measured. The nightly eval is ruled yes and not built.

### Reach (what Instinct does that Waldo can't)
- **No browser for app or iMessage owners** until the owner binds Browser Rendering (#1120) and #1110 lands. Until then, research stays at the level of search snippets.
- **Missing, and each needs a ruling first:**
  - messages to other people;
  - people and contacts;
  - booking, spending and ordering;
  - location and maps;
  - spreadsheets, slides, images and read-aloud;
  - agent-to-agent coordination.
- **In flight:**
  - #1174: calendar invites with guests;
  - #1165: reply-all;
  - #1150: Sheets and Slides reads;
  - #1109: meeting prep reads mail;
  - #1105: the Gmail body;
  - #1154 and #1175: Calendar and Gmail push wakes;
  - #1178 (draft): `use_mac` through the device bridge.

### Proof
**Nothing measures the agent end to end.** The 20-task set exists only as prose (gap doc §6), and #1037's eval catalog is a draft.

## 2. How we catch up

| Phase | What | Owner | Gate or step |
|---|---|---|---|
| **0, now** | **Baseline:** run the 20 tasks, plus recall, check-back and ask-versus-assume, against staging `ea41bb0e` through the app build or Telegram. Read each trace in Langfuse and Cloudflare. Post a scorecard on #1103. | Mac | Test account and QA rules (gap doc §6) |
| **1** | **Hand-off 2:** gate #1172 and the post-merge iMessage review (6149659751), then the owner's hand deploy, then a baseline re-run to measure the change | Lead; the owner deploys | Forward-only (`v6` and `v7`); migrations in timestamp order, iMessage's `20261012000000` first |
| **2, context** | #1149 → the compaction ADR (owner review) → build; #1078 counts what each call leaves out | Lead | ADR before build |
| **3, follow-through** | Alarm re-arm, the wake arbiter, and surfacing schedule failures; proactive delivery to iMessage; the approval link on iMessage; push (#1177) | Lead and builder | Owner steps for #1133 and #1177 |
| **4, judgement** | The nightly eval on a test owner, built from the gap doc §6 and #1037 → prompt amendments through the soul-file review (stakes-based asking, listen first, challenge without taking over, up-front limits) → measure the eval change | Lead; Suyash for voice | Every judgement change comes with a scenario; no fixed rules |
| **5, iMessage live** | The host's real send and interop, then the owner steps and physical setup, then the first live round trip, then the shared line and text-first onboarding (design and ADR), then Telegram retires after real use | Ashish, owner, Mac, lead | ADR for the shared line and onboarding |
| **6, reach** | Owner binds #1120, then #1110. Then, as rulings land: people, messaging others, spending, location | Lead, Google lane | Rulings first |

## 3. Open PRs by gap (16:40Z)

- **Hand-off 2:** #1172 (receipt line).
- **Context and safety:** #1149, #1155 (tool output is data), #1114 (codes kept out of context), #1078 (draft).
- **Follow-through:**
  - #1154 and #1175 (push wakes; #1175 needs the owner);
  - #1108 (jobs run as the admitted owner);
  - #1072 (draft);
  - #1177 and #1133 (push; both need the owner);
  - #1173 and #1176 (threads);
  - held for the app: #1138 and #1153.
- **Honest wording:** #1156, #1158, #1163, #1164, #1171. #1167 is held for the app.
- **Reach:** #1110 and #1120 (browser), #1165, #1174, #1150, #1109, #1105, #1168, #987, #1178 (draft), #1043 and #1042 (drafts).
- **Health:** #1127 (needs the owner), #1152, #1083, #1159 (draft).
- **Ops:** #1113 (needs the owner), #1081, #1082, #1038, #1033.
- **iMessage:** close #1095 as superseded.
- **Docs:** #1169, #1170, #1077, #1037.
- **Triage** (drafts from 11–12 Oct, probably superseded): #1071, #1063, #1058, #1057, #1046, #1036, #1035, #1032, #998, #973, #915, #907, #905, #902.

## 4. Rulings still needed
1. The shared iMessage line and text-first onboarding (identity binding and consent).
2. The people and contacts scope.
3. Messages to other people.
4. Booking and spending authority.
5. Location.
6. Standing grants, for watchers and Patrol acting unattended.
7. #1113 (guards and the cost ledger).
