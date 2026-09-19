# Waldo peer-experience reverse engineering and smallest winning build order

**Date:** 2026-09-19

**Status:** research and product-quality recommendation; not architecture authority, implementation evidence, or parity proof

**Waldo baseline:** current PR #138 worktree plan, `docs/planning/WALDO_PERSONAL_AGENT_PRODUCT_ARCHITECTURE_AND_BUILD_PLAN_2026-09-18.md`

**Products reviewed:** Moonshot Computer, Instinct, Poke, Meta Muse, Grok Bot, Hermes Agent, OpenClaw, and Waldo

## Executive decision

The category is not being won by the largest connector catalog. It is being won by the shortest trustworthy loop between **attention, memory, action, follow-through, and correction**.

The smallest product that can make Waldo competitive is:

```text
Tell Waldo something
-> it remembers the right part and shows why
-> Today and Open Loops make the value visible
-> Calendar lets it complete one bounded action safely
-> it follows up at the right time
-> the owner can steer, stop, correct, revoke, or delete everything
```

That loop should ship before a general browser, a skill marketplace, arbitrary MCP, a credential vault, a multi-agent work graph, or connector-count parity. Moonshot shows the power of an ambient personal ledger; Poke and Instinct show the appeal of messaging-native access; Muse and Grok Bot set the bar for visible activity, approvals, computer use, and background work; Hermes and OpenClaw show the speed available from open runtimes. None of those observations changes Waldo's central advantage: **one governed personal agent whose memory, responsibilities, relationships, health context, and actions remain legible to the owner**.

The recommended sequence is therefore:

1. **G0 — truthful product shell and owner isolation**;
2. **G1 — one excellent persistent conversation and correctable memory**;
3. **G2 — `Today` plus a complete Calendar action corridor**;
4. **G4-narrow — source-grounded follow-through, Activity, notifications, and one meeting-to-follow-up loop**;
5. **G3 + G5 in parallel — Trusted Relationships and HealthKit as Waldo's differentiated join**;
6. **G8-narrow — app plus one officially eligible remote channel**;
7. **G6 — one India commerce corridor with price approval and takeover**; and only then

8. **G7 — managed browser fallback for tasks APIs cannot complete**.

This is a resequencing recommendation, not a request for a second framework. It preserves the current plan's authority kernel, conversation/effect/receipt boundary, incremental grants, exact approvals, reconciliation, account epochs, and proof ladder.

## 1. Evidence lanes and clean-room rules

Competitive product research is useful only when the evidence lane is explicit. This review keeps four lanes separate.

| Lane | Permitted evidence | Claims it can support | Claims it cannot support |
|---|---|---|---|
| Public-source teardown | First-party product pages, documentation, privacy/terms, release notes, public demos, screenshots, and public source | Documented feature, intended experience, stated data handling, stated limitations | Actual reliability, hidden architecture, internal prompts, security effectiveness, or availability in every account |
| Owner-driven ordinary-use observation | The owner manually uses an account they control with synthetic or low-risk data and records the visible flow | Dated onboarding, friction, UI states, latency, visible failures, effect in the source of record | General reliability, internals, undisclosed data handling, or a right to automate/publish a benchmark |
| Structured black-box test | Predeclared synthetic accounts, tasks, expected authority, deterministic source-of-record checks, screenshots, and repeated trials | Measured experience and consistency within the authorized, tested scope | Unobserved mechanisms, universal parity, production security, or claims outside the tested version/region/tier |
| Self-hosted/open-system study | Public docs/source and a sandboxed local install of Hermes/OpenClaw-class systems | Observable behavior and inspectable implementation at the exact revision tested | Suitability as Waldo's kernel without a separate threat, custody, and operating-cost review |

Terms and access rules are a **collection-method and publication-risk input**, not a veto on learning from observable products. Instinct and Poke currently publish restrictions concerning benchmarking or competitive use in their [terms](https://instinct.com/terms) and [terms](https://poke.com/terms). Before automated, systematic, or published account-based testing, record the account authority, applicable terms, vendor permission/counsel view, automation method, data class, publication boundary, and the owner's chosen risk decision. Public first-party material and owner-recorded ordinary-use observations remain valid lanes; no lane creates permission to infer internals that were not observed.

Across every lane:

- use dedicated synthetic identities, calendars, mailboxes, contacts, meetings, and relationship records;
- do not extract prompts, evade access controls, scrape private surfaces, load-test a service, reuse another person's data, or probe secrets;
- record product/version/date/region/tier and mark unavailable surfaces `not observed` or `not comparable`;
- preserve the trajectory, approvals, source-of-record result, correction/revoke/delete result, and failure recovery—not only a polished final answer; and
- translate observations into independently written Waldo scenarios and contracts, never private code or proprietary prompt text.

## 2. What each product actually teaches

The tables below separate **observed vendor statements**, **bounded inference**, and **unknowns**. “Not established” means absent from the checked first-party material; it does not prove absence.

### 2.1 Moonshot Computer

**Observed from first-party sources**

- Moonshot describes an early-access iPhone product and a 100-seat founding beta. Its central interaction model is continuous listening that turns context into a persistent `Mind`, a commitment `ledger`, pending notes, morning history, standing orders, reminders, and action receipts. ([product](https://moonshot.computer/), [About](https://moonshot.computer/about), [privacy](https://moonshot.computer/privacy))
- When listening is enabled, audio is split at a quiet pause with a 30-second cap, sent through Moonshot's server for Google Cloud transcription, deleted after transcription, and retained as text. That text can contribute to durable personal context and can include nearby non-users. ([privacy](https://moonshot.computer/privacy))
- The product discloses per-fact correct/forget controls, whole-Mind deletion, Apple sources including HealthKit sleep, reviewed Gmail/Calendar actions, a five-second send confirmation, reminders, Focus-aware quieting, and push notifications. ([privacy](https://moonshot.computer/privacy))
- Google connection is required to finish setup and is implemented as one broad Composio “Google Super” authorization, while Moonshot states it constrains the tools used. The policy also discloses multiple model/service providers, recovery mirrors, a live storage migration, unfinished user-only-key encryption, historical-copy retention, split app/website deletion, and retention details still being verified. ([privacy](https://moonshot.computer/privacy))

**Inference**

Moonshot's advantage is not the microphone itself. It is a coherent product promise: “I noticed the promise you forgot and brought it back at the right time.” Named personal objects make background intelligence tangible.

**Unknown / conflict**

No reviewed first-party surface proves sustained iOS background reliability, battery impact, false-open-loop rate, authenticated UX quality, a general browser/computer, or transaction breadth. The homepage statement “Nothing leaves without your yes” is broader than the ordinary-language effect of enabled continuous remote transcription; Waldo should treat this as a warning against absolute privacy copy, not as a pattern to emulate.

**Waldo decision:** emulate the visible personal ledger, `Today`, per-fact correction, and proactive loop; reject ambient capture through G0-G4 and reject bundled Google authorization.

### 2.2 Instinct

**Observed from first-party and owner-supplied visible surfaces**

- Instinct's public promise is “no new interface”: contact the agent by text or call; it uses a phone and computer, follows up proactively, and can handle examples such as rides or finding a handyman. ([product](https://instinct.com/))
- Instinct's privacy policy describes connected-service data, private messages/audio, credentials/payment information, autonomous actions, and a training distinction: Google-derived materials are excluded, while other materials may be used unless the user opts out. ([privacy](https://instinct.com/privacy-policy))
- Dated owner-supplied dashboard screenshots show Messages, WhatsApp, dedicated email, Google Workspace, Outlook, Linear, Notion, GitHub, Slack, Granola, Trusted People, external-data deletion, and a vault for logins, cards, personal information, and agent-held items. These screenshots establish displayed surfaces, not connector reliability or internal architecture.

**Inference**

Instinct is selling delegation through a familiar relationship, not a dashboard of tools. Its strongest experience lesson is low-friction reachability plus willingness to finish messy real-world tasks.

**Unknown**

The checked public sources do not establish execution isolation, approval semantics, idempotency, recovery, receipts, memory correction, longitudinal reliability, or the actual breadth available to a given account.

**Waldo decision:** emulate contact-like reachability, Trusted People as a product concept, and end-to-end ownership of a request; reject raw password/card/TOTP custody and any “trust us” action path without exact approval and receipts.

### 2.3 Poke

**Observed from first-party sources**

- Poke presents itself as a personal assistant reachable through Apple Messages, Telegram, WhatsApp, and RCS, with email, calendar, reminders, web research, integrations, recipes, and proactive/background work. ([product](https://poke.com/), [docs](https://poke.com/docs))
- Its documented Connections experience includes connecting, disconnecting/reconnecting, and custom MCP URLs or API keys; usage documentation describes background automations on paid tiers and a lighter mode when higher-tier usage is exhausted. ([integrations](https://poke.com/docs/managing-integrations), [usage](https://poke.com/docs/usage-and-resets))
- Its privacy policy allows model improvement/training by default unless the user selects Maximum Privacy and describes special handling for Google data. ([privacy](https://poke.com/privacy))

**Inference**

Poke's strength is habit formation: it behaves like a capable contact inside surfaces users already check, and “recipes” make recurring value legible without exposing a workflow engine.

**Unknown**

The checked public docs establish breadth more clearly than exact per-action approvals, source verification, restart behavior, duplicate suppression, deletion/non-resurrection, or purpose isolation for arbitrary MCP/API-key connections.

**Waldo decision:** emulate messaging-native access and simple reusable routines; reject arbitrary connector admission on the launch path and do not make a catalog substitute for one reliable corridor.

### 2.4 Meta Muse

**Observed from first-party sources**

- Muse presents one primary relationship-like conversation plus side chats, a named/avatar/styled persona, Goals, Ideas, artifacts, background work, an activity view, editable memory files, app/web/WhatsApp access, and controls to increase, decrease, or disable proactivity. ([launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/), [design](https://introducing.muse.ai/))
- Its security design describes an isolated VM/browser, a separate Sentinel as the sole authorization authority, structured approvals outside agent prose, secret surrogation so the agent does not see credentials, per-connector/destination capabilities, tainted-data egress controls, takeover for sensitive steps, and an audit trail. ([security](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse))
- Meta states that errors and prompt injection remain possible; training is opt-out, and operator access remains possible until a future confidential-computing design. ([security](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse), [launch](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/))

**Inference**

Muse currently sets the clearest public experience bar for making autonomy visible without forcing users to read execution logs. Its strongest pattern is not “a VM”; it is the joined surface of goal, current activity, approval, takeover, completion, and later inspection.

**Unknown**

First-party launch material does not establish independent security, reliability under adversarial pages, the burden of repeated approvals, retention/deletion quality, or longitudinal helpfulness.

**Waldo decision:** emulate joined Activity, out-of-prose approval, meaningful-notification filtering, tunable proactivity, artifacts, and takeover. Buy a managed browser/VM capability behind Waldo policy; do not build this infrastructure or adopt Meta's data defaults.

### 2.5 Grok Bot

**Observed from first-party documentation**

- Grok Bot is documented as a persistent named teammate with account-wide access to a shared cloud computer, browser, files, terminal, connectors, chat collaboration, visible tool/computer activity, questions and approvals, steering by a new message, and an explicit “Stop now” control. ([overview](https://docs.x.ai/grok-bot/overview), [collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration), [computer](https://docs.x.ai/grok-bot/computer-and-apps))
- Skills and routines can be taught from a successful task, reviewed, tested on a safe example, and then scheduled. Routine definitions make owner, schedule/time zone, input, expected result, approvals, missing/stale-source behavior, history, pause/edit/test/delete, and idempotence visible. ([skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations))
- Sensitive steps such as passwords, 2FA, CAPTCHA, payments, and human checks use computer takeover; connectors are preferred where available. All Bots in an account share files, browser sessions, and CLI credentials. ([computer](https://docs.x.ai/grok-bot/computer-and-apps))

**Inference**

Grok Bot's most transferable lesson is teach-after-success: do the task manually once, inspect the learned procedure, test it, and only then schedule it. That converts demonstrated value into a habit without asking the user to design an automation upfront.

**Unknown**

The documentation does not prove isolation between intentions inside a shared account, success consistency, recovery under ambiguous effects, or the exact approval threshold for every task class.

**Waldo decision:** emulate visible activity, steer/stop, demonstrate-review-test-enable, and explicit routine history; reject account-wide shared credential/context scope as Waldo's trust model.

### 2.6 Hermes Agent

**Observed from first-party documentation**

- Hermes is a self-hostable agent with CLI/desktop access, more than 20 messaging channels, more than 60 tools, browser/computer abilities, MCP, cron, voice, bots, skills, persistent memory, and deployment across local machines, VPSs, containers, and serverless environments. ([docs](https://hermes-agent.nousresearch.com/docs/))
- Its quickstart explicitly recommends proving one clean conversation first, then layering gateway/channels, cron, skills, voice, and routing. A “Blank Slate” setup can start with provider/model plus file/terminal only; first success includes a reply, a tool call, multi-turn continuity, and session resume. The Nous Portal path further compresses first value to one OAuth/provider choice. Hermes documents interruption with a new message or `Ctrl+C` and exposes setup/doctor/model/session/gateway recovery commands. ([quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart), [Nous Portal](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal))
- Persistent memory is compact, agent-curated, searchable across sessions, and loaded at session start; new entries are not visible to the already-frozen session until a new session. `SOUL.md`, `USER.md`, and `MEMORY.md` separate identity, user profile, and learned facts. Background review can save memory and patch skills; writes are free by default unless `memory.write_approval` stages them for approval. ([file model](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what), [memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory), [personality](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality))
- Security documentation describes dangerous-command approval modes, fail-closed timeout, unattended/cron denial, and Docker/SSH isolation options. Mutating computer actions can be approved once, for a session, or always, and unattended mutations fail closed, but a `--yolo` posture can bypass normal approval. ([security](https://hermes-agent.nousresearch.com/docs/user-guide/security), [computer use](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use))
- Before file mutations Hermes records checkpoints; rollback is designed to restore Hermes-written changes while preserving later human edits when its ledger is available. It also documents backups and gateway watchdog/restart behavior. ([checkpoints and rollback](https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback), [messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging))

**Inference**

Hermes validates the build order Waldo should follow: conversation, resume, visible interruption, recovery diagnostics, then channels and automation. It also shows the operator appeal of portable files, understandable local state, and rollback that distinguishes agent edits from later human edits.

**Unknown / limitation**

Tool count and self-hostability do not establish safe defaults, user-friendly privacy, mobile onboarding, per-owner authority, or provider-effect correctness. Default autonomous memory/skill writes are incompatible with Waldo's durable-truth posture. Personality/memory files are useful authoring interfaces but do not by themselves provide provenance, consent, deletion, scheduling, or action authority; filesystem rollback is not external-effect reconciliation.

**Waldo decision:** reuse lessons and possibly isolated components/adapters, not Hermes as the owner kernel. Borrow its staged onboarding, diagnostics, portable reviewed voice material, explicit resume behavior, and human-preserving checkpoint semantics; require reviewed admission for every durable memory/skill mutation and exclude bypass modes from the product path.

### 2.7 OpenClaw

**Observed from first-party documentation and public product material**

- OpenClaw is an open-source, self-hosted gateway intended to run on the user's machine and connect WhatsApp, Telegram, and other channels to inbox, email, calendar, browser/computer, skills, plugins, memory, sessions, cron, nodes, and a Control UI. It does not present a hosted tier. ([product](https://openclaw.ai/), [docs](https://docs.openclaw.ai/))
- Its quick start detects an existing supported coding-agent login or API key, validates the configuration with a real completion, saves it, and opens the dashboard; memory and channel setup follow inference proof. The stated target is a first AI reply in about five minutes. ([getting started](https://docs.openclaw.ai/start/getting-started), [onboarding overview](https://docs.openclaw.ai/start/onboarding-overview))
- The Gateway is the source of truth for channels, configuration, credentials, and state. OpenClaw's own trust-boundary documentation says sandboxing and execution approvals are off by default, regular execution can run on the host without prompts unless configured, native plugins run in-process, and one Gateway is one trust domain rather than an adversarial multi-tenant boundary. ([why OpenClaw](https://docs.openclaw.ai/start/why-openclaw), [trust boundary](https://docs.openclaw.ai/start/why-openclaw/the-trust-boundary), [security](https://docs.openclaw.ai/gateway/security))
- `SOUL.md`, `IDENTITY.md`, `USER.md`, `MEMORY.md`, searchable daily notes, and provenance-bearing memory controls make personalization inspectable. Default “dreaming” can consolidate material into durable memory under documented thresholds and expose a Dream Diary; forget/reset operations also state important limits involving original transcripts, backups, and external copies. ([agent runtime](https://docs.openclaw.ai/concepts/agent), [memory](https://docs.openclaw.ai/concepts/memory), [dreaming](https://docs.openclaw.ai/concepts/dreaming), [memory CLI](https://docs.openclaw.ai/cli/memory))
- Automation distinguishes explicit jobs/tasks/standing orders from heartbeat-style assessment and exposes a task/history model; heartbeat is opt-in and designed to stay silent when nothing matters, while an inferred-commitments experiment was removed in favor of explicit automation. ([automation](https://docs.openclaw.ai/automation), [heartbeat](https://docs.openclaw.ai/heartbeat), [schedules](https://docs.openclaw.ai/automation/cron-jobs/schedules))
- Skills can be shared in a revisioned library and verified by digest, but third-party skills remain untrusted and can bring scripts, dependencies, host-side secret injection, and ongoing update risk. ([skills](https://docs.openclaw.ai/tools/skills))
- Managed isolated browser profiles are documented as the default browser posture. By contrast, once node-local computer control and its pairing surface are enabled, current docs state there is no lease, expiry, arm/disarm control, or per-action confirmation; macOS control is default-on when OS permission exists. ([browser](https://docs.openclaw.ai/tools/browser), [browser risk](https://docs.openclaw.ai/gateway/security/browser-control), [computer use](https://docs.openclaw.ai/nodes/computer-use))

**Inference**

OpenClaw is strongest for technical owners who value control, portability, channels, inspectable memory, quiet automation, and extensibility and accept operator responsibility. Its real-completion-before-configuration onboarding is an especially strong pattern. Its docs are unusually useful because they state important trust limits rather than hiding them.

**Unknown / limitation**

Public docs do not establish consumer-grade setup success, support burden, secure configuration by ordinary users, managed uptime, or governed separation between personal contexts. “Runs on your machine” is not equivalent to “private” when remote models, connectors, plugins, and host execution remain in the path. Paired computer control without an expiring lease or effect-specific approval is a direct rejection criterion for Waldo.

**Waldo decision:** emulate verified-completion onboarding, legible gateway/channel seams, provenance-aware memory, silent-on-no-change automation, diagnostics, and honest trust-boundary/deletion documentation. Reject host-power defaults, durable blanket computer authority, native untrusted plugins, and operator complexity as the mainstream Waldo experience.

## 3. Experience comparison: what is happening and what is not proved

| Dimension | Strong public pattern | Product(s) that best illustrate it | What remains unproved or commonly weak | Waldo target |
|---|---|---|---|---|
| Onboarding | Start in a familiar channel or a guided first conversation | Instinct, Poke, Hermes | Broad required permissions, multi-account confusion, and empty-chat abandonment | Useful with zero connectors; Calendar-only next; no broad grant |
| First value | Reflect an immediate personal commitment/day back to the user | Moonshot | False extraction and creepy archive import | One grounded answer + one visible Open Loop within the first session |
| Personality | Stable name/voice and relationship continuity | Muse, Hermes, Instinct | Fabricated intimacy, dependency pressure, and hidden inference | Reviewed voice + user settings + provenance-bearing memory |
| Memory | Named, inspectable facts/objects with correction | Moonshot, Muse | Contradiction, temporal supersession, deletion resurrection, and purpose control | Profile Claims/Open Loops with source, status, freshness, purpose, correct/forget |
| Proactivity | `why now`, meaningful notification, standing order/routine | Moonshot, Muse, Grok Bot | Nuisance, sensitivity, stale inputs, and silent automation growth | Manual-first; source-grounded; done/snooze/dismiss/incorrect/dial-down; quiet means silent |
| Action control | Approval outside agent prose, takeover, visible activity | Muse, Grok Bot | Ambiguous provider success, duplicate effects, and approval fatigue | Typed exact approval, immutable payload, read-back/reconcile, Activity, Stop |
| Computer/browser | Isolated cloud computer plus takeover | Muse, Grok Bot | Injection, shared sessions, cleanup, cost, and overuse when APIs exist | Buy managed execution behind `BrowserExecutionPort`; APIs first |
| Channels | Agent behaves like a contact | Instinct, Poke, OpenClaw, Hermes | Identity recycling, cross-surface ordering, webhook spoofing, and provider eligibility | App first; one official channel; one canonical conversation/order |
| Connector depth | A few actions feel complete; catalogs create discovery | Instinct, Poke | Icons and OAuth without quality, purpose isolation, or recovery | Calendar then Gmail/meeting; each corridor complete before the next |
| Recovery | Session resume, diagnostics, activity/history | Hermes, Grok Bot, OpenClaw | Exact-byte publication recovery and indeterminate external effects | Honest state machine, next-step recovery, no late or fictional success |
| Privacy/control | Detailed data-path disclosure, permissions/activity, self-hosting | Moonshot, Muse, OpenClaw | Broad scopes, opt-out training, split deletion, operator access, unsafe defaults | One joined Connections/Memory/Activity/Delete surface with truthful receipts |
| Longitudinal habit | Morning history, standing orders, routines, relationship continuity | Moonshot, Poke, Muse, Grok Bot | Whether interventions remain useful after novelty | 7/14-day cohort measuring usefulness, nuisance, correction, and control |

No reviewed first-party source proves that any peer is simultaneously excellent at all dimensions. The market's visible gap is a personal agent that combines contact-like ease, earned personalization, useful proactivity, exact action control, and owner-legible data handling without requiring either ambient surveillance or a power-user operations project.

## 4. The Waldo differentiation thesis

Waldo should not describe itself as “OpenClaw but safer,” “Poke for India,” or “Moonshot without the microphone.” Those frames inherit a competitor's center of gravity.

The product thesis is:

> **Waldo is the personal agent that keeps commitments moving across your own life and the people you trust, using health context when it helps, while showing what it knows, why it acted, and how to stop or correct it.**

Three differentiators reinforce the same loop rather than creating three products.

### Trusted Relationships

This is not generic agent-to-agent chat. The useful product is a narrow consent protocol: who is asking, the purpose, the minimum shared information, each side's independent approval, expiry, private decline, revoke/block/report, and dual receipts. It should first solve scheduling/rescheduling between two owners without sharing event titles, health, inbox, memory, or inferred profiles. If that is not faster and more trusted than a calendar link, stop expanding it.

### Health-aware planning

HealthKit should change planning quality, not become a dashboard or diagnosis engine. The first differentiated behavior is modest: when explicitly enabled, fresh purpose-approved sleep/activity context can shape workload timing or recovery suggestions, always with source/freshness and never as clinical certainty. The plan remains useful when health is absent, stale, limited, or revoked.

### India-native action corridors

India differentiation should begin with one deep corridor, not many logos. Swiggy/Zomato/Blinkit/Flipkart-like integrations require product/API permission or a managed browser/takeover path, exact price/item/address approval, OTP/payment handoff, cancellation/refund state, and no raw credential or payment-secret custody. The launch proof is one honest order/takeover corridor that survives a price change and ambiguous timeout—not four connector buttons.

## 5. Emulate, reject, buy, and build

| Capability | Emulate | Reject | Buy/reuse | Build/retain in Waldo |
|---|---|---|---|---|
| First session | Hermes' one-clean-conversation-first; Moonshot's immediate reflection of commitments | Mandatory life-archive import or broad OAuth | Model API and official client SDKs | ConversationPublicationService, owner identity/order, truthful empty/error states |
| Personality | Muse's visible persona settings; Hermes' stable voice material | Hidden “soul” as permission, fabricated intimacy, personality inference from thin evidence | Provider inference | Reviewed voice pack, user controls, relationship-quality eval |
| Memory | Moonshot's named facts and per-fact correction; Muse's editable memory | A second `Mind`, unreviewed self-writing, vector recall as truth | Commodity search/index only after eval | Profile Claims, Episodes, Open Loops, Relationships, provenance/admission/correction/delete |
| Proactivity | Moonshot morning history; Muse relevance filtering; Grok test-before-schedule | Generic patrol, engagement optimization, inferred standing authority | APNs and deterministic scheduler primitives | Why-now, quiet hours, feedback controls, occurrence identity, Activity/history |
| Google | Calendar-first value and metadata-first mail | Google “Super” onboarding | Official Google APIs/OAuth libraries | Vault/typed proxy, incremental grants, exact operations, source read-back |
| Meetings | Granola-like source-linked notes feeding follow-up | Always-on meeting capture as launch requirement | Official Granola/export/webhook API where available; transcription later | Source admission, citations, bounded backfill, follow-up/Open Loop creation |
| Browser/computer | Muse isolation/takeover; Grok visible activity | In-house browser, raw credentials, blind retries | Managed browser/VM service behind one port | Domain/action policy, approval, budgets, redaction, reconciliation, cleanup evidence |
| Channels | Poke/Instinct contact-like access | Channel-specific memory/authority silos | Official WhatsApp/email provider when eligible | PresenceClaimRegistry, binding/step-up, canonical order, revoke/delete |
| Skills/routines | Grok demonstrate-review-test-enable; OpenClaw digests; Hermes layering | Marketplace/arbitrary MCP on launch path; files as authority | Reviewed libraries only after admission | Version/digest, capability ceiling, revoke, aggregate budgets, conformance eval |
| Health | High-signal passive context, not a separate product | Ambient “stress detection,” raw arrays in general memory, medical claims | Apple HealthKit and Apple platform primitives | Consent epoch, deterministic derivation, freshness/provenance, destination policy |
| India commerce | Exact-price handoff and local-service usefulness | Vaulting card/OTP, hidden substitutions, broad browser autonomy | Official partner APIs; browser/takeover only if necessary | Typed cart/order state, approval, timeout reconciliation, cancellation/refund receipt |
| Trust/control | Muse Activity/approval; Moonshot deletion specificity; OpenClaw boundary candor | Absolute “private/on-device/deleted” copy | Standard observability/secret custody components | Owner authority, effects/receipts, joined control surface, deletion-state proof |

Hermes and OpenClaw can accelerate experiments and teach interface seams, but neither should replace Waldo's owner-governed kernel. Composio/MCP-style providers can accelerate long-tail discovery later, but Google Calendar/Gmail, HealthKit, Trusted Relationships, and the first India transaction corridor are too central to outsource their authority semantics.

## 6. Dependency-ordered build sequence and measurable exits

These exits add experience measures to the plan's existing safety and recovery gates. Thresholds are proposed launch hypotheses; the team must freeze the exact cohort, trial count, environment, and grading rubric before testing and must not weaken zero-critical-failure rules after seeing results.

### Slice 0 — G0: truth before magic

**Build only:** protected app shell, zero-connector conversation entry, account/session/consent epoch, truthful error/loading/empty states, data-path register, joined deletion model, clean Connection surfaces, and removal of fictional success.

**Experience exit**

- Every founder test user reaches a real conversation without a connector.
- Calendar-only consent displays no hidden Gmail/Drive/Contacts enrollment.
- A tester can identify the active owner, connected account, granted capability, last use, and revoke path without consulting a policy.
- Deterministic A→B races across chat, callback, subscription, deep link, queued work, and background upload produce zero cross-owner display/write/upload/delivery.
- Every public privacy/deletion claim maps to an exercised data path or is labelled planned/limited; no absolute claim contradicts a processor, recovery, or backup copy.

**Do not add:** ambient audio, browser, arbitrary skills/MCP, multiple channels, or connector catalog UI.

### Slice 1 — G1: Hello Waldo

**Build only:** real multi-turn streaming conversation, stop/steer, restart recovery, one reviewed voice, Profile Claim lifecycle, and the simple owner surface `Today / Open Loops / Memory / Activity / Connections`.

**Experience exit**

- Median time from sign-in to one useful grounded response is at most two minutes in the predeclared founder flow; p95 and abandonment are reported, not hidden.
- Blinded reviewers meet the predeclared usefulness/personality/controllability floor with zero critical fabricated-intimacy, coercion, or confident invented-personality failure.
- Remember, update, contradiction, correct, forget, and delete fixtures pass repeatedly; every retained claim shows source, status, purpose, and freshness.
- `Stop` prevents later output, durable memory, or effect publication; a newer message visibly steers or queues according to the declared rule.
- Process death at every publication boundary recovers exact bytes or terminates honestly without client retry, duplicate output, or a wedged next turn.

This slice should feel complete enough to use daily even if `Connections` is empty.

### Slice 2 — G2: Today plus Calendar

**Build only:** incremental Calendar OAuth, Calendar-sourced `Today`, free/busy/find slots, exact proposal/approval, owner-only apply, read-back/reconciliation, revoke, and Activity/receipt.

**Experience exit**

- Median connect-to-first-cited-`Today` value is at most five minutes; turns, permissions, correction/abandonment, and p95 are reported.
- In the comprehension check, every accepted pilot participant correctly identifies the account/calendar, exact change, notification behavior, expiry, and what is still unapproved before acting.
- Repeated create/update/delete flows have zero unauthorized, duplicate, overwritten-stale, or falsely completed effects; `pass^k` and trial count are reported.
- Timezone/DST, response loss, duplicate create, external edit/delete/move, ambiguous absence, stale etag, revoke, and account-switch fixtures all pass.
- Disconnect immediately blocks new work, invalidates stale proposals/callbacks, and explains retained non-reconstructive receipts.

### Slice 3 — G4-narrow: follow-through becomes a habit

Do not open all of G4 at once. First join Calendar, Open Loops, APNs, one read-only meeting source, and a deterministic reminder/follow-up engine. Add Gmail metadata/thread read and draft only after that loop is stable; admit immutable exact send last.

**Experience exit**

- A user can turn one successful meeting/calendar task into a one-time follow-up, inspect `why now`, sources, time zone, missing/stale-data behavior, and notification plan before enabling it.
- Every proactive item offers done, snooze, dismiss, incorrect, and dial-down/off; quiet/disabled mode produces zero notifications across repeated DST/travel/duplicate-alarm fixtures.
- The pilot reports the predeclared helpfulness/nuisance thresholds over at least a 7-day run; ignored, snoozed, dismissed, incorrect, too-sensitive, and disabled outcomes are all counted.
- Activity shows proposal, approval, running, waiting, stopped, reconciled, completed, delivery-failed, revoked, and deleted states without requiring chat interpretation.
- Meeting notes are source-cited and bounded; unrelated content does not enter memory.
- When Gmail send is admitted, concurrent draft mutation, recipient/header/body/attachment substitution, revoke, response loss, and retry can produce only the frozen approved message or an honest non-send state.

At this point Waldo should already be meaningfully comparable on the core personal-agent habit even without browser use.

### Slice 4 — G3 and G5: differentiated join

Run Trusted Relationships and the Apple truth lane in parallel only after G2 is stable; join them into personal beta after each independently passes.

**Trusted Relationships exit**

- Two synthetic owners schedule, reschedule, or decline with fewer owner actions than the frozen comparison baseline while exposing no event title, health, inbox, memory, or private decline reason.
- Wrong person, recycled identity, forwarded invite, compromised device, replay, block/report, one-sided revoke/delete, and partial failure preserve the authority boundary and leave inspectable receipts.
- Both participants can explain the purpose, data shared, duration, and revoke path before accepting.

**Health exit**

- Physical-iPhone evidence—not simulator UI alone—covers connected, no accessible data, limited history, stale, consent declined/revoked, account switch, background delivery, and deletion/purge.
- Every surfaced health influence includes source class, freshness, uncertainty, and purpose; zero diagnostic, causal, or treatment claims appear in the approved fixture set.
- Planning remains useful and truthful when health is absent; health data never grants effect authority or enters unrelated memory.

### Slice 5 — G8-narrow and G6: reachability plus India proof

**Channel exit**

- Ship the app and one officially eligible remote channel—not a substitute channel chosen only for implementation ease.
- Cross-surface races produce one canonical ordered history and one effect; stale/recycled identities and late callbacks cannot inherit authority.
- The owner can see and revoke each presence; quoted-instruction, spoofing, bounce/loop, hostile attachment, and deletion fixtures pass.

**India corridor exit**

- One real/sandbox order path reaches a verified order, cancellation/refund status, or explicit user takeover; a price/item/address change always invalidates approval.
- OTP, password, card, and payment secrets never enter Waldo memory, logs, or model context.
- Provider success plus response loss reconciles before retry; no ambiguous run is blindly repeated or reported complete.

Only after one corridor passes should the team choose the next India connector from observed demand.

### Slice 6 — G7: browser as fallback, not identity

**Buy/spike:** one managed browser/VM provider behind `BrowserExecutionPort`, plus a second replaceable candidate if the first fails isolation, observability, region, or unit-cost requirements.

**Experience exit**

- APIs/connectors are preferred and the UI explains when browser fallback is necessary.
- A non-payment use case and one takeover transaction each pass repeated clean-session tests with domain/action allowlists, visible activity, stop, prompt-injection resistance, redaction, budget, cleanup, and source verification.
- Every ambiguous result lands in `needs review` or `indeterminate`, never `done`; no blind retry occurs.
- Failure of the vendor leaves Waldo's canonical commitments, approvals, and receipts intact and allows replacement behind the same port.

## 7. Competitive experience lab

Use the same scenario grammar across Waldo and every available peer, but score only comparable surfaces.

| Scenario | Visible questions | Deterministic evidence |
|---|---|---|
| First session | How quickly does it become personal without overreaching? | time, turns, permissions, abandonment, grounded-source check |
| Memory update | Does “I moved / no longer eat dairy / changed preference” supersede old truth? | later retrieval, visible provenance, correction and delete/non-resurrection |
| Today | Does it recover the day and open loops without inventing urgency? | cited calendar/commitment source and missing-data disclosure |
| Calendar action | Is approval understandable and the result exact? | provider event before/after, notification behavior, retry/revoke result |
| Meeting follow-up | Can notes become a bounded draft/reminder? | cited note span, intended recipient/content, no unrelated retention |
| Proactive reminder | Was it timely, useful, sensitive, and easy to quiet? | why-now source, feedback action, notification history, quiet-state proof |
| Stop and steer | Can the user regain control during work? | no late output/effect/memory; visible terminal state |
| Failure and recovery | Does timeout/restart/revoke produce a truthful next step? | activity history, no duplicate, source-of-record reconciliation |
| Connection control | Does the owner understand scope and revoke consequences? | actual provider grant and post-revoke denial |
| Delete/export | Does control cover all identities/copies? | active deletion, provider-pending, backup expiry, non-resurrection |
| Relationship | Is cross-user help minimal and consensual? | independent approvals, disclosed fields, private decline, revoke/block |
| Browser/takeover | Is risky work visible and bounded? | session trace, domain/action limit, takeover, cleanup, final source state |

For each run, freeze the prompt/task, initial data, allowed capabilities, expected approvals, fault schedule, source of record, severe-failure rule, and reviewer rubric. Report task success, `pass^k`, p50/p95 time and interaction count, permission friction, unnecessary approvals, memory precision/abstention, false completion, duplicate effect, proactivity usefulness/nuisance, and user-rated personality/control. Preserve failures; do not report only the best demonstration.

Zero-tolerance failures remain:

- unauthorized external effect or sensitive disclosure;
- cross-owner/account/relationship leakage;
- fictional or unverified completion;
- changed content after approval;
- deleted or corrected memory resurrection;
- notification during deterministic quiet/disabled state;
- private non-user data entering unrelated memory; or
- product/privacy copy contradicted by the observed data path.

Waldo may claim only **tested-scope parity** with a named, dated peer/version for scenarios actually run. Public source material informs the target but cannot prove parity. A peer's weaker control never lowers Waldo's safety floor.

## 8. What not to build yet

The first competitive Waldo does not need:

- ambient listening or emotional-trend inference;
- a second memory ontology or graph product;
- all-at-once Google or broad SaaS authorization;
- a credential/card/TOTP vault;
- an in-house browser/computer runtime;
- arbitrary MCP endpoints or a public skill marketplace;
- a multi-agent fleet or work graph;
- voice I/O as a launch blocker;
- broad watchOS features before the phone/HealthKit corridor is real;
- many India connector logos; or
- self-hosting as the default consumer onboarding experience.

Deferring these is not a capability retreat. It protects the one sequence every peer teaches in a different way: **first make the agent useful, then make it persistent, then let it act, then let it act in the background, and only then increase reach and power**.

## 9. Final product call

Waldo should aim to feel as easy as Poke or Instinct, as legible during action as Muse or Grok Bot, as continuous as Moonshot, and as owner-controlled as the best parts of Hermes/OpenClaw—without copying their trust compromises or operating burden.

The decisive founder-alpha experience is not “Waldo has browser use.” It is:

1. Waldo greets the owner as the same recognizable agent.
2. It remembers one useful fact and one commitment correctly.
3. `Today` shows the day and open loops with sources.
4. It proposes and completes one Calendar change exactly.
5. It follows up later for a reason the owner understands.
6. Activity shows what happened and Stop/correct/revoke/delete actually work.

After that loop is reliable, Trusted Relationships, physical-device health context, one remote channel, and one India action corridor can make Waldo clearly different rather than merely caught up. Browser/computer use then becomes replaceable execution infrastructure, not the product's identity.

## Primary first-party sources

### Moonshot Computer

- [Moonshot product](https://moonshot.computer/)
- [Moonshot privacy policy](https://moonshot.computer/privacy), last updated 2026-09-14
- [About Moonshot](https://moonshot.computer/about)

### Instinct

- [Instinct product](https://instinct.com/)
- [Instinct privacy policy](https://instinct.com/privacy-policy), revised 2026-08-26
- [Instinct terms](https://instinct.com/terms), revised 2026-08-26

### Poke

- [Poke product](https://poke.com/)
- [Poke documentation](https://poke.com/docs)
- [Managing integrations](https://poke.com/docs/managing-integrations)
- [Usage and resets](https://poke.com/docs/usage-and-resets)
- [Poke privacy policy](https://poke.com/privacy), updated 2026-09-11
- [Poke terms](https://poke.com/terms), modified 2026-03-17

### Meta Muse

- [Introducing Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/)
- [How Meta designed Muse](https://introducing.muse.ai/)
- [Security and safety for Muse](https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse)

### Grok Bot

- [Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- [Chat and collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [Computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [Skills, routines, and automations](https://docs.x.ai/grok-bot/skills-routines-and-automations)

### Hermes Agent

- [Hermes documentation](https://hermes-agent.nousresearch.com/docs/)
- [Quickstart](https://hermes-agent.nousresearch.com/docs/getting-started/quickstart)
- [Nous Portal integration](https://hermes-agent.nousresearch.com/docs/integrations/nous-portal)
- [Messaging](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/)
- [Which file does what](https://hermes-agent.nousresearch.com/docs/user-guide/which-file-does-what)
- [Memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory)
- [Personality](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality)
- [Security](https://hermes-agent.nousresearch.com/docs/user-guide/security)
- [Computer use](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use)
- [Checkpoints and rollback](https://hermes-agent.nousresearch.com/docs/user-guide/checkpoints-and-rollback)

### OpenClaw

- [OpenClaw product](https://openclaw.ai/)
- [OpenClaw documentation](https://docs.openclaw.ai/)
- [Getting started](https://docs.openclaw.ai/start/getting-started)
- [Onboarding overview](https://docs.openclaw.ai/start/onboarding-overview)
- [Why OpenClaw](https://docs.openclaw.ai/start/why-openclaw)
- [Trust boundary](https://docs.openclaw.ai/start/why-openclaw/the-trust-boundary)
- [Automation](https://docs.openclaw.ai/automation)
- [Heartbeat](https://docs.openclaw.ai/heartbeat)
- [Schedules](https://docs.openclaw.ai/automation/cron-jobs/schedules)
- [Agent runtime](https://docs.openclaw.ai/concepts/agent)
- [Memory](https://docs.openclaw.ai/concepts/memory)
- [Dreaming](https://docs.openclaw.ai/concepts/dreaming)
- [Memory CLI](https://docs.openclaw.ai/cli/memory)
- [Gateway security](https://docs.openclaw.ai/gateway/security)
- [Browser](https://docs.openclaw.ai/tools/browser)
- [Browser-control risk](https://docs.openclaw.ai/gateway/security/browser-control)
- [Computer use](https://docs.openclaw.ai/nodes/computer-use)
- [Skills](https://docs.openclaw.ai/tools/skills)

## Retrieval and confidence limits

- No authenticated competitor account was used in this research pass. Owner-supplied Instinct screenshots were treated as dated visible-surface observations only.
- No competitor runtime, reliability, latency, battery use, accessibility, action correctness, deletion behavior, or security claim was independently tested.
- First-party legal/privacy pages establish vendor statements and disclosed limitations, not independent compliance or security proof.
- First-party product/docs pages establish intended/documented behavior, not universal availability or measured quality.
- Hermes and OpenClaw were reviewed from first-party documentation/public material; no local install or source-level security audit was performed here.
- Product pages and policies can change. Every black-box result must pin the tested date, product/version, account tier, region, and permission state.
- “Unknown” and “not established” are deliberate evidence labels, not claims that a capability is absent.
