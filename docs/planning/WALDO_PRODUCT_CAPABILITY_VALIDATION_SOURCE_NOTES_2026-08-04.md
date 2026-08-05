# Waldo Product Capability Validation — Source Notes

> Date checked: 2026-08-04
> Purpose: source notes for validating the final Waldo Home + Work architecture against the public Waldo thesis and the Dimension, Folk, Poke, Agent Orchestrator, Medley, and Hermes benchmark set.
> Scope: product capabilities, jobs, trust/authority, continuity, surfaces, orchestration, limitations, and architecture fit. This is not implementation evidence.
> Evidence labels: **Observed** means directly supported by the cited first-party source or pinned source tree; **Inference** is a bounded interpretation; **Unknown** is not established by the inspected public contract.
> Build authority: [`WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md`](./WALDO_ARCHITECTURE_LOCK_AND_WHOLE_PRODUCT_BUILD_DIRECTION_2026-08-05.md). Source-note dispositions compare benchmark fit; they do not define product phases, slices, or team-size scope cuts.

## 1. Source classification and authority

| Source | Type | Authority in this review | Important boundary |
| --- | --- | --- | --- |
| [Waldo portfolio story](https://shivansh-portfolio-one.vercel.app/work/waldo) | First-party public company/product narrative | Current public thesis and promise | Target direction and selected internal evidence; it explicitly does not claim the end-to-end experience is shipped |
| [Waldo product, technical and vision brief](https://waldo-technical-brief.pages.dev/) | First-party public technical narrative | Current target surfaces, authority model, platform thesis, and current-truth boundary | Target architecture, not independently inspectable production proof |
| [Dimension homepage](https://dimension.dev/), [docs index](https://docs.dimension.dev/llms.txt), and linked docs | First-party product material with an announced 2026-05-20 wind-down | Best public product contract for Dimension | Current service availability is unverified; treat the feature material as a benchmark, not a live-availability claim |
| [Dimension clean-room dissection](/Users/shivanshfulper/Developer/Pin4sf/waldo-brain/03-References/research/dimension-product-engineering-clean-room-dissection-2026-07-30.md) | Local canonical, primary-source-pinned research | Consolidated Dimension lifecycle, capability, limitation, and source map | Do not infer acquisition terms or present historical capability as currently available |
| [Folk homepage](https://www.folk.com/), [docs](https://www.folk.com/docs/memory), [Crew](https://www.folk.com/docs/crew), [privacy](https://www.folk.com/privacy) | Current first-party product and legal sources | Current Folk Personal AI contract | This is Nozomio's personal agent at `folk.com`, not the unrelated Folk CRM at `folk.app` |
| [Poke docs](https://poke.com/docs), [Recipes](https://poke.com/docs/creating-recipes), [MCP](https://poke.com/docs/mcp-servers), [API](https://poke.com/docs/api), [release notes](https://poke.com/docs/release-notes) | Current first-party product documentation | Current Poke contract | Public behavior does not establish general effect reconciliation or verified outcome closure |
| [Agent Orchestrator repository](https://github.com/Untrivial-ai/agent-orchestrator/tree/66240ab24ea78d1e6e2b1baa34c6796a1a7494dc) | Current first-party source/docs at a pinned commit | Coding-agent supervision and harness-adapter evidence | Coding sessions/worktrees/PRs are not Waldo's general human-work ontology or truth |
| [Medley repository](https://github.com/Spine-AI/medley/tree/8a6221c88d9f4ca96f2c556b08f5882f4be11131) and [mission skill](https://github.com/Spine-AI/medley/blob/8a6221c88d9f4ca96f2c556b08f5882f4be11131/plugin/skills/mission/SKILL.md) | Current first-party plugin source/docs at a pinned commit | Mission interview/DAG/supervision product contract | The mission engine is a separately downloaded proprietary binary; engine semantics are first-party claims, not fully inspectable source evidence |
| [Hermes Agent repository](https://github.com/NousResearch/hermes-agent/tree/f5be9236e00ddf2f2a412697f267078fc4ee068e) | Current first-party source and docs, pinned to `f5be9236e00ddf2f2a412697f267078fc4ee068e` | Current harness/runtime evidence | A capable executor/harness; it is not evidence that Hermes should own Waldo identity, personal truth, or acceptance |
| [Final Waldo architecture plan](/Users/shivanshfulper/.codex/worktrees/waldo-final-architecture-plan/waldo-backend/docs/planning/WALDO_FINAL_HOME_WORK_BACKEND_ARCHITECTURE_PLAN_2026-08-04.md) | Local target design | Architecture being validated | Proposed capability cannot be described as shipped merely because the plan can express it |

## 2. Public Waldo thesis that the architecture must preserve

### Observed

The current portfolio and technical brief consistently establish:

1. Waldo is a private, user-owned personal agent; Kennel is its first Mac home.
2. One Waldo persists across models, tools, work, life, mobile, desktop, and future forms.
3. A finished agent session is not the same as a solved human Outcome.
4. Home and Work are two spaces in one relationship: Home carries the day; Work coordinates agents, people, workflows, services, artifacts, evidence, and decisions.
5. The durable product value is continuity, timing, permission, evidence, acceptance, and what remains—not transcript volume.
6. Explicit user statements and corrections outrank behavioral inference.
7. Health/body data is permissioned supporting context and care, not the category or an autonomous authority source.
8. The user should be able to inspect, correct, export, revoke, delete, and change model/provider without losing the relationship.

Sources: [portfolio story](https://shivansh-portfolio-one.vercel.app/work/waldo), [technical brief](https://waldo-technical-brief.pages.dev/).

The current marketing landing page and older pitch-deck language are excluded from this validation by explicit user direction. They do not arbitrate current product or architecture requirements.

## 3. Comparator product contracts

### 3.1 Dimension — assemble the workday and carry connected work

| Dimension | Source-backed observation | Limitation relevant to Waldo |
| --- | --- | --- |
| Primary job | Connected work assistant that assembles context, catches candidate work, performs selected work, and returns artifacts/results | Broad usefulness did not publicly establish a durable Outcome object |
| Surfaces | Web, email, Slack, iMessage claims; native clients were not consistently proven in final materials | Cross-surface marketing and shipped-surface truth diverged |
| Daily continuity | Morning Briefing, Catch Up, Meeting Prep, Evening Recap, action suggestions, email labeling/drafts | Daily summary is not the same as preserving exact unresolved consequence and human closure |
| Work execution | Chat actions, delegated Todos, background threads, schedule/event workflows, learned Skills | “Done” semantics, retry ownership, idempotency, partial success, cancellation, and reconciliation were not publicly defined |
| Context/memory | Connected-source indexing plus a per-account Context Graph of entities, relationships, preferences, facts, summaries, and inferences; profile editable/deletable | Public schema did not expose provenance, contradiction handling, validity, or purpose limitation at Waldo's required depth |
| Authority | Accept, Reject, Edit, or Respond before sensitive actions; workflow-level approval settings | Global/trusted auto-approve is too coarse for heterogeneous consequence classes |
| Artifacts | Presentations, spreadsheets, documents, PDFs, provider export, searchable Library | Artifact production did not prove outcome verification or acceptance |
| Capability discovery | Integration tags: Read, Act, Search, Trigger; custom MCP discovery and confirmation | Declaration did not prove current executable safety or conformance |

Primary sources remain indexed at [Dimension's docs inventory](https://docs.dimension.dev/llms.txt), including [proactive features](https://docs.dimension.dev/proactive-features.md), [workflows](https://docs.dimension.dev/workflows.md), [skills](https://docs.dimension.dev/skills.md), [artifacts](https://docs.dimension.dev/artifacts.md), and [custom MCP](https://docs.dimension.dev/custom-mcp.md). Consolidated lifecycle/source evidence: [local clean-room dissection](/Users/shivanshfulper/Developer/Pin4sf/waldo-brain/03-References/research/dimension-product-engineering-clean-room-dissection-2026-07-30.md).

### 3.2 Folk — one personal agent in the user's existing life surfaces

| Folk | Source-backed observation | Limitation relevant to Waldo |
| --- | --- | --- |
| Primary job | “The friend in your texts that gets stuff done”: life administration, relationships, money awareness, email/calendar, research, travel, reminders, and background work | Breadth is marketed strongly; externally verified completion is not a general published contract |
| Presence | iMessage, Telegram, WhatsApp, calls, and dashboard; same agent and continuity across the documented channels | Phone/channel-root migration and full portable identity are not clearly self-service; current docs do not establish Discord as a core supported channel |
| Persistent memory | Visual Brain; long-term people/preferences/plans/facts; browse, search, delete, import | Provenance, time validity, conflict, correction history, purpose, and complete export are unresolved publicly |
| Execution | Per-user private cloud computer/browser, connected applications, custom MCP, coding-agent handoff | Browser/MCP isolation, egress, secret-use policy, trace shape, and reconciliation are not fully public |
| Proactivity | One-shot reminders, routines, watchers, follow-up conditions, morning check-ins, location-aware nudges, calls; `/stop` and snooze controls | A durable general Open Loop with consequence, evidence gap, disposition, and human closure is not public |
| Reusable behavior | Folkways bundle instructions, schedule, and required connections and can be shared | Public contract is weaker than signed/versioned/tested behavior bundles with rollback and revocation |
| Multi-person coordination | Crew computes with the target person's agent/tools after approval; requester receives status by default; target can approve a small typed reply; returned data is untrusted | Both parties must use Folk; signatures, expiry, replay defense, idempotency, portable audit, disputes, and verified “done” are unknown |
| Authority | Approval/deny for actions; login/payment/captcha handoff; Crew per-request approval; device-reported write confirmation | Public docs do not establish Waldo-grade digest binding, use limits, revocation generations, reconciliation, or independent acceptance |
| Privacy | Claims tenant-isolated cloud computer, encrypted stored data, no sale/training, independently revocable connections and deletion | “Only you” marketing is qualified by support/operations access; user-held E2E key protocol and complete export are not public |

Sources: [Folk homepage](https://www.folk.com/), [memory](https://www.folk.com/docs/memory), [browser](https://www.folk.com/docs/browser), [reminders](https://www.folk.com/docs/reminders), [Folkways](https://www.folk.com/docs/folkways), [Crew](https://www.folk.com/docs/crew), [privacy](https://www.folk.com/privacy), [subprocessors](https://www.folk.com/subprocessors).

### 3.3 Poke — messaging-native delegation and distribution

| Poke | Source-backed observation | Limitation relevant to Waldo |
| --- | --- | --- |
| Primary job | Natural-language email, calendar, reminders, web search, and connected-service actions inside Apple Messages, Telegram, WhatsApp, and RCS | Public docs do not define a general Outcome/acceptance model |
| Integration surface | Recipes for Linear, Todoist, Notion, Asana, GitHub, DeepWiki, Sentry, Vercel, Supabase, Ramp, Webflow, and more; arbitrary MCP servers | Tool discovery and credentials do not by themselves establish authority, supply-chain trust, or tool-drift safety |
| Reusable/distributable capability | Kitchen recipes bundle onboarding context, first-message behavior, required MCP templates, share/install link, updates for future installs, and creator payout eligibility | Existing installs do not automatically receive recipe changes; version, diff, conformance, rollback, and risk declarations should be explicit in Waldo |
| Programmatic entry | API turns arbitrary JSON into agent context with full access to connected email/calendar/reminders/integrations | API key can inject commands with broad product access; Waldo needs typed commands, audience/purpose, schema, replay/idempotency, and capability ceilings |
| Background work | Pro automations; programmatic/scheduled/event triggers; usage-aware lighter modes | The user-visible degradation policy exists, but outcome-specific budgets and effect reconciliation remain unspecified |
| Human executor | Poke Human can hand restaurant reservations, phone calls, orders, and rides to a real person | Human work still requires identity, bounded authority, evidence, expense policy, privacy, and acceptance contracts |
| Artifact capability | Tables/charts, PDFs, attachments, and hosted websites are described in release notes | Artifact creation is not proof of external-world success or acceptance |

Sources: [welcome](https://poke.com/docs), [integrations](https://poke.com/docs/managing-integrations), [recipes](https://poke.com/docs/creating-recipes), [MCP](https://poke.com/docs/mcp-servers), [API](https://poke.com/docs/api), [release notes](https://poke.com/docs/release-notes), [usage](https://poke.com/docs/usage-and-resets).

### 3.4 Agent Orchestrator — dense supervision of parallel coding sessions

Repository pin: [`66240ab24ea78d1e6e2b1baa34c6796a1a7494dc`](https://github.com/Untrivial-ai/agent-orchestrator/tree/66240ab24ea78d1e6e2b1baa34c6796a1a7494dc).

| Agent Orchestrator | Source-backed observation | Limitation relevant to Waldo |
| --- | --- | --- |
| Primary job | Supervises parallel terminal-based coding agents through a desktop/CLI harness | A coding session, repository, branch, PR, or worktree is not a general human Outcome |
| Isolation | Creates a separate git worktree for each session | Worktree isolation does not establish general filesystem, credential, egress, deletion, or personal-context policy |
| Control surface | Live terminal access, working/waiting/finished/blocked state, PR state, browser preview, and follow-up instructions | Session status is execution observation, not evidence, Acceptance, or Open Loop closure |
| Feedback routing | Routes CI failures, review comments, and merge conflicts back to the responsible session | Feedback-loop automation does not grant effect authority or prove the requested human outcome |
| Harness breadth | Common supervisor for many coding-agent CLIs | Adapter breadth supports Kennel's provider-neutral direction but each exact version still needs Waldo conformance |

Primary source: [Agent Orchestrator README at the pinned commit](https://github.com/Untrivial-ai/agent-orchestrator/blob/66240ab24ea78d1e6e2b1baa34c6796a1a7494dc/README.md).

### 3.5 Medley — mission interview, frontier DAG, and supervised workers

Repository pin: [`8a6221c88d9f4ca96f2c556b08f5882f4be11131`](https://github.com/Spine-AI/medley/tree/8a6221c88d9f4ca96f2c556b08f5882f4be11131).

| Medley | Source-backed observation | Limitation relevant to Waldo |
| --- | --- | --- |
| Primary job | `/mission` interviews the user, proposes a task DAG with per-task runtime/model routing, then supervises parallel workers | Mission is useful for complex work but should remain optional beneath a general Outcome |
| Review/control | User reviews the DAG, says go, watches a local dashboard, handles approvals, and steers in plain language | The host's approval UX and inherited permissions are not Waldo AuthorityGrants |
| Context inheritance | Workers inherit skills, MCP servers, project memory, permission grants, and subscription auth from the host setup | Inherited context/permission is too broad to become Waldo authority or purpose-bound disclosure automatically |
| Runtime evidence | Public repository contains the plugin, hooks, skills, and engine-resolution/install path | The mission engine is downloaded as a proprietary closed-source binary; most engine behavior is documented, not independently inspectable source |
| Local operation | Mission state is described as local SQLite; engine runs a loopback daemon with consent-gated/content-free telemetry claims | Local operation still requires version pinning, supply-chain verification, revocation, and adapter conformance before Waldo admission |

Primary sources: [Medley README](https://github.com/Spine-AI/medley/blob/8a6221c88d9f4ca96f2c556b08f5882f4be11131/README.md) and [mission skill](https://github.com/Spine-AI/medley/blob/8a6221c88d9f4ca96f2c556b08f5882f4be11131/plugin/skills/mission/SKILL.md).

### 3.6 Hermes Agent — persistent, provider-neutral agent harness and work runtime

Repository pin: [`f5be9236e00ddf2f2a412697f267078fc4ee068e`](https://github.com/NousResearch/hermes-agent/tree/f5be9236e00ddf2f2a412697f267078fc4ee068e).

| Hermes | Source-backed observation | Limitation relevant to Waldo |
| --- | --- | --- |
| Primary job | Self-hostable personal agent/harness with terminal, tools, memory, skills, schedules, multiple channels, and remote/cloud execution | It is an executor/runtime, not a user-owned cross-provider Outcome authority |
| Provider/runtime flexibility | Multiple model providers; local, Docker, SSH, Singularity, Modal, Daytona, and Vercel Sandbox terminal backends | Backend availability does not prove common isolation, credentials, cancellation, consistency, or cost behavior |
| Presence | CLI/TUI plus Telegram, Discord, Slack, WhatsApp, Signal, email, and more through one gateway; live session handoff | Session continuity is not automatically life/work Outcome continuity |
| Memory/learning | Agent-curated memory, user profile, conversation search, autonomous skill creation/improvement, Agent Skills compatibility | Autonomous skill/memory change must become a governed proposal in Waldo, never silent personal truth or authority |
| Persistent goals | `/goal` persists objective/verification/constraints/boundaries/stop condition and auto-continues through a bounded judge loop; pause/resume/wait | Judge can be wrong and some blocked cases are treated as done to stop budget burn; Waldo must keep provider completion, Verification, Acceptance, and Open Loop disposition separate |
| Multi-agent Kanban | SQLite task board, named profiles, durable tasks/dependencies/handoffs, dispatcher, heartbeats, blocking/unblocking, retries, human comments, dashboard | Hermes task completion/handoff remains executor evidence; it must not directly close a Waldo WorkUnit/Outcome |
| Scheduling | Natural-language cron with delivery; managed scheduler can wake scaled-to-zero gateways; persisted run claims and heartbeats | Every scheduled effect still needs one retry owner, stale-trigger handling, idempotency, authority revalidation, and terminal user resolution |
| Recovery/steering | Resume, handoff, interrupt, `/stop`, queued user messages, crash/session recovery, background processes, subagents | Provider/session recovery must map through Waldo leases, fencing, cancellation generations, and reconciliation |
| Security | User/channel allowlists, dangerous-command approval, hard blocklist, file guards, container isolation, MCP credential filtering, input scanning, session isolation | Broad YOLO/off modes and treating a container as sufficient approval replacement conflict with Waldo's consequence- and data-aware authority model |

Sources: [Hermes README at pin](https://github.com/NousResearch/hermes-agent/blob/f5be9236e00ddf2f2a412697f267078fc4ee068e/README.md), [persistent goals](https://github.com/NousResearch/hermes-agent/blob/f5be9236e00ddf2f2a412697f267078fc4ee068e/website/docs/user-guide/features/goals.md), [Kanban](https://github.com/NousResearch/hermes-agent/blob/f5be9236e00ddf2f2a412697f267078fc4ee068e/website/docs/user-guide/features/kanban.md), [sessions](https://github.com/NousResearch/hermes-agent/blob/f5be9236e00ddf2f2a412697f267078fc4ee068e/website/docs/user-guide/sessions.md), [security](https://github.com/NousResearch/hermes-agent/blob/f5be9236e00ddf2f2a412697f267078fc4ee068e/website/docs/user-guide/security.md).

## 4. Combined product capability matrix

Legend:

- **Reference strength** describes what the benchmark demonstrates publicly.
- **Waldo fit: native** means the final plan already has an owning contract/module.
- **Waldo fit: clarify** means the architecture can support it but the product contract or named boundary should be made explicit.
- **Waldo fit: evidence-gated extension** means the capability remains committed where the build lock says so, but cannot be declared supported until its authority, privacy, conformance, and acceptance gates pass.

| Product capability / user job | Dimension | Folk | Poke | Hermes | Waldo architecture fit | Required Waldo meaning |
| --- | --- | --- | --- | --- | --- | --- |
| One agent across surfaces | Claimed web/messaging continuity | Strong messaging/calls/dashboard continuity | Strong messaging continuity | Gateway + CLI/channel handoff | **Native** — Presence + owner-scoped durable authority | A presence never creates another identity, memory, or loop |
| Capture and natural conversation | Chat, Todos, suggestions | Conversation as universal command | Messaging-native chat | CLI/TUI/channel chat | **Native** — Capture + Presence command protocol | Capture may remain unpromoted; Outcome creation is explicit/confirmed |
| Morning Brief, Catch Up, Daily Close | Strong daily assembly | Morning check-ins/background work | Reminders/automations | Cron reports | **Native** — OpenLoop/ReEntryPoint + attention/schedule | Compile from durable truth, not unread volume or agent confidence |
| Inbox/calendar/meeting preparation | Strong first-party pattern | Connected email/calendar/meetings | Core documented job | Tool/provider dependent | **Native architecture; adapters missing** | Each read/write family has typed scopes, receipts, reconciliation, and retention |
| Reminders, routines, watchers | Workflows/background agents | Strong multi-trigger proactivity | Recipes/automations | Cron | **Native + clarify** | Distinguish Schedule/Trigger from Routine/Recipe/Skill and Open Loop |
| Persistent, inspectable personal memory | Context Graph editable/delete | Brain, import, group/Crew memory | Not a prominent public product contract | MEMORY/USER/context/session search | **Native** — ContextClaim/Spot/Constellation/Memory policy | User statements outrank inference; provenance, correction, validity, purpose, deletion |
| Cross-app search and DeepWiki | Indexed Search/Context Graph | Connected apps/browser/research | DeepWiki Recipe/MCP | Web/search/MCP/tools | **Native** — KnowledgeProjection/ContextProjection/SourceUsageReceipt | Search/index is rebuildable projection, not canonical memory truth |
| Connected tool/MCP action | Read/Act/Search/Trigger + custom MCP | Composio/custom MCP/browser | Recipes/custom MCP | Tools/MCP | **Native** — CapabilityManifest + EffectIntent/Receipt | Discovery never grants authority; admission requires conformance and digest-bound intent |
| Browser/computer execution | Not central in public contract | Per-user cloud browser + phone handoff | Connected integrations/human fallback | Multiple execution backends | **Native contract; evidence-gated adapters** — ExecutionEnvironmentAdapter/WorkspacePort | Sensitive-step handoff, egress/credential isolation, checkpoints, postcondition verification |
| Artifact creation/library | Strong Library/export | Broad generated artifacts | Charts/PDF/sites | Files/tool output | **Native** — ArtifactRegistry + Workspace/Blob separation | Artifact version/evidence is not Outcome acceptance |
| Durable Outcome and success criteria | Missing publicly | Partial domain trackers | Missing publicly | Persistent goal completion contract | **Native and differentiating** — Outcome/AcceptanceCheck | The person's intended state, constraints, evidence policy, acceptance, disposition |
| Mission/planning/dependency graph | Complex-step plans | Background work | Agent-created work implicit | Goal + Kanban dependencies | **Native** — optional Mission + WorkUnit dependencies | General work graph, not software-only tasks |
| Multi-provider agent sessions | Not provider-oriented | Cursor agent handoff/cloud computer | Integration-oriented | Strong provider/runtime neutrality | **Native** — RunLoop + AgentSession + manifests | Provider sessions are replaceable activity, not product truth |
| Parallel workers/subagents | Not a defining public feature | Cloud work/coding handoff | Not prominent | Strong delegate/Kanban model | **Native architecture; adapter-by-adapter conformance** | Child authority is intersected and bounded; only canonical reducer changes Waldo truth |
| Pause/resume/steer/cancel/recover | Background thread needs-input | `/stop`, background return, handoff | Conversation/API | Strong session controls and recovery | **Native** — Kennel executor protocol + leases/fencing/cancellation | Recover with same operation/session keys; reconcile before retry |
| Consequential judgment | Accept/Reject/Edit/Respond | Approval/deny + sensitive handoff | Natural interaction; details limited | Command approvals/human Kanban input | **Native** — JudgmentRequest + AuthorityGrant | Exact alternatives, uncertainty, consequence, digest, expiry, revocation, use limit |
| Evidence, independent verification, acceptance | Public gap | Public gap outside selected writes | Public gap | Goal judge/worker complete is not independent outcome proof | **Native and differentiating** | Evidence, Verification, Acceptance, and OpenLoop closure remain distinct |
| Open Loop and exact re-entry | Daily recap/remaining items | Conditional follow-up approximates it | Reminders approximate it | Resume/goal/task persistence | **Native and differentiating** | Persist unresolved consequence, responsible party, evidence gap, next trigger, exact re-entry |
| Reusable/distributable capability | Workflows, Skills, marketplace | Folkways | Recipes/Kitchen/MCP + API | Skills/Agent Skills/MCP | **Clarify** | `RoutineDefinition`, `SkillBundle`, and `Connector/MCP package` need separate, versioned contracts |
| Agent-to-agent/person-to-person work | Not central | Crew is a strong reference | Human fallback, connected actions | A2A/multi-profile possible | **Committed, clarify and evidence-gate** | Compute near owner, target approval, minimal status, typed reply, untrusted payload, private failure |
| Human executor | User approval/input | Human step/login/payment | Poke Human | Human Kanban comments | **Architecture-compatible; clarify Actor adapter** | Human WorkUnit assignment, SLA/cost, identity, data minimization, evidence, dispute/cancel/acceptance |
| Attention restraint | Feature toggles/brief cadence | Nudge budget/off/snooze | Usage/degradation controls | Explicit commands/cron | **Native** — attention policy + OpenLoop priority | Interrupt on consequence/authority, not engagement or activity volume |
| Health/body context | Not core | Optional Health/location | Not core | Not core | **Native bounded policy** | Passive caring context inside an existing user-grounded purpose; never independent authority |
| Ownership/export/provider switching | Profile edit/delete; shutdown deleted data | Delete/import; complete export unclear | Connector/account controls | Self-hosting/provider switching | **Native target; must implement** — export/restore + adapters | Relationship and unresolved truth survive provider changes; credentials remain reconnect-only |

## 5. Can the final architecture support the combined product?

### Verdict

**Inference — yes at the architecture level, conditionally at the product-delivery level.** The final plan has the correct stable kernel for a product that combines:

- Dimension's daily connected-work assembly and artifacts;
- Folk's persistent personal presence, memory, proactive help, private compute, and relationship coordination;
- Poke's messaging-native delegation, Recipes/MCP distribution, programmatic triggers, and optional human execution;
- Agent Orchestrator's dense parallel-session supervision, isolated workspaces, and feedback routing;
- Medley's mission interview, reviewed frontier DAG, per-task routing, and supervised workers;
- Hermes's provider-neutral sessions, persistent goals, Kanban-like planning, schedules, skills, remote execution, steering, and recovery.

It can do this without turning Waldo into four separate agents because the plan centralizes identity, Outcome truth, authority, memory policy, acceptance, and Open Loop closure in the per-owner Coordinator/RunLoop authority boundary while making surfaces, providers, connectors, people, protocols, and execution environments replaceable.

That is architectural capability, not proof of a delivered product. Actual breadth will be constrained by admitted adapters, connector scopes, context policies, effect-family reconciliation, evidence collectors, verification methods, and surface UX.

### Why the composition is coherent rather than a feature pile

| Benchmark layer | Waldo's unifying object/policy |
| --- | --- |
| Dimension brief, Todo, workflow, Skill, Artifact | Capture/Commitment → Outcome → optional Mission → WorkUnit; Schedule/Routine; SkillBundle; Artifact |
| Folk conversation, Brain, nudge, browser, Crew | Presence; ContextClaim/Spot/Constellation; AttentionPolicy/OpenLoop; ExecutionEnvironment; future ExternalDelegation |
| Poke message, Recipe, MCP, API trigger, Human | Presence command; Recipe/Routine package; ProtocolAdapter/CapabilityManifest; typed TriggerOccurrence; Human Actor adapter |
| Hermes goal, Kanban task, session, subagent, cron, skill | Outcome/AcceptanceCheck; WorkUnit graph; AgentSession; bounded child execution; Schedule; SkillBundle |

The benchmarks' “done” signals become observations/evidence. Waldo alone reconciles them against the intended Outcome, obtains independent Verification where required, asks the authorized person for Acceptance, and decides what Open Loop remains.

## 6. Clarifications to add before treating the product matrix as locked

These are additions to product/contract clarity, not reasons to replace the stable architecture kernel.

### 6.1 Make behavior packaging explicit

The current plan discusses schedules, skills, capability bundles, and supply-chain trust but should visibly distinguish:

| Contract | Owns | Does not own |
| --- | --- | --- |
| `RoutineDefinition` | Trigger/schedule, action proposal, notification/attention policy, stale-trigger and pause behavior | Learned procedure or connector executable |
| `SkillBundle` | Reviewable procedure, inputs/outputs, required capabilities, tests/evals, provenance, version, rollback | Authority, credentials, Outcome truth |
| `IntegrationRecipe` | Onboarding, required connectors/MCP templates, initial configuration, optional routine/skill refs, install/update policy | Silent install, silent privilege expansion, personal memory |
| `CapabilityPackage` | Executable/tool/MCP manifest, schemas, digests, SBOM/provenance, conformance, expiry/revocation | Product workflow or human acceptance |

This makes Dimension Workflows/Skills, Folkways, Poke Recipes, and Hermes Skills composable without collapsing them into one unsafe “plugin.”

### 6.2 Reserve a cross-person delegation contract

Folk Crew demonstrates a committed job that is not fully represented by ordinary executor delegation. Build it behind the following evidence-gated contracts rather than weakening ordinary executor delegation:

```text
ExternalDelegationRequest
  owner, target principal/agent, purpose, WorkUnit reference,
  minimum requested capability, data-disclosure ceiling,
  authority ceiling, expiry, idempotency key, request digest

ExternalDelegationDisposition
  accepted | declined | blocked | failed | result_available,
  requester-visible summary, participant-private failure reference

DelegationReply
  typed payload, payload digest, target approval/grant,
  untrusted-data label, retention, expiry

SharedContextGrant
  source owner, recipient, purpose, fields/categories,
  temporal scope, pre-existing-data preview, revocation generation
```

Rules: compute near the data owner; reveal status by default; disclose data only through a separately approved typed reply; never treat remote text as instruction authority; delegation intersects rather than expands authority; separately verify any external postcondition.

### 6.3 Make human execution a first-class adapter family

Poke Human and Folk's sensitive-step handoff show two different human roles:

1. **the owner makes a judgment or performs an authentication/payment/captcha step**; and
2. **another person accepts a bounded WorkUnit and performs the task**.

Add explicit manifest fields for human executors: identity/organization, jurisdictions, available jobs, response SLA, cost/expense policy, permitted data classes, communication channel, cancellation/refund/dispute behavior, evidence types, and verification availability. A person saying “done” remains evidence, not automatic acceptance.

### 6.4 Make browser/computer handoff semantics product-visible

The ExecutionEnvironment/Workspace boundary should require:

- a frozen operation intent before computer/browser I/O;
- an explicit handoff state for login, captcha, payment, consent, or private input;
- no credential or sensitive value in model-visible events/transcripts;
- checkpoint/resume under the same operation and lease/fencing generation;
- destination/egress policy;
- screenshots/DOM/files treated as untrusted evidence;
- postcondition verification rather than “the click happened”; and
- a terminal user-visible ambiguous/failure path.

### 6.5 Add an experience capability ledger beside the infrastructure ledger

The final plan's current-to-target ledger is backend-centric. Add the matrix in section 4 as the product-level ledger with four independent statuses:

```text
architecture expressible
contract defined
adapter/provider conformance passed
cross-surface product acceptance passed
```

This prevents “the schema exists” from being presented as “Waldo can manage my inbox,” and prevents a live connector from being presented as “the Outcome is verified and accepted.”

## 7. Flexibility boundary

**Inference:** the architecture gives Waldo high horizontal flexibility across personal administration and agent orchestration because `WorkUnit.requiredCapabilities`, capability manifests, protocol adapters, context projections, replaceable execution environments, evidence contracts, and general Outcome semantics are domain-neutral.

Flexibility is intentionally bounded:

- A new read-only source needs a manifest, identity/auth, data classification, retention/deletion, provenance, and projection tests.
- A new external mutation needs frozen effect arguments, idempotency/reconciliation, authority scope, retry ownership, receipts, cancellation, ambiguity handling, and verification.
- A new agent/provider needs session start/resume/steer/pause/cancel/recovery semantics plus versioned conformance.
- A new surface needs owner-bound registration, command idempotency, ordered event cursor/resync, local-secret boundaries, and projection-only rendering.
- A new skill/recipe needs source/version/digest, declared dependencies/risks, evals, promotion control, rollback, and revocation.
- A new person-to-person flow needs both participants' identity/authority, minimum disclosure, expiry/replay defense, and private failure handling.

Therefore Waldo can eventually serve work far beyond software—research, scheduling, travel, writing, meeting follow-through, administrative coordination, customer work, procurement, human services, device operations—but each consequential effect family must earn admission. “General” means a stable domain and adapter grammar, not arbitrary prompt-authorized action.

## 8. Explicit unknowns and falsifiers

### Unknowns

1. Whether users value the combined Home + Work relationship more than a focused assistant or focused orchestrator.
2. Whether daily briefs reduce mental reconstruction or become another feed.
3. Whether users will inspect provenance/correction controls enough for them to improve trust and safety.
4. Whether independent verification reduces review time enough to justify latency/cost.
5. Whether one Coordinator/RunLoop owner boundary meets latency and alarm/judgment SLOs under parallel general work.
6. Whether a consumer-friendly permission model can expose enough capability without recreating operator complexity.
7. Whether cloud/private execution can meet credential, isolation, recovery, egress, and cost requirements across browser, filesystem, and terminal workloads.
8. Whether cross-person agent delegation is useful without requiring broad private-context disclosure or same-network lock-in.
9. Whether the first real connector's reconciliation semantics survive apply-then-timeout, duplicate delivery, expired approval, and provider idempotency-window expiry.
10. Which initial user segment and repeated Outcome create enough value to justify this system breadth.

### Falsifiers

| Hypothesis | Falsifier |
| --- | --- |
| One Waldo across Home + Work reduces fragmentation | Users maintain separate personal and work agents because combined continuity creates unwanted context mixing or unclear authority |
| Outcome-first orchestration is better than session/task supervision | Users prefer raw session/task views and Outcome clarification costs more time than re-entry/verification saves |
| Needs You reduces supervision | Missed consequential decisions increase, or users continue opening every session to feel safe |
| Verified completion reduces integration burden | Evidence/verification bundles take equal or more review time without reducing false completion, rework, or dropped commitments |
| Correctable, provenance-rich memory earns trust | Users neither inspect nor correct it, and harmful/stale personalization is not measurably reduced |
| Messaging presence increases useful continuity | It increases shallow commands/interruptions but not verified Outcomes, correction, return, or Open Loop closure |
| Adapter neutrality creates useful flexibility | Adding a second provider or effect family requires rewriting Outcome, authority, memory, or acceptance truth |
| Health as passive caring context improves help safely | It changes priority/action without clear user grounding, leaks into work execution, or users experience it as controlling/diagnostic |
| Recipe/plugin distribution grows capability safely | Capability drift, privilege expansion, supply-chain incidents, or silent behavior changes outpace conformance/revocation controls |
| Human/agent delegation can minimize disclosure | Common tasks require raw context export, participants cannot understand the boundary, or “done” disputes cannot be resolved |

## 9. Bottom line for the architecture review

**Design observation:** the final plan specifies one durable owner authority, general Outcomes/WorkUnits, separate AgentSession/effect/evidence/verification/acceptance/OpenLoop states, purpose-bound context, manifest/conformance admission, and exact re-entry. In the inspected public contracts, the benchmark products do not expose this complete separation; that is scoped evidence, not a universal market claim or implementation proof.

**Inference:** building the plan faithfully can produce the intended synthesis of Dimension + Folk + Poke + Hermes while upholding the larger Waldo thesis. The advantage is not feature novelty by omission; it is making the expected parity capabilities cohere around one user-owned identity, bounded authority, verified reality, deliberate closure, and portability.

**Proposed decision:** use the founder-approved architecture lock, capability ledger, and explicit extension contracts as the common seam; build the committed capability families in parallel and evaluate them through the shared whole-product acceptance scenarios.

**Unknown:** no source or architecture document proves customers will trust, retain, or pay for the combined product. Whole-product trials must test burden reduction, not merely demonstrate that agents can run long workflows.
