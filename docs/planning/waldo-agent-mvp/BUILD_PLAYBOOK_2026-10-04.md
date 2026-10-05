# Waldo build playbook: owner per item, proof per item (2026-10-04)

Layers: SOURCE (merged code), CI, STAGING (trace on the staging bot), LIVE. Say "staging-verified" or "production-verified" only with a trace. Dalda's results are his claims until we read the trace. Status here is read from source on beta-mvp at the time of writing.

Follow the [engineering execution playbook](ENGINEERING_EXECUTION_PLAYBOOK.md) for standing why-build, mature-implementation research and complete journey verification. Track prepared source, tests, merged SHA, deployed version and live behavior separately; this dated inventory is not a release receipt.

Core journey order (Dalda's order, accepted): connect Google -> context -> prepare/act with verification -> follow through. Merging a PR is not an acceptance result. Polling is fine for the first product; event-driven waking is not a gate.

## Not in the immediate release gate
Payments, own mailbox identity, every booking service driver (flight, dining, ride, food, shopping), game play, Linux execution, A2A, new channels. They stay in the pack as blocked procedures. The owner's goal that all 27 procedures work out of the box is a later gate after the core journey.

## Interaction qualities (a required check in every end-to-end test)
1 interruption or priority change keeps task state; 2 ask only about blockers; 3 resolve the person, file and account; 4 combine evidence and explain conflicts; 5 visible progress without noise; 6 the smallest decision for the owner; 7 preferences without invented memories; 8 revise the same artifact. A trace that fails any of these is not a pass.

## Ownership

### Instinct (core lane)
| Item | Next deliverable | Proof (STAGING trace) |
|---|---|---|
| Google single connect, multi-account | S1: one connect, scopes with handlers, two accounts; built with fakes first | owner connects once; mail+calendar load; the answer names the account |
| Context quality | #712 (redaction drop) then S3/S5 acceptance includes answer quality | mail/calendar answer shows real names and addresses in the model-visible result |
| Profile, timezone, About me | S3: audit stores, build | new owner sets timezone; About me reaches the prompt |
| Deadline detector and nudges | S5 detector + heartbeat hook (full mail context, no minimal extract); #709 settings store | synthetic deadline mail -> one nudge; opted-out owner -> none |
| Write actions (send, reply, calendar, Drive) with approval + receipt | audit approval and receipt path per write tool; patch files for Dalda | draft -> approve -> send; receipt matches the provider id |
| Scheduled and recurring jobs (polling) | reminder/watch lifecycle audit against the pack | reminder fires once; cancel works |
| Browserbase read-only path + search-vs-browse eval | #706/#707/#708 merged; eval list ready | browse one-shot after deploy; owner grants spend |
| Model routing and cost | routing table + per-turn cost line (no model calls from core) | cost recorded per turn; owner sets the ceiling |
| Grading loop | scenario list, rubric, hard-fail rules, E01-E04 | graded trace set per release |
| 27-skill wiring + traces | per-skill table below | one Telegram trace per skill |
| Earned autonomy | per-action-type standing grants, widen/revoke, remembered, shown in receipts | owner grants "send reminders to X"; later send needs no approval; revoke restores it |
| Interruption timing | decide: message now, batch, or stay quiet unless waiting costs | trace shows each of the three outcomes |
| Voice in/out | gap audit of the Telegram media path, then plan | voice note answered; spoken reply optional |
| MFA / authenticator handoff | design; secrets only via vault link | MFA step handed to the owner without the code in chat |

### Dalda
| Item | Next deliverable | Proof |
|---|---|---|
| Serving-path wiring (proactivity, claims, receipts; reconcile settings; #711 rebases onto #709, we own the settings store, he reads and wires) | gate swap and receipt-line wiring from core's handoff files | deadline journey end to end |
| Memory forget, correction, continuity, compaction | runner windows, forget drill | forget one item and not others; correction sticks; long conversation holds |
| Recovery and delivery (interrupt, cancel, duplicates, truthful completion, file delivery) | owner-turn/DO work; core supplies fault tests and grading | cancel mid-run; restart mid-run; no duplicate send |
| Deploys and staging | single deploy writer; sets WALDO_EGRESS_ALLOWLIST | /healthz shows the new SHA |
| Telegram journey tests + second Telegram account | owner-2 binding | isolation rows I2, I9 plus Telegram-side rows |
| Multi-user ops (per-owner limits, shared-provider failure, backup restore, small concurrent-user test) | test plan | 3-owner concurrent run, no cross-reads |
| Cloudflare continuity | keep distinct from Browserbase | one primary browser path proven |

## Dalda's corrections to the earlier matrix
1 The shipped builtins are default-seeded (SOURCE: #683 "reviewed builtins on by default, disables preserved"). My earlier "needs /skills install" is out of date. Auto-load on staging is his claim until traced.
2 The 27-procedure pack exists (all-skills-v1.1.md). It is an authored inventory with capability gates, not proof the tools work. It is the skills inventory below.
3 Files: staging-verified journeys (create, revise, readback, search, Telegram links) are his claim; core grades the traces.
4 Multi-account Google and one-step onboarding are separate requirements (S1, S3).
5 Polling first, event waking later. 6 Payments, own mailbox, booking drivers, all 27 are out of the immediate gate. 7 Use "staging-verified" and "production-verified" only with a trace.

## The 27 procedures (from the pack's own capability gates; tool names are schema entries in source, handler status unproven unless a trace exists)
| # | Procedure | Tools it needs | Status | Blocker |
|---|---|---|---|---|
| 1 | Day brief | query_calendar, get_tasks, get_communication, read_owner_context | schemas in source | S1 Google connect; calendar-prep flag off on staging |
| 2 | Meeting prep | query_calendar, read_thread, read_owner_context | schemas | general Drive reader missing |
| 3 | Inbox triage + reply draft | get/search_communication, read_thread, draft_email | schemas | multi-account scan unproved |
| 4 | Sourced research brief | web_search, browse_page, read_tool_output | merged | deploy of #706-#708 |
| 5 | Calendar + focus-time proposal | query_calendar, query_availability, get_tasks, propose_calendar_change | schemas | invitation mutation unproved |
| 6 | Project catch-up | read_owner_context, search_episodes, get_tasks, search_communication, read_thread | schemas | goal store, project connectors missing |
| 7 | Weekly review | query_calendar, get_tasks, read_owner_context | schemas | waiting-for list, task-write gaps |
| 8 | Follow-up prep + monitored continuation | read_thread, draft_email (send_email) | schemas | joined watcher lifecycle not accepted |
| 9 | Logged-in browser task | none admitted | blocked | browse_act is public, not a logged-in driver |
| 10 | Flight options/booking/check-in | none | research only | booking drivers; outside gate |
| 11 | Dining + reservation | none | research only | reservation driver; outside gate |
| 12 | Ride request | none | blocked | ride + payment driver; outside gate |
| 13 | Food order | none | research only | ordering driver; outside gate |
| 14 | Shopping, renewal, refund | none | research only | commerce/payment driver; outside gate |
| 15 | Reviewed outbound message | read_thread, draft_email | schemas | send_message proposes to the owner only |
| 16 | Reminders + watch lifecycle | set/list/cancel_reminder, open_loop, close_loop | foundation | joined watch acceptance pending |
| 17 | Document signing prep | none | blocked | signing tools missing |
| 18 | Scoped engineering continuation | none | not established | owner-specific harness |
| 19 | Trusted-person coordination | none | blocked | peer transport not proved |
| 20 | Memory correction + continuity | read_owner_context, search_episodes | foundations | all-store acceptance (Dalda's runner) |
| 21 | Meal/activity log, health planning | log_meal, log_workout, list_health_logs | schemas | live ingest unproved; health gated by medical lines |
| 22 | Composed work/personal planning | query_calendar, get_tasks, read_owner_context | unproven composition | needs 1, 7 |
| 23 | Learning, practice, decision reuse | read_owner_context, web_search | partial | course/document access |
| 24 | Structured artifact authoring | create/read/list/revise_artifact | text subset | native/binary export absent |
| 25 | Artifact visual quality | none | blocked | renderer + inspection tools missing |
| 26 | Revision-safe save + delivery | read_artifact, revise_artifact | CAS foundation | joined create/revise/open acceptance |
| 27 | Richer document + native export | none | blocked | export stack missing |
Added by the owner (not in the pack): voice in/out, MFA handoff, earned autonomy, interruption timing (Instinct items above). Pack rows 9-14, 17-19, 25, 27 depend on drivers outside the immediate gate; they stay blocked until the owner opens that gate.
Per-skill proof is one Telegram trace; "working" means that trace exists, not that the schema does.

## Guards that stay (plain-words why)
Cross-owner reads (another owner's data must never appear); credentials and card numbers (must not reach logs or other owners); irreversible actions without a receipt (the owner must see what happened); hard medical lines. See GUARD_SWEEP_2026-10-04.md.
