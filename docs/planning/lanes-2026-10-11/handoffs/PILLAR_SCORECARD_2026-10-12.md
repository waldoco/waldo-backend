# Pillar scorecard, 12 October 2026

The owner asked:
1. How many of the eight pillars every agent product will have are properly built and working through natural language, in the app and on other surfaces?
2. Do they meet the industry standard?
3. How do they map across Waldo's UX and promises, and how much is still left to build?

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
- Backend `beta-mvp` `889efa27`, which staging runs as Worker `3f059c04`.
- `cdd906dd` (#1080, merged at 03:36Z) is not deployed.
- App `main` `6dcba63b`.

**Method**
- Source was read, not run. The only live observation is the Main chat probe at 02:41Z.
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

## 1. The answer

### The strict test

A pillar works by natural language on a surface when it passes three tests:
- **t1:** its tools are in that surface's per-turn tool list;
- **t2:** the handlers do the real thing on staging;
- **t3:** the result reaches the reply, and a later turn can get it back.

| Surface | Pillars passing all three | Notes |
|---|---|---|
| **App Main chat (the product)** | **0 of 8** | Nearest misses: connectors, reminders, memory, text chat |
| **Telegram (dev surface)** | **3 of 8**: memory and skills, triggers, connectors | By reading. None observed live on `889efa27` |
| WhatsApp | 0 | Code exists, but no owner can link it: the link-code issuer hard-codes `telegram` [reported] |
| iMessage | 0 | The modules exist, but nothing imports them [reported] |
| Inbound email | 0 | No handler [reported] |

**Observed live:** one slice of one pillar, app text chat (send, reply, history read-back) on `889efa27` at 02:41Z. That same probe triggered the history overwrite that #1080 fixes.

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
  - Every round carries 49–53 tools, with no tool search.
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
| **P6** Text and voice | App text 5; TG 4; push 1; voice in 3 (TG only); voice out 0; WhatsApp 2; iMessage 2; email 0 | partial | partial | Below: no push, two transcripts | 19 (15) | Push (S7); one transcript across surfaces |
| **P7** Payments and identity | Email sign-in 4; Google sign-in 0; 18+ at sign-up 0; payments 0 | not a chat capability | not a chat capability | Identity below; payments not promised | 1, plus 3 golden-path rows | No Google sign-in, no 18+ record, and a 12 h session with no refresh |
| **P8** Evals and observability | Tracing 4; alerts 0; evals 2 | not a chat capability | not a chat capability | Tracing at the bar; evals well below | 0 | No eval or probe gates a merge. No workflow runs evals [verified] |
| **W1** Health plane (Waldo) | Consent, ingest and scores wired. Golden-path step partial: ingest fails silently without the iOS permission [reported] | partial | partial | n/a | 21 (16) | The health-log tools check no consent [reported]. #1066's health hold |
| **W2** Approvals (Waldo) | Lifecycle 4; "Not now" 1; expiry on read 0 | partial | partial | Binding above the bar; deferral and staleness below | 8 (5) | "Not now" answers 409, and expired requests still show as open [reported] |

## 3. Harness engineering against Anthropic's guidance

| Practice and source | Waldo at `889efa27` | Verdict |
|---|---|---|
| Gather context, act, verify, with subagents for isolation ("Building agents with the Claude Agent SDK", 29 Sep 2025) | `delegate_task` sub-agents share a round budget. Effects are verified by reading the ledger back | At the bar |
| Just-in-time context, tool-result clearing, compaction ("Effective context engineering for AI agents", 29 Sep 2025; the context editing and compaction docs) | **G1:** earlier turns' tool results reach the reply on neither path. Report 04 found this by reading, report 07 re-checked it, and #1079's tests agree. **G2:** three silent history cuts. No compaction and no working set | Below |
| Fewer, consolidated tools, with tool search above about 10 tools ("Writing effective tools for agents", 11 Sep 2025; "Introducing advanced tool use", 24 Nov 2025) | 49 tools on app turns and 53 on Telegram, every round. 19 allow-listed tools have no handler [reported]. Tool search (ADR-0034) is unbuilt | Below |
| Tool descriptions are true | On the app, the connect tool tells the model a connect button is in the chat, but the app path drops the button [verified: `surfaces/app.ts:17-24`, `tools/live/google.ts:38`] | Below |
| Containment before supervision: egress allowlists, credentials kept outside the agent ("How we contain Claude across products", 25 May 2026) | Egress allowlist; tokens held in Vault; external-origin taint; built-in tools are not preauthorized | At or above |
| One permission check on every call (Agent SDK permissions) | A per-turn capability manifest; digest-bound approvals rechecked before dispatch | At or above |
| Long-running work resumes from a durable log ("Effective harnesses for long-running agents", 26 Nov 2025; "Scaling Managed Agents", 8 Apr 2026) | An interrupted app turn ends `interrupted` and never reruns. The canonical Coordinator and RunLoop sit behind flags that no staging config sets [reported] | Below |
| Evals built from real failures, with code graders, judges calibrated against humans, and pass^k (report 09, P8) | A 46-case manual runner, judged by the chat model itself (`JUDGE = WALDO_CHAT_MODEL`), driving the Telegram responder only [verified: `packages/runtime/evals/run.ts`]. No CI workflow mentions evals [verified] | Well below |

The pattern is that the authority layer was built to a high bar, while the context and quality layers were not. Tonight's three failures were all continuity bugs on the app path: the 503, the overwrite and the dropped connect button. An app-path eval or journey test could have caught each one [inference].

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

- **GP-4a** (history loads) and **GP-4b** (send works) move from "deployed, unprobed" to **verified live**, observed at 02:41Z on `889efa27`. GP-4b carries the overwrite defect: #1080 is merged but not deployed.
- **No WP row moves on that probe alone** [inference]. The chat rows' remaining gaps are threads, quick replies, push and continuity, and the probe touched none of them.
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
3. **iMessage has no bot API.** Apple Messages for Business requires an approved messaging provider, a reachable live agent, and a first reply within 5 seconds (v3.1, 21 Jul 2026).
4. **App Store, at store launch:**
   - guideline 4.8 may require an equivalent privacy-preserving login once Google sign-in ships;
   - in-app account deletion (5.1.1(v)). The app already sends `account.delete` [reported];
   - consent before sending personal data to third-party AI (5.1.2(i));
   - no sensitive data in push payloads (4.5.4).
   - "No Apple sign-in for the beta" holds while the app ships from source.
5. **Zero data retention.** Several Anthropic features are not ZDR-eligible: Managed Agents, the MCP connector, programmatic tool calling and Agent Skills in the API. That limits adopting them for health-bearing turns.

## 5. Build order [proposed]

Ordered by which app cells flip and which promises close soonest.

1. **Deploy #1080.** This needs the owner's go in L1's session.
2. **P5 on the app, the smallest flip.**
   - Render the connect affordance in app chat instead of dropping it.
   - Make the tool text true on each surface.
   - Add disconnect.
   - Owners: an additive L3 contract, L2 runtime, an L4 card.
3. **P4 on the app.**
   - Get the owner's ruling on #1066's health hold, then merge it.
   - Arm jobs for app-only owners.
   - Ship push (S7) once the APNs key exists.
   - Plan Gmail and Calendar watch triggers.
4. **P3 on the app.** Wire the skill host for app turns, and index app chat into episode search and nightly (G3).
5. **G1 on both paths.** One composer that carries recent tool results, plus approval and receipt state, into the reply. It flips no cell on its own, but every t3 depends on it.
6. **P8.**
   - An app-path eval suite in CI, judged by a model from another family.
   - Seed it with tonight's real failures: the 503, the overwrite, the dropped connect button.
   - Add the Audit lane's promise probes, so "deployed, unprobed" rows can become "verified live".
7. **Tools.** Tool search or a smaller per-turn manifest (ADR-0034). Remove allow-list entries that have no handler.
8. **P7.** Google sign-in (O2-A), the 18+ server record, session refresh.
9. **P1.** Either route traffic to WaldoCoordinator and RunLoop or retire them, and add resume or cancel for interrupted turns.
10. **Owner decisions now.** Google verification or dropping the restricted scopes; a WhatsApp and iMessage strategy, given the platform gates.

## 6. Evidence

**Spot-checked by the orchestrator at `889efa27`:**
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
