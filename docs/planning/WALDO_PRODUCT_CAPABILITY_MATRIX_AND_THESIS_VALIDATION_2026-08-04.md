# Waldo Product Capability Matrix and Thesis Validation

**Status:** architecture companion; source-backed whole-product envelope locked for build
**Date:** 2026-08-04
**Companion architecture:** [`WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md`](./WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md)
**Build-direction authority:** [`WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md`](./WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md)
**Purpose:** test whether the planned Waldo architecture can join the personal-assistant envelope of Dimension, Folk, and Poke with the agent-orchestration envelope of Agent Orchestrator, Medley, and Hermes without becoming a feature collage or breaking Waldo's larger thesis

## 0. Evidence and interpretation rules

Every conclusion is marked **[Observed fact]**, **[Inference]**, **[Proposed decision]**, or **[Unknown / blocked]**, and recommendations use **Adopt**, **Adapt**, **Spike**, **Defer**, or **Reject**. Competitor capability means a capability described in a current first-party source; it is not an independent quality, privacy, or reliability certification. Waldo target capability means the architecture can support it after the named contracts, product workflow, adapter, and acceptance tests are implemented; it does not mean the capability ships at the pinned backend SHA.

Source authority is claim-specific:

| Claim | Authority |
|---|---|
| Current Waldo product thesis | The founder's [Waldo company story](https://shivansh-portfolio-one.vercel.app/work/waldo), [August product/technical brief](https://waldo-technical-brief.pages.dev/), explicit product corrections, and the canonical August reading pack |
| Current Waldo implementation | Pinned source and tests recorded in the architecture plan |
| Competitor capability | Current first-party product documentation, source repository, or product page |
| Target design | The final Home + Work architecture plan and the proposed decisions in this companion |

**[Proposed decision — Reject]** The current marketing landing page and older pitch-deck language are outside this validation scope by explicit user direction. They do not arbitrate product or architecture requirements.

## 1. Verdict

> **[Inference — Adopt] Yes, conditionally.** If the stable kernel, product contracts, adapters, parallel workstreams, and whole-product acceptance scenarios are implemented faithfully, Waldo can join the useful personal-assistance envelope of Dimension, Folk, and Poke with the work-supervision envelope of Agent Orchestrator, Medley, and Hermes: daily assistance, messaging-native delegation, connected actions, editable continuity, durable routines, provider-neutral agent sessions, mission/DAG/Kanban planning, parallel supervision, recovery, evidence, judgment, acceptance, and re-entry.

> **[Proposed decision — Reject]** Do not define the product as a sum of competitor features. That would produce overlapping task, mission, memory, completion, and notification models. Waldo's product is the single relationship and Outcome spine beneath those capabilities. The benchmarks contribute interaction, planning, and execution patterns; they do not contribute Waldo's identity or truth model.

> **[Inference — Adapt]** The architecture is sufficient as a platform/kernel design, but architecture alone does not create product parity. The plan must be accompanied by explicit Home workflows, connector behavior, onboarding, attention policy, memory-correction UX, and end-to-end acceptance measures. Those are added here as product gates.

The shortest product definition remains:

```text
Dimension's daily clarity
+ Folk's persistent personal relationship and cloud reach
+ Poke's messaging ease, integrations, and delegated action
+ Agent Orchestrator's multi-session supervision
+ Medley's mission interview, contract, and frontier DAG
+ Hermes's durable goals, Kanban, schedules, and recovery
+ Waldo's user-owned identity, bounded context, evidence, human acceptance,
   Open Loop closure, and exact re-entry
= one Waldo across Home and Work
```

## 2. Thesis checksum against Waldo's public materials

### 2.1 What the architecture must preserve

| Public thesis statement | Architecture consequence | Validation |
|---|---|---|
| “The session is a work log. The Outcome is the product.” | `AgentSession` cannot be the user-facing unit of truth and provider `done` cannot close work. | **[Design — specified]** Separate AgentSession, WorkUnit, Evidence, Verification, Acceptance, Outcome, and OpenLoop state machines. |
| One private, user-owned Waldo across models, tools, work, life, and eventually devices | One owner authority root; models, executors, connectors, and presences are replaceable. | **[Design — specified]** Same-DO `WaldoCoordinator`, manifests, `WaldoExportBundle`, and multi-surface protocol. |
| Personal assistance and work orchestration should be one relationship | Home and Work share identity, Outcomes, authority, evidence, memory policy, and continuity. | **[Design — specified]** The plan rejects separate agent loops per surface. |
| Person before prompt; context is composed, not copied | Purpose-bound `ContextProjection`; explicit statements and corrections outrank inference. | **[Design — specified]** Includes raw-health, transcript, credential, and unrelated-context exclusions. |
| Action over dashboards | Product success is accepted change with evidence, not activity visualization. | **[Inference — Adapt]** The domain supports it; the Home and Kennel projections still need product acceptance tests that punish feed/dashboard behavior. |
| Proactive, but not presumptive | Quiet routines may prepare or suggest; consequential action requires exact authority. | **[Design — specified]** Attention, schedules, `JudgmentRequest`, server-created `AuthorityGrant`, and effect admission. |
| Completion is evidence; closure belongs to the person | Independent verification precedes acceptance; Open Loops close only through conscious resolution/release. | **[Design — specified]** Non-negotiable state separation with selective, disclosed verification. |
| Less mental reassembly and fewer decaying commitments | Re-entry must restore the goal, last verified state, unresolved judgment, artifacts, and smallest next action. | **[Design — specified]** `OpenLoop` and `ReEntryPoint`; benefit must still be measured in user trials. |
| Kennel is Waldo's first Mac home, not a second identity or the company boundary | Kennel observes and executes through protocols; it owns local operation durability, never Outcome truth. | **[Design — specified]** Kennel proposes; the owner DO admits. |
| Physical authority is a later horizon | Software identity, permission, receipts, recovery, and revocation must precede devices. | **[Horizon — not current software scope]** Physical execution requires a separate product and safety decision; it is not a team-size cut. |

Sources: [Waldo — Why I am building it](https://shivansh-portfolio-one.vercel.app/work/waldo) and [Waldo Product, Technical & Vision Brief](https://waldo-technical-brief.pages.dev/).

## 3. Benchmark contribution matrix

| Product | First-party observed strengths | What Waldo adopts | What Waldo must not inherit | Where it lands |
|---|---|---|---|---|
| Dimension | Morning Briefing, Catch Up, Action Plan, AI Inbox, Meeting Prep, Daily Recap, artifacts, connected apps, multiple chat surfaces, custom MCP. Dimension's site also says the product winds down on 2026-05-20. | **[Proposed decision — Adapt]** A calm daily loop: prepare, catch up, suggest work, help complete it, and deliberately close the day. | **[Proposed decision — Reject]** A separate work-assistant identity, inbox/activity as product truth, or a dependency on a discontinued product. | Home projections, ContextCompiler, connector packs, Artifact, Brief/Close, attention governor. |
| Folk | Persistent assistant in messaging, isolated always-on cloud computer, web/code/app use, scheduled routines, editable/deletable memory, phone calls, and explicit-approved agent-to-agent Crew requests. | **[Proposed decision — Adapt]** Relational continuity, messaging ease, cloud reach, memory controls, routines, bounded person/agent delegation. | **[Proposed decision — Reject]** “Remember everything forever,” cloud filesystem as canonical memory, opaque behavioral profiles, or approval inferred from a social relationship. | Presence protocol, WorkspacePort, governed ContextClaims, routines, DelegationGrant, people adapter. |
| Poke | Apple Messages/Telegram/WhatsApp/RCS, email/calendar/reminders/search, Recipes, MCP integrations, API triggers, shareable integrations, and human fallback for real-world tasks. | **[Proposed decision — Adapt]** Concise delegation, one-tap capability packs, event ingress, connector distribution, and optional human-service execution. | **[Proposed decision — Reject]** Arbitrary JSON becoming trusted agent context, bearer keys as broad authority, or human/provider reports as automatic acceptance. | Messaging presence, BehaviorPackage registry, MCP adapter, command gateway, EffectEngine, HumanExecutorAdapter. |
| Agent Orchestrator | Parallel coding-agent sessions in isolated worktrees, live terminal control, common harness adapters, visible working/waiting/finished/blocked state, and automated CI/review/merge-conflict feedback loops. | **[Proposed decision — Adapt]** Dense multi-session supervision, truthful provider status, isolated local execution, feedback routing, and operator drill-down. | **[Proposed decision — Reject]** Repository, branch, terminal, PR, or coding session as the universal unit of human work; AO as Waldo identity or Outcome truth. | Kennel Work/Operator Mode, ProviderAdapter, WorkspacePort, AgentSession projections. |
| Medley | Mission interview, reviewed mission plan, task DAG, per-task runtime/model routing, parallel workers, approvals, live dashboard, and plain-language steering inside Claude Code/Codex. | **[Proposed decision — Adapt]** Mission as an inspectable optional contract beneath an Outcome; plan only to the information frontier; supervised execution and review receipts. | **[Proposed decision — Reject]** Mandatory Mission ceremony for simple Outcomes, in-repository workers as the general work ontology, or inherited host permissions as Waldo authority. | MissionPlanner, WorkUnit graph/dependencies, JudgmentRequest, ExecutionRegistry, evidence/review. |
| Hermes | Provider-neutral sessions, terminal and messaging channels, persistent profiles/memory, skills, MCP, cron, durable Kanban with dependencies, named agents, heartbeats, retries/circuit breaking, goals/judges, local and cloud execution. | **[Proposed decision — Adapt]** Mission/Kanban supervision, capability profiles, heartbeats, pause/steer/recover, schedules, skill lifecycle, placement flexibility. | **[Proposed decision — Reject]** Hermes task DB as Waldo Outcome truth, self-learning memory/skills without governed promotion, or model judge as human acceptance. | Kennel Work, Mission/WorkUnit planner, AgentSession adapters, scheduler, conformance registry, WorkspacePort. |

Primary sources: [Dimension](https://dimension.dev/), [Dimension docs](https://docs.dimension.dev/), [Folk](https://www.folk.com/), [Poke docs](https://poke.com/docs), [Poke Recipes](https://poke.com/docs/creating-recipes), [Poke MCP servers](https://poke.com/docs/mcp-servers), [Poke API](https://poke.com/docs/api), [Agent Orchestrator](https://github.com/Untrivial-ai/agent-orchestrator), [Medley](https://github.com/Spine-AI/medley), and [Hermes Agent](https://github.com/NousResearch/hermes-agent).

### 3.1 Earlier thread capability synthesis, bundled

This is the product-level answer from the earlier discussion, made explicit beside the architecture rather than left scattered across the thread.

| Waldo capability family | User-visible capabilities | Kennel's role | Benchmark contribution | Waldo-specific meaning |
|---|---|---|---|---|
| Personal relationship and continuity | One agent that remembers permitted goals, commitments, preferences, corrections, people, and unfinished responsibility across work and life | Show/edit provenance, corrections, permissions, Open Loops, and exact re-entry when depth is needed | Folk's persistent relationship and editable Brain; Poke's messaging ease | **[Proposed decision — Adopt]** User-owned, purpose-bound continuity survives provider/surface changes; memory never becomes authority. |
| Daily executive assistance | Capture, Morning Brief, Catch Up, calendar/inbox help, meeting preparation, follow-ups, nudges, commitments, Daily Close | Home is the calm planning/judgment surface; Island handles capture/status/small decisions | Dimension's daily loop; Folk routines; Poke email/calendar/reminders | **[Proposed decision — Adapt]** Organize around consequence and what became true, not unread counts or activity. |
| General delegated action | Research, draft, schedule, communicate, organize files, create artifacts, use connected apps, hand work to people/services | Needs You, effect review, receipts, verification, repair, reopen | Poke integrations/human fallback; Folk computer/browser; Dimension connected work | **[Proposed decision — Adapt]** Every consequential mutation has exact authority, effect intent, reconciliation, evidence, and a terminal path. |
| Outcome and mission orchestration | Turn intent into Outcome, optional Mission, bounded WorkUnits, dependencies, priorities, budgets, and acceptance criteria | Work board ordered by Outcome/Mission; inspect the plan and information frontier | Medley mission interview/DAG; Hermes goals/Kanban; Dimension Action Plan | **[Proposed decision — Adopt]** General units of work—not repositories, prompts, or sessions—carry human intent. |
| Multi-agent supervision | Start/resume/steer/pause/cancel/reconcile Codex, Claude, Hermes, Pi, people, tools, and future executors | Provider-rich Operator Mode beneath the Outcome view; evidence and blocked states stay visible | Agent Orchestrator's parallel supervisor; Medley workers; Hermes provider/runtime neutrality and recovery | **[Proposed decision — Adapt]** Sessions are replaceable execution activity. Waldo retains identity, authority, acceptance, and closure. |
| Local/cloud work | Run on the Mac, seal workspaces, continue eligible work in cloud, return artifacts/checkpoints, and recover after failure | Kennel is the local presence/executor and re-entry surface, not canonical truth | Folk cloud computer; Hermes execution backends; Cloudflare Computer | **[Decision — committed]** Placement changes through governed checkpoints and new fenced leases; it cannot fork the Waldo relationship. |
| Knowledge and artifacts | Personal/project DeepWiki, approved-source search, generated documents/sheets/decks/code, Shelf, provenance, export/delete | Browse sources, artifact versions, evidence, and impact paths | Dimension Library/artifacts; Poke DeepWiki; Folk files/research | **[Proposed decision — Adapt]** Knowledge is a rebuildable projection and artifacts are evidence-bearing deliverables, not silent memory or automatic success. |
| Proactivity with restrained attention | Schedules, watchers, routines, condition-driven preparation, consequence-ranked Needs You, defer/release | Quiet ambient status and focused judgments instead of a notification/activity feed | Folk watchers/routines; Poke automations; Hermes cron | **[Proposed decision — Adopt]** Low-risk preparation can be proactive; consequential action and changed circumstances return to exact authority. |
| Multi-surface presence | Same intent and work across Kennel, mobile, web, messaging, and voice; deep-link into the exact decision | Desktop supplies the richest inspection and local execution without becoming another agent | Dimension surfaces; Folk/Poke messaging; Hermes gateway | **[Proposed decision — Adopt]** One owner command/event history and one Open Loop set across every presence. |
| Extensibility and distribution | Connectors, MCP client/server, provider/executor/presence SDKs, routines, skills, recipes, capability packages, future A2A | Install, inspect, test, revoke, and debug capabilities | Poke Recipes/MCP; Folkways; Hermes skills/MCP | **[Proposed decision — Adapt]** Extensibility distributes Waldo's governed services without distributing hidden authority or personal truth. |
| Caring personal context | Capacity or health-derived context may make an existing plan kinder, smaller, or better timed when explicitly permitted | Explain why context was used and let the user correct/revoke it | Waldo-specific constitution | **[Proposed decision — Adapt]** Health is passive context inside a user-grounded purpose, never the agenda, category, permission source, or autonomy controller. |

## 4. Integrated product-capability matrix

Status uses the architecture plan's pinned backend truth: **shipped**, **partial**, **stub**, **proposed**, **missing**, or **rejected**. “Target” means the architecture has a named home for it; no target row is a shipped claim.

| Product capability | Benchmark signal | Waldo target behavior and stronger guarantee | Current Waldo status | Owning target module / dependency |
|---|---|---|---|---|
| Natural capture: “What's on your mind?” | Folk/Poke messaging; Dimension chat | **[Proposed decision — Adapt]** Capture from any presence into one deduplicated owner command; ask before promoting ambiguous input to commitment/Outcome. | Stub | Gateway + `OutcomeModule`; depends on protocol and owner root |
| Voice conversation and guided work | Folk calls; ChatGPT Voice market direction | **[Proposed decision — Adapt]** Voice reads, explores, plans, and handles small judgments; sensitive effects require explicit readback and the same server-created AuthorityGrant. Voice creates no separate memory/session truth. | Missing | PresenceGateway + voice adapter; depends on judgment/projection contracts |
| Morning Brief | Dimension; Folk routines | **[Proposed decision — Adapt]** Consequence-ranked changes, commitments, decisions, and realistic next actions; degraded inputs are visible; no raw activity dump. | Proposed | Attention + ContextCompiler + projections; depends on continuity truth |
| Daily Close | Dimension Daily Recap | **[Proposed decision — Adapt]** Reconcile what became true, accept/reopen/release, and carry forward only deserving Open Loops. | Proposed | Acceptance + OpenLoop + ReEntry; depends on evidence/continuity |
| Inbox triage and drafting | All three personal assistants | **[Proposed decision — Adapt]** Search/summarize/draft in a bounded context; sending is a separate frozen effect with exact recipient/content digest and reconciliation. | Missing | ConnectorPort + EffectEngine; depends on exact connector scopes/reconciliation |
| Calendar and scheduling | Dimension/Folk/Poke | **[Proposed decision — Adapt]** Prepare and propose freely; create/update only under scoped authority with stable reconciliation key, timezone tests, receipt, and compensating path. | Missing | Calendar adapter + EffectEngine; depends on authority/effect contracts |
| Meeting preparation and follow-up | Dimension | **[Proposed decision — Adapt]** Compile purpose-relevant people, commitments, last evidence, and open questions; follow-up becomes a reviewed Artifact/effect. | Missing | ContextCompiler + Artifact + connectors; depends on accepted sources/effects |
| Reminders, commitments, and nudges | Folk/Poke | **[Proposed decision — Adapt]** A reminder is not an Outcome; tie it to a commitment/OpenLoop where applicable, budget attention, and support defer/release. | Proposed | CommitmentScheduler + Attention + OpenLoop; depends on continuity contracts |
| Proactive watchers and routines | Folk/Poke Recipes; Hermes cron | **[Proposed decision — Adapt]** Versioned schedule + purpose + capability + budget + expiry; read-only monitoring may run quietly, effects still require policy/authority. | Partial runtime scheduling, missing product semantics | CommitmentScheduler + RunLoop; depends on admitted capability |
| Research and artifact production | Dimension artifacts; Folk web/files; Hermes tools | **[Proposed decision — Adapt]** Produce content-addressed Artifacts with provenance and source-use receipts; provider completion is candidate evidence only. | Stub | ArtifactRegistry + WorkspacePort + EvidenceVerifier; depends on artifact/workspace contracts |
| Persistent personal continuity | Folk memory | **[Proposed decision — Adapt]** Explicit statements/corrections, evidence-linked claims, purpose-bound retrieval, expiry, inspection, export, deletion, and tombstones. | Partial schemas only | ContinuityModule + WaldoExportBundle; depends on owner/deletion contracts |
| Personal DeepWiki / knowledge projection | Poke DeepWiki integration; workspace-centric harness trend | **[Decision — committed]** Rebuildable, inspectable projection over approved sources and Artifacts; not canonical memory and not authority. | Missing | KnowledgeProjection + SourceUsageReceipt; depends on permitted sources/artifacts |
| Per-user filesystem/workspace | Folk cloud computer; Hermes environments; Cloudflare Computer | **[Decision — committed]** Mutable execution workspace with sealed checkpoints; encrypted durable artifacts and product metadata remain outside it. | Missing | WorkspacePort + local/cloud adapters; depends on checkpoint/blob contracts |
| Local-to-cloud session continuation | Hermes placement; cloud workspaces | **[Decision — committed]** Continue from a sealed checkpoint, pinned manifest, provenance, and new fenced lease. Do not pretend a live process migrated when it was recreated. | Missing | WorkspaceCheckpoint + AgentSession reconciliation; depends on adapter conformance |
| General Outcomes and planning | Medley mission contract/DAG; Hermes goals/Kanban; Dimension Action Plan | **[Decision — committed]** Outcome → optional Mission → WorkUnits at the current information frontier; not limited to repositories or coding. | Missing | OutcomeModule; depends on protocol/domain reducers |
| Multi-agent/provider sessions | Agent Orchestrator, Medley, Hermes, and current coding harnesses | **[Decision — committed]** Codex, Claude, Hermes, Pi, future providers through capability-declared session adapters; one common start/resume/steer/pause/cancel/reconcile contract. | Partial runtime, missing product AgentSession | RunLoopEngine + KennelExecutorPort; depends on adapter conformance |
| Mission/Kanban/dependencies/heartbeats | Medley + Hermes + Agent Orchestrator | **[Decision — committed]** Kennel board projects Outcome/Mission/WorkUnit truth and session observations; task dependencies and heartbeats inform supervision, but liveness never proves progress or acceptance. | Missing | OutcomeModule + projections + session monitor; depends on domain/session contracts |
| Needs You / judgment | Poke confirmations; Folk Crew approval; Hermes steering | **[Decision — committed]** Consequential, ambiguous, expired-authority, or value choices return with recommendation, options, uncertainty, evidence, and cost of waiting. | Missing | JudgmentAuthorityModule + Attention; depends on trusted command envelope |
| Human fallback | Poke Human | **[Decision — committed]** A person/service may be an executor with capability, scope, price, privacy, receipt, cancellation, and dispute contracts; they do not become trusted truth. | Missing | HumanExecutorAdapter + EffectEngine; depends on counterparty/effect contracts |
| Evidence and independent verification | Waldo-specific differentiation | **[Decision — committed]** Separate attributable evidence, deterministic effect read-back, selective declared artifact checks, stale/indeterminate results, and repair from provider activity. | Partial technical evidence only | EvidenceVerifier; depends on effect/artifact evidence |
| Acceptance, reopen, release | Waldo-specific differentiation | **[Decision — committed]** User accepts a particular revision/evidence set, may reject/repair/reopen, or consciously release remaining responsibility. | Missing | AcceptanceModule; depends on evidence/verification |
| Open Loop and exact re-entry | Waldo-specific differentiation | **[Decision — committed]** Persist what remains, why, last verified state, unresolved judgment, artifacts, and the smallest useful next action across devices/days. | Missing | ContinuityModule; depends on domain/acceptance projections |
| Agent-to-agent / person-to-person coordination | Folk Crew; A2A ecosystem | **[Decision — committed and evidence-gated]** Explicit counterparty identity, one-way minimal disclosure, non-transitive delegation, owner approval, and shared receipt; no shared personal memory. | Missing | DelegationGrant + People/A2A adapters; depends on identity/disclosure conformance |
| Connected apps and general actions | Dimension/Folk/Poke | **[Decision — committed]** Discoverable connector capabilities with per-operation effect semantics, exact scopes, retry owner, reconciliation, and terminal resolution. | Missing general registry; specialized effect core partial | CapabilityRegistry + ConnectorPort + EffectEngine; depends on family conformance |
| User-created routines, skills, recipes, and capability packages | Dimension Workflows/Skills; Poke Recipes; Folkways; Hermes skills | **[Decision — committed]** Keep four composable contracts: a routine owns triggering; a skill owns a reviewed procedure; an integration recipe owns onboarding/composition; a capability package owns executable/tool admission. None contains hidden authority. | Missing | BehaviorPackage registry; depends on lifecycle/admission/revocation contracts |
| MCP interoperability | Dimension/Poke/Hermes | **[Proposed decision — Adapt]** Consume external MCP tools/resources and expose bounded Waldo capabilities through a version-pinned adapter; MCP Task is never WorkUnit and OAuth tokens are not passed through. | Missing | ProtocolAdapterPort; after core contracts |
| Other-harness distribution | User's distribution requirement | **[Decision — committed]** Offer a Waldo MCP server/SDK for capture, bounded context, Outcome status, judgment submission, artifact/evidence registration, and re-entry; external harnesses cannot close Outcomes or read unrestricted personal memory. | Missing | Waldo Capability Gateway; depends on stable domain/authority/evidence contracts |
| Model routing | Hermes model neutrality; current multi-model market | **[Decision — committed]** Route by declared capability, privacy, latency, cost, reliability, and full harness evaluation—not model name or context size alone. | Missing | ModelRouter + EvaluationRegistry; depends on versioned conformance |
| Cost/budget controls | Hermes; agentic economy trend | **[Decision — committed]** Reserve budget, attribute usage, surface overrun/expiry, and bind paid effects to separate authority. Autonomous purchasing remains a separate future effect-family decision. | Partial governor, missing product ledger | BudgetReservation + UsageReceipt; depends on atomic reservation/usage contracts |
| User ownership/portability | Folk memory controls; Waldo thesis | **[Proposed decision — Adopt]** Export/import/restore governed continuity while excluding credentials, raw health, and provider-owned transcript by default. | Missing | WaldoExportBundle; after canonical stores |
| Passive caring context | Waldo thesis, not competitor category | **[Decision — committed boundary]** User-grounded purpose first; health/capacity may soften options or suggest a reversible change, never originate agenda or autonomy. | Partial privacy foundations | ContextPolicy + consent/correction UX; depends on purpose/consent contracts |

## 5. Use cases Waldo can support

| Use case | What the user experiences | Required capability chain | Product proof |
|---|---|---|---|
| Carry the day | Capture what matters, receive a Morning Brief, handle a few consequential choices, and complete a Daily Close. | Capture → Outcome/commitment → connectors → Attention → Acceptance/OpenLoop | **[Proposed decision — Adopt]** User reconstructs less and fewer meaningful commitments silently decay. |
| Inbox-to-outcome | Waldo finds a request, drafts a response, asks only when consequence requires, sends once, and keeps the promised follow-up alive. | Inbox read → ContextProjection → Artifact → Judgment → EffectIntent/Receipt → OpenLoop | **[Proposed decision — Adapt]** Duplicate-send and recipient/content-drift fault tests pass. |
| Meeting lifecycle | Prepare context and decisions, capture agreed obligations, send follow-up, and return later on what remains. | Calendar/people/context → Artifact → commitments → effects → verification/re-entry | **[Proposed decision — Adapt]** Commitments remain attributable and correctable; no transcript dump by default. |
| Personal administration | Schedule, remind, research travel, prepare options, and coordinate people/services through messaging. | Messaging → connector/human adapters → exact authority/effects → receipts | **[Proposed decision — Adapt]** Fast delegation without weakening approval or disclosure boundaries. |
| Research to a trusted artifact | Delegate research locally or in cloud, retain sources and checkpoints, independently test the deliverable, then accept or reopen. | Outcome → WorkUnits → sessions/workspace → Artifact/Evidence → Verification/Acceptance | **[Proposed decision — Adopt]** A confident report without adequate sources cannot be accepted automatically. |
| General multi-agent mission | Plan a launch, application, trip, hiring process, design project, or software change into bounded WorkUnits across agents, tools, and people. | Mission planner → CapabilityRegistry → AgentSessions/connectors/people → evidence | **[Proposed decision — Adopt]** No repository/session ontology leaks into the general Outcome. |
| Supervise many providers | See Codex, Claude, Hermes, Pi, and future sessions under the Outcomes they serve; pause, steer, cancel, recover, and reopen. | Kennel projection → ProviderAdapter → AgentSession FSM → OperationLedger | **[Proposed decision — Adapt]** Same control semantics and truthful unsupported states across providers. |
| Move work from Mac to cloud | Seal permitted files/state, resume in an isolated cloud environment, then return an Artifact and checkpoint to Kennel. | WorkspaceCheckpoint → policy/credential broker → cloud executor → evidence sync | **[Decision — committed]** Isolation, egress, credential, restart, deletion, consistency, portability, and cost gates pass before declared support. |
| Personal DeepWiki | Ask Waldo about approved projects/life artifacts and inspect why an answer was produced. | Knowledge sources → rebuildable projection → purpose-bound retrieval → SourceUsageReceipt | **[Proposed decision — Adapt]** Delete/correct/rebuild changes future retrieval deterministically. |
| Continue from any surface | Begin by message/mobile, inspect in Kennel, decide by voice/web, and receive the result elsewhere without new identity or duplicated work. | Commands/events/projections/cursors → one owner root → ReEntryPoint | **[Proposed decision — Adopt]** Restart/disconnect/duplicate-request tests preserve one canonical history; disconnected drafts are not admitted truth. |
| Coordinate with another person or agent | Ask for a bounded contribution without sharing unrelated personal context; receive only the permitted result/receipt. | Counterparty identity → DelegationGrant → minimal context → Artifact/receipt | **[Decision — committed and evidence-gated]** Counterparty identity, disclosure, non-transitive delegation, receipt, revoke, and dispute conformance must pass. |
| Extend Waldo into another harness | A third-party agent captures intent, requests bounded context, reports evidence, asks for judgment, or resumes an Open Loop through Waldo. | MCP/SDK gateway → exact scopes → command dedupe → audit/projections | **[Proposed decision — Adapt]** External client cannot mint authority, alter memory directly, accept an Outcome, or close an Open Loop. |

## 6. Distribution surface: what Waldo should expose

| Distribution product | Safe capability | Use cases served | Boundary |
|---|---|---|---|
| Waldo MCP server | Capture intent, read owner-approved context projections, list assigned WorkUnits, request judgment, register Artifacts/Evidence, query re-entry, propose connector actions. | Codex/Claude/Hermes/other MCP hosts can work for the same Waldo without becoming it. | **[Proposed decision — Adapt]** No raw memory export, credential access, self-granted authority, acceptance, or closure tools. High-impact actions return a Waldo judgment/effect proposal. |
| Connector SDK | Declare read/write operations, scopes, schemas, effect semantics, reconciliation lookup, receipts, retention, and deletion. | Calendar, inbox, CRM, travel, finance, home, health, project tools, and future services. | **[Proposed decision — Adopt]** Every write family passes intent-before-I/O, frozen-digest, ambiguity, cancellation, and expiry conformance. |
| ExecutionEnvironmentAdapter SDK | Start/restore/checkpoint/cancel/reconcile isolated workspaces; broker files, credentials, egress, budgets, and artifacts. | Kennel local sessions, Cloudflare Computer, containers, hosted sandboxes, SSH machines. | **[Proposed decision — Adapt]** Environment never owns Outcome truth or personal memory; checkpoint is not acceptance. |
| Provider/Harness adapter SDK | Discover and control sessions with honest native/emulated/unsupported capabilities. | Codex, Claude, Hermes, Pi, Think, and future harnesses. | **[Proposed decision — Adopt]** Hidden retries and provider retention must be declared; one retry owner per path. |
| Presence SDK | Authenticated commands, redacted projections, event cursor/replay, judgment readback, and deep links. | Mobile, web, messaging, voice, wearables, eventual ambient/physical presences. | **[Proposed decision — Adapt]** Presence cache is ephemeral; no local product-truth reducer. |
| Waldo Packs | A signed composition referencing a `RoutineDefinition`, `SkillBundle`, `IntegrationRecipe`, and/or admitted `CapabilityPackage`. | Distributable workflows analogous to Recipes/Folkways/skills: founder brief, meeting follow-through, release supervision, travel preparation. | **[Proposed decision — Adapt]** Composition is not execution authority. Each referenced component retains independent version, risk, conformance, update, rollback, and revocation behavior. |
| A2A delegation adapter | Exchange external tasks/messages/artifacts with identified agents. | Agent-to-agent collaboration beyond MCP tool calls. | **[Decision — committed and evidence-gated]** External task status is an AgentSession observation, not WorkUnit/Outcome state; no transitive authority. |
| Read-only Outcome/Evidence API and webhooks | Subscribe to owner-authorized state changes and submit attributable evidence. | CI, monitoring, browser extensions, team tools, automations, reporting. | **[Proposed decision — Adapt]** Typed DTOs, explicit event classes, idempotent ingress, minimal disclosure; never arbitrary JSON promoted as trusted context. |

**[Inference — Adopt]** Yes, Waldo is architecturally capable of becoming a distribution layer for other harnesses. Its differentiation hypothesis is not “more tools”; it is making user-owned context, authority, Outcome, evidence, judgment, and re-entry canonical across the inspected harness set. Adjacent products may overlap, and this only becomes real after the contracts, conformance suites, and user acceptance ship.

### 6.1 Behavior-packaging contracts

| Contract | Owns | Must not own |
|---|---|---|
| `RoutineDefinition` | Trigger/schedule, proposed action, stale-trigger behavior, pause/expiry, attention policy | Executable connector code, learned procedure, or authority |
| `SkillBundle` | Reviewable procedure, typed inputs/outputs, required capabilities, tests/evals, provenance, version, rollback | Credentials, Outcome truth, or automatic promotion into personal memory |
| `IntegrationRecipe` | Onboarding, required connector/MCP templates, initial configuration, component references, install/update policy | Silent installation, privilege expansion, or personal context |
| `CapabilityPackage` | Executable/tool/MCP manifest, schemas, artifact/instruction digests, provenance/SBOM, conformance, expiry/revocation | Product workflow, user intent, or acceptance |

**[Proposed decision — Adopt]** Keep these contracts separate even when the UI installs them together as a Waldo Pack. This preserves the useful distribution pattern from Dimension, Folk, Poke, and Hermes without creating an unsafe generic “plugin” object.

## 7. Cloud workspace, filesystem, DeepWiki, and storage clarification

1. **[Inference — Adapt]** A per-user Linux environment can make cloud execution, durable files, browser/code tools, and asynchronous sessions materially easier. It can support work that starts in Kennel and continues in the cloud.
2. **[Proposed decision — Reject]** A cloud filesystem does not become Waldo's brain, personal memory, Outcome store, or acceptance ledger. Mutable files have weaker correction, provenance, concurrency, deletion, and multi-surface semantics than canonical product contracts.
3. **[Inference — Adapt]** Filesystem workspaces can reduce R2 traffic for hot session state, package caches, checked-out repositories, and derived indexes. They do not eliminate the need for an encrypted durable blob/archive layer for accepted Artifacts, sealed checkpoints, backup, multi-surface access, and disaster recovery.
4. **[Proposed decision — Adapt]** DeepWiki is a `KnowledgeProjection`: derived, attributable, inspectable, rebuildable, and deletable. The source documents and accepted Artifacts remain authoritative; user statements/corrections outrank generated interpretations.
5. **[Decision — locked]** Cloudflare Computer remains a feature-flagged preview `ExecutionEnvironmentAdapter`; Sandbox SDK/Containers are the initial cloud-execution candidate and R2 the initial encrypted blob/checkpoint adapter. Adoption requires isolation, credential, egress, recovery, consistency, cost, upstream maturity/version, portability, and deletion gates. Cloudflare supplies substrate; Waldo supplies identity, purpose, policy, truth, and closure.
6. **[Proposed decision — Adapt]** “Move a session to cloud” means checkpoint and resume/recreate under a new fenced lease with pinned provider/environment manifests. It must never silently claim a live process, hidden memory, or exact executor state migrated when it did not.
7. **[Proposed decision — Adopt]** Browser/computer execution has a product-visible `sensitive_handoff` state for login, CAPTCHA, payment, consent, or private input. Credentials/private values never appear in model-visible events; resume uses the same operation key and a new fencing generation; screenshots/DOM/files are untrusted evidence; postconditions are verified independently of “the click happened.”

Sources: [Cloudflare Computer announcement](https://blog.cloudflare.com/cloudflare-computer/), [Cloudflare Computer repository](https://github.com/cloudflare/computer), and the architecture plan's source-pinned Cloudflare adoption table.

## 8. Architecture coverage and product gaps

### 8.1 What is structurally covered

| Requirement | Coverage |
|---|---|
| One identity and one durable authority root | **[Design — specified]** Explicit target, including owner routing/isolation migration gate; not implemented product proof. |
| General Home + Work domain | **[Design — specified]** Outcome/Mission/WorkUnit shared spine with separate session/effect/proof/closure states. |
| Replaceable models, harnesses, connectors, environments, surfaces | **[Design — specified]** Versioned manifests, registries, protocol adapters, and conformance gates. |
| Local and cloud execution | **[Design — specified]** WorkspacePort and checkpoint contracts; real adapters remain unbuilt. |
| Safe external effects | **[Design — specified over partial runtime evidence]** Existing specialized effect spine plus generalized contract; whole-product path remains unbuilt. |
| Personal/work privacy boundary | **[Design — specified]** Purpose-bound projection and explicit excluded data classes. |
| Evidence, verification, acceptance, Open Loop, re-entry | **[Design — specified]** Separate contracts and FSMs; product implementation remains unbuilt. |
| Distribution to other harnesses | **[Design — specified]** Protocol boundary supports it, but a public capability gateway/product surface remains to be built. |

### 8.2 Product decisions still required

| Gap | Why architecture cannot decide it | Decision / falsifier |
|---|---|---|
| First ideal customer and first weekly loop | The same kernel can serve many workflows; breadth too early will hide whether burden falls. | **[Proposed decision — Adopt]** Start with people already coordinating several agents plus real calendar/inbox commitments. Falsified if they do not experience cross-system reassembly as frequent pain. |
| Initial provider and calendar account | The adapter model is intentionally replaceable, but activation needs real versions/scopes. | **[Build-time choice]** Pin a Kennel provider and reversible calendar effect inside their workstreams before real conformance; unrelated work continues. |
| Home interaction spec | Backend contracts do not decide brief density, capture promotion, attention cadence, or Close ritual. | **[Proposed decision — Adapt]** Create a Home acceptance spec using time-to-clarity, interruptions avoided, correction rate, and carried-forward commitments. |
| Connector catalogue and service quality | MCP availability does not establish safe writes, useful scopes, or reliable reconciliation. | **[Proposed decision — Adopt]** Build first-party calendar/inbox packs and the broader capability system in parallel; activate each connector only after family conformance. |
| Memory and DeepWiki UX | Correct schemas do not make correction, provenance, export, or deletion understandable. | **[Proposed decision — Adopt]** Prove inspect/correct/delete/rebuild/restore flows with users before proactive reliance. |
| People/human execution | A human executor adds pricing, privacy, cancellation, dispute, and SLA semantics. | **[Decision — committed and evidence-gated]** Build behind the executor contract; activation waits exact counterparty and dispute conformance. |
| Local/cloud placement policy | Cost, privacy, file size, tools, latency, and user preference conflict. | **[Build-time choice]** Measure real workloads and require explicit location visibility and override behind `WorkspacePort`. |
| Capability-pack governance/business model | Distribution introduces supply-chain, support, and monetization choices. | **[Decision — committed governance]** Build signing/provenance/conformance/update/revocation/quarantine; marketplace monetization remains a separate business decision. |
| Outcome-quality evaluation | Model benchmarks do not test Waldo's complete system. | **[Proposed decision — Adopt]** Build scenario evals for burden, false completion, missed Open Loops, duplicate effects, privacy exposure, and repair. |

### 8.3 Six independent delivery statuses

Every product-capability row must eventually track these separately:

| Status | Question answered |
|---|---|
| `architecture_expressible` | Is there a safe owner/module/state model for the capability? |
| `contract_defined` | Are versioned commands, events, policies, failures, and retention rules specified? |
| `module_implemented` | Are the owning reducer/module, invalid paths, migrations, and rollback implemented? |
| `adapter_conformance_passed` | Has the exact provider/connector/environment version passed real and fault-injected behavior tests? |
| `cross_surface_acceptance_passed` | Has the user-visible workflow worked across the intended presences and reached accepted Outcome/re-entry? |
| `operational_proof_passed` | Have load, recovery, deletion, cost, observability, rollout, and rollback passed at the claimed environment? |

**[Proposed decision — Adopt]** Never collapse these into one “supported” flag. A schema does not prove inbox assistance; a live connector does not prove verification or accepted product value.

## 9. Flexibility envelope and deliberate limits

**[Inference — Adopt]** Flexibility is high at the capability edges and intentionally low at the truth/safety center.

| Dimension | Flexible | Locked |
|---|---|---|
| Model/provider | Route or replace by manifest/eval | No provider owns identity, memory policy, acceptance, or closure |
| Execution | Local Mac, cloud workspace, container, isolate, remote service | Same Outcome/authority/effect/evidence contracts and fenced leases |
| Surface | Kennel, mobile, web, messaging, voice, eventual device | One owner, command idempotency, event cursor, no surface-local truth |
| Capability | First-party connector, MCP, SDK adapter, capability pack, person | Fail-closed scopes, provenance, conformance, revocation, no hidden authority |
| Context | Personal/work source mix tailored to purpose | Minimum necessary, correction precedence, raw health/credentials/transcripts excluded by default |
| Autonomy | Quiet read/preparation, scheduled work, scoped repeatable effects | Consequential choices, changed arguments, expired grants, ambiguous effects return to Waldo/user |
| Storage | SQLite, R2-compatible blobs, local/cloud filesystem, rebuildable indexes | Canonical ownership/retention/deletion contracts and no filesystem-as-memory shortcut |

The limits are product features. A system that can do “anything” by copying all context, accepting any plugin, retrying unknown effects, and trusting provider completion would contradict the Waldo thesis even if it appeared more autonomous.

## 10. Whole-product parallel delivery and acceptance

There is no product-slice sequence. All committed capability families are built through the parallel workstreams in the architecture lock and integrated continuously through shared contracts. The scenarios below are simultaneous acceptance obligations, not smaller releases or catalogue gates:

1. **Delegated Outcome closure:** Capture → Outcome → direct WorkUnits or optional Mission → multiple sessions → judgment → reversible effect → deterministic external read-back → declared artifact checks → accept/reopen → exact next-day re-entry.
2. **A day carried forward:** Morning Brief, Catch Up, inbox/calendar preparation, commitments, nudges, meeting lifecycle, and Daily Close over the same Outcome/OpenLoop truth.
3. **One Waldo across presences:** Begin, inspect, decide, and resume the same canonical state through Kennel and every presence that declares the capability; a disconnected surface holds drafts only.
4. **External harness distribution:** A second harness receives a bounded WorkUnit through Waldo MCP/SDK, requests judgment, and returns candidate Artifact/Evidence while failing to mint authority, memory, acceptance, or closure.
5. **Local/cloud workspace and knowledge:** Seal a permitted Kennel workspace, restore/recreate it through an admitted cloud adapter with a new fence, return an Artifact/checkpoint, rebuild the knowledge projection, delete it, and prove no stale restore/effect survives.
6. **People/agent collaboration and packages:** Bounded counterparty work and all four behavior-package contracts pass identity, disclosure, update, revocation, quarantine, receipt, cancellation, dispute, and non-transitive-authority tests.

## 11. Thesis validation scorecard

The product is working only if the following improve together:

| Measure | Target direction | Thesis falsifier |
|---|---|---|
| Accepted Outcomes per active user | Up | More sessions/tasks run but accepted real-world outcomes do not increase |
| Consequential judgment minutes | Down without missed consequences | User must inspect raw sessions as often as before or important decisions are hidden |
| Mental reassembly / exact re-entry | Down | User repeatedly asks “where were we?” or rebuilds purpose/context after surface/provider changes |
| Silent commitment decay | Down | Brief/Close generates activity but meaningful obligations still disappear |
| False completion and reopen/repair quality | False completion down; repair becomes precise | Provider `done` or weak evidence is routinely presented as resolved |
| Effect safety | No unexplained duplicate/changed effects | Apply-then-timeout, expiry, or cancellation causes a blind retry or wrong recipient/resource |
| Privacy and agency | No unauthorized context/effect; correction changes future behavior | Raw health/private context leaks, memory becomes permission, or correction does not propagate |
| Attention burden | Alerts and dashboards down | Waldo creates another feed, task graveyard, or demand for continuous supervision |
| Provider/surface portability | Same Outcome survives replacement | Changing provider/device strands history, permissions, evidence, or Open Loops |
| Caring without control | Relevant assistance improves with consent | Health-derived context independently creates agenda, pressure, or paternalistic action |

## 12. Final product judgment

**[Inference — Adopt]** The final architecture is designed to uphold the larger Waldo thesis by making the relationship layer canonical: one user-owned identity, one bounded context policy, one Outcome history, one authority model, one evidence/acceptance boundary, and one place for unresolved responsibility across life and agent work. The inspected market evidence supports this as a coherent hypothesis, not a proof of uniqueness or superiority.

**[Inference — Adapt]** Building it can produce the capabilities users recognize from Dimension, Folk, Poke, Agent Orchestrator, Medley, and Hermes, with greater provider and surface flexibility. It will not automatically produce their polish, connector breadth, response quality, or distribution. Those require every committed workstream and whole-product acceptance scenario above.

**[Decision — locked]** Start the whole-product build now. Publish protocol v0.1 and shared fixtures as the cross-repository seam; run backend, Kennel, workspace, connector, continuity, distribution, and security/operations workstreams in parallel. Keep provider, connector, workspace implementation, model, protocol revision, and marketplace vendor choices replaceable behind conformance-gated contracts.

**[Build-time choices]** The initial Kennel provider/version, calendar vendor/account scope, and first-user acceptance thresholds are selected and recorded inside their owning workstreams. They block only the corresponding real-adapter or product-claim gate, not construction of the rest of Waldo and not the architecture lock.

## Appendix A. Source register

### Waldo

- [Waldo — Why I am building it](https://shivansh-portfolio-one.vercel.app/work/waldo), accessed 2026-08-04.
- [Waldo Product, Technical & Vision Brief](https://waldo-technical-brief.pages.dev/), accessed 2026-08-04.
- `waldo-brain/03-References/research/waldo-product-and-agentic-harness-benchmark-catalog-2026-08-04.md`, local canonical benchmark synthesis.
- `waldo-brain/03-References/research/waldo-desktop-home-work-product-blueprint-2026-08-02.md`, local final product blueprint.
- `waldo-brain/03-References/research/waldo-personal-agent-orchestration-final-architecture-2026-08-01.md`, local target architecture research.

### Products and harnesses

- [Dimension](https://dimension.dev/) and [Dimension documentation](https://docs.dimension.dev/), accessed 2026-08-04.
- [Folk](https://www.folk.com/), accessed 2026-08-04.
- [Poke documentation](https://poke.com/docs), [Managing Integrations](https://poke.com/docs/managing-integrations), [Creating Recipes](https://poke.com/docs/creating-recipes), [MCP Servers](https://poke.com/docs/mcp-servers), [API](https://poke.com/docs/api), and [Release Notes](https://poke.com/docs/release-notes), accessed 2026-08-04.
- [Agent Orchestrator at `66240ab24ea78d1e6e2b1baa34c6796a1a7494dc`](https://github.com/Untrivial-ai/agent-orchestrator/tree/66240ab24ea78d1e6e2b1baa34c6796a1a7494dc), accessed 2026-08-04.
- [Medley at `8a6221c88d9f4ca96f2c556b08f5882f4be11131`](https://github.com/Spine-AI/medley/tree/8a6221c88d9f4ca96f2c556b08f5882f4be11131), accessed 2026-08-04.
- [NousResearch Hermes Agent at `f5be9236e00ddf2f2a412697f267078fc4ee068e`](https://github.com/NousResearch/hermes-agent/tree/f5be9236e00ddf2f2a412697f267078fc4ee068e), accessed 2026-08-04; re-pin before implementation conformance.
- [Cloudflare Computer announcement](https://blog.cloudflare.com/cloudflare-computer/) and [repository](https://github.com/cloudflare/computer); exact current pin and preview status are recorded in the architecture plan.
- [MCP architecture](https://modelcontextprotocol.io/specification/2025-06-18/architecture), [A2A concepts](https://a2a-protocol.org/latest/topics/key-concepts/), and [AG-UI events](https://docs.ag-ui.com/concepts/events); protocol revisions must be pinned at adapter admission.
