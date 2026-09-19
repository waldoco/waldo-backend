# Waldo Personal Agent — Product Architecture and Build Plan

**Status:** proposed canonical backend roadmap; review before merge

**Updated:** 2026-09-19

**Backend baseline:** `origin/main@e91bee017b0c36759cbfda1353fc11c73e3afe0a`

**App baseline:** `origin/main@7218c18fed8b874492e3831bbb5bd1e1c58abe58`

**Current cross-repository scope authority requiring G0 amendment:** [Waldo Personal Agent — Reconciled Launch Contract](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md)

**Research/review record:** [Waldo Brain PR #31](https://github.com/Pin4sf/waldo-brain/pull/31) at `43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7`; it reviews the prior PR #138 head `db659aec4d9d98aca041d170ae37af6393a45edd` and remains evidence rather than roadmap or architecture authority.

**Live work/evidence:** the owning GitHub issue or PR and [ledger #116](https://github.com/Pin4sf/waldo-backend/issues/116)

This is the implementation plan for getting a real Waldo personal agent running as quickly as possible without discarding the trustworthy kernel already built. Before merge, it is a candidate roadmap. Once reviewed and merged, it replaces the August backend plans and B0–B6 sequencing for roadmap, dependency order, and documentation cleanup. It does not silently override the pinned Brain launch contract or an accepted Brain ADR: a conflicting product-scope seam remains non-authoritative until the launch contract is amended, a conflicting architecture seam remains non-authoritative until the named ADR disposition is published, and the plan/entrypoints plus `accepted-adrs.json` are repinned/regenerated from that Brain revision. Unaffected seams follow this plan. The older backend documents remain available at the pinned baseline in Git history.

It is not evidence that Waldo is deployed, competitive parity has been reached, Apple signing is configured, WhatsApp eligibility exists, or any named vendor is integrated.

## 1. Executive decision

**[Decision] Build a thin, outcome-complete personal agent before expanding the work-agent platform.**

Waldo's launch product is one recognizable, user-governed agent that:

1. has a stable personality and correctable memory;
2. understands Gmail, Calendar, selected Drive content, meetings, and permitted health context;
3. can propose and safely complete bounded actions with receipts;
4. follows up on commitments without invented urgency or fabricated success;
5. works first in the Waldo app, then through an officially eligible remote channel;
6. can coordinate with another Waldo without either agent gaining the other's authority; and
7. becomes unusually useful in India through first-class local service connectors.

Keep the per-owner authority root, `WaldoCoordinator`, trusted RunLoop, ContextComposer, Judgment Authority, scheduling, source sanitization, intent-before-I/O, reconciliation, and evidence/acceptance separation. Do not build another agent framework beside them.

Build now:

- one production conversation path;
- a compact Profile Claim and memory lifecycle;
- one production primary route plus the accepted reasoning/fallback ladder, revalidated by eval;
- Google Calendar and Gmail as the first real connector corridor;
- restrained proactivity and notifications;
- Trusted Relationships/Waldo-to-Waldo scheduling;
- purpose-bound HealthKit-derived context;
- Granola meeting context;
- one India transaction corridor, starting with Swiggy;
- a managed browser fallback behind a Waldo-owned policy port.

Freeze from the personal-agent critical path:

- broad work-agent orchestration and Mission graph UI;
- Kennel workspace portability and cloud checkpoints;
- adding model/provider breadth beyond the accepted routing ladder before eval evidence requires it;
- generic self-authored skills, dreaming, patrol, and autonomous self-modification;
- a password/card/TOTP vault;
- an in-house browser or computer-use stack;
- Telegram/Discord as launch requirements;
- broad work-SaaS parity; and
- watchOS feature breadth before the iPhone corridor works.

## 2. Evidence contract and current truth

Claims in this document use these labels:

- **[Observed]** source, tests, product screenshots, or first-party material inspected at the stated pin/date;
- **[Inference]** the most likely interpretation of observed evidence;
- **[Decision]** the chosen build direction;
- **[Proposed]** a design that still requires a bounded contract, ADR, or implementation review;
- **[Blocked]** work that cannot honestly pass its gate without an external decision, permission, or environment.

Proof levels stay independent:

```text
architecture_specified
contract_defined
module_implemented
adapter_conformance_passed
cross_surface_acceptance_passed
operational_proof_passed
```

A schema, mock, local test, connector icon, provider response, or agent statement cannot imply the next level.

### 2.1 Backend baseline verified on 2026-09-18

**[Observed]** Fresh `origin/main` was fetched and remained `e91bee0`.

**[Observed]** Baseline checks in an isolated worktree:

| Check | Result |
|---|---|
| Contracts | 74 files, 1,584 tests passed |
| Runtime | 43 files, 1,152 tests passed |
| Workspace typecheck | passed |
| Static guards | passed |
| Supabase/full `verify` | not run in this documentation pass |
| Live connectors, staging, deployment | not run / no proof |

The first runtime attempt failed because the sandbox could not bind localhost or write Wrangler logs. The identical command passed outside that sandbox; this was an environment restriction, not a green result obtained by changing tests.

**[Observed] Implemented kernel:**

- authenticated, owner-routed responsibility ingress and projections;
- capture/planning contracts and durable owner state;
- a generalized execution writer and start-only WorkUnit bridge;
- public Judgment answer/projection routes and `JudgmentAuthorityModule`;
- journal/outbox, leases/fences, alarms, safety hooks, Scribe sanitization, and ContextComposer foundations;
- closure v0.6 schemas, fixtures, OpenAPI, and contract tests.

**[Observed] Not yet a working personal agent:**

- the public planning turn is intentionally zero-tool and zero-effect;
- the WorkUnit bridge is start-only and uses a deterministic fake execution environment in local proof;
- production gateway mode lacks a live delivery sink, spend source, and production context source and therefore fails closed;
- Calendar, Email, Health, document, sheet, and channel surfaces are contracts or fakes, not production connector implementations;
- closure v0.6 has no public runtime reducer/route on main even though generated OpenAPI advertises the paths; the Worker currently returns 404 for them;
- the current identity module permits only one registered Presence per owner, so app + email + WhatsApp requires an additive governed multi-presence model;
- no production conversation writer/orchestrator owns durable chat;
- no Waldo-to-Waldo protocol is implemented;
- no staging or production deployment is proved.

### 2.2 Mobile/Apple baseline verified on 2026-09-18

**[Observed]** The active `waldo-app` checkout is dirty and 67 commits behind its fetched `origin/main`; do not build in that checkout. Use a clean worktree at `7218c18f` or later.

**[Observed]** The current remote baseline contains an Expo 54/React Native 0.81 app, an Expo HealthKit module, SQLCipher-backed local storage, and iPhone/watchOS targets. It does not yet contain a functioning WatchConnectivity path, App Intents, HealthKit background observer/anchored queries, native tests, or a production agent connection.

**[Observed] Release blockers in app source:**

- onboarding says health data does not leave the phone while health sync defaults on and calls a server function;
- HealthKit permissions are broad rather than purpose-incremental;
- known Waldo consent, no accessible samples/limited history, stale data, and query failure are conflated; HealthKit read denial itself is intentionally not observable;
- local encrypted health storage is not partitioned and purged by account/consent epoch;
- chat fabricates a successful calendar move when the backend fails;
- watch state is explicitly mock data;
- the app still has direct legacy Supabase/server paths and handwritten DTOs.

**[Observed]** Xcode 27.0, iOS/watchOS 26.5 and 27.0 simulators, and paired simulator devices are installed. `security find-identity -p codesigning` reported zero valid signing identities. The Apple developer account is available per the owner, but physical-device/TestFlight signing is not yet locally proved.

### 2.3 Brain authority disposition and implementation stop gate

The owner has explicitly authorized changing or retiring ADRs that obstruct the first-principles build. That is not permission to leave two live authorities. The pinned Brain launch contract currently declares itself the single launch/milestone authority, requires WhatsApp for the complete release, and owns M0–M8; this plan instead permits an app+email release candidate while official India WhatsApp eligibility remains blocked and replaces that milestone order. Publish an amended/superseding Brain launch contract that preserves its durable product/privacy constraints but adopts this release-cut/channel gate before treating those conflicting scope choices as live.

This plan also selects the ADR dispositions below. The corresponding Brain change must mark each superseded/amended decision, and the backend snapshot must then be regenerated. The snapshot was stale at the start of this review and omitted ADR-0078 through ADR-0083; this pass resynced those source-derived entries from the pinned Brain revision, while final supersession statuses still depend on publishing the Brain change.

| Accepted ADR | Disposition for this plan | Implementation consequence |
|---|---|---|
| ADR-0069 — model roster and routing | **Supersede the dated roster pins; retain the policy invariants.** Model IDs/prices from June are configuration evidence, not durable architecture. Keep one default route, a bounded reasoning/fallback ladder, spend ceilings, provider-shaped rendering, and the shadow-eval ritual. | G0 runs the current model eval and publishes the chosen pins/config digest. A model swap with an unchanged contract becomes a config+eval change, not a new product architecture. |
| ADR-0071 — V1 scope cut | **Supersede as launch authority.** Its Brief + shadow-Fetch + Spots + Chat milestone and broad Copilot-write commitment no longer match the owner-directed personal-agent release cuts. Preserve useful capability contracts as backlog evidence only. | This plan's founder alpha/personal beta/India beta cuts become the sole live scope after the Brain change; old milestone labels cannot re-import deferred surfaces. |
| ADR-0073 — compliance regime | **Retain and apply before external beta.** GDPR-baseline engineering and India DPDP-aware controls remain the privacy floor even if beta geography changes. | Before any non-founder user: enforce age/eligibility and geo policy; per-source/purpose consent; DPIA and processor/DPA inventory; truthful privacy copy; export/deletion exercise; incident/breach plan; and documented launch-region decision. |
| ADR-0075 — connector OAuth custody | **Amend the execution boundary; retain Vault custody.** Google refresh does not mint a reliably single-operation token, and Gmail `gmail.compose` authorizes both draft management and sending. Supabase Vault remains the only refresh-token/client-secret custodian, but a trusted connector Edge Function/proxy executes typed allowlisted provider operations and never hands a bearer token to the DO. | The agent's per-turn capability and approval gate remains authoritative even when provider scopes are broader. Remove the managed-broker proposal and ADR-0075's false “one-operation token” security claim. Google verification remains an external gate. |
| ADR-0077 — conversation graph, run state, and replay | **Amend for staged delivery.** Retain Supabase ownership of the visible graph/messages, DO ownership of runs/outbox/schedules/stream cursors, device-cache status, and the evidence-gated transport spike. Defer the R2 replay/export projection from founder alpha until export/reconstruction evidence justifies its operating cost. | G1 has two required durable planes, not three: canonical conversation rows in Supabase and execution truth in the DO. R2 cannot become a launch blocker or a second transcript; add it before the release that advertises replay/export. |
| ADR-0081 — health computation authority | **Retain.** Canonical derived health/Form computation remains deterministic and backend-owned with the accepted destination/retention matrix. | The app only ingests/caches or shows a labelled fallback estimate; the DO/model receives a purpose-filtered projection, never raw arrays or a competing canonical score. |
| ADR-0082 — device cache lifecycle | **Retain.** Per-account and per-consent-epoch SQLCipher files/keys, fail-closed purge, backup exclusion, and account-switch/restore/device proof remain mandatory. | G5 cannot pass on UI/simulator evidence alone; physical-device restore, account-switch, consent-epoch, background, and purge tests are required. |
| ADR-0083 — mutable skill admission | **Retain but defer from the critical path.** Its one-Scribe read-admission, trusted reconstruction, and route-bound prompt-budget rules remain binding if mutable skills re-enter. | G1 uses reviewed static voice/policy material; it does not quietly introduce mutable or self-authored skill bodies. |

**Publication gate:** land the amended/superseding Brain launch contract, the ADR supersession/amendment packet, and the regenerated snapshot; then repin this plan and every entrypoint to that Brain revision before merging dependent implementation. Historical ADR files may remain with explicit `superseded_by`/amendment banners; deleting them is unnecessary because Git/history has value, but they leave the active read path. Duplicate or never-adopted ADR prose may be removed once inbound references are clean. A green test cannot resolve two contradictory live authorities.

### 2.4 Additional accepted-ADR conflict inventory

The following accepted decisions would otherwise silently re-import the old product. Publish these dispositions in the same Brain packet; this is an authority cleanup, not permission to delete the useful invariants inside an ADR.

| ADRs | Disposition | Durable part kept / obsolete part removed |
|---|---|---|
| ADR-0005, ADR-0006, ADR-0031, ADR-0046 — memory halls, nightly Scribe, recall, trust | **Supersede 0005 and 0031; amend 0006; retain/amend 0046.** | Replace five launch “halls” plus recall-all-every-turn with compact Profile Claims, Episodes, Commitments/Open Loops, and Relationship records plus purpose-scoped retrieval. Keep candidate/admission rather than direct model writes, provenance, bi-temporal correction/supersedence, and external-truth priority. Explicit user remember/correct/delete can settle synchronously through the admission seam; nightly consolidation is optional, not the only writer. Required context fails honestly when missing rather than universal fail-open recall. |
| ADR-0008, ADR-0034 — static trigger ACL and lazy discovery | **Amend.** | Static trigger ACL remains an outer ceiling. A digest-bound per-turn manifest is the inner ceiling and is rechecked at dispatch. Compression remains. Lazy discovery may describe capabilities inside the outer ceiling but cannot add an executable operation to the frozen turn; execution requires a newly admitted manifest. |
| ADR-0012, ADR-0067 — Telegram-first launch/binding | **Supersede as launch authority.** | App first, inbound email next, WhatsApp only after official provider admission. Preserve verified webhook/identity-binding lessons in the provider-neutral multi-presence contract; Telegram becomes an optional future adapter, not a launch substitute. |
| ADR-0017, ADR-0020 — Patrol/intervention cadence | **Supersede for personal-agent launch.** | Keep alarm/scheduler infrastructure. Remove generic 15-minute patrol and inferred composite interventions from launch. Proactivity is tied to explicit commitments, calendar/mail/meeting changes, or user-configured bounded rules with quiet hours, expiry, visible reason, and cancellation. |
| ADR-0021, ADR-0049 — broad Copilot/general MCP tools in V1 | **Supersede the V1 breadth; amend retained tools.** | Keep typed schemas only where they help compatibility. Launch admits public web research and selected-document reads through the per-turn manifest. Generic MCP, code execution, broad document/sheet writes, and self-expanding tools remain disabled until a measured use case, data policy, adapter contract, and eval gate exist. |
| ADR-0027 — draft-only email | **Amend.** | Preserve bounded draft creation, MIME/Scribe controls, and no ambient/automatic send. Add a distinct exact-draft send effect only after fresh approval at the irreversible edge, typed proxy enforcement, digest/recipient binding, read-back, and restricted-scope compliance. |
| ADR-0041 — Phase-1 voice memo | **Supersede as launch scope.** | “Voice pack” means personality/writing style, not audio I/O. Voice memo ingestion is deferred until the core app corridor is stable and a separate audio privacy/retention/input contract earns re-entry. |
| ADR-0007 — fixed R2/pgvector episode archive | **Supersede the fixed storage/90-day rule.** | Episodes use the plan's protected canonical store plus rebuildable search projection. Retention follows purpose/data class, consent, export/deletion and measured scale; R2 is introduced only for an admitted artifact/replay need, never because an episode crossed an arbitrary age. |
| ADR-0010, ADR-0014 — HealthKit background “stress detection” and health thread injection | **Amend.** | Keep consented anchored/observer ingestion and durable anchors. Remove the 24/7 stress-detection claim and ambient health-triggered thread injection. Background delivery updates source freshness; health affects a plan or bounded user-configured rule only through ADR-0081 destination policy, quiet hours, expiry, and visible reason. |
| ADR-0015, ADR-0042, ADR-0072 — Brief/Spot/Fetch loops | **Supersede as launch pillars.** | Their types may remain for compatibility and the shadow-before-promotion discipline remains useful. They are not launch loops. Meeting preparation and follow-up re-enter through explicit Calendar/meeting commitments; no old Brief/Spot/Fetch milestone or trigger can widen current scope. |
| ADR-0018, ADR-0019 — generic autonomy levels and Form-driven windows | **Amend/supersede.** | Replace generic L3 “auto + audit” with capability/resource/parameter/time/budget grants checked at dispatch and resume. Health/Form may shape a proposal but never creates effect authority. Any standing auto-effect requires its own typed grant, risk ceiling, expiry, cancellation, reconciliation, and acceptance proof. |
| ADR-0035 — channel persona/memory slicing | **Amend.** | Keep one Waldo identity and channel-appropriate rendering. Remove “full memory” for any channel and launch assumptions for Telegram/Slack/Discord. Every presence receives the minimum purpose- and destination-admitted context; sensitive health/mail/relationship content never rides a channel merely because it is connected. |
| ADR-0037, ADR-0039 — append-only log and soft-delete/thread breadth | **Amend.** | Keep non-repudiable bounded event metadata and persistent thread identity where useful. Delete/crypto-shred reconstructive payloads and derived projections under account/consent deletion; retain only lawful non-reconstructive tombstones. Soft delete is at most an explicit recovery window followed by purge. Branching/deep UI is not a founder-alpha requirement. Retire deterministic sensitive-content-derived pattern IDs. |
| ADR-0070 — engagement/keep-rate | **Supersede as an optimization authority.** | Keep privacy-safe delivery/service-quality telemetry only. Never optimize unsolicited messages, relationship pressure, health nudges, or notification volume for engagement. Proactivity is evaluated on requested-task usefulness, correctness, controllability, mute/cancel behavior, and harm—not retention maximization. |

Accepted ADRs not named in sections 2.3–2.4 remain binding for their seam. If implementation uncovers another contradiction, stop that seam and add an explicit retain/amend/supersede decision rather than interpreting silence as permission.

### 2.5 Brain PR #31 review integration

Brain PR #31 is the durable research and independent-review record; it is not a competing build plan and does not itself amend an accepted ADR. Its review targeted backend PR #138 at `db659aec4d9d98aca041d170ae37af6393a45edd` and was summarized in the [owner COMMENT review](https://github.com/Pin4sf/waldo-backend/pull/138#pullrequestreview-5249943509). This revision accepts the following findings, incorporates the blocking corrections in the plan, and leaves the Brain record immutable as evidence of what was reviewed.

| Finding | Assessment | Plan disposition | Acceptance gate |
|---|---|---|---|
| R1 — crash can lose exact conversation bytes | **Correct, P1.** A digest and reserved ordering cannot reconstruct uncommitted user bytes or a nondeterministic assistant response. | Stage the exact admitted input/output in the canonical Supabase content lifecycle before durable acknowledgement or recoverable publication intent; keep staged rows hidden, owner-bound, expiring, and deletion-generation aware. This is not a second transcript. | G1 proves no-client-retry recovery at every staging/reservation/commit boundary, changed-byte rejection, orphan cleanup, cancellation/deletion, and next-turn liveness. |
| R2 — mutable Gmail draft can change after final read | **Correct, P1.** Waldo cannot lock a Gmail draft against another client between `drafts.get` and `drafts.send`. | Freeze the exact approved RFC 5322/MIME message snapshot and send that immutable snapshot through `users.messages.send`; do not send a mutable provider draft by ID. Preserve the provider draft and any concurrent edits unless a separate visible cleanup operation is authorized. | G4 races recipient/body/header/attachment/thread changes after approval, provider revoke, timeout, success-with-response-loss, and duplicate suppression. |
| R3 — account-isolation proof arrives too late | **Correct as a gate-order defect, P1.** It does not by itself prove a production leak. | Move the minimum account-isolation floor into G0 and make it a prerequisite for every real G1/G2 path: account-and-generation-bound local/query/cache state, cancellation on logout/switch, stale callback/subscription rejection, and disabled legacy health upload until explicit cloud consent. | G0/G1/G2 race A→B during chat, provider callback, deep link, subscription delivery, queued work, and background upload; assert zero cross-account display, write, or upload. Full physical HealthKit proof remains G5. |
| R4 — one provider identity cannot be made globally unique by independent owner DOs | **Correct, P2.** | Add a protected global claim registry that reserves/activates/revokes `(provider namespace, provider subject)` while each owner DO remains the permission authority. | Required before G8 activates a second presence; prove concurrent claims, partial failure, expiry, revoke/relink, and recycled-number step-up. |
| R5 — Calendar ambiguity needs provider concurrency primitives | **Correct, P2.** | Persist a client-chosen event ID before create; reconcile that ID after timeout. Bind `If-Match` to update/delete; a `412` creates a fresh proposal rather than overwrite. | G2 tests response loss, duplicate create, external edit/delete/move, stale etag, and ambiguous absence. |
| R6 — schedules, reviewed procedures, and continuous responsibility were conflated | **Correct, P2.** | Separate worker liveness, proactive assessment, and scheduled responsibility. Admit reviewed static procedures only with source/license/version/digest, compatibility, activation/revocation, and resume checks; file format never grants authority. | G1 covers static-procedure admission if used; G4 proves occurrence identity, timezone/DST, overlap, lateness/misfire, pause/resume/cancel, duplicate alarm, lost wake, and bounded recovery. |
| R7 — the plan conflated two products named Folk | **Correct, P2.** | Track `folk Personal AI` separately from `folk CRM Assistant`; do not transfer claims between them. | Market/eval fixtures use the correct product identity and only first-party supported claims. |

The review also sharpens three cross-cutting rules: a long-running agent is a durable responsibility state machine, not continuous model thought; engineering improvement is separate from production execution and cannot self-authorize policy/tool changes; and files such as soul, memory, or skill documents are authoring/projection/procedure interfaces rather than schedulers, credentials, permissions, or canonical state.

The backend now preserves an independent [source-by-source evaluation of all S01–S32 links and A01–A18 adoption records](../research/WALDO_BRAIN_PR31_SOURCE_AUDIT_2026-09-18.md). It classifies official contracts, empirical preprints, builder reports, practitioner guidance, marketing, and internal synthesis separately; records the partial Hermes-cron retrieval limitation; and distinguishes direct evidence from Waldo policy inference. The audit is supporting evidence, not a second roadmap.

## 3. First-principles hypotheses and falsifiers

The plan is driven by hypotheses that can fail, not competitor imitation.

| Hypothesis | Why it matters | Falsifier | Action threshold |
|---|---|---|---|
| H1: repeated usefulness comes from a closed loop, not connector count | Icons do not create trust; completed and remembered outcomes do | users cannot complete common Calendar/Gmail tasks more reliably than with a normal chatbot | stop connector expansion and repair the turn/effect/receipt loop |
| H2: Google Workspace is the highest-leverage initial context/action source | email and calendar reveal commitments and enable useful low-risk actions | an app-only cohort rarely connects or uses Google after onboarding | reconsider onboarding and choose the highest-used source, not broader OAuth |
| H3: correctable memory plus personality creates relationship continuity | a personal agent must feel like the same agent without inventing facts | memory-enabled evals do not beat a no-memory baseline or corrections reappear incorrectly | simplify memory and block inferred writes until precision improves |
| H4: HealthKit-derived constraints differentiate Waldo | health can make daily planning unusually personal | physical-device data is too sparse/noisy or users do not value health-aware changes | keep health optional and shift it after the core assistant loop |
| H5: Trusted Relationships create a defensible network capability | coordinating two agents can remove real back-and-forth | two-user scheduling is slower or less trusted than sharing a normal calendar link | keep invitations but stop further cross-user expansion |
| H6: managed browser execution is faster and safer than building a browser | Waldo's advantage is policy/context, not browser infrastructure | vendor isolation, observability, reconciliation, or unit cost cannot pass the test matrix | keep APIs and user takeover; do not ship browser writes |
| H7: India-specific connectors improve distribution and retention | global agents underserve local commerce/services | Swiggy or equivalent usage is rare after the novelty period | retain the adapter seam but stop local connector breadth |

The architectural spike falsifier is simple: an authenticated app message must produce a real model response and a read-only Google Calendar query through the existing owner boundary without a second authority store. If that cannot be implemented without unrelated legacy machinery, create a thin personal-agent composition root that reuses the existing identity, policy, scheduler, effect, and receipt components. Do not rewrite the trust kernel.

## 4. Market reality and Waldo's competitive target

### 4.1 What is happening

**[Observed]** The current category is converging around six user-visible capabilities:

1. a stable relationship/personality rather than a blank chat;
2. persistent context from email, calendar, files, meetings, and memory;
3. contact through messaging, app, email, or desktop;
4. background follow-up and long-running work;
5. API actions plus isolated browser/computer fallback; and
6. explicit trust surfaces: permissions, receipts, vaults, sandboxes, or trusted people.

Instinct's supplied dashboard shows Google Workspace, Outlook, Linear, Notion, GitHub, Slack, and Granola; contact through Messages, WhatsApp, and a dedicated email; Trusted People; external-data deletion; and a vault for logins, cards, personal information, and agent-held items. Its Google consent screen requests broad Drive, Contacts, Slides, Docs, Sheets, Calendar, Gmail, and Tasks access.

Poke emphasizes low-friction messaging, recipes, and MCP connectivity. Two distinct products named Folk must not be conflated: `folk Personal AI` presents a relationship-like personal agent across messaging surfaces, while `folk CRM Assistant` grounds workflows in CRM context. Moonshot Computer is a particularly relevant early-stage peer: its first-party material describes an early-access iPhone agent built around ambient transcription, a persistent `Mind`, ledger/morning history, reminders and standing orders, HealthKit sleep, Apple context, and one managed Google connection. Meta Muse emphasizes background work, a secure VM/browser, app/WhatsApp access, connectors, and a security monitor. Grok Bot brings an agent into collaborative chat. Hermes and OpenClaw show the appeal of open, extensible runtimes, persistent context, skills, and local/computer execution.

### 4.2 Capability comparison

This is a public-evidence comparison, not a benchmark or reverse-engineering claim. “Not established” means the checked first-party source did not document it; it does not prove the feature is absent. Owner-supplied Instinct screenshots are evidence of the displayed product surface, not its internal architecture or reliability.

| Product | Presence | Personalization / memory | Connectors and actions | Background / browser / computer |
|---|---|---|---|---|
| [Instinct](https://instinct.com/) | text/call; supplied dashboard shows Messages, WhatsApp, and dedicated email | site claims a model for personal nuance; dashboard exposes personal info and agent items | dashboard shows Google Workspace, Outlook, Linear, Notion, GitHub, Slack, Granola; founder posts show agent email and concierge calls | site claims proactive follow-up and phone/computer use; isolation, receipts, and execution architecture are not public |
| [Poke](https://poke.com/docs) | Apple Messages, Telegram, WhatsApp, RCS | durable personal memory/personality is not established by the checked overview | email, Calendar, reminders, web search, integrations | reminders are documented; a general persistent computer/browser architecture is not established |
| [Moonshot Computer](https://moonshot.computer/) | early-access iPhone app; push and a separately linked iMessage/web conversation are described | ambient transcript-derived `Mind`, ledger, morning history, standing orders, call records, per-fact correct/forget | iOS permissions; reminders, WeatherKit, read-only HealthKit sleep; one Composio Google grant for Gmail, Calendar, Drive metadata and Contacts | ambient assessment and three-times-daily permanent-Mind study are described; no general browser/computer runtime is established |
| [folk Personal AI](https://www.folk.com/) | iMessage, Telegram, WhatsApp, and Discord | presents itself as a friend that remembers conversations and checks in | reminders plus read-only Plaid-backed money context are publicly described | folk drafts and the user sends; public material does not establish autonomous money movement or a general browser/computer runtime |
| [folk CRM Assistant](https://help.folk.app/en/articles/12460796-introducing-assistant) | built into the folk relationship/CRM workspace | recaps use notes and interactions around people, companies, and deals | finds follow-ups, researches companies, sends trigger-defined emails | assistants are described as always-on and trigger-driven; no general computer-use claim |
| [Meta Muse](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) | Muse app, WhatsApp, iOS/Android/web; glasses planned | learns from conversations, remembers details, accepts “forget” requests | connected apps, email, travel, forms, negotiation, protected payment and credential paths | dedicated Secure VM/browser, Sentinel review, long-running work, app-close continuation, approvals and audit trail |
| [Grok Bot](https://docs.x.ai/grok-bot/overview) | desktop/mobile direct chats and multi-Bot groups | Bot history, preference corrections, reusable skills and scheduled/event routines | Marketplace connectors, browser, CLI, files, secure takeover, optional local-computer execution | persistent cloud computer and background routines; Bots on one account share cookies, files, and CLI credentials |
| [Hermes Agent](https://hermes-agent.nousresearch.com/docs/) | CLI/desktop plus 20+ messaging platforms | agent-curated cross-session memory, user modeling, `SOUL.md`, self-created/improved skills | 60+ tools, web/browser, MCP, portable skills | local/VPS/container/serverless terminals, cron, Bot teams, isolated subagents |
| [OpenClaw](https://docs.openclaw.ai/) | self-hosted gateway across major chat apps plus web/macOS/mobile nodes | sessions, memory, skills, per-agent/workspace/sender routing | tools, plugins, cron, hooks, webhooks, device actions | always-available self-hosted gateway; model/provider and execution remain operator-managed |

| Product | Cross-user / multi-agent | Extensibility | Important public unknowns | Waldo should adopt / defer |
|---|---|---|---|---|
| Instinct | founder-announced Trusted Person network and Instinct-to-Instinct coordination | no public builder/API contract found | retention, model/provider stack, browser isolation, approval/recovery semantics, measured reliability | adopt effortless contact, proactive completion, and trusted coordination; defer broad scopes and a credential/TOTP vault |
| Poke | no owner-to-owner agent protocol found in checked docs | recipes, MCP servers, and API docs | memory/correction model, connector effect controls, background recovery | adopt messaging ergonomics and reusable recipes behind Waldo policy; do not chase all channels before app truth |
| Moonshot Computer | no owner-to-owner agent protocol established; ambient capture can include people who never installed it | no general public plugin contract; Google actions run through a named managed-tool set | real-world usefulness and reliability; accuracy of inferred `Mind`; bystander consent; full deletion horizon during storage migration; provider retention; broad bundled Google scope | adopt its concrete data-flow disclosure, per-fact correction, visible deletion result, quiet-state signal, morning brief, ledger and standing-order UX; reject ambient listening or bundled Google access as Waldo launch defaults |
| folk Personal AI | no owner-to-owner agent protocol is established by the checked source | no general public plugin contract established | memory correction/export/deletion, action recovery, and messaging-platform data handling | adopt low-friction relational conversation, explicit reminders, and user-finalized sends; retain Waldo's governed memory and effect boundary |
| folk CRM Assistant | shared CRM context is not an owner-to-owner personal-agent protocol | source establishes assistants/workflows, not a general public plugin runtime | portability outside folk, personal memory controls, general action recovery | adopt relationship-grounded retrieval and follow-up signals; use as a connector, not Waldo's brain |
| Meta Muse | no public owner-to-owner agent protocol in the launch source | controlled connector ecosystem; no general public plugin contract established | real-world reliability, retention detail, connector catalog/regions; Confidential VM is future-tense | adopt secret brokerage, isolated execution, visible audit and approval patterns; buy computer infrastructure behind Waldo's port |
| Grok Bot | Bot-to-Bot groups/handoffs inside an account; not a two-owner trust protocol | REST/API surface, Marketplace connectors, saved skills/routines | account-wide shared computer state weakens isolation between Bots; personal/work boundary and long-term retention | adopt steer/stop, visible activity, evidence, routines; require stronger per-purpose isolation and exact manifests |
| Hermes Agent | named Bots, group chat and subagents; no checked owner-to-owner relationship protocol | MIT, MCP, open skills/Skills Hub, many backends | operational burden, connector conformance, safety of autonomous skill mutation and broad channel credentials | borrow adapter/tool conformance and portable-procedure ideas; defer self-modifying skills until the core agent is reliable |
| OpenClaw | multi-agent/team routing and sender isolation; not consented cross-owner coordination | MIT, plugin SDK, channel/provider/tool plugins | end-user security/ops burden and uneven plugin assurance | borrow gateway/plugin seams and optionally support self-hosting later; do not replace Waldo's governed owner kernel |

### 4.3 What is not proved

- A connector catalog does not prove reliable reads, safe writes, read-back, revocation, or deletion.
- A broad OAuth screen is not a product advantage if users cannot understand the grant.
- A friendly prompt is not stable personality or correct memory.
- Browser demos do not prove safe authenticated transactions or recovery after timeout.
- Provider `done` does not prove the external result, user Acceptance, or continuing responsibility.
- A vault UI does not justify storing raw passwords, cards, CVVs, OTPs, or TOTP seeds.
- Closed-source product internals, retention, and platform agreements are unknown unless the vendor publishes them.
- Deleting transient microphone audio does not mean the retained transcript, derived memory, model-provider copy, recovery record, or backup has been deleted.
- A detailed privacy policy is valuable evidence of intended data flows and known limits; it is not runtime proof that those flows, retention periods, and deletion paths behave as described.

### 4.4 Moonshot lesson: beat ambient surveillance with deliberate continuity

Moonshot demonstrates that a small team can make a personal agent feel coherent through a small set of legible objects: a `Mind`, an open-loop ledger, a morning history, standing orders, receipts, and permission-aware phone context. Its privacy page is also a useful disclosure benchmark because it names actual providers, request payload classes, server copies, correction/deletion controls, backup horizons, bystander data, and unfinished encryption/retention limits.

Waldo should not compete by collecting more ambient life. It should be the agent that earns deep personalization from deliberate, provenance-bearing sources: the owner's conversation and corrections, Calendar, selected mail/meeting context, explicit commitments, and purpose-filtered health state. Every durable claim should answer **why Waldo knows it**, **which source and purpose admit it**, **when it expires**, and **how to correct or forget it**. Every proactive message should answer **why now**, **what changed**, **what Waldo proposes**, and **how to mute, defer, or cancel it**.

For founder alpha and personal beta, Waldo therefore has no 24/7 microphone mode and no automatic ambient transcript-to-memory path. A future user-triggered or time-bounded capture feature requires its own on-device-first data-flow and bystander-consent review; transient-audio deletion alone is insufficient. Google is optional and incrementally authorized—Calendar first, then bounded Gmail/selected Drive—not one required super-grant. Mail, meeting, health, or relationship data may not use a model route with an unknown or materially worse retention/training posture merely to create a richer profile.

### 4.5 Instinct parity by user outcome

| User outcome | Instinct signal | Waldo current truth | Waldo parity decision |
|---|---|---|---|
| Feels like one person | branded direct contact and personal agent framing | voice assets and prompt foundations, no proved production conversation | ship a reviewed voice pack, style preferences, and longitudinal evals in G1 |
| Knows my day and inbox | Google Workspace connection | contract seams only | Calendar first, then bounded Gmail search/read/draft and selected Drive files |
| Reaches me anywhere | app, Messages, WhatsApp, email | app prototype; no production channel | app + APNs first; dedicated inbound email; WhatsApp adapter/eligibility in parallel |
| Remembers correctly | personal information and agent items | broad memory ontology/foundations, no simple user correction loop | compact Profile Claims, commitments, episodes, inspect/correct/forget |
| Acts and follows up | concierge/action claims | effect kernel but no real connector corridor | intent, confirmation, I/O, read-back, receipt, Open Loop follow-up |
| Coordinates people | Trusted People and agent network | concept buried in old docs, no implementation | elevate Trusted Relationships immediately after Calendar |
| Uses work context | Granola, Slack, Linear, Notion, GitHub | contracts and broader Kennel plans | Granola read-only now; defer broad work SaaS to work-agent bridge |
| Handles authenticated web tasks | vault/browser implications | no production browser | managed isolated browser behind policy; no raw credential vault |
| Deletes and controls data | external-data deletion surface | security contracts, incomplete joined deletion | ship connection, memory, consent, and account deletion receipts before scale |

Waldo should match these outcomes, not copy Instinct's permission breadth or vault implementation.

### 4.6 Final experience thesis and build order

The category leaders expose different parts of one winning loop:

| Product signal | Experience lesson for Waldo | Build response |
|---|---|---|
| Instinct | one recognizable person, proactive follow-through, direct contact, broad life/work context, trusted-person coordination | make personality, continuity, follow-up, app/APNs presence, and Trusted Relationships first-class product behavior rather than settings or architecture prose |
| Moonshot | named personal objects and value before a new prompt | ship `Today`, `Open Loops`, Memory, standing reminders, and receipts without using ambient surveillance as the shortcut |
| Poke | the assistant feels like a contact and integrations start from natural language/recipes | keep the conversation as the primary interface; turn a successful one-time task into an inspectable repeatable routine rather than exposing a workflow builder first |
| Meta Muse | persistent background work, browser reach, goals, visible approvals and audit | provide Activity, plan/progress, approval, takeover, and read-back UX; buy the isolated browser substrate after API corridors work |
| Grok Bot | visible tool activity, steer/stop, persistent computer, test-before-enable skills/routines | expose running state and stop/steer early; require one safe manual run before automation; do not copy account-wide shared-computer credentials |
| Hermes / OpenClaw | broad tools, memory, channels, skills, scheduling, self-hostable/open runtime patterns | reuse or buy tool/browser/scheduler/connectivity substrate where it passes Waldo adapters; keep identity, memory admission, authority, effects, receipts, relationship, and health semantics Waldo-owned |

The shortest competitive build is one closed daily loop, not the full connector list:

```text
talk to Waldo
-> Waldo remembers a correctable fact or commitment
-> Today/Open Loops reflects it with Calendar context
-> Waldo follows up at the right time through app/APNs
-> the owner can steer, stop, snooze, correct, revoke, or inspect why
-> any Calendar effect is approved, read back, and receipted
```

Build and release in this order:

1. **G0 truth and owner isolation.** Remove fictional success, resolve authority/documentation conflicts, bind every state path to the owner/account generation, and make data/revoke/delete state inspectable.
2. **G1 relationship core.** Real streaming conversation, recognizable personality, compact provenance-bearing memory, correction/forget, and visible stop/steer in the real app.
3. **G2 daily context.** Optional Calendar-only connection, cited `Today`, availability, exact propose/approve/apply/read-back, and Open Loops.
4. **G2a proactive return loop.** Explicit commitments, reminders, quiet hours, APNs, `why now`, done/snooze/dismiss/incorrect/dial-down, Activity history, and test-before-enable routines. Founder alpha begins here because this is the first build that behaves like an agent between prompts.
5. **Parallel depth after founder alpha:** G4 Gmail/selected Drive/Granola context; G5 HealthKit planning on physical devices; and G3 Trusted Relationships. These lanes reuse the same memory, approval, scheduling, Activity, and receipt surfaces and cannot create alternate agent loops.
6. **G6/G7 action reach.** Add one official India corridor, then a replaceable managed browser fallback for unsupported sites. APIs remain preferred; login/payment uses takeover and exact approval.
7. **G8 distribution and joined release.** Add inbound email and independently revocable presences; ship WhatsApp only on a supported provider path. Join app, push, email, and later channels into one ordered owner history.
8. **G9 work bridge.** Let Kennel consume the same owner authority, memory/commitment, and receipt contracts only after the personal loop is operationally stable.

Run the §17.3 competitive lab throughout. A benchmark finding may reorder a not-yet-started slice when it shows a materially better user outcome, but it cannot silently bypass owner isolation, exact approval, correction/deletion, source verification, or the zero-critical-failure floor.

The supporting [peer-experience reverse-engineering and build-order record](../research/WALDO_PEER_EXPERIENCE_REVERSE_ENGINEERING_AND_BUILD_ORDER_2026-09-19.md) preserves the product-by-product observations, inferences, unknowns, first-party sources, emulate/reject/buy/build decisions, and proposed measurement exits behind this sequence.

## 5. Definition of done

The list below defines the feature-complete competitive target. Passing it in a named test environment creates a beta/release candidate, not production proof. A public release additionally requires staging, physical-device/channel acceptance, deletion/recovery exercises, and small-cohort operational evidence for every advertised surface.

### Competitive P0 target outcomes

1. **Conversation:** an authenticated owner receives a streaming, non-fabricated answer; restart/retry does not duplicate the turn.
2. **Personality:** blinded reviewers recognize Waldo's voice without the agent becoming verbose, clingy, medically certain, or falsely confident.
3. **Memory:** the user can ask Waldo to remember a preference, inspect its source/status/purpose/freshness, correct it, delete it, and see the correction win in a later conversation.
4. **Calendar / Today:** Waldo can produce a cited view of today's commitments from Calendar plus explicit Open Loops, find availability, propose a change, obtain the required approval, apply it, read it back from Google, and show a receipt.
5. **Email:** Waldo can search/read within granted scope and create a draft; send remains a separate explicit effect.
6. **Proactivity:** Waldo follows up on an explicit commitment within quiet hours, explains `why now`, offers done/snooze/dismiss/incorrect/dial-down controls, and stops after completion, cancellation, or expiry.
7. **Trusted relationship:** two owners can invite/revoke, negotiate availability with minimal disclosure, independently approve their own event, and receive linked receipts.
8. **Health:** with explicit consent, physical-device HealthKit data produces a freshness/provenance-bearing derived planning constraint; Waldo-consent-declined/revoked, `no_accessible_data`, limited-history, and stale states never invent readiness.
9. **Supported pattern awareness:** a protected deterministic pipeline can say “insufficient history,” surface an evidence-backed observational pattern with support/missingness/freshness/provenance, accept correction/dismissal, and delete it without causal or clinical claims.
10. **Meeting context:** Granola notes/action items are retrieved with source links and become proposals, not hidden commitments.
11. **India corridor:** Swiggy search/cart can produce an exact-price proposal and user-controlled checkout handoff without exposing OTP, UPI PIN, CVV, or password.
12. **Control:** one coherent experience exposes Connections, current grants, retained Profile Claims, Open Loops, pending/running/waiting/completed/failed actions, receipts, processor-visible data paths, and deletion/revocation/backup-expiry status.
13. **Distribution:** the app path works end to end; email follows. WhatsApp for India is activated only if Meta admits Waldo to the Third Party Agent path or gives authoritative written eligibility for Waldo's exact offering and test tenant.

### Release cuts

- **Founder alpha — after G2a:** real app conversation, reviewed personality voice pack (not voice I/O), inspectable/correctable memory, Connection controls, the Google Calendar read/propose/apply/read-back corridor, Open Loops, bounded reminders/proactivity, Activity, and owner-bound APNs for a tiny internal owner set. This is the earliest Waldo that can return usefully between prompts and makes no HealthKit, Granola, Swiggy, WhatsApp, or broad parity claim.
- **Personal beta — after G3 + G4 + G5 and the external-beta privacy gate:** add Trusted Relationships, bounded Gmail/selected Drive, owner-bound APNs proactivity, physical-device health proof, and the deletion/revocation/control surface. Before inviting any non-founder, complete ADR-0073 age/eligibility and geo policy, per-source/purpose consent, DPIA and processor/DPA inventory, privacy disclosures, export/deletion exercise, incident/breach plan, and launch-region decision. Granola is enabled only for accounts/plans with verified API access; its absence does not block testing the rest of this cut and is not silently replaced by scraping.
- **India beta — after G6:** add the supported Swiggy corridor for an eligible test cohort. Production-access lead time cannot block founder alpha or personal beta.
- **Competitive multichannel release candidate — after G5b and G8:** all applicable P0 outcomes, including supported health patterns, meeting, and India corridors, pass in staging and on real devices/accounts; email is joined; WhatsApp is included only with official provider admission and otherwise is not advertised. Promotion to public release still requires the operational proof above.

### Anti-criteria

The release fails if any of these occur:

- a network/provider error renders fictional success;
- an external write happens before durable intent and current authority checks;
- a timeout causes an unreconciled duplicate action;
- model output changes memory, authority, health consent, or another owner's state directly;
- raw health, credentials, full unrelated transcripts, or another person's private data enter prompts/logs;
- a health association is presented as causal, diagnostic, or supported without its evidence threshold;
- a user correction is ignored or deleted data reappears from search/cache;
- a connected service silently widens model-visible tools;
- one Waldo can act for another owner;
- simulator-only evidence is presented as physical HealthKit/watch proof; or
- a WhatsApp workaround violates platform terms.

## 6. Minimal target architecture

```text
Waldo app · inbound email · WhatsApp when eligible · later Kennel
                         |
            Authenticated Owner Gateway
             identity + presence binding
                         |
            Conversation Orchestrator
       turn ordering · streaming · cancellation
                         |
     +-------------------+-------------------+
     |                   |                   |
Context Assembly   Capability Resolver   Personality Renderer
profile/memory     exact per-turn tools   reviewed voice pack
open loops         grant + risk ceiling   user style settings
relationships      connector status       no authority
health view        budgets/expiry
     |                   |                   |
     +--------- Policy / Judgment Gate ------+
                         |
             Intent -> I/O -> reconcile
                         |
 Google · Granola · Health projection · Swiggy · Browser port
                         |
          Observation -> Evidence -> Receipt
                         |
        Verification / Acceptance / Open Loop
```

### 6.1 State and writer ownership

| State | Canonical writer/store | Notes |
|---|---|---|
| identity, presences, grants, command intake/order | existing owner authority / DO SQLite | one owner root; server-derived bindings; sole allocator of owner `command_seq` and per-thread `turn_seq` |
| conversation graph, parentage, and bodies | Supabase `day_spaces`/threads/messages under RLS | accepted ADR-0077 ownership; the authenticated backend publication service is the only content/state writer and uses hidden `staged` plus visible `committed` states carrying immutable DO-assigned IDs/sequences rather than inventing a second order |
| conversation execution state | existing owner DO runs/outbox/stream cursors | coordinates publication and retry but is not a second transcript |
| connector identity, scopes, and lifecycle | **[Proposed] `ConnectionModule` / owner DO** | canonical provider-account binding, consent/scope revision, token generation, status, and deletion progress |
| Profile Claims and user preferences | owner DO compact records | source, purpose, sensitivity, revision, correction, expiry |
| episodes and searchable content | protected Postgres plus rebuildable search projection | canonical validity is rechecked before use |
| Outcomes/Open Loops/schedules | existing owner modules/DO | only durable responsibilities are promoted; ordinary chat stays chat |
| action intents, receipts, reconciliation | existing RunLoop/effect owner | intent before I/O; one retry owner |
| raw/normalized health | device and protected Supabase health plane | never DO memory or generic transcript |
| derived health planning view | versioned protected computation, purpose-filtered projection | nonnumeric/minimal where sent to a model or external channel |
| OAuth credentials and provider bearer use | Supabase Vault plus trusted connector Edge Function/proxy | amended ADR-0075; refresh/access tokens never enter the DO/model/log, and the proxy exposes only typed allowlisted operations |
| global provider-presence claims | **[Proposed] protected `PresenceClaimRegistry`** | sole cross-owner uniqueness writer for `(provider namespace, provider subject)` reservation/activation/revoke generation; it owns no conversation, memory, or per-owner permission |
| relationship state | each owner's DO | no cross-owner canonical writer or shared memory |
| relationship exchange | **[Proposed] minimal signed envelope relay** | transport/receipt ordering only; never owns either user's commitment |
| large artifacts | object storage only when a real artifact requires it | not a default memory store |

Do not move conversation bodies into the owner DO or create a second app transcript in the current plan. Any future ownership migration requires an accepted ADR, one cutover, deletion parity, and retirement of the prior canonical path.

#### Conversation publication and deletion protocol

The authenticated backend `ConversationPublicationService` is the only service allowed to create or transition conversation-content rows and materialize visible ordering from the DO reservation. Supabase remains the canonical human-visible graph; the owner DO remains execution truth and the order allocator. There is deliberately no claimed cross-store transaction. Idempotent states and reconciliation make partial progress visible and recoverable.

The content lifecycle is `staged -> reserved -> committed`, with terminal `expired`, `revoked`, or `deleted` states. Every stage binds owner, thread, client idempotency key, exact content digest, admission/deletion generations, expiry, and an opaque staging reference. Staged rows are inaccessible to the normal transcript projection and prompt assembly, but participate in RLS, retention, export, deletion, and content-log suppression. This is one Supabase content lifecycle and writer, not a second transcript.

For an inbound user command:

1. authenticate the owner and bind the thread before accepting the body into an in-memory quarantine whose request logs, traces, analytics, and error reporting cannot capture content;
2. apply deterministic local Scribe/DLP classification before any generic transcript, event, queue, or log write;
3. for raw health or another protected field, require the exact purpose and current consent, store the value only in its protected plane (or process it transiently without retention), and reduce the generic form to a non-reconstructive display marker plus opaque reference; use a keyed, rotating digest where low-entropy values could otherwise be guessed, never a plain digest of the protected value;
4. canonicalize the admitted ordinary bytes or protected marker/reference and idempotently write a hidden `staged_input` through the publication service, bound to the owner/thread, client key, exact digest, current admission/deletion generations, and short expiry; reuse of the key with changed bytes is rejected;
5. submit only the opaque staging reference, digest, and generation metadata to the owner DO; it dedupes and returns a reservation containing the server message ID, owner-wide `command_seq`, per-thread `turn_seq`, and parent/cancellation generation without storing the body; the publication service then compare-and-sets the staged row to `reserved` with that reservation;
6. compare-and-set the same Supabase row to visible `committed`, carrying the frozen IDs/sequences; `visible_order` is derived from the DO-assigned turn and message phase, never independently allocated by Supabase;
7. only a confirmed canonical commit releases exactly one DO run bound to that immutable message ID/digest; and
8. acknowledge durable acceptance only after both the staged payload and recoverable DO reservation exist. Before that point the input is explicitly unaccepted and may require the same-key resubmission. After it, restart reconciliation uses the exact staged bytes and frozen identifiers rather than reconstructing content from a digest or rerunning the user.

The protected write must be confirmed before its non-reconstructive transcript reference becomes visible. A crash after the protected write but before reference publication leaves a quarantined, idempotently recoverable record with a short cleanup deadline; it does not leak the value into the transcript. Consent revocation or deletion between the two steps cancels publication and purges/tombstones the protected record. Missing purpose/consent fails closed and retains no exact value. Crash tests cover every protected-store/reference boundary, log and error capture, low-entropy digest guessing, late revocation, retry, orphan cleanup, and deletion/reindex replay.

For launch, one thread executes turns serially. A concurrent inbound message is either queued at its frozen next `turn_seq` or explicitly steers/cancels the active turn under one deterministic policy; it never starts an unordered parallel reply. A canonical assistant row carries its input parent ID and the same turn sequence with the assistant phase. Tests race app/channel callbacks, retries, cancellation, publication timeout, and restart and assert that owner command order, transcript order, response parentage, execution order, and visible cancellation outcome agree.

For assistant output:

1. provisional stream events remain noncanonical and cannot claim an effect;
2. after final schema/policy validation, the publication service writes the exact final body as a hidden `staged_output`, keyed by server message/run identity and bound to its digest, parent, owner/thread, admission/deletion generations, and expiry;
3. only after staging succeeds does the DO freeze the opaque reference/digest and enqueue a restart-resumable publication intent; a model rerun never reconstructs an already-frozen answer;
4. the publication service compare-and-sets that same row to visible `committed` with the frozen order;
5. only a confirmed Supabase commit emits `message.committed`, advances the DO outbox, and becomes visible to later prompt assembly; and
6. a timeout remains `publication_pending` until read-back proves commit or retry safely completes it. A failure before staging is an honest interrupted/failed turn, not a recoverable exact answer.

Missing, expired, revoked, or deleted staged payloads become visible terminal execution states where appropriate and release their reserved turn so later turns remain live. Orphan cleanup is deadline-bound and idempotent. Consent revocation, message/thread deletion, and account deletion advance the governing generation before purge, preventing a late promotion. G1 kills the process after input stage, reservation, input commit, output stage, publication intent, and output commit, then restarts without client retry. It also tests same-key changed bytes, revoke/delete between every boundary, orphan expiry/purge, and next-turn liveness, asserting no duplicate visible message, regenerated answer, wedged sequence, or second canonical transcript.

Logs, journal metadata, and unrelated DO events never duplicate conversation bodies. Raw health samples or protected health fields typed into chat are handled through the pre-persistence quarantine and accepted health destination matrix; exact values remain transient or in the protected health plane, while the generic transcript contains only the non-reconstructive marker/reference.

Deletion first makes the canonical Supabase message/thread unavailable to normal RLS reads and advances a deletion/revocation generation consumed by prompt assembly. The DO then invalidates run references, summaries, caches, schedules, and derived/search projections idempotently. R2 is included only after the ADR-0077 staged-delivery amendment admits that projection. The user sees a deletion receipt or honest `deletion_pending` status. Tests crash/restart between every boundary and cover duplicate callbacks, digest mismatch, missing rows, deletion during streaming, stale-index retrieval, consent change, and cross-owner substitution.

#### Multi-presence identity and channel binding

`IdentityPresenceModule` remains each owner's sole permission writer, but its one-Presence-per-owner invariant becomes one owner with multiple independently revocable `PresenceBinding` records. Each binding carries channel/provider, stable provider subject or normalized phone identity, verified-at, status, binding and revocation generations, capabilities, and last provider event cursor. Because independent owner DOs cannot atomically enforce cross-owner uniqueness, a protected `PresenceClaimRegistry` is the sole writer for reservation, activation, expiry, and revoke generation of `(provider namespace, provider subject)`. It owns no conversation, memory, or per-owner permission. A provider identity becomes active for at most one owner; partial reservations are recoverable and recycled identities require explicit step-up before relink.

Linking starts only from a freshly authenticated Waldo app session. The server issues a short-lived, one-use challenge bound to owner, intended channel/provider account, app presence, and redirect/callback. The channel callback proves possession and provider signature before activation. Never join by display name, profile photo, address-book similarity, or phone-number resemblance. A recycled/reassigned number requires re-verification and explicit relink after the prior binding is revoked/quarantined; it never inherits the old owner's memory, threads, pending actions, or delivery state.

Every inbound callback and resumed run rechecks provider signature, provider subject, owner/account status, binding generation, revocation generation, capability, and event/message dedupe key. The owner DO assigns cross-surface command order. Provider message IDs and Waldo origin markers suppress duplicates and outbound echo loops. Revocation/account deletion advances the generation before asynchronous provider cleanup, so a late webhook fails closed.

Conformance tests cover challenge replay and owner/provider substitution; one phone claimed by two owners; recycled-number relink; a late webhook after revoke/account deletion; simultaneous app and channel turns; provider retry/reordering; outbound echo loops; and unlink/relink while a response is in flight.

### 6.2 Normal agent-turn protocol

1. authenticate the owner and bind the presence server-side;
2. normalize and classify the inbound message, including sensitivity and external-text taint;
3. load current turn/thread state, relevant Profile Claims, Open Loops, relationship state, and purpose-allowed health view;
4. resolve the smallest per-turn capability manifest from request, connected services, grants, risk, budget, and expiry;
5. compose minimal context with provenance and explicit exclusions;
6. call one primary model with schema-bound answer/tool proposals;
7. validate output against capability, data, policy, and semantic rules;
8. answer directly for informational work, or create a proposal/intent for an effect;
9. persist frozen intent, digest, idempotency and reconciliation key before I/O;
10. execute through the connector/browser adapter;
11. read back or reconcile from the source of record;
12. store observation/evidence/receipt, update the relevant Open Loop, and render truthful status.

Untrusted mail, documents, web pages, meeting text, and counterparty messages may supply observations but may not grant authority, choose or change an effect destination, widen a capability, or provide executable parameters without independent typed validation. They can cause Waldo to propose an action; only owner intent or a pre-existing typed grant may authorize it. A prompt instruction such as “ignore this text” is not the control boundary.

Ordinary conversation does not require a Mission or Outcome graph. Promote only a promise, scheduled action, waiting dependency, multi-step responsibility, or user-declared outcome into durable responsibility state.

Streaming is provisional. Chunks are untrusted, incrementally output-sanitized UI events; they are not canonical assistant content, receipts, or effect claims and cannot trigger a tool. Only the final schema/policy-validated body and digest enter the publication protocol. Cancellation, policy rejection, provider loss, or restart ends the provisional stream as `interrupted`/`failed`; the UI never preserves it as a successful assistant turn. G1 tests include cancellation and restart between chunks, an unsafe late chunk, a tool claim in prose, final-digest mismatch, and reconnect without duplicate publication.

Prompt caches and continuation identity bind the owner, purpose, exact admitted-context/source digest, consent and source revisions, policy version, frozen capability/tool-manifest digest, model/provider transform version, and deletion/revocation generation. Provider-native reasoning or tool artifacts are not replayed across models unless a versioned transformation has explicit tests; a lossy transform is admitted as new untrusted context, never treated as preserved reasoning truth.

### 6.3 Capability resolution replaces the broad global tool surface

**[Observed]** The current `user_message` trigger can see 29 of 30 named tools. Deny-first ACLs are useful, but this is too broad for launch.

**[Decision]** Retain the global vocabulary for compatibility, but derive a signed/hashed per-turn manifest containing only the tools and connector operations required for the declared purpose. A Calendar question should not expose memory writes, generic MCP, message deletion, sheets, browser writes, or task execution.

The manifest and tool schemas are frozen for the full model turn and every retry within it. Lazy discovery may reduce what is rendered into context, but it may not add, remove, or redefine a callable tool mid-turn. A resumed continuation creates a newly authorized manifest revision after reconciling prior effects; it never silently inherits a wider runtime surface.

Capability admission binds:

- owner and authenticated presence;
- purpose and affected resource;
- exact operations and parameter ceilings;
- source and destination data classes;
- confirmation/effect class;
- expiry and revocation generation;
- monetary/token/browser budget;
- idempotency and reconciliation policy; and
- adapter availability/version.

### 6.4 Model-provider data-processing gate

Every model/gateway route is default-deny by data class, not merely “an approved model.” A versioned `ModelEgressPolicy` binds provider, model/route, region, DPA/subprocessor status, training use, retention/ZDR status, gateway/provider payload logging, allowed source/destination classes, consent/purpose, fallback ladder, and configuration digest. At minimum distinguish public text, ordinary user chat, Profile Claims, Calendar metadata/body, Gmail metadata/body, meeting notes/transcript excerpts, protected derived-health context, raw health, credentials, and other-owner data. Raw health, credentials, and unadmitted other-owner data are forbidden on every route.

Before a route can receive mail, meeting, or derived-health content, its processor/DPA and retention posture must be documented and accepted for that class. Cloudflare AI Gateway payload logging is default-off in configuration and the trusted proxy explicitly sends `cf-aig-collect-log: false` (or the verified current equivalent) on every sensitive request, including fallbacks; omitting or overriding that control fails closed. Metadata-only logging, when separately justified, uses `cf-aig-collect-log-payload: false` and content-minimized identifiers. A conformance test verifies both configuration and request paths, while a synthetic canary proves only that prompts/tool output are absent from the capture paths it exercised. If no-training/ZDR/region or log suppression cannot be established, that route receives only the lower data classes its evidence permits.

Fallback is a fresh policy decision. It may narrow or refuse content but cannot widen data egress, retention, region, or logging. Each provider attempt re-renders the prompt for its route, filters context to that route's admitted classes, and records a content-minimized policy/config digest. Tests force every fallback rung, revoke consent/Connection mid-turn, misconfigure payload logging, inspect logs/traces/analytics, and verify that a blocked data class fails closed without silently retrying through a less private provider.

## 7. Personality, personalization, and memory

### 7.1 Personality

Personality is a product capability, not permission. Publish a small reviewed runtime voice pack from Waldo's existing soul/voice assets:

- warm, capable, grounded, and lightly playful;
- concise when unsolicited, deeper when asked;
- adapts format and directness to the person;
- says what it knows, infers, and cannot verify;
- never shames, pressures, feigns intimacy, claims a completed action, or presents medical certainty.

Evaluate voice through blinded multi-turn scenarios, not keyword checks alone. Include grief/stress, missed commitments, health uncertainty, disagreement, correction, action failure, and long-running relationship cases.

### 7.2 Compact memory model

Do not expose the existing multi-hall/dreaming ontology as the launch product. Preserve its trust-ordering lessons and migrate to four user-legible record types:

| Record | Examples | Write rule |
|---|---|---|
| `ProfileClaim` | timezone, working style, food preference, relationship name | explicit user claim may be admitted; inference is proposed for review |
| `Episode` | a meeting result or completed trip | requires source/evidence and bounded retention |
| `Commitment` / `OpenLoop` | follow up Friday, renew insurance | durable trigger, state, expiry, completion/acceptance |
| `RelationshipState` | trusted person, grant, coordination preference | explicit mutual protocol; no shared personal memory |

Every retained claim includes owner, scope, provenance, recorded/applicable time, revision, sensitivity, confidence where relevant, purpose admission, and correction/supersession/deletion links.

Memory lifecycle:

```text
candidate -> source/purpose check -> admit or propose -> retrieve
          -> correct/supersede -> invalidate indexes/caches -> delete/export
```

User statements and corrections outrank inference. External/model content cannot promote its own trust. Retrieval must recheck canonical validity and consent so deleted or superseded data cannot return through an embedding, summary, old prompt cache, or scheduled job.

For claim-level “forget” where the originating transcript remains, create a content-minimized `MemoryAdmissionBarrier` rather than relying only on deleting the current claim. It binds owner, typed entity/predicate or sensitivity class, originating source IDs/digests, effective revision/time, reason class, and supersession generation without retaining the forgotten value. Extraction, consolidation, replay, model upgrades, reindexing, summaries, caches, and scheduled jobs must consult it and may not re-admit the forgotten claim from pre-barrier sources. Only a new explicit user statement after the barrier can create a reviewed successor. Full account/source deletion removes the underlying transcript and follows the broader deletion run; the barrier is not a substitute for erasure. Tests rebuild every projection from historical messages and prove no resurrection by paraphrase, re-embedding, replay, or model change.

### 7.3 Restrained proactivity

Launch proactivity comes only from:

- explicit reminders and recurring rules;
- approaching commitments/deadlines;
- Calendar conflicts or requested preparation windows;
- waiting replies/action items from admitted mail or meeting sources;
- connector failure/revocation that blocks an accepted responsibility; and
- user-configured health-aware planning windows.

Every proactive rule has purpose, source, cadence, quiet hours, rate limit, expiry, cancellation, and a visible reason. Do not run generic patrol, dreaming, or engagement-seeking messages.

Keep three mechanisms distinct: **worker liveness** wakes infrastructure, **proactive assessment** decides whether an admitted observation warrants a proposal, and **scheduled responsibility** advances a user-visible commitment. Cloudflare Durable Object alarms provide at-least-once wakeups and only one alarm per object; they are not themselves a multi-schedule product contract. Each routine therefore has an owner, purpose, stable occurrence ID, trigger and timezone/travel policy, overlap and lateness/misfire rules, admitted capabilities and aggregate/token/tool/recovery budgets, expiry, cancellation generation, delivery destination, and inspect/edit/pause/resume/cancel/history controls. Deterministic reminders do not require an LLM. Resume reconciles pending effects first, rechecks authorization/config/source/procedure revisions, and cannot let verifier or recovery loops evade the routine's aggregate budget.

Persist the desired routine separately from each materialized occurrence. Reconcile missing, duplicate, or stale occurrence records against the current desired-state revision before execution; changing or cancelling the parent invalidates older occurrence generations.

Execution and delivery are separate state machines: `completed` work can still be `delivery_failed`, and provider acceptance is never reported as human receipt. Silent/no-action runs still leave owner-visible, content-minimized history. A routine may not recursively create another routine from inside its own run without a fresh owner-visible proposal. When the one Durable Object alarm exhausts platform retries, a durable dead-letter/repair record and an independent watchdog must keep later logical occurrences from disappearing permanently.

A durable continuation record names the task revision, accepted progress, pending effects and approvals, source/context/procedure/tool versions, remaining aggregate budget, cancellation/revocation generations, and next allowed transition. A wakeup or long context window is not continuity by itself; each resume validates the record and reconciles source-of-record effects before taking another step.

Founder-path mail follow-up is not general inbox monitoring. It is a bounded scheduled re-read of an exact Gmail thread that the owner admitted for a waiting-reply Open Loop. The rule stores only the provider thread ID, admitted purpose, last source message/history marker, cadence, expiry, and revocation generation; it stops when a qualifying reply is observed, the loop closes/expires, or the Connection is revoked. It suppresses Waldo's own sent-message echo and treats external draft edits as observations, not replies. Gmail `users.watch`/Pub/Sub is deferred until a separate cursor/renewal/gap-recovery contract is accepted. Tests cover late/reordered observations, concurrent external reply/draft changes, self-sent echo, revoke during poll, missed cadence, and provider/read failure without an invented reminder.

## 8. Connector and adapter strategy

### 8.1 Common connector contract

Every connector separates:

1. connection/authentication;
2. source admission and data scope;
3. read capabilities;
4. proposal capabilities;
5. effects requiring approval;
6. idempotency and source-of-record reconciliation;
7. revocation/deletion; and
8. conformance/staging evidence.

The connector never owns Waldo memory, authority, Outcome truth, or Acceptance. Connector results are untrusted observations until admitted. Every adapter result has three bounded representations: the raw/provider observation in the protected source plane, a minimal typed projection eligible for model context, and a richer redacted UI/evidence receipt. Raw provider payloads are never copied into model context merely because the connector returned them, and model-minimized output does not replace the source-of-record evidence needed for verification.

#### Canonical connection lifecycle

`ConnectionModule` is the sole writer of a per-owner `Connection` aggregate. A Connection binds the provider, immutable provider account/tenant identity, purpose, admitted data classes, granted scopes and their revision, opaque token handle/generation, adapter version, consent epoch, and lifecycle status (`connecting`, `active`, `reauthorization_required`, `revoked`, `deleting`, `deleted`, or `error`). Multiple provider accounts remain distinct Connections; a callback never silently replaces one account with another.

OAuth start stores a short-lived, one-use, owner/presence-bound state record and PKCE verifier, plus nonce/issuer/redirect binding where the provider protocol supports them. The callback verifies those bindings before a server-side code exchange, retrieves the provider's stable account identity, detects cross-owner/account substitution, and activates the Connection with an atomic scope revision. Secrets, refresh tokens, and provider bearer tokens remain inside Supabase Vault and a trusted connector Edge Function/proxy; Waldo's DO records only opaque connection/credential generations and never durable raw credentials.

The proxy does not expose “fetch any URL with this token.” It accepts a signed owner-bound operation envelope containing the frozen per-turn capability-manifest digest, exact typed operation, affected resource, approval/effect class, parameters/digests, credential and revocation generations, idempotency key, expiry, and expected response class. It re-verifies those bindings, constructs the provider method/path itself from an allowlist, executes, sanitizes the response, and returns bounded observation/evidence. Google OAuth scope is only an outer permission ceiling; Waldo's proxy and dispatch policy enforce the narrower operation boundary. Draft creation, draft deletion, and send are distinct operations even where one Google scope permits all three.

Every effect and resume rechecks Connection status, exact scopes, provider account, token generation, and revocation generation. Revocation invalidates capability first, then revokes/deletes provider credentials and retained derivatives through a visible deletion state machine. Conformance tests include CSRF/state replay, authorization-code replay, PKCE failure, token/account substitution, cross-owner callback, unrequested scope widening, scope downgrade, refresh rotation/failure, concurrent callbacks, mid-run revoke, and partial deletion.

The current Supabase `oauth_tokens` and `one_time_tokens` tables and every deployed Edge Function/caller must be inventoried and reconciled to the amended ADR-0075. G0/G2 has one credential boundary: Supabase Vault plus the trusted typed connector proxy. Do not return provider bearer tokens to the DO, dual-write refresh tokens, or introduce a managed broker in the founder-alpha path. A future broker requires a new accepted custody ADR, account-bound handle migration/reconnect plan, deletion parity, cutover/rollback criteria, and read-path proof before any legacy secret path is retired.

Credential-boundary tests include token-exfiltration attempts, wrong method/path, arbitrary-host/SSRF input, recipient/calendar/resource substitution, stale or replayed operation envelopes, manifest-digest mismatch, approval substitution, callback/account substitution, refresh rotation/failure, and a revoke or account deletion racing an in-flight provider call.

### 8.2 Google Workspace — P0

Use official Google APIs. Supabase Vault and the typed connector proxy custody and use credentials; Waldo owns grants, purpose, capability resolution, receipts, and data retention. Google's Workspace MCP servers are in Developer Preview as of this review; they are useful for prototypes but cannot be the public production dependency until their terms and availability permit it.

Incremental scope order:

| Increment | Capability | Minimum provider scope / caveat | User control |
|---|---|---|---|
| G-Cal-1 | primary-calendar free/busy and bounded event reads | `calendar.freebusy` + `calendar.events.owned.readonly`; proxy restricts to `primary` | connect Calendar read |
| G-Cal-2 | propose event create/update/delete | no added provider scope; no provider write yet | local proposal only |
| G-Cal-3 | apply exact approved diff, read back, reconcile | `calendar.events.owned`; provider scope reaches owned calendars, proxy restricts alpha to `primary` | separate Calendar write grant |
| Gmail-1 | Gmail-query search and bounded metadata projection | `gmail.readonly`; `gmail.metadata` cannot use `messages.list?q=...`, so the bearer ceiling is broader than the returned operation | exact source/time/query limits |
| Gmail-2 | read selected threads/bodies | `gmail.readonly`; same scope as search, newly admitted typed operation and retention purpose | explicit mail-content explanation and retention policy |
| Gmail-3 | create/update drafts | `gmail.compose`; this scope also permits send, so proxy policy—not OAuth—enforces draft-only | draft operation grant; no send authority |
| Gmail-4 | delete exact draft | `gmail.compose`; distinct typed destructive operation | explicit confirmation; Gmail deletes it immediately and permanently |
| Gmail-5 | send exact approved message snapshot | `gmail.compose`; proxy freezes approved RFC 5322/MIME bytes and sends through `users.messages.send`, never mutable draft ID | fresh approval bound to every byte at the irreversible edge |
| Drive-1 | user-selected files through Picker | `drive.file` where the workflow permits it | no all-Drive default |
| People-1 | user-selected contact lookup for an invite or recipient | deferred; exact `contacts.readonly` need and minimization must be justified before request | no full address-book ingestion |
| Tasks-1 | read/create/update selected task lists | exact Tasks scope selected by read/write operation at adapter contract | enable only when the workflow is used |
| Docs/Sheets/Slides | document workflows | exact per-file/read-or-write scopes selected later | not onboarding scope |

Do not copy Instinct's all-at-once Google grant. Use incremental authorization and show what each active connection lets Waldo do.

Google classifies Gmail scopes that read/manage message metadata, headers, or bodies—including `gmail.metadata`, `gmail.readonly`, and `gmail.compose`—as restricted. `gmail.compose` is not a draft-only security boundary; it can authorize `drafts.send`. If Waldo's server stores or transmits restricted data, production use requires Limited Use compliance, restricted-scope OAuth verification, and ordinarily an annual Google-approved security assessment. Begin scope justification, verified-domain/privacy materials, processor/data-flow inventory, test-user plan, and CASA readiness in G0. Founder/test-user corridors do not prove public verification, and Gmail must not enter external beta until the applicable approval is complete.

Keep the first Calendar effect class deliberately narrow: the authenticated owner's primary calendar; non-recurring, owner-only events; no attendee or conference mutation; and `sendUpdates=none`. For create, validate and persist a permitted client-chosen Google event ID before I/O and reconcile that exact ID after response loss; retrying the same insert must not create a second event. Treat duplicate/collision responses such as `409` according to the exact provider operation and never assume they prove that Waldo created the found event. For update/delete, bind the approved version/etag, timezone, and resolved instant and dispatch with `If-Match`; a provider `412` invalidates the approval and creates a fresh proposal rather than silently rebasing or overwriting. Then read back from Google. Additional owner-selected calendars, recurring-series/instance edits, attendee notifications, conference creation, organizer transfer, and imported invitations are later distinct effects with their own approval and reconciliation rules. Test custom-ID validation/collision, duplicate create, DST boundaries, timezone changes, stale etag/`412`, external edit/delete/move, ambiguous absence, and timeout after provider commit; ambiguous absence remains indeterminate until the operation-specific reconciliation budget is exhausted.

Gmail send has its own TOCTOU boundary, and Google does not document atomic compare-and-send for a mutable draft. Fresh approval therefore binds deterministically canonicalized raw RFC 5322/MIME bytes and their digest, every envelope/header recipient, subject, attachment bytes/digests, thread intent, owner/provider account, approval generation, expiry, and a Waldo-owned idempotency/reconciliation reference. The typed proxy sends exactly those immutable bytes through `users.messages.send`; it does not call `drafts.send` by mutable provider draft ID. The provider draft remains intact, including concurrent external edits, and is surfaced as independently changed/still present. Any cleanup is a separate visible operation with separate approval. A timeout after send is indeterminate: reconcile source-of-record message state before reporting or offering another send—never blindly resend. Tests cover canonicalization/digest stability, edit the draft after the final read, substitute MIME/headers/recipients/attachments, revoke during dispatch, simulate provider success followed by response loss, and prove concurrent external draft edits remain intact.

Waiting-reply tracking in G4 uses the bounded exact-thread scheduled-read contract in §7.3. Search/read scopes alone do not imply mailbox surveillance. A future Gmail watch stream must separately specify `users.watch`, Pub/Sub authentication, history cursor storage, renewal, dedupe/order, expired-history and gap recovery, reauthorization, revoke, deletion, and self-event suppression before it can replace polling.

Current contract gaps to fix:

- Calendar is proposal-only; add apply, get/read-back, reconcile, and revoke behavior.
- Email lacks bounded Gmail thread search/read; add it without weakening explicit send confirmation.
- No production adapter exists behind either port.

### 8.3 HealthKit / Apple — P0 differentiator

The iPhone owns native HealthKit access and a short-lived encrypted cache. Raw samples remain on device or in the protected health plane when the person separately consents to cloud processing. Waldo's model receives only a purpose-filtered derived view with freshness, source window, method/version, missingness, limitations, consent epoch, expiry, and opaque evidence references.

HealthKit intentionally does not reveal whether the person denied read access to a specific type; full access with no matching samples and denied read can both appear as no data. Waldo must track its own cloud-processing consent separately and label the native result `no_accessible_data`, never “HealthKit denied.” On iOS/watchOS 27 or later, availability-gate `getEarliestAuthorizedSampleDate(for:completion:)` to identify the positively knowable limited-history case, constrain queries to that window, and disclose partial history. The app still targets iOS 16, so earlier systems must not infer a limited-history boundary they cannot observe; they report `no_accessible_data`/available source window only. Native tests cover both the pre-27 fallback and iOS 27 result/error paths.

First supported context should be small: sleep sufficiency/state, HRV/resting-heart-rate trend eligibility, self-reported energy, and scheduling constraints. Do not request every existing HealthKit type during onboarding.

Required app repair before agent use:

- default server health sync off;
- separate OS read permission from Waldo cloud-processing consent;
- partition DB/key/cache by account and consent epoch;
- purge on sign-out, account switch, revocation, and deletion;
- add typed native results with per-field state, timestamp, source, and manually-entered flag;
- add missing workout permission only if workout data is actually in scope;
- implement anchored/observer queries and durable anchors for background ingestion;
- remove `try?` error erasure and distinguish device unavailable, Waldo consent declined/revoked, limited authorized window, no accessible data, stale data, and query failure without claiming OS read denial;
- add XCTest/native bridge conformance and physical-device evidence.

Supported pattern awareness is a separate protected computation, not free-form model memory. Amend ADR-0081 with a versioned `HealthPattern` aggregate containing pattern definition, subject/consent epoch, evidence window, eligible observations, support, missingness, freshness, computation version, provenance, uncertainty, state (`candidate`, `supported`, `dismissed`, `expired`, or `deleted`), feedback/correction lineage, and expiry. Begin with a small predefined family of observational comparisons; do not let a model mine arbitrary correlations and then narrate them as truth.

The deterministic health authority computes support and state. A model may explain only the destination-filtered result and limitations. Each pattern family needs a minimum-evidence rule, longitudinal/golden fixtures, negative controls, source/method compatibility, false-discovery review, and wording tests that ban causal, diagnostic, treatment, and calibrated-probability claims. The person can inspect evidence scope, correct self-report/context, dismiss a candidate/supported pattern, and delete it; consent withdrawal or source deletion invalidates derived patterns and every search/context projection. Until the threshold passes, Waldo says `insufficient_history`.

Watch is a projection/controller later. The phone remains the state owner. The watch may view, acknowledge, or propose; it cannot own memory or execution truth.

Apple surface order after the core app path:

1. APNs for truthful completion/follow-up delivery;
2. EventKit as an optional second `CalendarProvider` for Apple-only users, without dual-writing a Google-owned event;
3. bounded App Intents such as “What needs my attention?” and “Tell Waldo…”, never a generic unconstrained execute intent;
4. WatchConnectivity for a minimal phone-owned projection and acknowledgements;
5. Contacts only through explicit user selection/purpose, not silent address-book ingestion.

Do not promise an iMessage bot surface; no supported third-party Messages bot path was established in this review.

### 8.4 Granola and meeting context — P0/P1

Use Granola's official public API where the owner's plan permits it. Business and Enterprise plans currently support signed webhooks. Begin read-only:

- retrieve meeting metadata, owner-visible notes, summaries, and action items by default;
- fetch only purpose-bound transcript excerpts when the user's request cannot be answered from those artifacts;
- preserve meeting/source links and timestamps;
- treat action items as candidates requiring owner admission;
- never treat a model-written meeting summary as proof of a commitment;
- never persist a full transcript into Waldo memory/search by default; third-party speech receives short TTL, meeting/source scoping, and deletion/revocation propagation;
- allow source deletion/revocation to invalidate derived context.

Treat a webhook as a change notification, not as note content. Verify the Standard Webhooks signature against the raw body, enforce a narrow timestamp window, bind the endpoint to its Connection/scope, and deduplicate by `event_id`. Durably admit the notification and acknowledge within Granola's delivery window before doing heavier work; fetch current note data through the API and recheck access at fetch time. Use cursor/date-bounded `updated_after` backfill for initial sync and disabled-endpoint gaps. Because current webhook events do not report deletion or access revocation, give retained note-derived context a TTL and periodically re-fetch its source IDs; a `404`, access loss, or Connection revocation generation invalidates the projection immediately. Test invalid/rotated secrets, stale timestamps, duplicate/reordered events, retry storms, endpoint disable/re-enable, note deletion/unshare without a webhook, and a crash after durable admission but before acknowledgement.

Fathom/Plaud/other notetakers can later implement the same `MeetingContextProvider`; do not build separate agent logic for each. Wispr Flow or other dictation products are input surfaces unless an official meeting-record API/export is verified; do not treat a desktop audio tool as an implicit transcript connector.

### 8.5 Claude/ChatGPT/Codex connectivity

Do not advertise a personal ChatGPT or Claude-history connector without a supported official API and retention contract. Initial support is:

- provider APIs as Waldo's bounded inference engine;
- user-selected import/export files where lawful and useful;
- Codex/Kennel as a later work executor through released Waldo contracts; and
- official connectors only when the vendor exposes a stable supported path.

Never scrape consumer chat accounts or reuse browser sessions as an implicit memory import.

## 9. Trusted Relationships and Waldo-to-Waldo

This is a first-class product capability immediately after single-user Calendar works, not generic multi-agent delegation.

Each owner root independently owns:

- `TrustedRelationship`;
- `RelationshipGrant`;
- `CoordinationProposal`;
- `SharedCommitment`; and
- `CoordinationReceipt`.

The exchange uses a minimal end-to-end authenticated-and-signed `CoordinationEnvelope` with sender/recipient relationship IDs, schema/version, purpose, disclosure class, ciphertext/payload digest, key epoch, nonce/sequence, expiry, reply reference, and sender authentication. Receiving Waldo treats even successfully decrypted content as untrusted counterparty input.

No cross-owner payload may exist until an accepted protocol ADR and threat model choose the identity/signature trust root, authenticated key agreement/distribution, audited encryption library/protocol, and relay placement. Payloads are authenticated-encrypted between the two owner roots; the relay receives only ciphertext plus the minimum routing/expiry metadata and cannot mint relationship authority, decrypt payloads, or make either owner's canonical write. The ADR must bind owner and relationship identity, resist recipient/relationship substitution and downgrade, define key epochs and rotation/recovery, decide whether launch provides cryptographic forward secrecy (and forbid claiming it if not), handle compromised devices/keys/accounts, propagate revocation/account deletion, and define ciphertext/metadata retention and deletion receipts. Do not hand-roll primitives.

Protocol:

1. A sends B an expiring, single-use invitation.
2. B authenticates independently and accepts the relationship.
3. Both roots persist their own relationship and revocation state.
4. A sends the minimum proposal needed for the declared purpose.
5. B's Waldo evaluates privately and asks B when B's policy requires it.
6. Each Waldo executes only its own owner's side.
7. The exchange links receipts, but each root owns its own commitment/Acceptance state.
8. Revoke/block/report immediately stops future exchange; in-flight messages expire safely.

First use case: two-person meeting coordination.

- exchange available windows and constraints, not event titles or full calendars;
- propose a time;
- independently approve/apply each event;
- reconcile two receipts;
- handle decline, expiry, timezone change, reschedule, partial completion, and revocation.

Non-negotiable constraints:

- no shared personal memory;
- no transitive delegation;
- no ambient authority from being trusted;
- no health sharing by default;
- derived constraints such as “avoid after 8pm” require explicit sharing permission;
- replay/dedupe, rate limits, abuse reporting, and counterparty verification;
- authenticated encryption with no plaintext relay/log/trace payloads and no silent protocol downgrade;
- private failure semantics—one user must not learn the other's private reason for refusal.

Protocol tests include forged/unknown/rotated/revoked/confidentiality keys; wrong-recipient and cross-relationship substitution; encryption/version downgrade; ciphertext corruption; relay replay, reordering, delay, duplication, expiry, retention and deletion; relationship revoke during flight; compromised device/key and recovered account; the selected forward-secrecy property; account deletion; and one-sided Calendar apply. If only one owner's event is applied, both roots retain truthful independent state and offer bounded, separately authorized compensation rather than pretending atomic cross-owner success.

## 10. India connector advantage

Build one high-quality local service pack before a broad catalog.

### 10.1 Swiggy first

Use Swiggy's official MCP/builder surface where available, behind Waldo's adapter and policy layer. The first corridor is:

```text
search/menu -> item selection -> cart proposal -> exact address/total
-> fresh user approval -> provider checkout/payment handoff -> receipt/read-back
```

Rules:

- the model never receives password, OTP, UPI PIN, CVV, raw card details, or TOTP seed;
- address and dietary information are disclosed only for the order purpose;
- a price/address/item change invalidates approval;
- payment remains user takeover or a separately supported tokenized flow;
- timeout after submit reconciles order state before any retry;
- cancellation/refund capabilities are explicit and source-verified.

### 10.2 Blinkit, Zomato, Flipkart, and others

Prefer, in order:

1. official API/MCP/partner surface;
2. official deep link or cart handoff;
3. managed isolated browser with user takeover at login/payment;
4. no integration when the only option violates terms or cannot reconcile safely.

Do not promise a connector merely because browser automation can click the site. Each service needs an exact availability/terms probe and a bounded conformance suite.

## 11. Browser and computer use

**[Decision] Buy the replaceable execution substrate; keep Waldo's policy, context, and receipts.**

Define `BrowserExecutionPort` with:

- owner-isolated ephemeral session;
- domain and action allowlist;
- secret injection outside model-visible context;
- navigation/action/time/cost budgets;
- screenshot/action trace and redaction policy;
- pause/takeover;
- mandatory pre-submit/pre-pay approval;
- source-of-record read-back;
- cancellation, cleanup, and terminal-ambiguity result;
- idempotency/reconciliation when the site permits it.

A workspace, working directory, container label, or vendor “session” is organization—not proof of isolation. G7 must separately prove filesystem, process, network, credential, clipboard, download/upload, and cross-session boundaries; absolute paths or inherited host access fail the gate even if execution stayed inside the named workspace during a happy-path test.

Pilot Cloudflare's browser/agent tooling because the backend already runs on Cloudflare, but keep Browserbase/Stagehand or another managed provider behind the same port. A timeboxed OpenClaw/Hermes adapter study may reuse their browser, channel, or execution substrate where license, isolation, secret handling, and operational recovery pass; their memory, permissions, schedules, and product model never become Waldo authority. Promote a substrate only after isolation, authenticated-session cleanup, prompt-injection resistance, receipt quality, cancellation, latency, and cost pass. Computer-use model output never bypasses this port.

APIs remain preferred for Calendar, Gmail, Granola, and Swiggy. Browser fallback is lower assurance and visibly labeled.

## 12. Channels and access

### App first

The app is the first complete presence because it can provide authentication, settings, approvals, health consent, memory controls, rich receipts, and push notifications. Remove all false-success fallbacks before connecting effects.

### Dedicated inbound email

An owner-specific Waldo email is a useful remote channel that does not require a messaging-platform approval. It needs sender verification/linking, quoted-history stripping, attachment policy, spoofing/loop protection, and sensitive-action step-up in the app.

### WhatsApp provider admission in parallel; India activation currently blocked

As of this review, the March 6, 2026 WhatsApp Business Solution Terms prohibit AI providers whose primary functionality is a general-purpose assistant, with an exception for users registered with EEA or Brazil country codes. India is outside that public exception. Separate Third Party Agent user terms indicate that another platform/path exists, but they do not grant Waldo provider admission or Business Solution API rights.

**[Blocked]** Do not build or activate an India production adapter on ordinary Business Solution access. First obtain Meta admission to the Third Party Agent platform or authoritative written eligibility plus an official provider contract/test tenant for Waldo. Before that, build only the provider-neutral multi-presence/channel contract and use app + inbound email. Meta Muse's WhatsApp presence does not prove that an independent provider has the same rights, and no unofficial relay/workaround is acceptable.

Do not use an unofficial linked-device bridge or disguise Waldo's general AI purpose. If eligibility is not obtained, launch the app cohort honestly and use email/app push as the remote path while the gate remains open.

## 13. Work agent and Kennel boundary

The personal agent and work agent share owner identity, Profile Claims, grants, commitments, receipts, and acceptance semantics. They do not share arbitrary raw transcripts, local files, or ambient credentials.

Kennel later becomes:

- a presence for reviewing work;
- a capability-declared local executor;
- the owner of local workspace bytes/process durability; and
- a source of artifacts and bounded observations.

Backend remains the owner of identity, authority, canonical commitments, memory admission, acceptance, and cross-surface order. Defer cloud workspace migration, portable checkpoints, multi-agent DAG UI, and broad coding orchestration until the personal-agent loop is stable and the user explicitly selects work-agent scope.

## 14. Build versus buy

| Capability | Decision now | Waldo must still own |
|---|---|---|
| owner authority, memory admission, commitments, effects, receipts | build/retain | all canonical truth and policy |
| model inference | buy provider API behind existing gateway seam | context, capability manifest, budgets, sanitization, evals |
| model routing | one default route plus a bounded reasoning/fallback ladder; pins selected and changed by eval | fail-closed privacy, spend ceilings, provider-shaped rendering, and no duplicate effects |
| OAuth and credentialed connector execution | direct Google APIs through Supabase Vault + typed connector Edge Function/proxy; Nango/equivalent is future-ADR research only | ConnectionGrant, exact operations, approvals, deletion, audit, secret/bearer isolation |
| Google Workspace | official APIs | incremental scopes, action policy, read-back |
| Granola/Swiggy | official API/MCP where supported | schema normalization, authority, receipts |
| long-tail SaaS | later evaluate Composio/MCP providers | source admission, per-turn capability, conformance |
| browser/computer | managed service behind `BrowserExecutionPort` | domain/action policy, approvals, reconciliation, evidence |
| identity/data | retain Supabase + per-owner DO split | RLS, single writers, deletion, account lifecycle |
| agent framework | do not replace current runtime | thin Conversation Orchestrator only |
| payments | provider checkout/tokenized handoff | exact-price approval and receipt; never raw card/OTP custody |

No vendor is considered integrated because it appears in this table.

## 15. Keep, modify, freeze, remove

### Keep

- per-owner DO/SQLite authority root;
- `IdentityPresenceModule`, `WaldoCoordinator`, `JudgmentAuthorityModule`;
- RunLoop journal/outbox, alarms, leases/fences, cancellation and reconciliation;
- ContextComposer provenance and source sanitization;
- intent-before-I/O and one retry owner;
- Evidence, Verification, Acceptance, Outcome, and Open Loop separation;
- Health Scribe/destination privacy floor;
- strict schemas, fixtures, generated OpenAPI, and proof-level reporting.

### Modify

- add one `ConversationModule` and production composition path;
- simplify memory to Profile Claims, Episodes, Commitments, and Relationship State;
- replace broad `user_message` tool visibility with per-turn capability resolution;
- extend Calendar from proposal-only to approved apply/read-back/reconcile;
- extend Email with bounded search/read while preserving explicit send approval;
- turn closure v0.6 contracts into a runtime path only when the conversation/effect corridor needs it;
- make Google/Health/meeting connections incremental and purpose-bound;
- make app state truthful and generated from backend contracts.

### Freeze

- multiple provider/model routing breadth;
- generic MCP/catalog expansion;
- dreaming, patrol, broad automatic profiling, and self-modifying skills;
- Kennel cloud portability and multi-agent work graphs;
- Telegram/Discord launch work;
- broad work SaaS connectors;
- watchOS UI breadth and Live Activities;
- graph database/vector infrastructure beyond an evaluated search projection.

### Remove from launch and documentation authority

- fictional success and demo fallback behavior;
- raw password/card/TOTP vault scope;
- all-at-once OAuth onboarding;
- product-wide B0–B6/desktop-first/Telegram+Discord launch sequencing;
- duplicated status tables and giant overlapping architecture plans;
- any claim that local fakes, schemas, or simulator UI prove a working agent.

Do not delete runtime code solely because it is frozen. Runtime removal requires import/build/deployment inventory, a tested replacement, rollback, and consumer migration. This documentation cleanup removes stale guidance; Git history preserves its exact content.

## 16. Dependency-ordered build gates

These are dependency gates, not one strictly serial queue or substitute products. Time ranges are planning ranges for one focused implementation lane with agent/reviewer support; they exclude external OAuth/platform approval time.

After G0, run one launch spine plus two bounded readiness lanes:

- **agent launch spine:** G1 conversation/memory, G2 Calendar/Today, then G2a Open Loops/proactivity/APNs/Activity; release the founder alpha only after the joined daily loop passes;
- **Apple truth lane:** repair account/consent partitioning, truthful HealthKit states, native tests, simulator builds, signing, and physical-device fixtures, joining the corridor at G5; and
- **external access lane:** probe/apply for Google verification, Granola plan/webhook access, Swiggy production access, official WhatsApp eligibility, and Apple certificates/profiles. This lane may prove availability but cannot claim product integration.

After G2a, run G3 Trusted Relationships, G4 bounded Gmail/selected Drive/meetings, and G5 physical-device health as disjoint parallel depth lanes. Each must reuse G1 memory, G2 connector/effect, and G2a scheduling/Activity surfaces. G6/G7 action reach follows one proved API corridor; G8 joins channels; G9 attaches the later work-agent surface.

Adapter contracts, provider sandboxes, and conformance fixtures may start in the external lane once their writer and authority boundaries are fixed. No lane may publish a user-visible success path before the G1 conversation/receipt corridor exists, and every join reruns cross-owner, revocation, retry, and deletion tests.

### G0 — Truthful baseline and documentation convergence (1–3 days)

- review/merge one canonical build plan and thin entrypoints; publish the amended/superseding Brain launch contract plus every retained/amended/superseded ADR disposition named in §§2.3–2.4; then repin the plan/entrypoints and regenerate/diff `accepted-adrs.json` from that Brain revision before implementing any conflicting seam;
- publish one live data-path register for every admitted source and derived object: collection trigger, fields, purpose, canonical owner, every processor/model/storage copy, training/default-improvement setting, retention and backup horizon, region/DPA state, revoke/delete path, and `live | limited | planned | retired` status; a privacy-policy sentence or adapter interface is not runtime proof;
- make conversation useful with zero connectors, and require separately selectable grants; a Calendar-only choice must not enroll Gmail, Drive, Contacts, or a bundled super-scope;
- prohibit always-listening microphone capture, ambient transcription, and transcript-derived durable memory through G0–G4; any future capture proposal requires a separate bystander-consent, on-device-first, retention, model-egress, correction, and deletion gate;
- define joined identity lifecycle and deletion across the app account, website/waitlist, messaging presences, marketing records, analytics, connector grants, support/application records, provider mirrors, recovery copies, and backups; the deletion receipt distinguishes `deleted`, `revoked`, `pending provider`, `backup expiry`, and `failed` rather than collapsing them into one success;
- ban absolute claims such as “private,” “nothing leaves,” “deleted,” “encrypted so we cannot read it,” or “on device” unless the ordinary-language meaning is true for every relevant copy and processor; add claim-to-evidence tests for public copy and in-product receipts;
- define non-user data handling before importing email, meetings, contacts, relationship messages, or audio: minimization, notice where feasible, source visibility, correction/removal, retention, model egress, and abuse/report handling;
- create clean backend/app worktrees at fresh remote pins;
- remove app fictional success;
- put the entire authenticated app group behind a protected route/auth gate, including direct and stale deep links;
- bind each device/session to an inspectable owner session, expose last-active/revoke controls, and prove a revoked or stale device cannot resume connector work, receive private pushes, or replay approvals;
- define an account epoch such as `(owner_id, auth_generation, consent_epoch)` and bind every Query key, Zustand projection, SQLCipher store, SecureStore preference/watermark, subscription, queued operation, callback, and background job to it;
- on logout/account switch, advance the generation first, cancel in-flight query/mutation/upload work, reject stale completions, clear visible stores, close the prior account database, and only then admit the next owner;
- disable legacy health upload by default until separate cloud-processing consent exists; device HealthKit authorization never creates Waldo cloud consent;
- resolve or explicitly version the closure OpenAPI/runtime mismatch;
- lock the additive one-Presence-to-multi-presence contract, schema migration, compatibility read path, rollback, and channel-lane owner; preserve the current app binding until G8 proves multiple active presences rather than putting that migration on the founder-alpha critical path;
- inventory existing OAuth token tables/functions, reconcile them to the single Vault/typed-connector-proxy boundary, and specify rollback for that reconciliation;
- start Google brand/scope verification and restricted-scope Limited Use/CASA readiness: exact scope justification, verified domains, public privacy/data-deletion pages, processor/data-flow inventory, test-user project, and annual-assessment ownership;
- publish the provider/route-by-data-class egress matrix and DPA/retention/region evidence; a synthetic log canary proves only the observable capture paths it exercises and cannot substitute for provider-wide retention/ZDR/DPA evidence;
- prove app dependency install, tests, simulator build, and backend verification wall;
- record signing/physical-device prerequisites.

**Exit:** no demo fallback can look like a receipt; exact baselines and failures are recorded. A fresh owner reaches useful conversation without a connector, Calendar-only authorization exposes no Gmail/Drive/Contacts grant, and the data-path/deletion registers reconcile every admitted copy with provider evidence and truthful UI language. Deterministic A→B, device-revoke, joined-deletion, and logout tests race chat, Calendar request, connector callback, subscription delivery, background health upload, queued work, and deep-link processing and prove zero A-owned display, cache reuse, write, upload, or delivery under B. Server RLS remains mandatory but is not accepted as protection against stale local state.

### G1 — Hello Waldo: production conversation + compact personalization (5–10 days)

- authenticated app turn, server IDs/order/cancellation, streaming model response;
- one simple owner surface organised as `Today`, `Open Loops`, `Memory`, `Activity`, and `Connections`; internal Profile Claim/graph/protocol terms remain progressive disclosure rather than becoming competing product nouns;
- visible `Stop` and steer controls; stopped work cannot later publish a success response or durable memory update;
- one evaluated default model route plus a bounded reasoning/fallback ladder with spend, safety, context, and data-class ceilings;
- enforce `ModelEgressPolicy` before every provider/fallback attempt; G1 admits no mail, meeting, or health context until its route passes the corresponding data-class gate;
- Supabase conversation graph plus backend `ConversationPublicationService`, coordinated by DO run/outbox state without a second transcript; exact input and output bytes follow the hidden staged/reserved/committed lifecycle in §6.1;
- digest-bound per-turn capability resolver enforced again at dispatch;
- reviewed voice pack and user style settings;
- if reviewed static procedures are used, separate acquisition, scan/review, installation, activation, execution, update, and emergency revocation; record source/license/version plus a recursive digest over instructions, scripts, references, assets, and pinned dependencies, compatibility/tool requirements, evaluation, and sandbox/egress needs; popularity, provenance labels, or a scanner result are evidence but never proof of safety, progressive disclosure and a file format never grant execution authority, and resume rejects a revoked, changed, or incompatible version;
- Profile Claim propose/inspect/correct/delete, with source, evidence/status, purpose, freshness, “why Waldo knows this,” and a direct correct/forget path on every durable claim; forget preview states what is deleted, retained for a bounded reason, rebuildable, provider-held, or backup-pending;
- conversational quality evaluation for warmth, specificity, uncertainty, stable style, interruption recovery, and useful initiative, with explicit failures for clinginess, coercive attachment, fabricated intimacy, invented emotional insight, or confident personality inference from thin evidence;
- generated app client and no direct legacy success path.

**Exit:** a fresh install reaches a verified useful response with no connector and without exposing provider, tool, gateway, or workflow-builder complexity. Real multi-turn conversation survives restart, correction, forget/delete, contradiction, mid-stream cancellation, unsafe output, and provider failure without duplicate, resurrected, or fictional output. Every retained claim can answer why/how it was learned, current status, purpose, and freshness; a forget preview and later verification match the actual deletion lineage. A stopped turn publishes neither success nor later side effects. Fault injection kills the process after input stage, DO reservation, input commit, assistant stage, publication intent, and assistant commit, then restarts without client retry; changed-byte replay, revoke/delete at every boundary, orphan expiry, and later-turn liveness pass without a regenerated answer or wedged sequence. G0's A→B isolation floor passes on the real conversation path. A pure conversation exposes zero effect/MCP tools; dispatch rejects any operation absent from the turn manifest; lazy discovery cannot widen or mutate the frozen manifest. Procedure fixtures additionally prove recursive-digest mismatch, hidden script/resource substitution, dependency drift, activation/revocation races, output/context amplification, and aggregate token/tool/verifier/retry budget enforcement. Blinded conversation review has no critical manipulation/fabricated-intimacy failure and meets predeclared usefulness, personality, and controllability thresholds.

### G2 — Google Calendar vertical slice (4–8 days)

- incremental OAuth and Connection controls, beginning with an independently revocable Calendar-only grant; Connections displays granted scopes, account, last sync/use, errors, and revoke/delete consequences;
- a cited on-demand `Today` brief combines Calendar source records and owner-approved Open Loops without ambient capture or hidden inbox expansion;
- harden and prove the single Vault/typed-connector-proxy boundary; migrate or remove any conflicting legacy secret path without dual-write or exposing bearer tokens to the DO;
- read/free-busy/find slots;
- per-turn manifests admit only the exact Calendar reads/writes required by the request and approved proposal;
- primary-calendar, owner-only/non-recurring proposal, approval, apply with `sendUpdates=none`, client-chosen create ID, `If-Match` update/delete, etag-bound read-back, reconciliation, revoke; the deterministic approval card sits outside model prose and shows provider account/calendar, exact before/after, notifications, authority expiry, and what remains unapproved;
- Open Loop/update/receipt in app;
- record trust-speed measures—time to first value, turns, permissions requested, approval corrections/abandons, and successful revoke—without relaxing the authority boundary;
- prompt-injection and cross-owner tests.

Proxy adversarial tests cover bearer exfiltration, arbitrary URL/path injection, SSRF, resource/account substitution, operation confusion (including draft-to-send), manifest/digest substitution, replay/expiry, response oversize/secret reflection, revoke during execution, and provider commit followed by transport loss.

**Exit:** a zero-connector owner can opt into Calendar only, receive a source-cited `Today` view, inspect the exact approval, apply one primary-calendar owner-only event change, and revoke the connection without a hidden Gmail/Drive/Contacts grant. The effect is source-verified and retry-safe in a test account across timezone/DST, response loss, duplicate create, external edit/delete/move, ambiguous absence, and stale-etag `412`; a `412` produces a new proposal and never overwrites. Account switching during OAuth callback, read, and write proves zero cross-owner display or effect. Predeclared trust-speed thresholds pass without an unauthorized, ambiguous, or falsely completed action.

### G2a — Open Loops, proactivity, Activity, and APNs (3–6 days)

- explicit commitments created from an owner request, accepted memory proposal, or Calendar outcome; no ambient/inferred promise mining;
- one reminder/follow-up engine with stable occurrence identity, timezone/travel, overlap, lateness/misfire, expiry, bounded recovery, and inspect/edit/pause/resume/cancel/history controls;
- deterministic/no-model execution for reminders and watchdogs that need no judgment; separate execution and delivery status, owner-visible run history, no recursive routine creation, and dead-letter/watchdog repair after alarm retry exhaustion;
- every proactive item states `why now` and the admitted sources, and offers done, snooze, dismiss, incorrect, and dial-down/off controls that update future behavior without silently creating durable personality claims;
- owner-bound APNs token registration/rotation/revocation, minimal lock-screen payloads, quiet hours, and deep links to canonical state;
- one joined Activity surface for proposal, approval, running/tool activity, stop, waiting, reconciliation, completion, delivery, failure, revoke, and deletion; chat is not the only audit surface;
- manual-first routine creation: prove one safe occurrence, then show owner, schedule/time zone, input source, expected result, approval boundary, missing/stale-data behavior, next run, and notification plan before enablement;
- every enabled obligation exposes owner, purpose, source, destination, cadence/event, current authority, expiry, cancel control, last result, next run, and delivery proof; a chat mention alone never grants recurring authority;
- no-change runs remain silent and leave an inspectable no-op record rather than manufacturing engagement;
- explicit `Stop`/pause semantics across scheduler, run, delivery, and publication so a cancelled occurrence cannot later emit success or a stale notification.

**Exit:** an owner creates one Open Loop in conversation, sees it alongside Calendar context in `Today`, receives exactly one quiet-hours-compliant APNs follow-up with a source-grounded `why now`, resolves it through done/snooze/dismiss/incorrect/dial-down, and can inspect or stop every state in Activity. Disabled, quiet, and no-change states produce zero notifications. Recovery distinguishes what was attempted, what external effect occurred, available evidence, Verification, Acceptance, and the remaining Open Loop. Tests cover DST gaps/repeats, travel, overlap, pause/reschedule/cancel in flight, missed/lost/duplicate alarm delivery, restart, alarm retry exhaustion, no-action decisions, delivery failure after successful execution, recursive-schedule rejection, stale notification deep links, and recovery that cannot evade the aggregate budget. Predeclared helpfulness/nuisance thresholds pass with zero critical authority, disclosure, duplicate-delivery, or false-success failures.

### G3 — Trusted Relationships (5–10 days)

- entry criterion: accepted identity/signature, authenticated-encryption/key-agreement, relay, key-lifecycle/recovery, forward-secrecy, retention/deletion ADR and threat model before any cross-owner data;
- invite/accept/revoke/block/report;
- the recipient sees the requesting owner and narrowly stated purpose before acceptance; acceptance never grants a general profile, memory, inbox, calendar, health, connector, or inferred-relationship view of the other person;
- signed envelope, expiry, replay/dedupe and abuse controls;
- minimal availability negotiation;
- independent approvals and dual receipts;
- private decline/failure semantics and one-sided-apply compensation.
- independent relationship-object export/deletion/revoke for each owner, including relay copies and pending invitations, without deleting or exposing the other owner's private state;

The accepted threat model must name message/key endpoints and the Waldo operator/server threat boundary. Server-root encryption is not described as operator-confidential unless the selected protocol and evidence actually provide that property.

Calendar invitations or attendee notifications are not the cross-owner authority protocol; each Waldo applies only its owner's owner-only event in this gate.

**Exit:** two test owners schedule/reschedule or decline without sharing event titles, memory, inferred profiles, or authority. Wrong-person acceptance, recycled identity, forwarded invite, compromised device, replay, blocking, harassment/report, one-sided deletion, and one-sided revocation fixtures preserve the same boundary and leave an inspectable receipt. Public non-user/recipient handling language matches the tested protocol.

### G4 — Gmail, selected Drive, and meeting context (5–10 days)

- Gmail defaults to metadata/snippet search; opening a selected thread/body is a separately visible read and attachments require their own explicit admission; send uses the immutable approved RFC 5322/MIME snapshot through `users.messages.send`, preserves the mutable provider draft, and remains a separate exact approval outside model prose with exact account, recipients, subject, body, attachments, authority expiry, and changed-since-review invalidation;
- selected Drive files only;
- Granola read-only retrieval with citations, signed-webhook admission, and bounded backfill;
- waiting-reply detection only through bounded scheduled re-reads of owner-admitted exact Gmail thread IDs and the G2a engine; no general inbox monitor or implied watch stream;
- connector availability and revocation UX.
- Gmail/meeting occurrences reuse G2a's manual-first routine, Activity, stop, delivery, and notification contracts rather than creating connector-specific automation state;
- voice/transcription/inference/analytics subprocessors and their retention/training posture are visible before sensitive data is admitted.

**Exit:** Waldo prepares for a meeting, drafts a follow-up, and tracks/notifies it through G2a without silently sending, leaking private notification content, or retaining unrelated content. Every proactive item retains source-grounded `why now` and working controls. The Gmail suite edits a provider draft after the last read, substitutes MIME/header/recipient/attachment data, races revoke, simulates provider success plus response loss, and proves the approved immutable message is the only possible send while external draft edits remain intact. Waiting-reply occurrences inherit and pass G2a's schedule/delivery/recovery suite. APNs provider acceptance is not misreported as user display or acknowledgement, and Activity reconciles connector execution, delivery, revoke, and deletion to their source records.

### G5 — Health-aware planning on physical devices (7–14 days)

- consent/account lifecycle repair;
- small incremental HealthKit set;
- typed freshness/provenance and background ingestion;
- purpose-bound derived planning view;
- explanation, correction, revocation/deletion;
- purpose-specific HealthKit usage descriptions, public privacy/App Privacy disclosures, and an Apple HealthKit/App Review/license compliance check for the cloud/LLM path;
- iPhone simulator + physical iPhone proof; Watch only if the phone corridor passes.

**Exit:** health-connected, Waldo-consent-declined/revoked, `no_accessible_data`, stale, and limited-history scenarios all produce truthful plans without inferring HealthKit read denial.

### G5b — Supported health-pattern awareness (7–14 days plus evidence collection)

- accept the ADR-0081 `HealthPattern` extension and destination/retention matrix before persistence;
- implement only predefined observational pattern families with explicit minimum evidence, support, missingness, freshness, source/method compatibility, provenance, uncertainty, consent epoch, and expiry;
- keep candidate/supported/dismissed/expired/deleted lifecycle in the protected health plane;
- expose `insufficient_history`, evidence scope, correction/dismissal, and deletion in the app;
- run golden, longitudinal, negative-control, source-change, correction, deletion, and consent-revocation fixtures;
- review every user-facing explanation for causal, diagnostic, treatment, or false-confidence language.

**Exit:** supported, candidate, insufficient-history, dismissed, stale, corrected, revoked, and deleted cases remain reproducible and cannot resurrect through memory/search/context. G5b is required for the competitive release candidate; it does not block the smaller founder alpha.

### G6 — India transaction corridor (5–10 days)

- Swiggy official adapter or verified supported surface;
- search/cart/exact-price approval/checkout takeover;
- timeout/read-back, cancellation/refund handling where supported;
- credential and payment-secret negative tests.

**Exit:** one test order corridor reaches an honest receipt or takeover state without secret exposure or blind retry.

### G7 — Managed browser fallback (5–10 days)

- vendor spike against `BrowserExecutionPort`;
- isolated sessions, allowlist, trace/redaction, takeover, budgets and cleanup;
- prompt-injection and authenticated-session tests;
- effect-specific approval for communication, purchase, deletion, publication, authentication, permission change, or external mutation; no normal-path `approve all`, permanent desktop grant, or provider `--yolo` equivalent;
- one non-payment use case, then one user-takeover transaction.

**Exit:** a failed/ambiguous browser run cannot be reported as done or repeated blindly.

### G8 — Channels and joined release (external lead time dominates)

- migrate and prove independently revocable multi-presence bindings through the G0 compatibility/rollback contract before enabling a second active presence;
- add the protected `PresenceClaimRegistry` as the sole global reservation/activation/revoke-generation writer for `(provider namespace, provider subject)` while owner DOs remain the permission authority; recover partial reservations and require explicit step-up for recycled identities;
- realtime/app delivery hardening and cross-surface ordering;
- inbound email with provider webhook authentication, explicit sender linking or step-up, per-owner aliases/nonces, quoted-text and attachment limits, bounce/auto-reply/unsubscribe loop suppression, and bounded retention;
- channel pairing proves who may communicate through that presence but never grants authority over another connector, device, relationship, workspace, or shared channel; cross-presence effects require the same owner/capability checks as the app;
- official WhatsApp adapter only if Meta has supplied the required Third Party Agent/provider admission and test tenant; otherwise omit it from the release claim;
- App Store submission disclosures and HealthKit/privacy compliance evidence distinct from device-function evidence;
- deletion/export, incident controls, observability and cohort acceptance;
- cost/concurrency/backpressure/load proof.

**Exit:** advertised surfaces pass real test tenants/devices and an owner can trace and revoke every connection/action. Two owners racing the same provider subject produce one recoverable claim; partial activation, expiry, revoke/relink, recycled-number, and late-callback cases cannot inherit prior authority. Email spoofing, alias/nonce replay, oversized/hostile attachment, quoted-instruction, bounce/auto-reply loop, unsubscribe, and deletion tests pass.

### G9 — Work-agent bridge

- release versioned execution/artifact contracts to Kennel;
- local executor with bounded workspace grant;
- separate work context from personal context by purpose;
- later add broad work connectors only from measured demand.

## 17. Evaluation and battle-test matrix

### 17.1 Product scenarios

1. **Correction:** “I no longer eat dairy.” Old preference is superseded everywhere.
2. **Calendar ambiguity:** apply succeeds but response times out; Waldo reconciles and does not duplicate.
3. **Email injection:** a message says to reveal memory or change rules; it remains untrusted source text.
4. **Stale health:** latest data is old; Waldo states the limitation and does not invent readiness.
5. **Account switch:** owner A sync is in flight when the app switches to B; A data never enters B state.
6. **Relationship privacy:** A asks why B declined; A sees a private decline, not B's calendar/health reason.
7. **Connector revoke:** Google is revoked mid-run; effect stops/reconciles and the Open Loop explains the block.
8. **Swiggy price change:** cart total changes after approval; approval is invalidated.
9. **Browser injection:** page content attempts to alter policy or access another domain; action is rejected.
10. **False completion:** model says “done” without source receipt; state remains unverified.
11. **Deletion:** deleted memory is absent from canonical store, indexes, summaries, prompt caches, and future jobs.
12. **Cross-surface race:** simultaneous app/channel messages produce one ordered owner history.
13. **Pattern correction:** a supported health association loses eligible evidence or the user corrects context; it becomes corrected/insufficient/dismissed and never resurfaces from memory.
14. **Publication restart:** the process dies after staging/reservation with no client retry; exact input/output bytes recover or terminate honestly and the next turn remains live.
15. **Gmail draft race:** another client changes the draft after approval; Waldo can send only the frozen approved MIME snapshot and preserves the external draft change.
16. **Routine recovery:** an alarm is duplicated, missed, or delivered across DST/travel; one occurrence advances within budget and remains inspectable/cancellable.
17. **Destination injection:** a page, email, or meeting note supplies a new recipient or upload destination; Waldo may quote it in a proposal but cannot authorize or dispatch it without independent typed owner authority.
18. **Procedure amplification:** a reviewed procedure or tool output recursively expands context, retries, or verifier calls; the aggregate run budget terminates it truthfully and records the cause.

### 17.2 Metrics

- task success and verified final state;
- false-completion rate;
- unauthorized action/data-disclosure rate;
- approval precision and unnecessary-interruption rate;
- preference recall, update, correction, deletion, and abstention;
- temporal memory update accuracy and correct abstention under missing/contradictory evidence;
- source citation/provenance accuracy;
- duplicate-effect and indeterminate-effect resolution;
- no-progress loop detection plus aggregate agent/tool/verifier/recovery budget adherence;
- user-rated usefulness, trust, personality consistency, and controllability;
- latency, tokens, browser minutes, connector/API cost, and cost per verified task.

Predeclare tasks, trial counts, denominators, severe-failure rules, and source-of-record graders. Run every trial from an isolated clean environment and report both aggregate success and consistency measures such as `pass^k` for customer-facing flows where every repeated attempt must succeed. Bound evaluator/repair iterations and include their spend in the task budget. Preserve bounded trajectories—not just final prose—so tool choice, approval, reconciliation, resume, and no-progress failures are diagnosable. Use same-model ablations: no durable memory; memory without health; complete Waldo. Keep held-out histories and repeated trials. Long-horizon memory fixtures cover temporal updates and abstention, but recall benchmarks do not prove deletion or tenant isolation. A finite green eval suite is not universal safety proof.

### 17.3 Competitive reverse-engineering and parity lab

Waldo should study, benchmark, and reverse-engineer the observable product experience of serious peers. That work is not removed merely because a vendor publishes restrictive terms. Record applicable account terms, access method, data risk, and collection constraints in the benchmark record so the owner can make an informed decision; treat them as a method/risk input, not as a substitute for product judgment or an automatic roadmap veto.

Use four evidence lanes and never merge their claims:

1. **Public-source teardown:** first-party product pages, documentation, policies, release notes, demos, screenshots, and public code establish documented capability and intended experience.
2. **Owner-operated black-box study:** with an account the owner controls, run ordinary user-visible flows against synthetic data; record the dated product state, prompts, clicks, permissions, timing, outputs, corrections, failures, and source-of-record effects.
3. **Self-hosted/open implementation study:** install or inspect public source and docs for Hermes/OpenClaw-class systems; trace tool, memory, schedule, browser, channel, and recovery behavior without treating their architecture as Waldo's product architecture.
4. **Clean-room Waldo reproduction:** translate observed user outcomes into independently written fixtures and contracts. Do not copy private code, credentials, proprietary prompts, hidden data, or another user's content; do not bypass access controls, disrupt a service, or claim an unobserved internal mechanism.

The core cross-product fixture pack covers:

1. useful zero-connector first session;
2. personality continuity without fabricated intimacy;
3. remember/update/contradict/correct/forget with provenance and no resurrection;
4. cited `Today` and inspectable Open Loops;
5. Calendar-only connect/read/propose/approve/apply/read-back/revoke;
6. Gmail metadata-first search, selected-thread read, draft, exact approval, and send when G4 is admitted;
7. source-grounded proactivity with why-now/done/snooze/dismiss/incorrect/dial-down controls;
8. visible activity, steer/stop, recovery, and no late fictional success;
9. data-path comprehension, non-user handling, joined deletion, provider-pending state, and backup expiry;
10. Trusted Relationship invitation, purpose, scheduling, decline, revoke, and abuse cases.

Use dedicated synthetic owners, biographies, calendars, mailboxes, health summaries, contacts, and relationship messages. Freeze the task, initial state, connector grants, expected authority, provider source of record, fault schedule, grader, and severe-failure rule before each run. Preserve bounded trajectories rather than final prose alone. Blinded reviewers score usefulness, personality continuity, specificity, factuality, friction, initiative, correction/forget behavior, and control; deterministic graders independently verify effects, source citations, deletion, and revocation.

| Dimension | Acceptance floor |
|---|---|
| truth and authority | zero critical unauthorized action/disclosure, fictional success, deleted-memory resurrection, or misleading privacy/deletion receipt |
| first value | works with zero connectors; record predeclared p50/p95 time, turns, permissions, and abandonment thresholds |
| personalization | repeated remember/update/contradict/correct/forget fixtures pass, with provenance and correct abstention under weak evidence |
| control | an owner can explain why Waldo knows/notified/acted, stop a run, inspect Activity, revoke a connector, correct/forget a claim, and obtain a deletion-state receipt |
| effects and recovery | exact proposal/approval/read-back match the provider record; timeout, restart, revoke, and response-loss faults create no duplicate or false success |
| proactivity | every item has a source-grounded `why now`; quiet/disabled states are silent; helpful, ignored, snoozed, dismissed, incorrect, and dial-down outcomes meet predeclared nuisance thresholds |
| longitudinal quality | a small 7/14-day synthetic and consenting-test cohort meets predeclared usefulness, personality, memory-correction, friction, and controllability thresholds without weakening the zero-critical-failure rule |

Run the pack first against Waldo and every available peer surface. Use the same synthetic biographies, calendars, mailboxes, tasks, relationship scenarios, and scoring rubric where the products support comparable surfaces. Preserve screen recordings/screenshots, prompts, action traces, correction attempts, latency, interaction count, permission friction, and final source state. Mark unsupported or inaccessible surfaces `not comparable`; do not invent a result. Repeat critical flows enough to measure consistency, not just the best run.

Waldo may claim “tested-scope parity” with a named, dated product only for the scenarios actually run and evidenced. It must still have zero critical authority, privacy, cross-owner, deletion-resurrection, or false-success failures; a competitor's weaker control does not lower Waldo's floor. Public-source teardowns can define hypotheses but cannot alone prove parity, and private internals remain unknown unless independently evidenced.

### 17.4 Proof ladder

```text
unit/schema
-> Workers/native integration
-> adapter conformance with deterministic fakes
-> real sandbox/test account
-> cross-repository app/backend fixture acceptance
-> staging and fault injection
-> physical device/channel acceptance
-> small cohort operational proof
```

## 18. Apple end-to-end test plan

| Environment | What it can prove | What it cannot prove |
|---|---|---|
| Jest/TypeScript | transformations, consent state machines, generated client behavior | native entitlements or HealthKit behavior |
| XCTest | Swift mapping, per-field state, anchor/account lifecycle | real sensor delivery without device setup |
| iPhone simulator | navigation, permission/no-data UI, sample-data flows, deep links | production background delivery and real sensor/source behavior |
| paired iPhone/Watch simulators | target embedding, watch UI, shared serialization, and URL/routing fixtures | `WatchConnectivity` transfer, background callbacks, physical lifecycle/power, and pairing reliability |
| physical iPhone | HealthKit authorization/query, background delivery, keychain, push | physical Watch behavior |
| physical iPhone + Watch | source provenance, WatchConnectivity, background/lifecycle | TestFlight distribution/production provider behavior |
| TestFlight + staging | signing, provisioning, APNs, staging connectors, cohort update path | production scale/operations |

Before physical-device work:

1. create/download a valid Apple Development signing identity and profiles;
2. select a clean app worktree and repository-pinned pnpm;
3. add native unit/UI test targets (the current shared scheme references a nonexistent test target);
4. make the phone app embed/configure the watch target only if watch scope is active;
5. use synthetic/sample data first, then explicitly authorized owner test data;
6. keep screenshots/logs free of raw health and personal content.

## 19. External gates and risks

| Gate/risk | Current state | Mitigation |
|---|---|---|
| Google restricted/sensitive scopes and verification | not proved; Gmail metadata/read/compose are restricted, and server storage/transmission ordinarily triggers annual assessment | begin G0 Limited Use, exact-scope justification, verified domain/privacy/deletion materials, test-user plan, restricted-scope review and CASA readiness; no external-beta Gmail claim before approval |
| model/gateway processing of personal source data | DPA/ZDR/region/retention and payload-log-off proof not completed in this pass | default-deny route-by-data-class matrix; gateway payload logs default-off plus explicit per-sensitive-request suppression that fails closed; bounded synthetic canary for observable capture paths plus separate provider contractual/retention evidence; no mail/meeting/derived-health content until admitted; fallback cannot widen egress |
| WhatsApp general AI eligibility in India | **currently blocked by the public Business Solution Terms** unless Meta admits Waldo to the Third Party Agent path or authoritatively confirms another eligible route | seek provider admission/test tenant; app/email fallback; no workaround or advertised WhatsApp support |
| Apple signing | account exists per owner; zero local identities observed | configure Xcode team/certificates/profiles before physical proof |
| HealthKit/App Store compliance | not proved | purpose-specific usage text; privacy policy/App Privacy disclosure; permitted cloud/LLM review; deletion/export; no ads, data-broker sale, or marketing use of HealthKit data |
| Granola plan/API eligibility and Swiggy production credentials | not proved; Swiggy production access is invite-based | API/plan probe and production-access application before launch claim |
| Health computation/pattern extension | ADR-0081 floor exists; G5b extension not yet accepted or built | accept bounded record/destination contract; golden, longitudinal, correction and deletion fixtures |
| conversation publication/retention | Supabase/DO ownership is accepted; production writer, retention and deletion corridor are unproved | publication service, RLS, retention/deletion/export and restart proof before G1 persistence |
| relationship confidentiality, keys, and relay placement | proposed | identity/signature plus authenticated-encryption/key-agreement, recovery, forward-secrecy, relay retention/deletion ADR and threat model before cross-owner data exists |
| browser vendor reliability/cost | unknown | timeboxed vendor bake-off and kill criteria |
| competitive-study collection method | peer access, terms, observable surfaces, and reproducibility vary by product | log access/method risk, use synthetic owner-controlled data, separate public, black-box, self-hosted, and clean-room evidence, and bound every parity claim to the exact dated scenarios actually run |
| remote reconciliation branches | docs exist but are not merged | review together; do not create competing authorities |

## 20. GPT-6 Astra review packet

Review this document and the branch diff against exact source pins. The reviewer should answer:

1. Does the current-state section overclaim any runtime, adapter, app, Apple, or market capability?
2. Can G1–G4 be built by extending the existing kernel, or does a named seam require replacement?
3. Is Supabase conversation ownership plus DO execution coordination single-writer, restart-safe, and deletion-safe without pretending cross-store atomicity?
4. Can the proposed per-turn capability manifest actually constrain the existing tool path?
5. Does Calendar intent-before-I/O/read-back handle every apply/timeout/retry case?
6. Can Trusted Relationships leak another owner's identity, calendar, health, refusal reason, or authority through relay plaintext/metadata, key recovery, protocol downgrade, or a compromised device?
7. Are HealthKit consent, freshness, account switching, background delivery, and device proof complete?
8. Are browser/payment/India flows safely bounded, or should any remain user-takeover only?
9. Which frozen components are still transitive runtime dependencies and therefore cannot be removed yet?
10. Are the build gates small enough to test independently, and is every gate's exit observable?
11. What is the strongest counter-plan that reaches a competitive personal agent faster without weakening authority/privacy?
12. After review, produce implementation issues only for the first dependency frontier; do not fan out all gates as simultaneous writers.
13. Does the typed connector proxy truly prevent bearer-token exfiltration, arbitrary provider calls, Gmail draft-to-send escalation, replay, SSRF, and resource substitution?
14. Does the provider-by-data-class egress gate cover DPA/ZDR/region/retention/logging and every fallback path?
15. Can multi-presence linking survive recycled phone numbers, cross-owner claims, late webhooks, simultaneous turns, and echo loops?
16. Are the health-pattern thresholds, negative controls, correction/deletion semantics, and noncausal wording sufficient to justify a release claim?
17. Does “deliberate continuity” plus zero-connector value, incremental grants, per-claim provenance, joined deletion, and no ambient listening through G4 form a coherent and defensible product wedge against Moonshot's ambient-memory model?
18. Does the four-lane competitive lab separate public evidence, owner-run black-box observation, open/self-hosted implementation study, and clean-room Waldo reproduction while still producing a rigorous tested-scope parity claim, and which thresholds must be fixed before implementation begins?

## 21. Documentation migration and source register

### 21.1 Replaced live guidance

The following August documents are no longer live authority. Their unique stable decisions are represented here; their full text remains recoverable at [`e91bee0`](https://github.com/Pin4sf/waldo-backend/tree/e91bee017b0c36759cbfda1353fc11c73e3afe0a/docs):

- Product Architecture Convergence;
- Architecture Lock and Whole-Product Build Direction;
- Product Capability Matrix;
- Final Home + Work Architecture;
- B2–B6 Goal Execution Contract;
- dated backend/Brain, Kennel/mobile, Cloudflare, Spotify/Xirp, Grok Bot, source-note, and benchmark audits.

Accepted ADRs, universal rule mirrors, current contributor/verification method, generated contracts, and dated execution ledgers remain. Historical ledgers are evidence, not current sequencing.

### 21.2 Internal pins

- [Backend main `e91bee0`](https://github.com/Pin4sf/waldo-backend/tree/e91bee017b0c36759cbfda1353fc11c73e3afe0a)
- [App main `7218c18f`](https://github.com/Pin4sf/waldo-app/tree/7218c18fed8b874492e3831bbb5bd1e1c58abe58)
- [Brain personal-agent launch contract `be08c4a`](https://github.com/Pin4sf/waldo-brain/blob/be08c4afa6f356c66600e73ae0bf54e5d7a3a158/01-Waldo/product/WALDO_PERSONAL_AGENT_LAUNCH.md)
- [Brain PR #31 research/review record `43be41e`](https://github.com/Pin4sf/waldo-brain/pull/31), including the [PR #138 architecture review](https://github.com/Pin4sf/waldo-brain/blob/43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7/03-References/research/waldo-backend-pr138-architecture-review-2026-09-18.md) and [harness-engineering source/adoption register](https://github.com/Pin4sf/waldo-brain/blob/43be41e1a24af5d901eb6b68d9a63e1c32dfa6f7/03-References/research/waldo-harness-engineering-lessons-and-adoption-2026-09-18.md); evidence only, not live product authority
- [Independent PR #31 source/adoption evaluation](../research/WALDO_BRAIN_PR31_SOURCE_AUDIT_2026-09-18.md), covering every S01–S32 source and A01–A18 record with authority classes, limits, corrections, and launch dispositions
- [Moonshot and peer competitive-quality evaluation](../research/WALDO_MOONSHOT_COMPETITIVE_QUALITY_EVALUATION_2026-09-19.md), separating first-party observations from inferences and converting the data-flow, experience, privacy, and benchmarking lessons into G0–G4 acceptance gates
- [Peer-experience reverse engineering and smallest winning build order](../research/WALDO_PEER_EXPERIENCE_REVERSE_ENGINEERING_AND_BUILD_ORDER_2026-09-19.md), covering Moonshot, Instinct, Poke, Muse, Grok Bot, Hermes, and OpenClaw with public/black-box/open-system/clean-room evidence lanes and measurable launch slices
- [Backend entrypoint reconciliation `c91fa51`](https://github.com/Pin4sf/waldo-backend/commit/c91fa51)
- [App documentation reconciliation `97b43ff2`](https://github.com/Pin4sf/waldo-app/commit/97b43ff2)

### 21.3 Competitor and infrastructure sources

- Moonshot Computer: [product](https://moonshot.computer/), [privacy/data-flow disclosure](https://moonshot.computer/privacy), and [about/founding beta](https://moonshot.computer/about)
- Instinct: [product](https://instinct.com/), [privacy](https://instinct.com/privacy-policy), [terms](https://instinct.com/terms), and owner-supplied dashboard/permission screenshots dated 2026-09-18
- Instinct founder on X: [launch](https://x.com/noahrshinn/status/2092691344456351744), [agent email](https://x.com/noahrshinn/status/2097443132816396649), [Trusted Person protocol](https://x.com/noahrshinn/status/2097794967574028448), [network follow-up](https://x.com/noahrshinn/status/2099358203121393851), [Concierge](https://x.com/noahrshinn/status/2100262985491231101), and [Stripe Link](https://x.com/noahrshinn/status/2093368510449877180)
- Meta Muse: [announcement](https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/) and [product](https://ai.meta.com/muse/)
- Grok Bot: [official overview](https://docs.x.ai/grok-bot/overview), [collaboration](https://docs.x.ai/grok-bot/chat-and-collaboration), [computer/apps](https://docs.x.ai/grok-bot/computer-and-apps), and [skills/routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- Poke: [official docs](https://poke.com/docs), [privacy](https://poke.com/privacy), and [terms](https://poke.com/terms)
- folk Personal AI: [official product](https://www.folk.com/)
- folk CRM Assistant: [official help](https://help.folk.app/en/articles/12460796-introducing-assistant)
- Hermes Agent: [official docs](https://hermes-agent.nousresearch.com/docs/)
- OpenClaw: [official docs](https://docs.openclaw.ai/)
- Swiggy MCP: [builder docs](https://mcp.swiggy.com/builders/docs/)
- Granola: [developer/API documentation](https://docs.granola.ai/)
- Granola public API: [official integration documentation](https://docs.granola.ai/help-center/sharing/integrations/granola-api)
- Granola webhooks: [official webhook documentation](https://docs.granola.ai/webhooks)
- Google OAuth and incremental authorization: [official documentation](https://developers.google.com/identity/protocols/oauth2)
- Google restricted-scope verification: [official production-readiness guide](https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification)
- Google Workspace user-data policy: [official policy](https://developers.google.com/workspace/workspace-api-user-data-developer-policy)
- Google API Services User Data Policy and Limited Use: [official policy](https://developers.google.com/terms/api-services-user-data-policy)
- Google Calendar OAuth scopes: [official scope table](https://developers.google.com/workspace/calendar/api/auth)
- Google Calendar client-chosen event IDs: [official event-creation guide](https://developers.google.com/workspace/calendar/api/guides/create-events)
- Google Calendar conditional writes and `412`: [official versioned-resources guide](https://developers.google.com/workspace/calendar/api/guides/version-resources)
- Gmail OAuth scopes: [official scope table](https://developers.google.com/workspace/gmail/api/auth/scopes)
- Gmail message search/list caveat: [official API method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/list)
- Gmail draft replacement/send semantics: [official draft guide](https://developers.google.com/workspace/gmail/api/guides/drafts)
- Gmail draft send authorization: [official API method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/send)
- Gmail immutable message send: [official API method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)
- Gmail draft deletion: [official API method](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.drafts/delete)
- Google Workspace MCP servers: [Developer Preview program](https://developers.google.com/workspace/preview)
- Nango: [official guides](https://docs.nango.dev/guides)
- Composio: [official docs](https://docs.composio.dev/)
- Cloudflare browser tooling: [official docs](https://developers.cloudflare.com/agents/tools/browser/)
- Cloudflare Durable Object alarms: [official docs](https://developers.cloudflare.com/durable-objects/api/alarms/)
- Cloudflare AI Gateway payload logging: [official docs](https://developers.cloudflare.com/ai-gateway/observability/logging/)
- OpenAI computer use: [official guide](https://developers.openai.com/api/docs/guides/tools-computer-use)
- Apple HealthKit setup: [official docs](https://developer.apple.com/documentation/healthkit/setting-up-healthkit)
- Apple HealthKit authorization limits: [official docs](https://developer.apple.com/documentation/healthkit/authorizing-access-to-health-data)
- Apple limited-history API: [official docs](https://developer.apple.com/documentation/healthkit/hkhealthstore/getearliestauthorizedsampledate%28for%3Acompletion%3A%29)
- Apple HealthKit privacy rules: [official docs](https://developer.apple.com/documentation/healthkit/protecting-user-privacy)
- Apple App Review health guidelines: [official guidelines](https://developer.apple.com/app-store/review/guidelines/#health-and-health-research)
- Apple simulator sample data: [official docs](https://developer.apple.com/documentation/healthkit/accessing-sample-data-in-the-simulator)
- Apple observer queries: [official docs](https://developer.apple.com/documentation/healthkit/executing-observer-queries)
- Apple App Intents: [official docs](https://developer.apple.com/documentation/appintents)
- Apple WatchConnectivity: [official docs](https://developer.apple.com/documentation/watchconnectivity)
- WhatsApp Business Solution Terms: [official terms](https://www.whatsapp.com/legal/business-solution-terms)
- WhatsApp Third Party Agent user terms: [official terms](https://www.whatsapp.com/legal/third-party-agents-terms)
- LongMemEval: [research paper](https://arxiv.org/abs/2410.10813)
- Clawdrain: [research paper](https://arxiv.org/abs/2603.00902)

Recheck time-sensitive terms, APIs, model availability, prices, and platform eligibility before implementation or launch.
