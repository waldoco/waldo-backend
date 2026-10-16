# Waldo Agent Plan workstreams A–H: status at `beta-mvp` `e5c022ef`, 14 October 2026, 16:30Z

## Sources

- **The items:** the Waldo Agent Plan (Ansh's Claude Doc, around revision 13) defines workstreams A–H. A is numbered by the lead's seam design (#1103 comment 6152354118), which adds A0, the guard ratchet.
- **The status:** merged PRs on `beta-mvp`, checked through the GitHub API on 14 October, plus the lead log.
- **Not verified:** marked where the item's PR or code wasn't checked in this pass.

## Status legend

| Status | Meaning |
|---|---|
| **built** | Merged on `beta-mvp`. |
| **partial** | Part of the item is merged. |
| **in flight** | A builder session is on it now. |
| **owner** | Waiting on an owner ruling, keys, a migration or a deploy. |
| **not started** | No PR exists. |
| **not verified** | Status unconfirmed in this pass. |

## Totals: 59 items

| Workstream | Items | Built | Partial | In flight | Owner | Not started | Not verified |
|---|---|---|---|---|---|---|---|
| A. One agent on every surface | 9 | 2 | 1 | 1 | 0 | 5 | 0 |
| B. Context and memory | 8 | 2 | 1 | 0 | 0 | 5 | 0 |
| C. Follow-through and proactivity | 10 | 3 | 2 | 1 | 1 | 1 | 2 |
| D. Model, tools, cost and deploy | 8 | 2 | 2 | 0 | 4 | 0 | 0 |
| E. Judgement and evals | 7 | 1 | 0 | 0 | 1 | 5 | 0 |
| F. Browser and connectors | 8 | 2 | 2 | 0 | 0 | 2 | 2 |
| G. Health and Body | 6 | 0 | 2 | 0 | 1 | 3 | 0 |
| H. Account and platform | 3 | 0 | 1 | 0 | 1 | 1 | 0 |
| **Total** | **59** | **12** | **11** | **2** | **8** | **22** | **4** |

Three more builders are working on things outside the plan's numbering: G57 (claims checked against receipts), G62 (bounded history load) and #1228 (voice notes treated as instructions). They come from the 14 October gap page.

## A. One agent on every surface

| Item | What it is | Status | Evidence |
|---|---|---|---|
| A0 | Guard ratchet on surface compares | built | #1190 |
| A1 | Canonical inbound turn with authorship | built | #1209; also #1223 (forwards never trigger commands) and #1229 (others' text never steers) |
| A2 | One admission and runtime per owner, one listener, skills everywhere | in flight | `claude/a2-owner-runtime`. Jobs run as the admitted owner: #1108 landed as #1234. |
| A3 | One main conversation per owner, with visibility (app #5, release blocker) | not started | Spec 6154900101 |
| A4 | Deliver seam: reply envelope, renderers, outbox | not started | Spec 6154958924 |
| A5 | Router for proactive output | not started | Spec 6154958924 |
| A6 | One approval desk | not started | #1163 (expiry) landed |
| A7 | Capabilities as data, conformance test, capabilities route | not started | The guard part is A0 |
| A8 | Surfaces in flight: iMessage, WhatsApp, links | partial | iMessage shared bridge #1224/#1225 landed. Not built: iMessage proactive delivery, WhatsApp by principal. |

## B. Context and memory

| Item | What it is | Status | Evidence |
|---|---|---|---|
| B1 | Land #1149 | built | #1149 |
| B2 | Compaction | partial | ADR #1182, #1204, #1207 built behind the switch, which is off. Waits on G37 and the eval (#1185). |
| B3 | Recall by relevance, pinned profile | built | #1192. Thread scoping ruled 1a and landed with threads. |
| B4 | Semantic recall | not started | Waits on G37. The provider is approved under consent and the DPA. |
| B5 | Working set ("that one") | not started | |
| B6 | Memory model: person kind, validity window | not started | Needs the people ruling |
| B7 | Context budget (head and tail tokens) | not started | G62 (storage reads) is related and in flight |
| B8 | Memory the owner can see and fix (app routes) | not started | The console has forget; app.v1 does not |

## C. Follow-through and proactivity

| Item | What it is | Status | Evidence |
|---|---|---|---|
| C1 | Alarm fallback re-arm | built | #1180, via #1186 |
| C2 | One wake arbiter | built | #1186. Also #1213 and #1236. |
| C3 | Failure notice | built | #1239 and the builder's item 3 |
| C4 | Open loops on every turn, check-back scenario | not verified | |
| C5 | Push | owner | #1177 (Expo token, #1133 migrations) |
| C6 | Event wakes | partial | Calendar push #1154 and Gmail push #1175 landed. Watching on connect is #1247, in flight with the Mac. |
| C7 | Durable tasks | in flight | `claude/c7-durable-tasks`, spec 6154789747 |
| C8 | Agentic heartbeat, watchers, Patrol | not started | Unattended action waits on the standing-grant ADR (G3) |
| C9 | One durability path through the outbox | not verified | |
| C10 | What the owner sees: feeds, Carrying, open loops, Brief | partial | Contract #1136 merged; route #1138 held for the app re-pin; app threads served (#1173, #1176, #1179). Most feeds are not built. |

## D. Model, tools, cost and deploy

| Item | What it is | Status | Evidence |
|---|---|---|---|
| D1 | Model fallback and per-purpose routing | owner | Waits on the fallback-provider ruling |
| D2 | Per-turn deadline, retries at 0 or 1, percentiles per hop | built | #1193 (M4), #1201. Percentiles per hop are partial. |
| D3 | Lazy tool loading | owner | Waits on its ruling |
| D4 | Tool hygiene | partial | Built: #1155 (tool output is data). Open: #1114. Not built: parallel safe reads, strict schemas. |
| D5 | Cost ledger and the $25 monthly cap | owner | #1113 |
| D6 | Deploy safety | built | #1214 and #1220. Staging's own R2 bucket and rate-limit namespace are not done. |
| D7 | One owner id in traces, trace id on app send | partial | #1237 files traces under the owner principal |
| D8 | Delete the dormant runtime | owner | A founder decision |

## E. Judgement and evals

| Item | What it is | Status | Evidence |
|---|---|---|---|
| E1 | Nightly eval harness | owner | #1185 needs keys, a schedule and storage |
| E2 | Baseline on staging, re-run after hand-offs | built | Mac runs: 6152381089, 6155218639 |
| E3 | Ask triggers as scenarios | not started | |
| E4 | Prompt amendments through soul review | not started | Gap G47 |
| E5 | Surface-parity scenarios | not started | |
| E6 | Human-side restraint scenarios | not started | Some cases exist in `evals/cases.ts` |
| E7 | Owner controls on judgement | not started | |

## F. Browser and connectors

| Item | What it is | Status | Evidence |
|---|---|---|---|
| F1 | #1110: Cloudflare browser on the owner binding | built | #1110 |
| F2 | #1120: staging binding | built | #1120 |
| F3 | Irreversible-action phrase list with tests | not verified | |
| F4 | Screenshots on every surface, browser cost in the ledger | not started | Needs A4 and D5 |
| F5 | Persistent session and sign-in hand-off | partial | The handoff console exists. Login custody is unwired (gap G54). |
| F6 | Google from the app: disconnect, metadata-only mode, health, reconnect | not verified | The console has disconnect |
| F7 | Reach after rulings | partial | `use_mac` (#1178) and contacts (#1189) landed. Other reach waits on rulings. |
| F8 | Sandbox for code and files | not started | |

## G. Health and Body

| Item | What it is | Status | Evidence |
|---|---|---|---|
| G1 | Score history | owner | #1159 and #1161 are drafts and need a migration |
| G2 | Score detail | not started | |
| G3 | Weight from calendar demand | partial | #1130. Message and task inputs are still null (gap G34). |
| G4 | Sleep debt | partial | Contract #1125 merged; migration #1127 needs the owner |
| G5 | Health data held, pause upload, evidence layer | not started | |
| G6 | Later items | not started | |

## H. Account and platform

| Item | What it is | Status | Evidence |
|---|---|---|---|
| H1 | Session renewal and signed-out reason (release blocker) | owner | #1133 (migration renumber) |
| H2 | Adult attestation and terms (release blocker) | not started | |
| H3 | The rest | partial | Uncapped admin invites (#1221) and the Google profile (#1218) landed. Sign-in with Google and the rest are not done. |

## Other numbered families

- **The Mac's M slices:**
  - built: M4 (#1193, #1201) and M5 (#1214);
  - not verified here: M1 (tool eligibility), M2 (tool contract pass) and M3 (scenario set; folds into #1185).
- **Master plan release checks A1–A16 (a separate numbering from workstream A):** none met. 12 are partial and 4 unmet: A3, A10, A12 and A13. See `research/gap-synthesis-2026-10-14.json`.
- **The gap page:** 61 gaps (G1–G62, without G46) in `research/gap-tables-2026-10-14.md`. These G numbers are not workstream G.
