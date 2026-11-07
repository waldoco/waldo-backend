| #207 | draft | `codex/trace-parity` | `e5fd1cab` | beta-mvp | 2026-10-21T10:54 | Prepare Cloudflare query redaction and typed Langfuse failure traces |
| #213 | ready | `fix/composer-tool-output-degrade` | `2e7a9f84` | beta-mvp | 2026-09-26T08:26 | fix(S1): composer per-fragment degrade for tool_outputs overflow |
| #215 | ready | `fix/consent-ttl-reissue` | `24e11728` | beta-mvp | 2026-10-21T10:54 | fix(S3): connect-link TTL 15min -> 12h with truthful expired-link copy |
| #439 | draft | `codex/admin-invite-cosmetics` | `b4b28343` | beta-mvp | 2026-10-21T10:54 | fix(dashboard): mobile admin heading and honest revoke receipt |
| #1033 | ready | `test/owner-ingress-pinned-clock-owner` | `832850ad` | beta-mvp | 2026-10-21T10:54 | Owner ingress test: run the pinned-clock recovery cases on their own owner with scheduled work off |
| #1043 | draft | `instinct/weather-daylight-tool` | `deab3137` | beta-mvp | 2026-10-21T11:26 | feat: get_weather tool (Open-Meteo), brief 02 WIP |
| #1063 | draft | `ashish/staging-pages-design-parity` | `d7c9165b` | beta-mvp | 2026-10-21T10:55 | feat(console): standalone worker pages match the dashboard design |
| #1078 | draft | `l2/history-cut-counts` | `863427c6` | beta-mvp | 2026-10-12T02:18 | Count the history each reply call leaves out |
| #1082 | ready | `ci/guard-actions-pinned` | `f0d328cf` | beta-mvp | 2026-10-21T10:55 | ci: guard that workflow actions are pinned to full SHAs |
| #1105 | ready | `l2/mail-read-depth` | `d1ad2120` | beta-mvp | 2026-10-21T10:55 | Read the Gmail body the sender meant, and say when only the preview was readable |
| #1109 | ready | `l2/prep-related-mail` | `44a447b1` | beta-mvp | 2026-10-21T10:55 | Let meeting prep read the owner's mail tied to the meeting, bounded and unstored |
| #1112 | ready | `l2/mail-links` | `39d57147` | beta-mvp | 2026-10-21T10:55 | List the links in an HTML mail after its body, bounded and without verification links |
| #1117 | ready | `l2/mail-chunks` | `40e1ba58` | beta-mvp | 2026-10-21T11:30 | Read Gmail bodies past 32,000 characters in chunks, and list attachments by name |
| #1127 | ready | `l5/sleep-debt-migration` | `a0669da8` | beta-mvp | 2026-10-13T08:15 | needs owner: store sleep debt on the derived health row (migration 20261013090000) |
| #1133 | ready | `claude/app-session-30-day` | `bad90ded` | beta-mvp | 2026-10-13T16:36 | needs owner: keep the app signed in for 30 days, renewed after a day, with per-device sign-out (migration) |
| #1138 | draft | `l5/overview-carrying-loops-worker` | `484e5b2e` | beta-mvp | 2026-10-13T09:01 | held for app re-pin: show what Waldo is carrying and the open loops on the app's day view |
| #1148 | ready | `claude/google-workspace-plan` | `0aa7625f` | beta-mvp | 2026-10-21T09:42 | Google Workspace plan for the agent |
| #1159 | draft | `l5/health-scores-history-contract` | `4539c597` | beta-mvp | 2026-10-13T13:25 | contracts: health score history for the Body detail chart |
| #1161 | draft | `l5/health-scores-history` | `f04081d9` | l5/health-scores-history-contract | 2026-10-13T13:25 | needs owner: serve health score history to the Body detail chart (migration) |
| #1167 | draft | `l2/approval-wording-emit` | `a9683520` | beta-mvp | 2026-10-13T17:59 | HOLD: serve each approval's question, button labels and undo window |
| #1177 | ready | `claude/app-push-expo` | `b7e7ae2b` | claude/app-session-30-day | 2026-10-13T16:35 | needs owner: push the Brief to the owner's app through Expo |
| #1227 | draft | `mac/first-conversation` | `e6c70e27` | beta-mvp | 2026-10-14T19:59 | Lead a getting-to-know-you first conversation and let the owner set their time zone in chat |
| #1228 | ready | `claude/voice-note-instruction` | `8723c596` | beta-mvp | 2026-10-15T02:15 | The owner's own Telegram voice note is their instruction, as transcribed |
| #1238 | draft | `mac/forget-provider-facts` | `4ce03763` | beta-mvp | 2026-10-14T14:20 | Forget suppresses Google's name and phone without a disconnect, and the forget settles (C2 of #1218's persistence review; stacks on #1227) |
| #1240 | draft | `mac/first-conversation-followups` | `4d8cfb72` | beta-mvp | 2026-10-14T14:41 | Follow-ups to #1227's gate review: setting tools under the taint gate, the zone facts refresh, the replay basis, the runtime rebuild test, and the D5 trip evals (stacks on #1227) |
| #1243 | draft | `fix/app-unmatched-forget-history-conflict` | `f4935dd1` | beta-mvp | 2026-10-21T11:06 | App forget turns complete: publish the reply on the stored owner input |
| #1248 | draft | `claude/bounded-history-load` | `985a1645` | beta-mvp | 2026-10-21T11:40 | Load only the conversation window each turn, and prune then summarize long threads (H-8) |
| #1249 | draft | `claude/claims-against-receipts` | `2b3a6c64` | beta-mvp | 2026-10-15T02:50 | Check every reply's done-claims against the turn's receipts before delivery |
| #1253 | draft | `claude/remove-chat-commands` | `b6b7fb84` | beta-mvp | 2026-10-14T17:00 | Take the chat commands off every surface; "stop" is ordinary text |
| #1260 | draft | `claude/a2-owner-runtime` | `84c53073` | beta-mvp | 2026-10-15T12:04 | A2: build one core per owner and a runtime per surface from adapters |
| #1277 | ready | `claude/owner-decision-adrs` | `711ac60d` | beta-mvp | 2026-10-15T01:43 | needs owner: five decision drafts (health in chat rows, standing grants, reply watch, spend ceiling, Google verification) |
| #1282 | draft | `mac/console-tasks-view` | `6560a775` | beta-mvp | 2026-10-21T10:55 | Console: read-only Tasks view of open loops |
| #1284 | ready | `claude/console-generative-ui` | `d8cb0f3a` | beta-mvp | 2026-10-15T08:05 | Waldo can show options, tables, plans and timelines beside its words |
| #1288 | draft | `mac/adr-draft-mcp-oauth` | `ca0e6cd8` | beta-mvp | 2026-10-15T08:32 | ADR draft: owner sign-in (OAuth) for third-party MCP servers (Swiggy, Zepto) |
| #1290 | draft | `mac/held-topic-redaction` | `25b43019` | beta-mvp | 2026-10-15T09:04 | needs owner: cut held forget topics out of public web results instead of withholding the page (#1286) |
| #1298 | draft | `docs/new-user-identity-flow-design` | `1e6daf37` | beta-mvp | 2026-10-16T18:49 | Design the new-user flow: one Waldo account linked by email and phone, with Google sign-in |
| #1309 | ready | `claude/whatsapp-refused-custody` | `88728424` | beta-mvp | 2026-10-21T10:13 | WhatsApp: keep a window-refused send in the outbox, and settle only when Meta says it arrived |
| #1310 | ready | `claude/whatsapp-held-approval-cards` | `efeb2e28` | beta-mvp | 2026-10-21T10:13 | WhatsApp: record an approval card as presented only once it is delivered |
| #1311 | ready | `claude/forget-held-heartbeats` | `74de820b` | beta-mvp | 2026-10-21T10:37 | Owner forget reaches heartbeat check-backs and reminders waiting for WhatsApp (stacks on #1308) |
| #1334 | draft | `ashish/core-brain-deletion-v8` | `974e7129` | ashish/core-brain-deletion-tracer | 2026-10-20T16:15 | DO NOT MERGE: v8 deleted_classes for RunLoopDO, TracerDO, RuntimeProbeDO (B-1 step 2) |
| #1340 | draft | `claude/wave2-telemetry-followups` | `5f7a855f` | beta-mvp | 2026-10-21T11:06 | Log typed tool error codes and record the floor reply honestly |
| #1342 | draft | `evals/voice-safety-judge` | `8be8defb` | beta-mvp | 2026-10-21T12:25 | Evals: voice and safety judge, 14 scenarios, labelled set and judge agreement |
| #1343 | draft | `claude/wave2-parallel-reads` | `28fd6cb6` | claude/wave2-telemetry-followups | 2026-10-21T11:41 | Run read-only tool calls from one model response at once (H-5) |
| #1344 | draft | `claude/browser-errands-seam` | `0eadefe9` | beta-mvp | 2026-10-21T10:00 | Browser errands: vendor-neutral seam, Browser Use v4 adapter (flag off), bake-off harness |
| #1345 | draft | `evals/errands-parity` | `b92b44b2` | evals/voice-safety-judge | 2026-10-21T12:24 | Evals: errands parity set (20 tasks, 13 nightly) and live baseline readiness |
| #1346 | draft | `harness/h4-stable-prompt-voice` | `cd070ed8` | beta-mvp | 2026-10-21T11:25 | H-4: byte-stable system prompt with a versioned voice block |
| #1347 | ready | `fix/drive-rate-limit-transient` | `0052bc88` | beta-mvp | 2026-10-21T11:58 | Treat Drive's 403 rate limits as rate limits, not refusals |
| #1348 | draft | `claude/wave2-cost-cap` | `dda157af` | beta-mvp | 2026-10-21T11:43 | Degrade owner turns past a 25 USD monthly ceiling: clamp to the owner's cheap route, hold paid tools |
| #1349 | ready | `harness/brain-tool-surface` | `5183af6c` | harness/h4-stable-prompt-voice | 2026-10-21T11:16 | Load a dozen core tools each round and the rest through provider tool search (phase 3, behind WALDO_TOOL_SEARCH) |
| #1351 | ready | `claude/wave2-harness-batch` | `03f239d9` | beta-mvp | 2026-10-21T12:16 | Wave 2 harness batch: telemetry follow-ups, parallel reads, forget-turn fix, bounded history + compaction (off), spend ceiling |
| #1352 | ready | `docs/review-bar` | `0d8709e4` | beta-mvp | 2026-10-21T12:12 | Build direction: parallel lanes, the escalation ladder and the review bar |
| #1354 | draft | `claude/wearables-trigger-a69617` | `b75e89d2` | beta-mvp | 2026-10-21T12:28 | Wave 4 wedge: health trigger, Health Connect ingest, WHOOP and Oura adapters |
| #1355 | draft | `claude/worker-layer` | `a59e31db` | beta-mvp | 2026-10-21T12:04 | Worker layer: task jobs, TaskWorker, profiles, start_task, crash recovery, parked retry (B-2 to B-7, R-4) |
| #1356 | draft | `claude/onboarding-consent-a1f9ee` | `b87c915d` | beta-mvp | 2026-10-21T12:10 | Onboarding, consent ledger and the owner look-up skill (O-1 to O-8) |
| #1357 | draft | `claude/connectors-mcp-397547` | `ed53ba86` | beta-mvp | 2026-10-21T12:21 | Connect remote MCP servers with OAuth from the console (C-1 to C-5) |
| #1358 | ready | `train/2026-10-21-a` | `aca8a6b5` | beta-mvp | 2026-10-21T12:18 | Merge train, 21 Oct: wave 2 harness batch (#1351), Drive rate limits (#1347), review bar (#1352) |
