# Pillar scorecard and plan to EoD, 12 October 2026

The owner asked:
1. How many of the eight pillars every agent product will have are properly built and working through natural language, in the app and on other surfaces?
2. Do they meet the industry standard?
3. How do they map across Waldo's UX and promises, and how much is still left to build?
4. How does Waldo compare with Meta Muse, Instinct, OpenAI Dots, Hermes and other personal agents? And what single plan should we follow to get the promise and the app working end to end by EoD?

The eight pillars:
1. durable workflows
2. computer use
3. memory and skills
4. triggers and scheduled jobs
5. connectors and auth
6. text and voice channels
7. payments and identity
8. evals and observability

## Basis

**Pins**
- Backend `beta-mvp` `889efa27`, read for this scorecard.
- At 03:46Z L1 deployed `cdd906dd` (#1080) to staging as Worker `b72928f0`, on the owner's go. Its only change from `889efa27` is #1080's history-store fix, so the reading below still holds.
- App `main` `6dcba63b`.

**Method**
- Source was read, not run. The only live observation is the Main chat probe at 02:41Z [reported: L4's Simulator sends and L1's log lines].
- Four read-only research agents wrote reports 07–10 in [research-2026-10-12/](research-2026-10-12/):
  - [07 surfaces](research-2026-10-12/07-surfaces-natural-language.md)
  - [08 engines](research-2026-10-12/08-pillar-engines.md)
  - [09 industry bar](research-2026-10-12/09-industry-bar.md)
  - [10 promise mapping](research-2026-10-12/10-pillar-mapping.tsv)
- Earlier inputs: reports 01–06 and the [promise map](PROMISE_DELIVERY_MAP_2026-10-12.md).

**Labels**
- **[verified]:** the orchestrator re-read it at `889efa27`.
- **[reported]:** a research agent or a lane read it, and the orchestrator did not re-read it.
- **[inference]**
- **[proposed]**

No health values appear here.

## Read this first: what EoD can and cannot deliver

**The full goal can't be met by EoD.** The goal is all eight pillars working end to end in the app, on par with Meta Muse, Dots, Hermes and the rest. These parts have external lead times that no lane can compress:
- **Google verification, plus the CASA assessment** for the three restricted scopes, takes weeks.
- **WhatsApp's AI-provider terms bar a general-purpose assistant**, and iMessage has no sanctioned bot route.
- **Google sign-in comes after push (S7)**, by your own ordering.
- **The staging browser binding (#1071) is a held external integration.**
- **Resuming interrupted turns (P1) is not a one-day change.**

**What EoD can deliver, if you answer the decisions below by 05:30Z (11:00 IST):**
- The golden path, observed live in the app on staging.
- **Chat-capable pillars in the app: from 0 of 6 to 2–3 of 6** under the strict test.
  - Must: triggers (P4) and connectors (P5).
  - Should: memory and skills (P3).
- **Approvals (W2), counted separately, should reach "Not now" from the app card.** Asking "what's waiting on me?" needs G1, which is a stretch goal.
- **Push (P6) is a stretch goal**, possible if the APNs key exists by 08:00Z.
- **Review capacity is the binding limit.** Every merge needs CI, an independent review subagent (about 15–20 minutes and up to 200k tokens each) and the advisor, and the 5-hour usage window is shared with the live lanes. Plan on 6–8 gated merges today.
- **A first step on P1, P2, P7 and P8.** Each stays partial and has a dated roadmap entry in section 5.

"EoD" here means 23:00 IST (17:30Z). This is an assumption.

## A. Decisions needed today

Each can be asked with AskUserQuestion. The first option is the recommendation.

| # | Decision | Options | Needed by | Unblocks |
|---|---|---|---|---|
| E1 | **Merge and deploy authority for today.** The overnight go ended when you woke | (a) **A daytime standing go with the overnight gate.** The orchestrator merges after CI (pgTAP included), an independent review and the advisor; L1 deploys `beta-mvp` tips after preflight; the hold list is unchanged. (b) You approve each merge and deploy yourself | 05:30Z | Everything below. Without (a), each merge waits on you, and that is the EoD bottleneck |
| E2 | **#1066's health hold** | (a) **Strip** the health-log numbers from the saved day-card prompt, then merge (O10). (b) Merge as is: owner-channel health is allowed in the beta, but it reaches `conv:*` and the episodes index. (c) Hold | 05:30Z | P4 in the app; GP-8; L3's Brief reader |
| E3 | **Index app chat into episode search and nightly (G3).** This widens where health-bearing text goes, the same question as E2 | (a) **Yes**, under E2's strip rule. (b) Hold | 08:00Z | P3 in the app; part of GP-7 |
| E4 | **#1076 "Not now"** | (a) **Approve L2's proposal:** the DO ALTER `ledger.deferred_at`, its definition of "raises it again", and Telegram's "Not now" (O11). (b) Hold | 08:00Z | W2 in the app; GP-5b |
| E5 | **The APNs key** (your task) | (a) **Create the .p8 this morning** and enter it in the secrets store. (b) Push waits | 08:00Z | Push (P6); GP-9 |
| E6 | **The device routes for push** (`/devices*`): new authenticated endpoints, with the contract already pinned in app #80 | (a) **Approve for staging behind a flag**, with the security checklist's endpoint items (auth, validation, rate limit). (b) Hold | 10:00Z | Push delivery to the phone |
| E7 | **#1071, the staging browser binding, plus browser admission by canonical identity** | (a) **Approve for staging only**, production off. (b) Hold, so P2 stays Telegram-only | 10:00Z | P2 in the app |
| E8 | **Google OAuth** | (a) **Confirm the consent screen is "In production"**: in "Testing", refresh tokens expire after 7 days. Run your consent on staging today, and start verification and CASA. (b) Drop the restricted scopes for launch, which breaks the Gmail and Drive promises | 08:00Z for the consent run | P5 in the app; GP-2 |
| E9 | **Probe sends** | (a) **Allow probes** from your account, or from a test account you create, with L1 reading the tail. (b) Probes wait for you | 10:00Z | Every "verified live" cell |
| E10 | **WhatsApp and iMessage in the beta promise** | (a) **Take both out of the beta copy**, and keep #1017 as a dev surface. (b) Keep "WhatsApp next" | Before landing #18 | Copy rows only |
| E11 | **L3's morning batch**, answered in L3's session | (a) **All recommended options:** open the reminder-push contract PR; ADR-0068; approvals 3a–3e | 08:00Z | Push reminders (W2 of S7); approval card fields |

**Answered at about 04:47Z, in the orchestrator's session:**
- **E1:** (a), the daytime standing go.
- **E2:** strip the transcript copies and build a health-history read, chosen after the owner asked how Waldo can learn patterns without history.
  - #1066 ships today with health-log numbers kept out of chat history and the search index.
  - A governed history read over the health plane follows as a roadmap item.
- **E4:** (a).
- **E8:** (a).
- **About 04:50Z:**
  - E3 (a): index app chat under the strip rule.
  - E6 (a): device routes for staging behind a flag.
  - E7 (a): #1071 and canonical admission, staging only, after the musts.
  - E9 (a): probes from the owner's account, with L1 reading the tail.
- **Still open:**
  - E5: the owner creates the APNs .p8.
  - E10: WhatsApp and iMessage copy.
  - E11: L3's batch, in L3's session. L3 isn't reachable by message right now.

If you choose E1(a), tell each lane in its own session; a relay from me is not a yes there. L4's brief, for one, requires your yes in L4's session for every app merge.

**Asked in L1's session (about 04:56Z):**
- **E12, Weight.** It never computes because its demand input has no producer. The producer runs in the Worker, and calendar access exists only in the owner DO. Filling it is a design decision, because Weight has no ADR and its weights are drafts. L1's smallest slice:
  - freebusy busy minutes per local day over the 30-day window, as counts only, with no titles;
  - physical load from the workouts and movement the producer already reads;
  - results stay `candidate_unaccepted`.
  It needs Google connected (E8), so it can't be verified live today.
- **E13: answered in L1's session: "align to ADR-0081, L1 edits". The work is PR #1083.** Form deviates from accepted ADR-0081. The code weights five components differently from the ADR. Align the code or amend the ADR, and decide who edits `scores/`, which is the Instinct contributor lane's code and read-only for L1.

Other held items stay in the morning report: session renewal, the 18+ server record, the Brief `latest` DO ALTER, and #1072.

## B. EoD target

### B.1 App cells to turn by EoD

Each target has a probe in the app Main chat.

| Pillar | Target today | What must land | Probe (app Main chat) | Gates |
|---|---|---|---|---|
| **P3** Memory and skills | **yes (should)** | **L2:** skills on app turns. **G3:** app chat in search and nightly | "Prep me for my 3 pm" loads the meeting-prep skill. "What did I tell you this morning about lunch?" finds the app message | E1, E3 |
| **P4** Triggers and jobs | **yes (must)** | **#1066** with the strip. **L4:** the D6 zone row (merged as app #82, `89a8e1d8`) ("Use this device's time zone", or "Keep <zone>"; the design system bans "Confirm" on buttons). **L2:** Prep, update cards and mail follow-ups on the app channel (`telegram-owner-do.ts:2417`) | "Remind me in 10 minutes to stretch" arrives on time. Then ask Waldo to move today's day card to a time inside the probe window (14:30–16:30Z), watch it arrive, and set it back. Without that, P4 is verified on reminders plus armed-job lines in L1's log tail | E1, E2 |
| **P5** Connectors and auth | **yes (must)** for a connected owner | **Your consent run.** **L2:** interim connect text, so the app turn points to Connections instead of reporting a button it dropped | "What's on my calendar tomorrow?" lists real events. "Connect my Google" points to Connections | E1, E8 |
| **W2** Approvals (not one of the eight) | **should:** the card plus "Not now" | **#1076.** **L3:** expiry on read. **G1:** approval state in the reply | "Move my 4 pm to 5" shows the card. Tap "Not now". With #1076 alone, the chat card for a deferred item may still read "no longer available". To read as put off, it also needs L3's `deferred_at` field and L4's re-pin. "What's waiting on me?" naming it needs G1, a stretch goal | E1, E4 |
| **P6** Text and voice | text yes; push is a stretch goal | **S7** sender and device routes. **L4:** registration | A reminder arrives as a push with the app closed | E5, E6 |
| **P1** Durable workflows | stays partial | **G1 composer** on both paths | "Draft a note to Sam and send it once I approve." A later turn cites the receipt | E1 |
| **P2** Computer use | stays no without E7 | Admission by canonical identity, plus the binding | "What are the opening hours on <url>?" | E7 |
| **P7** Payments and identity | stays partial | **L4:** the 18+ gate at sign-up (D7) | Sign-up stays blocked until 18+ is ticked | none |
| **P8** Evals and observability | first step | App-path regression tests in CI for tonight's three failures. The 503 and overwrite tests landed with #1075 and #1080; the connect test lands with its fix | CI shows all three | none |
| **W1** Health | better | **L4:** the ingest permission prompt. **Your** real-iPhone run. Weight is a design decision, not a fix (E12), and can't be verified live today | "How am I doing today?" answers from fresh readings | real iPhone |

### B.2 Golden path, observed live in the app

| Step | Today | Needs |
|---|---|---|
| 1a Sign-in with invite | probe | E9; a test account with a fresh invite |
| 1b Google sign-in | roadmap | After S7 (your order) |
| 1c 18+ checkbox | app gate today; server record on the roadmap | L4 (D7) |
| 2 Google connect | probe | E8: your consent run |
| 3 Health consent, ingest, scores | probe | Real iPhone; L1's Weight fix; L4's permission prompt |
| 4a/4b Main chat history and send | **verified live on `cdd906dd`** [reported: L4's two sends with the owner's yes, plus L1's log tail; no overwrite] | done |
| 5a Approve, "Don't do this" | probe | E9, after Google connects |
| 5b "Not now" | build | E4, then #1076 |
| 6 A reminder fires | probe | E9 |
| 7 Continuity | partial today | E3 (app chat searchable). One transcript across app and Telegram is on the roadmap |
| 8 Proactive at your times | build | E2, then #1066 and D6 |
| 9 Push | build | E5, E6, then S7 |
| 10 Deletion | probe | Your throwaway account; L1's proof |

## C. Today, by lane

**Deploy waves.** Each needs E1, or your go in L1's session:
- **Wave 1 at about 10:00Z** (15:30 IST): #1066, the interim connect text, the app branch at `:2417`, and expiry on read.
- **Wave 2 at about 14:00Z** (19:30 IST): skills on app turns and #1076, plus whichever stretch items (G1, G3, S7) passed the gate.

Then:
- **Probes:** 14:30–16:30Z.
- **Scorecard re-scored** from the probes at 17:00Z.

**`telegram-owner-do.ts` has one writer today: L2.** The file's lane rule (post the exact lines on #116 first) still applies. Merge order:
1. #1066
2. the interim connect text
3. the app branch at `:2417`
4. skills on app turns
5. the G1 composer
6. G3, if E3
7. browser admission, if E7

L3's Brief-reader wiring waits until after step 5.

**Contracts** (app.v1 is additive-only):
- **Additive.** These can ship before the app reads them:
  - `timezone_confirmed` (#1066);
  - read-only views.
- **A break until L4 re-pins.** No Worker emits these before the re-pin:
  - a connect card in chat;
  - a `google.disconnect` action;
  - approval fields A/B/C;
  - the 18+ field.

  That is why P5 uses interim text today, and why the connect card and disconnect are on the roadmap.

| Lane | Today, in order |
|---|---|
| **L2** (runtime; critical path) | **Must:** 1. #1066: strip, delta review, merge. 2. The interim connect text, with a test that a dropped app button is never reported as sent. 3. The app branch at `:2417`. **Should:** 4. Skills on app turns. **Stretch:** 5. G1: one composer that carries recent tool results and approval and receipt state into the reply on both paths; #1079's pin flips. 6. G3 (E3). 7. S7 behind a flag (E5, E6). 8. Browser admission (E7) |
| **L3** (contracts, approvals, Google) | 1. Expiry-on-read PR from the local branch. 2. The reminder-push contract PR (E11). 3. The approval fields A/B/C, if E11. 4. Draft the connect-card and disconnect contracts for tomorrow's re-pin. 5. The Brief `latest` reader, after L2's step 5 |
| **L4** (app) | 1. The D6 zone row (in progress at 04:15Z). 2. The 18+ gate at sign-up (D7). 3. The chat failure state and retry. 4. The Health permission prompt. 5. Push registration (S7). 6. Threads (C1), once served. 7. Reword #78's dated comment |
| **L1** (health plane, deploys) | 1. Put E12 and E13 to the owner. 2. Deploy waves 1 and 2. 3. Read the tails during probes and post on #116. 4. The deletion proof with your throwaway account |
| **Audit** | After wave 2: run the promise probes (Q1–Q10) with the probe account, update the ledger, and send verified rows back |
| **Orchestrator** | Gate each merge (CI, review, advisor) under E1. Track the waves. Re-score this doc from the probes. Write the evening report |
| **You** | Decisions E1–E11. The Google consent run, checking the publishing status. The APNs key. Probe say-so. The throwaway account. The real-iPhone run. Suyash's design questions |

---

# Where we stand

## 1. The answer

### The strict test

A pillar works by natural language on a surface when it passes three tests:
- **t1:** its tools are in that surface's per-turn tool list;
- **t2:** the handlers do the real thing on staging;
- **t3:** the result reaches the reply, and a later turn can get it back.

| Surface | Pillars passing all three | Notes |
|---|---|---|
| **App Main chat (the product)** | **0 of 6** chat-capable pillars | Nearest misses: connectors, reminders, memory, text chat |
| **Telegram (dev surface)** | **3 of 6**: memory and skills, triggers, connectors | By reading. None observed live on `889efa27` |
| WhatsApp | 0 | Code exists, but no owner can link it: the link-code issuer hard-codes `telegram` [reported] |
| iMessage | 0 | The modules exist, but nothing imports them [reported]. Draft #1017 would wire a Mac bridge (default-off) |
| Inbound email | 0 | No handler [reported] |

P7 (payments and identity) and P8 (evals and observability) have no chat tools by design, so they can't pass the chat test. They are judged on their engines only. Out of eight, the counts are 0 for the app and 3 for Telegram.

**Observed live:** one slice of one pillar, app text chat (send, reply, history read-back) on `889efa27` at 02:41Z [reported: L4's Simulator sends and L1's log lines]. That same probe triggered the history overwrite that #1080 fixes.

### Against the industry bar

From report 09's sources [inference]:
- **At or above the bar: authority and safety.**
  - Effects are reserved before any I/O and read back on retry.
  - Approvals are bound to a digest and a recorded presentation, and undo runs through the same ledger.
  - External-origin tool output is tainted, and egress is allowlisted.
  - Google tokens sit in Vault behind a proxy.
  - Production traces cannot carry text; the code enforces this.
- **Below the bar: continuity and context.**
  - Earlier turns' tool results never reach the reply (G1).
  - App chat is invisible to search and nightly memory (G3).
  - History is cut three ways without the model being told (G2).
  - Up to 49 tools ride every app round, and 53 on Telegram (Google tools only once connected), with no tool search.
- **Below the bar: proactivity and reach.**
  - No event triggers and no push notifications.
  - The app and Telegram keep separate transcripts.
  - Nothing is armed for an owner who uses only the app.
- **Well below the bar: evals.**
  - Nothing model-graded gates a merge.
  - The 46-case runner is manual, judged by the model it tests, and drives only Telegram.
  - The 36 native cases have never run.

### What's left against the promises

These counts are approximate; see section 4. Of the 120 website promises:
- about 76 need code;
- 20 need a copy decision;
- 12 need an owner or ops action;
- 12 need only a live probe.

None was verified live when the map was written.

## 2. Scorecard

**Engine level:**
- 0: missing
- 1: designed
- 2: partial
- 3: built and tested in source
- 4: reachable on staging
- 5: observed live

"app / TG" marks where the two differ. Promise rows are primary-pillar counts from report 10. They are approximate: 31 of the 165 classified rows were ambiguous.

| Pillar | Engine (app / TG) | App chat | Telegram | Industry bar | Promises (need code) | Biggest gap |
|---|---|---|---|---|---|---|
| **P1** Durable workflows | Owner-DO effects 4. Coordinator and RunLoop 3, but no route reaches them [reported] | partial | partial | Effect safety above; resume below | 1 (1) | An interrupted turn is abandoned, never resumed, and there is no cancel route [reported] |
| **P2** Computer use | 0 / 3 | no: app-only owners are rejected | partial | Below on the app. The approval-gated submit meets the bar on TG | 1 (1) | Admission requires a Telegram link [verified]. Staging's default browser route has no binding [reported] |
| **P3** Memory and skills | Memory 3–4. Skills 0 / 4: 16 curated SKILL.md, loaded on demand | partial | **yes** | At the bar on TG; below on the app | 7 (5) | Skills are wired only for Telegram [verified]. App chat is missing from search and nightly |
| **P4** Triggers and jobs | 2 / 4 | partial | **yes** | Below: no event triggers, no push | 19 (14) | Nothing is armed for app-only owners [verified]. #1066 is held |
| **P5** Connectors and auth | 4, unproven live | partial | **yes** | Core at the bar; revocation and Google verification below | 28 (17) | Connecting from app chat fails silently [verified]. No disconnect |
| **P6** Text and voice | App text 5 [reported]; TG 4; push 1; voice in 3 (TG only); voice out 0; WhatsApp 2; iMessage 2; email 0 | partial | partial | Below: no push, two transcripts | 19 (15) | Push (S7); one transcript across surfaces |
| **P7** Payments and identity | Email sign-in 4; Google sign-in 0; 18+ at sign-up 0; payments 0 | not a chat capability | not a chat capability | Identity below; payments not promised | 1, plus 3 golden-path rows | No Google sign-in, no 18+ record, and a 12 h session with no refresh |
| **P8** Evals and observability | Tracing 4; alerts 0; evals 2 | not a chat capability | not a chat capability | Tracing at the bar; evals well below | 0 | No eval or probe gates a merge. No workflow runs evals [verified] |
| **W1** Health plane (Waldo) | Consent, ingest and scores wired. Golden-path step partial: ingest fails silently without the iOS permission [reported] | partial | partial | n/a | 21 (16) | The health-log tools check no consent [reported]. #1066's health hold |
| **W2** Approvals (Waldo) | Lifecycle 4; "Not now" 1; expiry on read 0 | partial | partial | Binding above the bar; deferral and staleness below | 8 (5) | "Not now" answers 409, and expired requests still show as open [reported] |

## 3. Harness engineering against Anthropic's guidance

| Practice and source | Waldo at `889efa27` | Verdict |
|---|---|---|
| Gather context, act, verify, with subagents for isolation ("Building agents with the Claude Agent SDK", 29 Sep 2025) | `delegate_task` sub-agents share a round budget. Effects are verified by reading the ledger back | At the bar |
| Just-in-time context, tool-result clearing, compaction ("Effective context engineering for AI agents", 29 Sep 2025; the context editing and compaction docs) | **G1:** earlier turns' tool results reach the reply on neither path. Report 04 found this by reading, report 07 re-checked it, and #1079's tests agree. **G2:** three silent history cuts. No compaction and no working set | Below |
| Fewer, consolidated tools, with tool search above about 10 tools ("Writing effective tools for agents", 11 Sep 2025; "Introducing advanced tool use", 24 Nov 2025) Up to 49 tools on app turns and 53 on Telegram, every round (Google tools only once connected). 19 allow-listed tools have no handler [reported]. Tool search (ADR-0034) is unbuilt | Below |
| Tool descriptions are true | On the app, the connect tool tells the model a connect button is in the chat, but the app path drops the button [verified: `surfaces/app.ts:17-24`, `tools/live/google.ts:38`] | Below |
| Containment before supervision: egress allowlists, credentials kept outside the agent ("How we contain Claude across products", 25 May 2026) | Egress allowlist; tokens held in Vault; external-origin taint; built-in tools are not preauthorized | At or above |
| One permission check on every call (Agent SDK permissions) | A per-turn capability manifest; digest-bound approvals rechecked before dispatch | At or above |
| Long-running work resumes from a durable log ("Effective harnesses for long-running agents", 26 Nov 2025; "Scaling Managed Agents", 8 Apr 2026) | An interrupted app turn ends `interrupted` and never reruns. The canonical Coordinator and RunLoop sit behind flags that no staging config sets [reported] | Below |
| Evals built from real failures, with code graders, judges calibrated against humans, and pass^k (report 09, P8) | A 46-case manual runner, judged by the chat model itself (`JUDGE = WALDO_CHAT_MODEL`), driving the Telegram responder only [verified: `packages/runtime/evals/run.ts`]. No CI workflow mentions evals [verified] | Well below |

The pattern is that the authority layer was built to a high bar, while the context and quality layers were not. Tonight's app-path failures were continuity bugs: two were observed (the 503 and the overwrite), and one was found by reading (the dropped connect button). An app-path eval or journey test could have caught each one [inference].

## 4. Promises and UX: what's left

### 4.1 The 120 website promises, by pillar and status

- Statuses are the map's, unchanged.
- The pillar assignment comes from report 10, so the counts are approximate.
- WP-026, WP-034 and WP-064 describe one capability split across P4, W1 and P5.

| Pillar | partial | missing | copy decision | merged, not deployed | deployed, unprobed | open PR | total |
|---|---|---|---|---|---|---|---|
| P1 | 1 | | | | | | 1 |
| P2 | | 1 | | | | | 1 |
| P3 | 5 | 1 | 1 | | | | 7 |
| P4 | 9 | 8 | 2 | | | | 19 |
| P5 | 10 | 8 | 4 | 2 | 2 | 2 | 28 |
| P6 | 9 | 7 | 2 | | | 1 | 19 |
| P7 | | | | 1 | | | 1 |
| P8 | | | | | | | 0 |
| W1 health | 12 | 5 | 1 | 2 | 1 | | 21 |
| W2 approvals | 3 | 2 | 1 | 2 | | | 8 |
| W3 privacy and data rights | 1 | 1 | 6 | | 2 | | 10 |
| X not a pillar | | | 4 | | 1 | | 5 |
| **Total** | **50** | **33** | **21** | **7** | **6** | **3** | **120** |

### 4.2 What closes them

| | Code | Copy | Owner or ops | Probe only |
|---|---|---|---|---|
| Website promises (120) | 76 | 20 | 12 | 12 |
| Golden path (14) | 6 | 0 | 2 | 4 (2 more are verified live since the map) |
| Design-system rows (31) | 20 | 4 | 7 | 0 |

- **Code needed, by pillar:** P5 17, W1 16, P6 15, P4 14, P3 5, W2 5, W3 2, P1 1, P2 1.
- **Owner or ops on the golden path:** the "Not now" ruling (GP-5b) and the APNs key (GP-9).
- **Design rows:**
  - 20 open, 8 partial, 3 waiting on the designer or the owner.
  - By pillar: chat UX (P6) 11, brand and visual (X) 11, W2 3, W1 2, P4 2, P3 1, W3 1.

### 4.3 Moves since the map

- **GP-4a** (history loads) and **GP-4b** (send works) move from "deployed, unprobed" to **verified live**, observed at 02:41Z on `889efa27` [reported]. GP-4b carried the overwrite defect, which #1080 fixes; that fix is deployed as of 03:46Z, but no send has been observed on it yet.
- **No WP row moves.** Every chat-section row (WP-005 to WP-014) is `partial` or `missing`, and none was waiting on a probe.
- **App #78, #79 and #80 move no status:**
  - #78's zone write does nothing until #1066 deploys [reported];
  - #79 fixes a label;
  - #80 pins a contract.

### 4.4 Not promised, still required

- **P8 evals and probes:** no promise names them. Their absence is why none of the 120 promises was verified live, and why 12 rows wait only on a probe.
- **P1:** one promise row, but every consequential promise rides on it: sends, calendar changes, task changes.
- **Payments:** not promised. The pricing lines are copy decisions (O7). Don't build billing for the beta [proposed].

### 4.5 Platform gates

These come from report 09, from dated pages fetched 12 Oct.

1. **Google verification, and CASA for restricted scopes.**
   - The connector requests `gmail.readonly`, `gmail.send`, `gmail.compose` and `drive.readonly`, plus read-only Docs, Sheets and Slides [verified: `connectors/google.ts:9-21`].
   - Google lists `gmail.readonly`, `gmail.compose` and `drive.readonly` as **restricted** [reported from Google's scopes page].
   - When restricted data passes through Waldo's servers, it needs an annual third-party security assessment (CASA).
   - Unverified apps show a warning screen and are capped at 100 users.
   - The lead time is outside our control. Either start now, or drop the restricted scopes for launch. This is an owner decision, and it ties to O2.
2. **WhatsApp's "AI Providers" terms** (last modified 23 Sep 2026).
   - General-purpose assistants are barred, except where Meta is legally required to allow them.
   - The EEA position rests on an interim order that Meta is appealing [search snippet].
   - CLAUDE.md's "officially eligible WhatsApp" is the right guard. Plan as if WhatsApp is unavailable outside the EEA.
3. **iMessage has no bot API.** Apple Messages for Business requires an approved messaging provider, a reachable live agent, and a first reply within 5 seconds (v3.1, 21 Jul 2026). Waldo's own route is draft #1017, from 10 Oct: a paired bridge on the owner's Mac. It is default-off, carries a migration and is proven only locally, so it is held. It is not Apple's business channel, so its terms risk at scale still needs review [inference].
4. **App Store, at store launch:**
   - guideline 4.8 may require an equivalent privacy-preserving login once Google sign-in ships;
   - in-app account deletion (5.1.1(v)). The app already sends `account.delete` [reported];
   - consent before sending personal data to third-party AI (5.1.2(i));
   - no sensitive data in push payloads (4.5.4).
   - "No Apple sign-in for the beta" holds while the app ships from source.
5. **Zero data retention.** Several Anthropic features are not ZDR-eligible: Managed Agents, the MCP connector, programmatic tool calling and Agent Skills in the API. That limits adopting them for health-bearing turns.
6. **Google OAuth "Testing" status.** Google's OAuth page (last updated 26 May 2026; fetched 12 Oct) says an external app in Testing gets refresh tokens that expire after 7 days, unless it asks only for basic identity scopes. It also caps each Google account at 100 refresh tokens per client. If Waldo's consent screen is still in Testing, every beta Google connection dies weekly. Moving it to "In production" while unverified shows the warning screen and caps the app at 100 users [verified fetch; Waldo's current status unverified].

## 5. Parity roadmap after EoD [proposed]

The dates are estimates. The gate column names what holds each item.

| When | Pillar | Item | Gate |
|---|---|---|---|
| 13–14 Oct | P5 | A connect card in app chat, and Google disconnect, with revocation shown to the owner | L3 contract, then L4 re-pin |
| 13–14 Oct | P7 | Google sign-in (O2-A) once S7 has landed, then session refresh | Security review of the auth change |
| 13–14 Oct | P8 | A model-graded app-path eval in CI: a judge from another model family, pass^k on the golden tasks, seeded from real failures. Alerts on fatal codes (`history_invalid`, `send_failed`) | You add a model API key as a CI secret |
| 13–14 Oct | P2 | Browsing from the app, if E7 was a hold today | E7 |
| 13–14 Oct | Harness | G2: tell the model when history was cut (option A, the out-of-view note) | none |
| 15–18 Oct | P6 / GP-7 | One transcript across app and Telegram | Canonical-store migration plan |
| 13–18 Oct | W1 / P3 | A governed, owner-scoped health-history read over the health plane: ranges and aggregates. The model and a pattern job use the full history, and memory keeps only qualitative patterns (E2) | Bounded contract under ADR-0081 |
| 15–18 Oct | P4 | Event triggers: Gmail push through `users.watch` and Pub/Sub, with renewal and a polling fallback; Calendar push channels | A new external integration (Pub/Sub) |
| 15–18 Oct | Harness | Tool search or a smaller per-turn tool list (ADR-0034); remove allow-list entries that have no handler | none |
| 15–18 Oct | P3 / Harness | The conversation working set (option C), with its eval | E2's strip rule |
| 15–18 Oct | P1 / P8 | An activity view the owner can see: tasks and their states, receipts and approved permissions. Uncertain outcomes read "Unknown" | L3 contract, then L4 re-pin |
| 15–18 Oct | P3 | Memory editing in the app: view, edit and forget, beyond the read-only Constellations. Owner-taught skills, staged for approval | Contract and re-pin; ADR review for skill writes |
| Later | P5 | Standing grants with lifetimes and a revocation list (draft #932) | Explicit contract and ADR review, as CLAUDE.md requires for standing grants |
| 19–31 Oct | P1 | Resume or cancel an interrupted turn. Decide whether WaldoCoordinator and RunLoop carry traffic or are retired | ADR |
| 19–31 Oct | P6 | Voice in the app: speech in, then speech out | Provider and DPA review |
| Start now, weeks | P5 | Google verification and the CASA assessment for `gmail.readonly`, `gmail.compose` and `drive.readonly` | External assessor |
| Before App Store | P7 | 4.8 equivalent login, 5.1.1(v) deletion, 5.1.2(i) AI consent, 4.5.4 push content | App Store submission |
| Not for the beta | P7 | Payments: not promised; pricing lines are copy (O7) | none |
| Not for the beta | P6 | WhatsApp (AI-provider terms) and iMessage beyond the #1017 Mac bridge | Platform terms |

## 6. Against other personal agents

**Sources:**
- Audit's competitor refresh (#1058, `[#1058]`).
- Reports 02 and 09.
- Report 11, which assembles them by pillar: [11-competitor-pillar-matrix.md](research-2026-10-12/11-competitor-pillar-matrix.md).

**Reading the matrix:**
- No new web research went into this section.
- The verdicts measure how deeply each product's public sources document a pillar, not hands-on quality.
- "Not documented" is not "absent".
- Every OpenAI Dots cell rests on search snippets, owner transcription and press, because its pages returned 403.
- ChatGPT, Gemini and Claude rows are not here yet. They are one capped research pass after the 06:30Z usage reset.

### 6.1 Overview

Waldo's row uses this scorecard's evidence. Where the app and Telegram differ, it reads app / Telegram.

| Product | P1 Workflows | P2 Computer | P3 Memory and skills | P4 Triggers | P5 Connectors | P6 Channels | P7 Pay and identity | P8 Activity and evals | Health |
|---|---|---|---|---|---|---|---|---|---|
| **Waldo today** | partial: effect ledger strong; no resume, no task view | none / partial | partial / strong (no skills on the app) | partial / strong (clock only) | partial / strong (no disconnect) | partial: two surfaces, no push, two transcripts | partial: email sign-in; payments not promised | partial: receipts; no activity view; evals gate nothing | **partial: no competitor documents health-aware planning; Waldo's is built but held (E2)** |
| Meta Muse | partial | strong | strong (memory) | strong | strong | partial | strong | strong | not documented |
| OpenAI Dots | partial* | partial* | partial* | partial* | partial* | partial* | partial* | partial* | not documented |
| Instinct | not documented | partial | not documented | not documented | partial | partial | partial | not documented | partial (policy only) |
| Poke | partial | not documented | partial | partial | partial | partial | partial | not documented | partial (advertised) |
| Folk | partial | strong | strong (memory) | strong | strong | partial | strong | partial | partial |
| Vellum Assistant | strong (open bugs) | partial | strong | strong (open bugs) | strong | strong | partial | partial | none |
| OpenClaw | strong | not documented | strong | strong | partial | strong | partial | partial | partial (data only) |
| Hermes Agent | strong | not documented | strong | strong | partial | strong | partial | partial | not documented |
| Letta | partial | not documented | partial | partial | partial | partial | partial | partial | not documented |
| Khoj | not documented | not documented | not documented | partial | not documented | partial | not documented | not documented | not documented |

\* unverified: Dots' pages returned 403.

**This comparison flatters competitors.** Waldo's row is graded on code under the strict test. Competitors are graded on how deeply their public documents describe each pillar, and vendors don't publish their weaknesses.

### 6.2 Where Waldo leads, and where it trails

**Leads** [inference from the matrix]:
- **Health-aware planning.** No competitor documents it. That is not proof that none has it, so don't claim uniqueness publicly. The nearest are OpenClaw's on-demand HealthKit aggregates, Folk's Strava and meal-photo logging, and Poke's empty Oura page. Waldo has consent, ingest and three scores built. #1058's caution stands: the claim must be shown, not asserted, and today the day-card planning is held (E2).
- **Per-action authority.** Waldo's approvals are digest-bound, shown before they can be approved, and dispatched through a ledger with read-back. That matches Muse's Sentinel on per-action approval. Waldo lacks Muse's grant lifetimes and OpenClaw's list-and-revoke.
- **Memory provenance.** Waldo's memory writes are grounded in the owner's own words and carry provenance. No vendor documents per-memory provenance labels [#1058], which again is not proof of absence.

**Trails:**
- **Reach.** Competitors pair a native app with messaging, voice and push (Vellum, OpenClaw). Waldo has no push, two transcripts, and voice only on Telegram.
- **Computer use.** Muse and Folk run their own cloud computer through to checkout. Waldo browses only on Telegram.
- **Owner-visible activity and controls.** Muse shows an activity log with approved permissions; Dots shows an Activity View (unverified). Waldo shows receipts and cards, with no activity or permissions view.
- **Event triggers.** Muse events, Vellum watchers and OpenClaw standing intents are all ahead. Waldo runs on the clock only.
- **Skills that grow.** OpenClaw's Skill Workshop has versions and undo; Hermes stages skill writes for approval. Waldo's owner-written skills are a stub.

### 6.3 Parity bar per pillar, and Waldo's gap

| Pillar | On par means [from the matrix] | Waldo's gap | When |
|---|---|---|---|
| **P1** | Run records survive a restart, with a stated rule for missed runs. Owner-visible task states. Uncertain outcomes shown as "Unknown", never "ok". Approval waits that time out closed. A stopped run cancels its approval | Expired approvals still show as open. No task or activity view. Interrupted turns never resume | Expiry: today (L3). Activity view: 15–18 Oct. Resume: 19–31 Oct |
| **P2** | An isolated browser or computer that fills forms. Credentials out of the model's reach. Sensitive steps handed back. Stated limits | No browsing from the app. No staging binding | Today if E7, else 13–14 Oct |
| **P3** | The owner can view, edit and forget memory. Corrections replace old facts. Agent writes are capped or staged. AgentSkills-style skills with versions and undo, or approval | No skills on the app. App chat isn't searched or consolidated. No memory editing in the app UI. Owner-written skills are a stub | Skills and G3: today (E3). Memory editing and owner skills: roadmap |
| **P4** | Durable schedules plus event triggers. Silence allowed, failures always surface. A proactivity dial. Active hours in the owner's zone. DST-correct | App-only owners get reminders only. No event triggers | #1066 and the `:2417` branch: today. Events: 15–18 Oct |
| **P5** | Mail, calendar and MCP or custom connectors. Scoped grants with a lifetime. Revocation the owner can use. Credentials kept from the model | Connecting from app chat fails silently. No disconnect. No standing grants (draft #932). Google verification pending | Interim text: today. Disconnect: 13–14 Oct. Grants: roadmap. Verification: weeks |
| **P6** | A native surface plus messaging. One transcript. Structured approvals. Voice. iOS push | No push. Two transcripts. No voice in the app | Push: today if E5 and E6. One transcript: 15–18 Oct. Voice: 19–31 Oct |
| **P7** | Exact-detail approval for every purchase. Narrow payment instruments. Published tiers | Payments not promised. 12 h session with no refresh. No Google sign-in. 18+ only enforced in the app | 18+ gate: today. Refresh and Google: 13–14 Oct. Pricing: copy (O7) |
| **P8** | An activity log with approved permissions. Task states and run history. Honest degraded or unknown status. No vendor publishes evals | No activity view. Evals gate nothing | App-path eval in CI: 13–14 Oct. Activity view: 15–18 Oct |
| **Health** | Nobody plans with health. The documented bar is opt-in, on-demand data access | Day-card planning held (E2). The Weight producer bug. The model sees only zone words | E2 and the Weight fix: today. Real iPhone: you |

## 7. Evidence

**Spot-checked by the orchestrator at `889efa27`:**
- **Telegram connect:** `deliverConnectLink` sends a URL button through the channel's `sendMessage` and treats an undefined result as blocked (`telegram-owner-do.ts:1672-1683`). On Telegram that is a real send. On the app, `appCaller` acknowledges it without delivering.
- **Browser admission** requires `telegram_subject` and resolves the owner through `telegram` (`owner-browser-runtime.ts:49-70`).
- **App setup arms no background work** (`telegram-owner-do.ts:2024`).
- **The curated skill capability** is created only inside the Telegram `prepare` hook (`telegram-owner-do.ts:2077`, `:2112`). There are 16 product `SKILL.md` files under `packages/runtime/skills/`.
- **The app caller acknowledges a URL-button send** that goes nowhere (`surfaces/app.ts:17-24`). The connect tool tells the model a button was sent (`tools/live/google.ts:38`).
- **The eval runner** imports `createTelegramResponder`, and its judge is `WALDO_CHAT_MODEL` (`packages/runtime/evals/run.ts`). No workflow under `.github/workflows` mentions evals.
- **Google scopes:** `connectors/google.ts:9-21`.
- **Unpinned actions:** `.github/workflows/owner-do-smoke.yml` pins four actions by tag, which breaks the security checklist. A separate task was offered.

**Not verified:**
- Anything live beyond 02:41Z.
- The staging secrets for the browser, the transcriber and web search.
- The WhatsApp EEA order (search snippet only).
- How Google classifies the Calendar and Tasks scopes.
- Whether guideline 4.8 applies to an app that also has its own email sign-in.
- The pillar assignment of the 31 ambiguous rows.
