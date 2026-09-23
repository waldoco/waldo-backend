# Waldo MVP planning packet

> Vocabulary: the owner settled all product words on 2026-09-24. [VOCABULARY_AND_BRAND_2026-09-24.md](VOCABULARY_AND_BRAND_2026-09-24.md) is the source; where this doc uses an older word (Afternoon check-in, update cards, Approve / Change / Skip, Weight as demand, Readiness), read it by that doc. Form / Load / Recovery are the body and day words; Weight is body mass only; Fetch is the sweep and its output is a fetch alert; Handoff is work Waldo offered or took on, tracked as an open loop.

Updated 21 September 2026 · user-selected MVP baseline · documentation publication in PR #138 · implementation and runtime proof remain outstanding

This packet is the target. For what is built today, read [What is built](../../CURRENT_SYSTEM.md).

**Build one cloud Waldo that understands the person, chooses what needs doing and who should do it, acts within permission, checks the result, follows through, and updates its understanding.**

Read the [build plan](../WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md) for the decisions, architecture, source evidence, worker slices, acceptance checks and cost model. Give workers the [implementation guide](WORKER_GUIDE.md) for role-specific reading, libraries, harness/context/tool engineering, checks and a copy-ready assignment. This page is an index, not a second specification.

The [ecosystem strategy](ECOSYSTEM_STRATEGY.md) defines the proposed market position, personal-to-Kennel bridge, partner incentives and later expansion gates. It is strategic rationale; it adds no MVP implementation dependencies.

## Decisions

- Keep the existing Cloudflare owner runtime, Supabase and Expo/React Native iPhone app.
- Ship health-aware day planning, correctable memory, authorized Calendar changes, exact-approved email follow-up and cloud proactivity. Health sharing stays optional.
- Preserve five memory tiers as responsibilities: working context, personal memory, episodes, reviewed procedures and eventual archive. Simplify the initial records; add a fresh compact profile, immediate explicit correction/forget, incremental consolidation and relevance-tested retrieval. The existing production recall gap must be fixed and proved.
- Use official Google APIs. Buy Browserbase's hosted Stagehand browser execution for public research and bounded supported tasks; keep payments/bookings as explicit approval or user takeover.
- Use one evaluated primary model behind the existing interface. Sonnet 5 is the recommended first candidate; measure it against the already-supported Sonnet 4.6 before pinning.
- App and push first. Telegram is the recommended same-agent demonstration/fallback; WhatsApp keeps its own supported-route workstream. Local desktop login is not required.
- Include one bounded Kennel-to-Codex handoff in the showcase, using the same responsibility loop. Full work orchestration, the web dashboard and coordination between people's Waldos have explicit later milestones.
- Trusted Relationships, health-pattern mining, Swiggy, general self-modifying skills and broad connector catalogs do not block the showcase. Keep first-principles freedom to replace a component when the concrete proof fails; existing stack and philosophy are not unconditional requirements.

The proposed differentiating promise is: **Waldo turns your priorities and available energy into a realistic day—and carries chosen work through your own agents.** It is a hypothesis to prove, not a verified feature competitors lack. The recommended first joined-product ICP is a busy technical founder/builder; the personal experience must work without Kennel. Premium quality means quick first value, visible memory corrections, useful result cards, calibrated interruptions, graceful recovery and accessibility. These are specified within the existing slices, with acceptance checks A15/A16 and repeat-use measures; they do not add a new platform project.

## Build sequence

1. **S0:** remove fictional success and contain the legacy chat ownership defect; connect app → owner DO → real model → read-only Calendar → durable answer.
2. **S1:** personality, continuing conversation, memory correction/forget and explicit commitments.
3. **S2 + H:** health-aware day, bounded Calendar adaptation, cloud change detection and proactive return on a physical iPhone.
4. **S3 + B:** approved email follow-up/reply monitoring and useful public research.
5. **K0:** demonstrate one attached test-project task moving through a narrow cloud-to-Kennel bridge to its Codex-first harness, returning a diff and verification evidence. The bridge still needs implementation/proof.
6. **S4:** repeated real-device/provider recovery, isolation, control, usefulness and cost proof; then admit a small invited cohort.
7. **W/K/R:** expand to a proper web dashboard, broader existing-harness execution and coordination between different people's Waldos.

App/health and connector work can parallelize only after their contracts are released. One integration owner controls shared contracts and migrations. Open implementation issues for the next frontier rather than activating every future slice at once.

### Post-S4 roadmap addendum

The next path is **S4 → ConversationEntry → Joined Conversation Path → Telegram → S5**. Each slice needs a real end-to-end run through the intended app, owner runtime and provider path before the next slice is admitted; mocks, fixtures and schema presence do not count as completion evidence.

- **ConversationEntry:** use an immutable, owner/thread-bound canonical entry with separate model and app payload projections. Branches and threads keep append-only ancestor context, so edits, retries and resumptions preserve provenance without rewriting prior entries.
- **Joined Conversation Path:** prove shared conversation continuity across app and owner runtime, including ordering, reconnect, cancellation, account isolation and truthful receipts.
- **Telegram:** add an app-linked, revocable presence for the same owner; deduplicate provider events and keep consequential approvals in the trusted app path until Telegram approval is proved.
- **S5:** admit the joined app/channel path only after Telegram and all preceding real-run evidence pass. After the **S4.5** stabilization checkpoint, publish the assistant export from the canonical append-only conversation and permitted projections.
- **S5.5 onward:** add browser execution and Cloudflare Sandbox together when isolated Linux/file/process work is required. Add heartbeat/status at **S6.5**. **S7** adds pending approvals and the durable Activity ledger; approval state and activity evidence remain distinct from conversation prose.

Every slice records its own real-run evidence: source/config pins, account and consent state, observed provider effect, recovery result and sanitized evidence references. Later slices cannot inherit completion from an earlier slice's evidence.

No date, budget or exact cohort is fixed. Planning estimates are 3–4 weeks to the internal day loop and 6–8 weeks to the personal beta with two experienced owners and available test accounts. The joined showcase also requires K0; estimate that after a 2–3-day Kennel readiness spike. The illustrative 10-user moderate personal-usage envelope is $600–750/month, subject to actual model/browser use, external costs and the S0 measurements; add measured Kennel harness costs separately. W/K/R are outside these estimates. These are proposals, not commitments or spending authorization.

## Evidence

- [Source audit](SOURCE_AUDIT.md): production composition gaps, legacy app risks and retained substrate.
- [Competitor research](COMPETITOR_RESEARCH.md): Instinct, Muse, Grok Bot, Vellum, Poke and Folk; no invented hands-on claims.
- [Browser/open-agent research](RUNTIME_BROWSER_RESEARCH.md): Cloudflare, Browserbase, Hermes and OpenClaw.
- [Kennel source map](KENNEL_K0_SOURCE_MAP.md): reusable handoff seams, Codex-first direction and the unproven cloud bridge.

The audit used backend main `e91bee0`, PR #138 head `10e48fb`, and app main `7218c18f`. The source audit did not exercise tests or live services. Documentation publication checks are recorded in PR #138 and ledger #116. This packet supplies the selected product/build direction. Start with S0, including the bounded [cross-repository synchronization](ADR_RECONCILIATION.md); do not silently treat older Brain/app release cuts as current or claim an ADR amendment has already landed.

## Engineering details and first assignment

- [Implementation contracts](IMPLEMENTATION_CONTRACTS.md): retained publication, deletion, connection, effect and channel rules.
- [ADR reconciliation](ADR_RECONCILIATION.md): exact dispositions and cross-repository synchronization before changing affected seams.
- [First worker assignment](FIRST_WORKER_ASSIGNMENT.md): copy-ready S0 scope and acceptance; analyze current source, then build only that frontier.

Give the implementation lead the [copy-ready full MVP assignment](IMPLEMENTATION_PROMPT.md). Build and verify the complete MVP first, then use a separate dated competitor comparison to prioritize further quality improvements; the existing MVP usability and reliability criteria still apply.

Share this directory link with workers. Read this page, the worker guide, and the relevant build-plan sections; use the research appendices only for the seam being implemented. The canonical plan remains one file at its established September 18 path, updated September 21.

## Engineering and repository navigation

- [Repository map](REPOSITORY_MAP.md): where the main agent, app, health, Kennel bridge and canonical decisions live; source paths, fresh-ref checks and verification commands.
- [Engineering quality](ENGINEERING_QUALITY.md): CI and agent evaluations, dependency lifecycle, bounded coding-agent improvement, cleanup order and the measurable Instinct/Meta Muse experience target.

Build the first CI and behavioral proof alongside S0. Preserve the main plan's A1–A16 acceptance and S0–S4/H/B/C/K0 scope; the companions do not establish shipped capability or add a platform prerequisite.

#### Harness contracts and later controls

The harness contract families are: authority/consent; identity/addressing; conversation/projection; memory/provenance/correction; action/reconciliation; and monitoring/lifecycle. S7 exposes a pending approval queue, append-only Activity feed, and stop/undo controls through app/dashboard views; Telegram buttons may drive only separately proved approval scopes. Trusted agent-to-agent coordination follows S7. Dashboard views must cover conversation branches, memory corrections, connection status, approvals/activity, schedules/heartbeat and coordination, with acceptance for authority, durability, reconnect and failure recovery.

Founder-alpha Google custody remains native Vault plus the typed connector proxy. Nango Cloud may enter at S5.5 only for long-tail providers behind a Waldo-owned `ConnectionBroker`, after an accepted custody ADR proves account-handle migration/reconnect, deletion parity, cutover/rollback and read-path behavior. Composio is not the connector spine.

Hardening adopted from the Pi/Hermes study includes typed lifecycle/outcome and error events, refusing truncated tool calls, append-only checkpoints and branches, crash-safe delivery obligations, idle heartbeat maintenance, phone approval round trips and audit evidence. Raw wearable streams stay phone-local; only consented aggregate summaries cross into the agent.
