# Waldo build direction, 21 October 2026

Waldo is a full personal assistant that plans and acts around how its owner actually is. It launches globally to wearable owners, runs one brain per owner with task workers around it, and is built in five waves. This file records the owner's decisions of 21 October 2026 and the wave order. It replaces the September build plan and the older release sequences wherever they conflict.

Current source and tests decide what actually works. A plan line is never evidence that a capability ships.

## Decisions (owner, 21 October 2026)

| Area | Decision |
| --- | --- |
| Market | Global-first. The first owners wear an Apple Watch, WHOOP, Oura or a Health Connect device on Android, anywhere in the world. People without a wearable use a one-tap "how are you today?" check-in. The agent and its rails must also work in India, but India is not the launch frame. |
| Product | Mail, calendar, follow-ups, errands and research by chat, fitted to the owner's sleep, recovery and load. Health-aware planning is the wedge. Health admin (refills, appointments, tests, insurance) is the first deep vertical. Later expansion reuses the same rails. |
| Per-market rails | UPI hand-off, Swiggy's MCP servers and Indian-language voice notes are per-market adapters. Core code never assumes one market. |
| Architecture | One brain per owner: `OwnerDO` is the only authority root and the only writer of memory, chats and approvals. Task workers run long, parallel or untrusted work and hold no authority. The second brain (RunLoopDO, `WaldoCoordinator`, the responsibility protocol, TracerDO) is deleted in wave 1. |
| Health data | The app collects Apple Health (HealthKit) on iPhone and Health Connect on Android. WHOOP and Oura connect through their cloud APIs. The backend computes Form, Recovery and Load once for every source, and the model sees zone words. Baselines are kept per source and per HRV method, and missing time is unknown, never zero. |
| Channels | The app is the primary presence: onboarding, health sync, approvals and "What Waldo knows". Chat runs on iMessage (Photon as a transport behind the iMessage bridge) and WhatsApp (Meta Cloud API, waiting on business verification). Telegram stays a team test channel until iMessage and WhatsApp carry the alpha cohort, then retires. No feature is built for one surface only. |
| Onboarding | Health connect moves into the first run as an optional, skippable step, so the first Brief can compare against a baseline. The rest of the first-run flow follows the onboarding research: three questions at most, a first look at the day, ask-first authority widened one area at a time. |
| Owner look-up | Looking the owner up is an agent skill, not an onboarding gate. The agent may search the owner's public footprint (web search, handles the owner names, the owner's own exports). Every finding shows its source in "What Waldo knows" and can be corrected or forgotten. It never infers health, religion, caste, politics or sexuality, and never profiles other people. The privacy notice says the look-up happens (GDPR Art. 14, DPDP notice). |
| Voice | The personality north star (Suyash, 20 October) is the voice source, with the build handoff's four adjustments: "assistant" is the word owners hear, but he acts on their behalf; a coming decision plus a changed state counts as waiting-makes-it-worse; approval cards always show recipient, content, time and undo; spelling follows the owner's locale. |

## Waves

Waves order dependencies, not the calendar. Only the worker layer (wave 3) gates later items: health admin, the launch jobs and R-4. Everything else runs as parallel lanes, each one coherent design built by one session rather than split into slices. Lanes land on `beta-mvp` through batched integration PRs, because the migration-lineage guard makes every branch carry the current tip. One session writes a hot file at a time (`owner-do.ts`, the DO schema, migration numbering). Design, security and privacy lanes run on Opus; implementing a settled design, carries and doc syncs run on Sonnet.

Staging gets no deploy per merge. After local proof, one bundled deploy goes to staging, then each feature is tested end to end in the Waldo console on the owner's account, read through Langfuse traces and Cloudflare logs.

1. **Land wave 1.** Ashish's 18 PRs (#1318–#1336 without #1334) as one integration, then #1334 after a read-only check shows the deleted classes' hosted storage is empty. In parallel: resolve every other open PR (land, rebase or close), and repoint the repository rules to this file.
2. **Harness and voice.** These items:
   - a byte-stable prompt with a versioned voice block (H-4);
   - parallel read calls (H-5);
   - compaction (H-8);
   - rule pruning with ablations (H-9);
   - the personality merged into the voice block, with eval cases;
   - a durable post-chat memory flush (M-4);
   - fixes for the iMessage proactive-delivery gap and the unwired per-owner cost cap.
3. **Worker layer.** These items, followed by R-4, the parked retry that makes the honest floor reply true:
   - the jobs table and job protocol;
   - TaskWorker;
   - worker profiles;
   - `start_task`;
   - reader jobs;
   - crash recovery and parking.
4. **The wedge.** These items:
   - a health trigger: a zone change plus a coming decision produces one approval card, and nothing runs in real time;
   - WHOOP and Oura app approval;
   - the Health Connect client;
   - Photon for iMessage;
   - WhatsApp production switches;
   - onboarding and the consent ledger (O-1 to O-8).
5. **Connectors and launch jobs.** These items:
   - an MCP client with OAuth and the Waldo connect page (C-1 to C-5);
   - health admin from mail;
   - launch jobs J-0 to J-7;
   - browser work, starting from the Browser Use bake-off once the team's redraft is done.

Approvals that run on other companies' clocks start now, whatever the wave: WHOOP, Oura, Photon (data terms and proactive messages on shared numbers), Meta business verification, Apple Messages for Business, and zero-retention terms with the model providers.

## Escalation ladder

Every task starts on the cheapest rung that can do it, and climbs only when a tool returns a structured blocked result. APIs and MCP are the primary rungs; browser and computer use are last resorts. The model picks the rung. Prompts and tool descriptions say what each rung is for, and no keyword router decides for it. Detail and costs are in the agent build plan, "Escalation ladder and unit economics".

| Rung | What | Cost per task | In source at `db49cb66` |
| --- | --- | --- | --- |
| 0 | Memory and reasoning | Model tokens | Yes |
| 1 | Connector: native API or MCP | ~$0.001–0.01 | Gmail, Calendar, Drive, Tasks; MCP on staging only |
| 2 | Email parsing | ~$0.001–0.01 | Mail reads; read depth in the Gmail stack |
| 3 | Search and fetch | Free–$0.007 | `web_search`, Cloudflare public reads |
| 4 | Cloud browser | ~$0.05–0.50 | Cloudflare `browse_act` on staging; Browser Use adapter off |
| 5 | Sandbox | Cents | No production handler for `execute_code` |
| 6 | Owner's Mac | — | `use_mac` |
| 7 | Human | — | Later |

Two gaps close in wave 2. Tools need structured blocked outcomes (`login_required`, `js_required`, `challenge`), where today only `blocked_reason` exists. The prompt and tool descriptions need to tell the model to start on the cheapest rung.

## Review bar

Every batch is reviewed against these questions before it merges. They are questions for the sessions and people building Waldo, not rules Waldo runs, and none of them may be met by narrowing what the agent can do. A "no" blocks the merge or files a follow-up.

1. **One brain.** Does `OwnerDO` stay the only authority and the only writer? Do workers get a complete brief and hold no authority?
2. **Cheapest rung, strong tools.** Does the work use the lowest rung that can do it? Are tools shaped around tasks rather than endpoints? Do they return high-signal context and errors that say how to recover?
3. **No restriction without a harm.** Does every new limit, cap or guard name the harm it prevents, and degrade rather than fail?
4. **Context.** Is the prompt prefix byte-stable and the context append-only, with cache share measured? Is context sized to the task, with no blanket redaction or size refusal?
5. **Proof.** Is the change proven by a scenario or eval case, not only unit tests? Does each failure found in use become a regression case?
6. **Honesty.** Does every claimed action have a receipt? Does Waldo say what it does not know, rather than invent readiness or completion?
7. **Proactivity earns the interruption.** Does a proactive message pass the interrupt budget and quiet hours, and count toward the false-alarm rate (fewer than 1 per owner per week)?
8. **The owner stays in control.** Can the owner see, correct, forget and undo memory, grants and actions? Does authority widen one area at a time?
9. **Long work survives.** Are effects idempotent, keyed and applied once? Can long tasks resume after a crash and report progress?
10. **Every surface.** Does it behave the same in the app, iMessage and WhatsApp, with no feature built for one surface only?
11. **The wedge.** Does it serve health-aware planning, including for people without a wearable, and keep its pilot thresholds measurable?
12. **Privacy and authority lines.** Are health values kept out of logs, ledger rows, third-party sends and long-term memory? Are credentials kept out of prompts? Is consent checked?
13. **Cost.** Does it stay inside the per-owner cost envelope, with tokens, rungs and cache share visible per turn?
14. **Untrusted text stays untrusted.** Every field the owner did not type enters context as delimited untrusted data, and memory written from it records its source. That covers contact names, vCards, location labels, email sender names, page text, and MCP server or tool descriptions. A turn that has read untrusted content creates no channel links, grants, schedules or standing instructions without the owner's approval.
15. **Disclosed AI, with a human behind it.** Does Waldo identify as an AI on every channel? Does a route to a human exist where a channel requires one? Apple asked Poke for both before approving it for Messages for Business.

### Tool checklist

Each tool change is checked against these:

1. Every write takes an application idempotency key, never a transport id, and a replay returns the original receipt.
2. The approval card shows the frozen arguments, and dispatch rejects any change to their digest.
3. Approval and run-without-a-card decisions never rest on annotations from a third-party server, which are hints only.
4. Schemas are strict, each with a valid and an invalid test. Fields the code already knows, such as the owner, time zone or tokens, are never asked of the model.
5. Results show names rather than ids, offer a concise form, and paginate and cap long lists, with guidance on how to narrow them.
6. Errors use the one refusal shape, and a test proves the suggested fix succeeds on retry.
7. Tools are task-shaped and listed in a deterministic order. Only the core set stays loaded; the rest are found through tool search.
8. A tool change ships after a held-out eval run whose transcripts have been read. State is checked by assertions, never by a judge alone.


The comparison set for this bar:
- Harnesses: Claude Code and the Agent SDK, OpenAI Codex, OpenClaw, Pi, Goose, Hermes and Cursor.
- Memory: Cognee, MemPalace, and LongMemEval as the benchmark shape.
- Evals: τ-bench, for pass^k.
- Personal agents: Instinct, Muse and Poke.
- India rails: UPI hand-off, Swiggy's MCP servers, Indian-language voice notes and the DPDP notice.

The bar draws on public writing:
- Anthropic, "Building effective agents" (2024), "Writing effective tools for agents" and "Effective context engineering for AI agents" (2025);
- Manus, "Context engineering for AI agents" (2025);
- Cognition, "Don't build multi-agents" (2025);
- HumanLayer, "12-factor agents";
- OpenAI, "A practical guide to building agents" (2025).

2026 sources behind questions 14 and 15 and the tool checklist:
- the MCP 2026-07-28 specification changelog (deterministic tool order; Client ID Metadata Documents replacing Dynamic Client Registration; `iss` validation; `input_required` results);
- Imperva and Zenity on OpenClaw injections through message metadata and self-edited configuration (February and June 2026);
- TechCrunch on Apple's conditions for Poke (4 June 2026);
- Anthropic, "Demystifying evals for AI agents" (January 2026);
- arXiv 2606.10315 and 2606.19544 on judge blind spots and agreement.

## How we prove it

Every wave ships against the same proof ladder. A step that cannot run yet is recorded as NOT RUN with its reason, never as a pass.

| Rung | What it proves | Where it lives |
| --- | --- | --- |
| Verify wall | Contracts, runtime, guards and migrations hold | `pnpm verify`, `verify.yml` |
| Scripted scenarios | Tool order, receipts and refusals on fixed model output (194 tests at the M0 baseline) | `vitest.scenarios.config.ts` |
| Recorded eval gate | Every eval scenario still runs on behaviour PRs | `evals.yml`, `evals/nightly/gate.ts` |
| Live eval suite | Pass rate and pass^k per job with a judge model, under a call cap | `evals-live.yml`, `pnpm eval:nightly` |
| Voice and safety judge | Replies pass the personality's six tests; dose, diagnosis and crisis cases hold | New eval cases in the nightly suite |
| Memory suite | Knowledge updates, time reasoning and abstention (LongMemEval-style, synthetic) | M-5 to M-11 |
| Fault injection | Provider fallback, breaker and parked retry behave under outages | R-7 cases and the game day |
| Staging channel probes | Real webhooks on test accounts for the app, iMessage, WhatsApp and Telegram, with receipts | `scripts/probe-staging.mjs`, Simulator |
| Owner telemetry | Cost, latency, cache share and tool choice per turn | Turn event v9, cost ledger, Langfuse |
| Alpha pilot | Wearable-informed days against check-in days: proposal acceptance, actions per week, day-30 retention, false alarms | Pilot thresholds in "Health as Waldo's wedge" |

Each failure found in dogfooding or the pilot becomes a regression eval case in the same change that fixes it.

## Source documents

These Claude docs hold the detail behind each decision. Where they disagree with this file, this file wins until they are updated.

- [Waldo build handoff: backend, harness and personality](https://claude.ai/artifact/J1CnxUzs8KZDstptVXCmaD)
- [Waldo launch brief](https://claude.ai/code/artifact/99e32f08-88a5-409c-87e8-2bfb3176371e)
- [Waldo agent build plan](https://claude.ai/artifact/MGDBPSqzWQibPfCVvCqzY3): the architecture, the job protocol and memory sections hold. Its India-first framing, channel table and pricing are superseded by the decisions above.
- [Waldo personality: north star](https://claude.ai/artifact/9VE8Rz71y1rqY6C6Up86Uh)
- [Waldo v1 build](https://claude.ai/artifact/1xg9szN3bk7TgMp57Csx6R)
- [Health as Waldo's wedge](https://claude.ai/artifact/V5cYvfv58wZfFB4EcmDExm)
- [Waldo onboarding: how a real assistant starts](https://claude.ai/artifact/48GNboKousd11DSgsdELkL)

The Brain launch contract (`01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md` in `Pin4sf/waldo-brain`) still describes the September product and is amended to match this file.
