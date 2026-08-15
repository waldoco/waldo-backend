# Benchmark agent capability audit — Waldo backend convergence

**Checked:** 2026-08-15
**Status:** primary-source research; not product parity, deployment, security certification, or live acceptance
**Question:** Which capabilities are currently documented or implemented by the agent systems Waldo already treats as benchmarks, what has Waldo actually landed through B1, and what should B2–B6 adopt, adapt, or reject?

## Executive conclusion

**[Inference, high confidence]** The benchmark floor has moved relative to the older Waldo shorthand. **[Observed, high confidence]** Persistent goals, bounded subagents, restart-aware background work, multi-channel gateways, tool policy, sandbox choices, memory controls, trajectory export, and deterministic verification gates now appear across multiple first-party systems. Hermes and OpenClaw in particular document broader capability sets than “personal agent with memory and channels”: Hermes documents completion contracts and deterministic quality gates; OpenClaw documents durable session goals, SQLite-backed restart recovery, delivery reconciliation, background-task accounting, provenance-aware memory ingestion, and a wide channel/device surface.

**[Observed, high confidence]** Waldo has completed a different, narrower foundation through B1: public-contract reproducibility, authenticated owner routing, full-command replay identity, one committed execution writer, server-derived authority, recover-before-execute, stale observation rejection, and a deterministic local/fake WorkUnit start path. The exact landed boundary is recorded in the [B1 review handoff](../ledger/2026-08-14-b1-workunit-execution-bridge-review.md) and the current [B0–B6 plan](../foundation/NEXT-SESSION-PLAN.md).

**[Inference, medium-high confidence]** Waldo is not yet a capability-complete personal agent or a functional competitor to Hermes or OpenClaw. It has stronger specified separation between executor completion and user-owned Outcome truth than the inspected benchmarks, but that distinction is still mostly a contract and architecture advantage. B2–B6 must ship the closure spine, presences, real effects/adapters, governed context, durable messaging, portability, and operational acceptance before the product can be compared honestly in real use.

**[Decision]** Do not turn the competitive audit into a parity checklist. Adopt proven runtime mechanics; adapt them behind Waldo's authority, evidence, and acceptance contracts; reject any design where a provider turn, LLM judge, successful tool call, delivered message, or completed subagent silently becomes accepted human Outcome truth.

## Method and source boundary

The source order followed the repository research contract:

1. Local Waldo backend and waldo-brain records identified the canonical benchmark set and Waldo's intended boundaries.
2. Every material external claim below was rechecked against an official repository, official documentation, or source file.
3. Default-branch heads were resolved read-only with `git ls-remote` on 2026-08-15. Pins make this audit reproducible; live state after these pins outranks this file.
4. No benchmark was installed, credentialed, penetration-tested, or run end to end. “Not observed” means absent from the inspected first-party surface, not proof that the capability cannot exist elsewhere.

### Reproducible source pins

| System | Exact project and inspected head | Primary role in Waldo's benchmark set |
| --- | --- | --- |
| Pi | [`earendil-works/pi@086c32e`](https://github.com/earendil-works/pi/tree/086c32e74530564922d011ade23ff582c9d63116) — the current canonical home of the Pi coding-agent monorepo; the legacy `badlogic/pi-mono` URL redirects here | Thin evented loop, sessions, steering, compaction, embeddability |
| Hermes Agent | [`NousResearch/hermes-agent@e3fab04`](https://github.com/NousResearch/hermes-agent/tree/e3fab0437ee50ebe511cec57b9ac36f0c2803268) | Personal-agent continuity, learning, goals, delegation, cron, channels |
| OpenClaw | [`openclaw/openclaw@f24bd8a`](https://github.com/openclaw/openclaw/tree/f24bd8a2a29942bb54cfcb2932762186059ae774) | Self-hosted gateway, many presences, memory, goals, recovery, automation |
| YC QM | [`yc-software/qm@f9aec5e`](https://github.com/yc-software/qm/tree/f9aec5e79d8acca3473d47665c2dce2d92d3c5b8) | Capability-declared harness adapters, scoped computers, policy and audit |
| Cloudflare Agents / Think | [`cloudflare/agents@aed6d8f`](https://github.com/cloudflare/agents/tree/aed6d8f8506087d405613e768454e4f0c0ae7ea1) plus current official Think docs | Durable Object runtime, sessions, submissions, recovery, actions, subagent RPC |
| Agent Orchestrator | [`Untrivial-ai/agent-orchestrator@b3c51a2`](https://github.com/Untrivial-ai/agent-orchestrator/tree/b3c51a22a33dace7058bf6b47d20be8563b5e6cd) | Parallel coding-agent supervision, worktrees, PR/CI/review feedback |
| Medley | [`Spine-AI/medley@5e9e9a1`](https://github.com/Spine-AI/medley/tree/5e9e9a173763d66d1f151df53a401271fa3cf28a) | Goal interview, mission DAG, supervised parallel workers |
| OpenAI Codex | [`openai/codex@3685a61`](https://github.com/openai/codex/tree/3685a61dadefebb66690f8c0f945df044fc11b25) | Primary local provider target: threads, turns, approvals, sandbox, goals, subagents |
| Claude Code | [`anthropics/claude-code@0fa8c19`](https://github.com/anthropics/claude-code/tree/0fa8c19d50f70f9f383fb6ff5ce5209575267d21) plus official docs | Compatibility target: permissions, hooks, skills, subagents, resumable coding sessions |

## Capability matrix: core personal-agent and harness references

The cells describe first-party observed behavior, not quality scores.

“Pi” here means Mario Zechner's coding-agent harness, now maintained at `earendil-works/pi`, because Waldo, Agent Orchestrator, and Medley treat it as an executor substrate. It does not mean Inflection's consumer companion.

| Capability | Pi | Hermes Agent | OpenClaw | YC QM | Cloudflare Think |
| --- | --- | --- | --- | --- | --- |
| Identity and continuity | Application-owned session identity; reusable core does not define a personal identity | Profile-scoped `SOUL`, memory, skills, credentials and sessions across CLI, desktop and gateway | Gateway routes sessions and channels; each configured agent has its own workspace, persona, auth and session store | Person/room/org scopes compose resources; organization administration is first-class | One Agent/Durable Object instance and one or more Sessions; app supplies product identity |
| Memory | Host can transform context; coding harness persists a session tree and compaction summaries | Bounded `MEMORY.md` + `USER.md`, SQLite/FTS5 session search, memory-provider plugins; writes are automatic unless approval is enabled | Human-readable workspace memory, daily notes, search/indexing, staged provenance-aware promotion and optional dreaming | Scoped memory and workspace behind replaceable interfaces | Durable Session history, context blocks, FTS5 search, non-destructive compaction |
| Planning and durable goals | No product-level planner or personal goal contract in the inspected core | Persistent single-session goals; completion contracts; subgoals; deterministic shell gates; Kanban for multi-task work | One durable objective per session, a background-task ledger, revisioned persistent Task Flow and standing intents; no user-owned Outcome contract observed | Scoped crons/queues and harness turns; no personal Outcome contract observed | Durable turn submissions and Workflows; product goal model is application-owned |
| Delegation and subagents | SDK can build custom subagents; not a core coordination primitive | Fresh-context children, parallel batches, bounded depth/concurrency/iterations, inherited-but-narrowed tools | Background child sessions, bounded nesting/concurrency, restricted tool surface, optional context fork | Multiple harness providers and scoped collaborative work rather than one canonical subagent primitive | Parent-child RPC, agents-as-tools, retained runs and detached notifications |
| Tools and connectors | Typed app-supplied tools, lifecycle events and pre/post hooks | Broad toolsets, MCP, terminal/browser/web, skills and code-execution RPC | Typed tools, skills, MCP, browser, nodes, plugins, media and many channels | Small fixed model tool surface over scoped files, memory, keychain, apps, MCP and sandbox execution | Server/client tools, MCP, workspace/shell/browser, extensions, skills and Actions |
| Sandbox and permissions | Explicitly no built-in filesystem/process/network/credential restriction; containerization is host responsibility | Local or isolated terminal backends; command deny/approval guardrails; gateway default-denies unknown users | Sandbox is configurable and off by default; tool policy, exec approvals, pairing and explicit elevated escape hatches compose | Per-scope computer plus strict/auto/dangerous postures, command policy and audited grants; security doc lists important residual gaps | Durable Object isolation plus optional sandbox; Actions authorization is opt-in and turn authorization defaults to full grant |
| Durable/background work | Session persistence yes; scheduler and durable worker are host responsibilities | Cron is separate durable work; background terminal processes exist; ordinary delegated children remain owned by the parent turn/session | Cron, automation, standing orders, background-task ledger and subagent task records | Durable computers, crons, queues and session/turn persistence | Durable submissions, fibers, scheduled tasks, Workflows and detached agents-as-tools |
| Recovery and idempotency | Resume/fork/import and compaction exist; external-effect replay policy belongs to the host | Sessions resume; gateway supervision and cron persist; terminal-backend persistence varies and active delegation is not the general durable-job primitive | Documented restart recovery for turns, children, tasks, task-flow revisions, deliveries and schedules; execution and result-delivery state remain separate, with bounded tombstones and fail-closed unknown outcomes | Tool-call ledger replays recorded results; deployment and run state are audited | Submission idempotency; stream recovery; Actions ledger, but stale pending actions may re-run after a lease and docs promise at-most-once only on the happy path |
| Multi-channel surfaces | CLI/SDK/RPC; host builds other surfaces | CLI, TUI, desktop and one gateway across many messaging platforms | Web Control UI, desktop/mobile nodes, voice and a broad channel-plugin surface | Web and Slack are primary; organization deployment supplies integrations | WebSocket/React chat, messenger webhooks, email/Slack/voice primitives at SDK level |
| Observability and evals | Awaited lifecycle/tool events; shareable session traces; host owns evals | Tool/session logs, dashboard, trajectory generation/compression and training workflows | Status/diagnostics, task audit, redacted trajectory bundles and session/tool timelines | Audit records, provider request records, session history, tool ledger and deployment checks | Structured diagnostics channels, tracing, lifecycle hooks and Durable Object analytics |
| Outcome and verification semantics | No user-owned Outcome/Acceptance model observed | Strong coding completion mechanics, but the auxiliary LLM judge can be wrong; docs say blocked/unachievable may be treated as done to stop spend | Durable goal status and operator controls, but the model can mark complete and no independent evidence/Acceptance aggregate was observed | Audit and deployment verification exist; no personal Outcome/Acceptance aggregate observed | A turn/workflow/action can complete and emit typed output; no user-owned Outcome/Acceptance aggregate is supplied by the framework |

### Evidence behind the matrix

- **Pi:** The official README states that Pi runs with the launching process's authority and has no built-in filesystem, process, network, or credential permission system. Its core documents stateful tool execution, awaited lifecycle events, pre/post tool hooks and stop hooks; its SDK documents session lifecycle, resume/fork/import, steering/follow-up queues and programmatic embedding. It intentionally omits built-in MCP, subagents, planning/Todos, permission popups and a sandbox; those are host or extension responsibilities ([README](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/README.md), [agent core](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/agent/README.md), [SDK](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/coding-agent/docs/sdk.md), [security](https://github.com/earendil-works/pi/blob/086c32e74530564922d011ade23ff582c9d63116/packages/coding-agent/docs/security.md)).
- **Hermes:** The official overview documents one core across CLI, messaging gateway, TUI and desktop, with memory, skills, cron, tools and delegation. Memory is bounded and agent-managed, with optional write approval and FTS5 session recall. Delegated children start fresh, inherit a narrowed parent tool ceiling and are not the recommended primitive for work that must outlive the parent. Gateway authorization defaults to deny/pairing; dangerous command prompts fail closed on timeout ([README](https://github.com/NousResearch/hermes-agent/blob/e3fab0437ee50ebe511cec57b9ac36f0c2803268/README.md), [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [delegation](https://hermes-agent.nousresearch.com/docs/user-guide/features/delegation/), [security](https://hermes-agent.nousresearch.com/docs/user-guide/security/), [cron](https://hermes-agent.nousresearch.com/docs/user-guide/features/cron)).
- **Hermes goals:** A goal persists in session state and can carry outcome, verification, constraints, boundaries and stop conditions. Deterministic commands gate completion before an auxiliary LLM judge runs. The same documentation explicitly records false-positive risk and says an unachievable/blocked goal is treated as done to avoid burning the turn budget ([persistent goals](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals), [verify-on-stop](https://hermes-agent.nousresearch.com/docs/user-guide/configuration/#verify-on-stop-coding-verification)).
- **OpenClaw:** Official docs call the Gateway the source of truth for routing, sessions and channels; document separate per-agent workspaces/auth/session stores; list broad channel/device/tool/plugin surfaces; and describe sandbox defaults, pairing and exec approvals ([overview](https://docs.openclaw.ai/), [multi-agent routing](https://docs.openclaw.ai/multi-agent), [features](https://docs.openclaw.ai/concepts/features), [sandboxing](https://docs.openclaw.ai/gateway/sandboxing), [exec approvals](https://docs.openclaw.ai/tools/exec-approvals)).
- **OpenClaw continuity:** Goals survive process restarts and keep operator-only pause/resume/clear/replace controls, while the model can only create, complete or block under tool rules. Memory is file-visible and recent ingestion excludes untrusted/tool-origin content from owner-grounded promotion. Restart recovery restores or reconciles turns, subagents, task ledgers, revisioned Task Flow, delivery queues and cron, with bounded recovery and fail-closed unknown delivery outcomes. Current personal-agent QA also exercises proof-backed completion and no-fake-progress behavior ([goals](https://github.com/openclaw/openclaw/blob/f24bd8a2a29942bb54cfcb2932762186059ae774/docs/tools/goal.md), [Task Flow](https://github.com/openclaw/openclaw/blob/f24bd8a2a29942bb54cfcb2932762186059ae774/docs/automation/taskflow.md), [memory](https://docs.openclaw.ai/concepts/memory), [restart recovery](https://docs.openclaw.ai/gateway/restart-recovery), [background tasks](https://docs.openclaw.ai/automation/tasks), [trajectory bundles](https://docs.openclaw.ai/tools/trajectory)).
- **QM:** Its official README defines swappable Pi/OpenCode/Codex/Claude harnesses, per-scope memory/files/keychain/crons/computers and audited policy. The source exposes an adapter profile with declared transports and capabilities; the tool context uses a durable ledger. Its own security policy says QM is early, administrators can read content, command policy can be bypassed, purpose text is not enforced after credential materialization, and retention/egress controls are incomplete ([README](https://github.com/yc-software/qm/blob/f9aec5e79d8acca3473d47665c2dce2d92d3c5b8/README.md), [harness interface](https://github.com/yc-software/qm/blob/f9aec5e79d8acca3473d47665c2dce2d92d3c5b8/src/harness/harness.ts), [tool ledger use](https://github.com/yc-software/qm/blob/f9aec5e79d8acca3473d47665c2dce2d92d3c5b8/src/tools/primitives.ts), [security](https://github.com/yc-software/qm/blob/f9aec5e79d8acca3473d47665c2dce2d92d3c5b8/SECURITY.md)).
- **Think:** Think supplies Durable Object-backed sessions, memory/search, streaming, subagent RPC, programmatic submissions, schedules and durable recovery. Its Actions surface adds idempotency, approvals and authorization, but is experimental; authorization defaults to full grant, and a stale pending explicit-key action is reissued after the retry lease unless the app disables that behavior. Cloudflare describes the guarantee as at-most-once on the happy path ([Think](https://developers.cloudflare.com/agents/harnesses/think/), [submissions](https://developers.cloudflare.com/agents/harnesses/think/programmatic-submissions/), [Actions](https://developers.cloudflare.com/agents/harnesses/think/actions/), [Workflows](https://developers.cloudflare.com/agents/harnesses/think/workflows/), [observability](https://developers.cloudflare.com/agents/runtime/operations/observability/)).

## Adjacent orchestration and provider references

These systems are important comparisons, but they are not full personal-agent substitutes.

| Reference | Observed capability | Boundary for Waldo |
| --- | --- | --- |
| Agent Orchestrator | Persistent project orchestrator with durable chat, approvals, usage and recovery; delegated workers across 26 harnesses; isolated worktrees and browser profiles; live Kanban plus PR, CI, review and conflict feedback; desktop and LAN-paired mobile control ([README](https://github.com/Untrivial-ai/agent-orchestrator/blob/b3c51a22a33dace7058bf6b47d20be8563b5e6cd/README.md), [architecture](https://github.com/Untrivial-ai/agent-orchestrator/blob/b3c51a22a33dace7058bf6b47d20be8563b5e6cd/docs/architecture.md), [shipped-status contract](https://github.com/Untrivial-ai/agent-orchestrator/blob/b3c51a22a33dace7058bf6b47d20be8563b5e6cd/docs/STATUS.md)) | Excellent Kennel Work/control-plane reference. A repository task, PR or CI status is not a whole-person Outcome or Acceptance record. |
| Medley | `/mission` interviews the user, builds a task DAG with per-task routing, supervises Claude/Codex/Cursor/OpenCode/Kimi/Pi workers when available, streams a local dashboard and survives sessions through a daemon ([mission contract](https://github.com/Spine-AI/medley/blob/5e9e9a173763d66d1f151df53a401271fa3cf28a/plugin/skills/mission/SKILL.md)) | Adapt mission interview/DAG/supervision UX, but do not use Medley itself as the B2–B6 isolation layer: parallel workers share one working tree and require file-disjoint ownership. The mission engine is a separate compiled, non-open-source binary, so its internal durability, authority and recovery guarantees were not independently inspectable. |
| OpenAI Codex | Local coding agent with durable threads, turn/item event streams, thread resume/fork, granular sandbox/permission and approval flows, subagent metadata and persisted thread goals ([app-server protocol](https://github.com/openai/codex/blob/3685a61dadefebb66690f8c0f945df044fc11b25/codex-rs/app-server/README.md), [goal tool contract](https://github.com/openai/codex/blob/3685a61dadefebb66690f8c0f945df044fc11b25/codex-rs/ext/goal/src/spec.rs)) | Primary provider adapter and Kennel compatibility target. Codex thread/goal completion cannot become Waldo Acceptance without independent evidence and owner policy. |
| Claude Code | Terminal/IDE/GitHub coding agent with permission controls, hooks, skills, subagents and resumable sessions in official product documentation ([repository](https://github.com/anthropics/claude-code/tree/0fa8c19d50f70f9f383fb6ff5ce5209575267d21), [subagents](https://code.claude.com/docs/en/sub-agents), [permissions](https://code.claude.com/docs/en/permissions)) | Second provider/conformance target. Its provider session and hook lifecycle remain executor state, not Waldo identity or Outcome truth. |

## Adjacent personal-assistant products

These products affect the user-experience and privacy benchmark. Their public product pages do not expose the same implementation depth as the pinned open-source systems above.

| Product | Current first-party signal | Boundary for Waldo |
| --- | --- | --- |
| Folk | One agent across personal and group chat, with separate room-scoped group memory, scheduling and explicit confirmation before group bookings ([groups](https://www.folk.com/docs/groups), [product](https://www.folk.com/crew), [privacy controls](https://www.folk.com/docs/privacy-plans-and-keys)). The older `/docs/crew` page is no longer current. | Benchmark approachable continuity, correction and consequential-action confirmation. Do not repeat the older typed agent-to-agent protocol as current fact without a new first-party source. |
| Poke | Messaging-native email/calendar/reminder automation, Recipes and integrations; the July 23 release notes say Poke joined Cognition and the product continues unchanged ([release notes](https://poke.com/docs/release-notes)). Its June 23 privacy policy permits model training unless the user selects Maximum Privacy ([privacy](https://poke.com/privacy)). | Benchmark low-friction messaging UX and proactive Recipes, but do not make blanket “no training” claims or infer a durable Outcome/effect-reconciliation ledger from confirmations. |
| Dimension | Public materials described a context graph, action plans, Todos/Workflows, connected apps and confirmation surfaces. Current availability is contradictory: the [homepage](https://dimension.dev/) says the product wound down May 20 while the [status site](https://status.dimension.dev/) reported services operational later. | Keep as a historical product-design reference; do not treat it as a live parity target until availability is re-established. |

## Waldo today versus the benchmark floor

### Properly completed through B1

**[Observed, high confidence]** These are landed backend capabilities, not product claims:

- B0 established the reproducible verification baseline, route/OpenAPI parity and migration/history guards.
- Released v0.4 contracts establish strict responsibility, execution, judgment, evidence, verification, acceptance and continuity vocabulary without claiming all runtimes exist.
- #80 provides the sole writer for execution request/attempt/session/lease state.
- #87 defines the execution-environment seam and recover-before-execute discipline.
- #88 provides one authenticated, default-disabled, start-only WorkUnit route through owner routing, Coordinator admission, #80, trusted immutable intent resolution, the RunLoop composition, #87 and bounded observation admission.
- Full-command digest identity rejects altered replay; owner, canonical WorkUnit/Outcome revision, digests, authority, provider/environment/context, lease/fence and cancellation generation remain server-derived.
- Executor completion cannot imply Evidence, Verification, Acceptance, Outcome completion or OpenLoop closure.
- The exact reviewed path uses a deterministic local/test fake. No real provider adapter, real channel, deployment or product acceptance was proven.

Sources: [B1 review handoff](../ledger/2026-08-14-b1-workunit-execution-bridge-review.md), [B1 sole-writer ledger](../ledger/2026-08-14-b1-sole-execution-writer.md), [B1 environment ledger](../ledger/2026-08-14-b1-execution-environment-port-frontier.md), [architecture lock](../planning/WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md).

### Not yet complete

**[Observed, high confidence]** The following remain B2–B6 work. **[Inference, high confidence]** Waldo is therefore not yet operationally comparable to the broad personal-agent products:

| Gate | Missing user-visible/runtime proof | Benchmark pressure |
| --- | --- | --- |
| B2 | Durable Judgment, Evidence, Verification, Acceptance, OpenLoop and re-entry behavior | Hermes already exposes completion contracts and deterministic gates; OpenClaw exposes durable goals. Waldo must ship its stronger independent acceptance semantics, not merely document them. |
| B3 | One ordered Waldo identity across mobile, Kennel and messaging; truthful health-connected and health-disconnected states; link/revoke/cursor recovery | Hermes and OpenClaw already expose broad cross-surface continuity. |
| B4 | Connection registry, credential custody, real effect writer/reconciliation, Calendar and real Telegram/Discord adapters | Hermes/OpenClaw/QM already expose rich tools and channels. Waldo's differentiator must be safer authority and effect truth, not connector count alone. |
| B5 | Governed context, routines, scheduling, cloud execution, durable message delivery/recovery and budget proof | OpenClaw and Think document durable background/recovery primitives; Hermes documents cron and persistent goals. |
| B6 | Export/restore/delete across all stores plus real three-surface staging/production acceptance | Self-hosting or Markdown memory is not by itself semantic portability. Waldo must prove lifecycle completeness and deletion. |

## Adopt, adapt, reject

| Disposition | Mechanism | Why |
| --- | --- | --- |
| **Adopt** | Pi's small evented loop contract, explicit steering versus follow-up, awaited lifecycle events and host-owned policy seam | Keeps provider/runtime replaceable and testable. |
| **Adopt** | Fresh-context subagents with explicit goal/context packets, inherited authority ceilings, bounded depth/concurrency/iterations and final structured handoffs | Hermes/OpenClaw/Codex demonstrate the operational pattern; it reduces context contamination when authority cannot widen. |
| **Adopt** | Deterministic quality gates before probabilistic judgment | Hermes now documents this directly; Waldo should attach results as Evidence and Verification input, not silently close an Outcome. |
| **Adopt** | Background-task ledger, restart reconciliation, bounded tombstones, lost-state detection and push completion | OpenClaw's current recovery surface is a stronger benchmark than earlier Waldo notes reflected. |
| **Adopt** | Capability-declared provider/harness adapters and deployment conformance | QM makes heterogeneous harness differences explicit instead of pretending parity. |
| **Adopt** | Trace/trajectory export with aggressive privacy redaction and stable correlation | Pi, Hermes, OpenClaw, QM and Think all expose useful event/trace primitives; Waldo needs evaluation evidence across the full execution configuration. |
| **Adapt** | Hermes/OpenClaw persistent goal UX | Map a surface/session goal to a Waldo Outcome or Mission only through an explicit translation contract. Preserve owner correction, disposition, acceptance and reopen separately. |
| **Adapt** | OpenClaw one-gateway/many-presence model | One Waldo identity can project to mobile, Kennel, Telegram and Discord, but each Presence needs explicit link, scope, revoke, cursor and privacy policy. |
| **Adapt** | Think submissions, fibers, Workflows and durable-pause approvals | Use as substrate candidates behind #80/#87 and future effect contracts. Override full-grant defaults; reconcile unknown external effects before reissue. |
| **Adapt** | Hermes memory approval, OpenClaw provenance-aware staging, human-readable memory files | Waldo memory must retain source, confidence, time, purpose, status, corrections, expiry and user-statement priority; editable Markdown alone is not enough. |
| **Adapt** | AO worktree/PR/CI/review feedback and Medley mission DAG | Use for Kennel Work and bounded Missions beneath an Outcome. Integration evidence must still flow to independent Verification and authorized Acceptance. |
| **Reject** | Provider/agent `done`, LLM judge `done`, tool success, child completion, message delivery or PR merge as automatic Outcome completion | These are observations or evidence candidates, not the person's accepted state of the world. |
| **Reject** | Think's default full turn authorization and automatic stale-pending effect reissue for consequential operations | Conflicts with Waldo's default-deny authority and recover/reconcile-before-reissue rule. |
| **Reject** | Pi host authority, OpenClaw sandbox-off defaults or a broad local shell as Waldo's public security boundary | Local execution does not remove the need for purpose, scope, credential and effect controls. |
| **Reject** | Autonomous mutation of identity, health guidance, trust roots, acceptance policy or durable memory truth | Skills and learning may propose changes; protected policy and truth require governed promotion. |
| **Reject** | “Feature count parity” as the completion criterion | It rewards copied surfaces while ignoring authority, recovery, deletion, evidence quality and actual user outcomes. |

## What would falsify the Waldo thesis

**[Inference, high confidence]** The inspected systems narrow Waldo's differentiation. “Memory, goals, subagents, proactivity, channels, local ownership and recovery” are no longer sufficient moat claims.

Waldo's remaining thesis is falsified if real B2–B6 testing shows any of the following:

1. Users gain no meaningful trust or time benefit from separating executor completion, evidence, verification and acceptance.
2. Waldo's authority and reconciliation controls add friction without reducing duplicate effects, hidden overreach or verification burden.
3. Cross-surface continuity is less useful than independent provider-native sessions.
4. Health/body context does not change a chosen plan or Outcome and users prefer the product without it.
5. Export, correction and conscious closure do not change willingness to delegate a second meaningful responsibility.
6. A benchmark system can supply equivalent user-owned Outcome, Evidence, independent Verification, Acceptance and OpenLoop semantics with less integration cost, and Waldo's retained Modules enforce no additional behavior.

## Unknowns and required next proof

- **[Unknown]** No benchmark was run against the same task, authority policy, failure injection and acceptance rubric. This file cannot establish relative reliability, latency, cost or usability.
- **[Unknown]** Medley's mission engine is not open source; public plugin claims cannot prove internal single-writer, lease, replay, recovery or privacy behavior.
- **[Unknown]** “No independent Outcome/Acceptance model observed” is bounded to the inspected official surfaces and source paths.
- **[Unknown]** OpenClaw's and Hermes's newest documented recovery/goal behavior has not been adversarially tested here.
- **[Unknown]** Waldo's B1 semantics have deterministic tests and an exact-SHA wall, but no real provider, credential, external effect, channel or user workflow has exercised them.

The next comparison should be an executable conformance suite, not another prose matrix. Run the same bounded responsibility through Waldo plus at least Hermes, OpenClaw and one provider harness; inject restart, duplicate command, stale revision, approval expiry, ambiguous effect, channel retry, memory contradiction and failed verification; then compare evidence quality, recovery, authority leakage, user intervention and accepted outcome. That work belongs after the relevant B2–B5 capabilities exist and must not be represented as current parity.
