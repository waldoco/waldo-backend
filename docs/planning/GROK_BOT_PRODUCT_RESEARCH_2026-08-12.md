# Grok Bot product research and Waldo implications

> **Reference only.** This preserves first-party comparator evidence. It does not define Waldo's current architecture, build order, connector policy, or shipped capability.

- **Date:** 2026-08-12
- **Status:** Source-backed product research; no Waldo product decision is ratified by this note
- **Scope:** Identity, interface, creation, tools, files, computer use, demonstration, routines, mobile, collaboration, execution placement, trust boundaries, and high-level Waldo implications
- **Source policy:** First-party xAI documentation, xAI product/launch pages, and the official App Store listing only. No third-party reviews, social posts, or inferred implementation are used as evidence.

## Executive conclusion

The product is **Grok Bot**, not “Rockbot.” The transcription also likely rendered **Notion** as “Ocean”; Notion is an officially documented connector, while no “Ocean” integration was found in the first-party sources reviewed.

Grok Bot is meaningful validation of the early Waldo thesis that agent infrastructure should disappear behind a messaging-style product. Its documented primitives closely match the user’s account:

- create a persistent named agent with a name, job, and description;
- message it from desktop or iPhone and continue the same conversation;
- connect supported tools through a browse-and-add Plugins interface;
- let it operate a persistent cloud computer with browser, files, and terminal;
- watch or take over the computer for authentication and other sensitive steps;
- demonstrate a browser workflow and save the result as a reusable draft skill;
- schedule that work as a routine that continues after the laptop closes;
- put multiple Bots into a group chat and let them hand work to one another.

These are documented beta capabilities, not independently verified reliability claims. This review did not install the app, buy an eligible subscription, authenticate a service, or run a routine.

Grok Bot does **not** make the full Waldo thesis redundant. Its public contract is a roster of work-focused Bots sharing one user-scoped cloud VM, filesystem, browser sessions, command-line credentials, and local-computer permission boundary. It does not publicly establish multi-human collaboration in the same Bot session, per-Bot credential isolation, a canonical real-world Outcome/evidence/acceptance lifecycle, health-aware personal continuity, or automatic migration of arbitrary work between local and cloud environments. Those differences are material, not cosmetic.

## Evidence labels

- **Observed interface:** visible on an official product page or official distribution listing.
- **Documented:** stated in current first-party product documentation.
- **Marketing claim:** stated by xAI or Anysphere but not independently exercised in this review.
- **Inference:** a bounded interpretation of observed or documented facts.
- **Unknown:** the public sources reviewed do not establish the claim.
- **Conflict:** first-party surfaces differ or leave ownership/scope ambiguous.

## 1. Identity and provenance

### Resolved identity

**Observed interface — high confidence:** The official product name is **Grok Bot**. The xAI page is titled “Meet Grok Bot,” and the official launch post dated 2026-08-11 is “Introducing Grok Bot.” The product describes each Bot as a persistent, named AI teammate. Sources: [xAI Grok Bot product page](https://x.ai/bot), [xAI launch post](https://x.ai/news/introducing-grok-bot), [Grok Bot overview](https://docs.x.ai/grok-bot/overview).

**Observed distribution — high confidence:** The iPhone app is named **Grok Bot**, with the subtitle “AI teammates that do real work.” Its App Store developer and seller are Anysphere, and its listed Terms and Privacy Policy point to Cursor. The xAI product page likewise sends downloads, onboarding, plans, authentication, and sales to Cursor-owned surfaces. Sources: [official Grok Bot App Store listing](https://apps.apple.com/us/app/grok-bot/id6794501026), [xAI Grok Bot product page](https://x.ai/bot), [Grok Bot setup guide](https://docs.x.ai/grok-bot/get-started).

**Conflict / boundary:** Grok Bot is branded and documented on xAI properties, but the downloadable application, account, subscriptions, and linked legal terms are Cursor/Anysphere surfaces. The sources establish this operating relationship but do not, by themselves, explain its corporate or data-controller structure. Do not describe the product simply as an xAI-operated consumer app without checking the applicable Cursor contract for the relevant account and plan.

### Transcript corrections

| Transcript phrase | Resolution | Confidence |
|---|---|---:|
| “Rockbot” | **Grok Bot** | High |
| “Ocean” | Likely **Notion**, which appears in xAI’s connector catalog | Medium; transcription inference |
| “agents’ little computer” | Grok Bot’s documented persistent cloud computer | High |
| “iOS app” | A dedicated iPhone-only Grok Bot app currently requiring iOS 18+ | High |

Sources: [xAI connector documentation](https://docs.x.ai/grok/connectors), [Grok Bot for iOS](https://docs.x.ai/grok-bot/mobile).

## 2. Capability verification matrix

| Claim from the transcript | Finding | Evidence classification | Qualification |
|---|---|---|---|
| Telegram-style roster and chat | The official product page visibly presents a searchable sidebar of named Bots, normal message threads, a New Agent action, computer access, and group-like Bot conversations. | Observed interface | “Telegram-style” is a fair visual analogy, not xAI’s terminology. |
| Create an agent by filling out a form | First-run setup asks for a short name, one primary job, and a working description. The detailed management flow creates “New Agent,” then edits name, title, description, and avatar. | Documented | It is a short profile flow, although the exact interaction can be conversational or profile editing rather than one immutable form. |
| Markdown files and folder structures | Bots have a shared `/workspace`, can return folders, and accept Markdown among normal file formats. Skills contain reusable instructions. | Partially documented | Public Grok Bot docs do **not** establish that users must see or edit Markdown configuration files, or that a Markdown/folder tree is the main creation UI. The exact transcript claim is unverified. |
| One-click tool selection | In Settings → Plugins, users browse connectors, choose Add, and authenticate in a browser. Supported Grok connectors use OAuth; the catalog includes services such as Gmail/Calendar, Drive, Microsoft services, Salesforce, GitHub, Linear, Notion, Box, Canva, and Vercel. | Documented | “One click” compresses the OAuth consent and possible admin setup. Some tools require authentication, permissions, subscriptions, allowlisting, or custom MCP configuration. |
| Hundreds of tools | Cursor/xAI surfaces expose catalogs and plugins, but the reviewed first-party Grok Bot docs do not provide a stable count of “hundreds.” | Unknown | Do not repeat the number as fact. |
| The Bot has a computer with browser and apps | Each user receives a persistent managed Linux cloud VM with browser, filesystem, terminal, and connector/MCP access. Apps without clean APIs can be driven through computer use. | Documented; central product claim | All of one user’s Bots share this computer and its credentials. It is not one isolated machine per Bot. |
| Teach a task by showing it on screen | “Teach a task” records visible browser interaction for up to ten minutes, creates a draft skill, and requires review/testing. | Documented | Gradual rollout; desktop only; the learned skill is explicitly a draft and may miss decision rules, failure handling, and approval boundaries. |
| Build reusable skills | A successful process can be saved as a skill containing steps, decision rules, outputs, validation, and approval boundaries; private skills can be enabled per Bot. | Documented | Skills are shared across Bots but still depend on relevant connector/login access. |
| Create routines and scheduled tasks | A Bot can create a routine with owner, schedule/time zone, inputs, result, approval boundary, and missing-source behavior. Background routines run while the laptop is closed. | Documented | xAI recommends a test run and warns that tests perform real work. Long absence may cause the product to ask whether routines should continue or pause them. |
| Use the same agents on computer and phone | The iPhone app connects to the same Bots, conversations, routines, connectors, and cloud computer as desktop. Work continues when the app is closed. | Documented and officially distributed | Current mobile support is iPhone/iOS 18+, not iPad or Android. Some routine editing and teach-by-demonstration require desktop. |
| Agents coordinate with each other | Two to six Bots can share a group chat; Bots can asynchronously message each other, share context, and visibly hand off ownership. | Documented | This is Bot-to-Bot collaboration. It is not proof of several human teammates jointly inhabiting the same live session. |
| Teams can use agents others build | Team plans provide admin settings, team plugin/marketplace policy, shared billing, and a dedicated computer per member. | Partially documented | Public docs say each member gets a standing Bot/computer. They do not establish a reusable Bot profile owned once and operated collaboratively by many humans. |
| Local and cloud blend automatically | Cloud execution continues without the laptop. Separately, with consent and policy, Bots can run commands, read files, and move files using a member’s local Mac or Windows machine. | Partially documented | The product exposes local-execution controls and a visible cloud computer. Public docs do not prove transparent checkpoint migration or automatic placement of arbitrary tasks between local and cloud. |
| Laptop-off resilience | Cloud computer tasks and background routines can continue after the desktop app or laptop closes. | Documented; marketing claim not load-tested | Work requiring the local machine cannot continue if that local capability is unavailable; the documentation does not claim otherwise. |
| Model/provider complexity disappears | Grok Bot has no model picker; model routing and failover are managed by the product. | Documented | This is a strong example of infrastructure invisibility. It also means users/admins cannot restrict the model set except through contract discussions. |

Primary sources: [Get started](https://docs.x.ai/grok-bot/get-started), [Create and manage Bots](https://docs.x.ai/grok-bot/bots), [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration), [Files and results](https://docs.x.ai/grok-bot/files-and-results), [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps), [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations), [Grok Bot for iOS](https://docs.x.ai/grok-bot/mobile), [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises), [xAI connectors](https://docs.x.ai/grok/connectors).

## 3. What the public product actually exposes

### Messaging is the primary control surface

**Observed interface:** The official product-page demo shows named Bots in a sidebar, searchable chats, a message composer, an “Open computer” control, ordinary progress/result messages, references to other Bots, approval language, and routine creation inside a conversation. The docs explicitly say the transcript interleaves normal messages with tool activity, computer use, files, questions, and approval requests. Sources: [xAI Grok Bot product page](https://x.ai/bot), [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration).

**Inference:** The important simplification is not that files, MCP, terminals, or machines ceased to exist. They were moved behind a teammate metaphor and surfaced only when the person needs to connect, inspect, teach, take over, approve, or recover.

### Creation is role-first, not infrastructure-first

**Documented:** A first Bot needs a short name, a primary job, and a description. More advanced profile fields include title and avatar. The product recommends narrow, stable ownership and explicit approval boundaries rather than a generic helper. Sources: [Get started](https://docs.x.ai/grok-bot/get-started), [Create and manage Bots](https://docs.x.ai/grok-bot/bots).

**Inference:** This validates a form/conversation that compiles understandable product intent into agent configuration. It does not validate exposing raw instruction files as the onboarding model.

### Tools are presented as Plugins even when MCP is underneath

**Documented:** Users browse Settings → Plugins, add a connector, and finish authentication. The Bot uses connectors where reliable and browser computer-use where no connector or required visual workflow exists. At team level, the underlying policy still includes MCP allow/deny lists, hosted MCP authentication, team marketplaces, and custom servers. Sources: [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps), [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises), [xAI connectors](https://docs.x.ai/grok/connectors).

**Inference:** This is precisely the useful product pattern for Waldo: users see a recognizable service, capability, permission, and account—not the protocol. Advanced infrastructure remains available to administrators and builders without defining the ordinary experience.

### The computer is persistent, cloud-first, and shared per user

**Documented:** Each user gets one managed Linux VM. All their Bots share `/workspace`, browser cookies/sessions, files, command-line credentials, connectors, and local-computer permissions, while each Bot has a separate screen for parallel work. Closing the app or laptop does not stop cloud work. Sources: [Grok Bot overview](https://docs.x.ai/grok-bot/overview), [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps), [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises).

**Security consequence:** A Bot is an organizational/personality boundary, not a security boundary. Signing one Bot into a service or placing a file on the cloud computer can make it available to every Bot on that user account. xAI’s own docs explicitly warn users not to use separate Bots for isolation. Sources: [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy), [Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps).

### Local execution exists but is not the default identity

**Documented:** The cloud computer is distinct from the Mac or Windows device. Local commands, file access, and file transfer require the capability to be enabled and are governed by a local-computer policy whose default is Ask every time. Cloud work remains available if local access is denied. Sources: [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy), [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises).

**Unknown:** The public docs do not establish a general mechanism that checkpoints a running local task and resumes the same execution in cloud, or the reverse. They establish two capability planes and product-managed selection, not arbitrary execution migration.

### Demonstration produces a proposal, not magic truth

**Documented:** Teach-by-demonstration records visible interaction, creates a draft skill, and tells the user to review it and test a safe example. The docs explicitly warn that one demonstration may omit decision rules, failure handling, and approval boundaries. Source: [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations).

**Product lesson:** Waldo should preserve this honest staging: observed demonstration → proposed reusable behavior → explicit review/eval → eligible routine. A recording should never silently become durable authority.

## 4. Collaboration: what is and is not proven

### Proven in current public documentation

- Multiple Bots can run in parallel.
- A group chat contains two to six Bots.
- Bots can mention and asynchronously message each other.
- Handoffs can be visible in the group conversation.
- Team administrators can govern access, plugins/MCP policy, SSO, usage, and member computers.
- Each team member gets a dedicated user-scoped computer shared by that member’s Bot roster.

Sources: [Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration), [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises).

### Not proven by the reviewed sources

- Several human teammates collaborating live inside the same Bot conversation.
- A single team-owned Bot identity that many people jointly steer.
- A shared agent memory with explicit personal-versus-team projection boundaries.
- Per-human attribution and approval semantics inside a multi-human Bot session.
- Cross-user sharing of browser sessions, files, or credentials.
- A safe way to publish an agent built by one member for other members without duplicating or reauthorizing it.

**Conclusion:** The transcript correctly describes a team **of Bots**. It overreaches if interpreted as a team **of humans** sharing one durable session or agent account.

## 5. Claims that require caution

### “Exactly what Waldo envisioned”

**Partly true.** Grok Bot strongly validates the experience thesis: messaging, simple role creation, cloud persistence, mobile continuity, one-place connections, visible computer takeover, teach-by-showing, and scheduled routines.

**Not identical.** Grok Bot’s unit of product is a roster of specialized Bots attached to one shared cloud computer. Waldo’s converged unit is one durable personal agent relationship carrying Outcomes across body, day, work, people, devices, and replaceable executors. Grok Bot is strongest at delegating jobs; Waldo’s intended differentiation is continuity of human responsibility and trusted closure.

### “You never need to understand technology”

**Marketing direction, not complete reality.** Ordinary users can avoid terminals and MCP vocabulary, but current setup still includes downloading a desktop app, an eligible paid plan, Cursor authentication, tool sign-ins, OAuth permissions, occasional takeover for passwords/2FA/CAPTCHA, and optional local-execution policy. Team admins encounter privacy settings, MCP policy, network egress, credentials, billing, and VM controls. Sources: [Get started](https://docs.x.ai/grok-bot/get-started), [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises).

### “The agent keeps getting smarter”

**Marketing claim with documented mechanisms:** Named Bots retain working memory/preferences, conversations, files, browser state, skills, and routines. Public sources do not provide accuracy, correction, staleness, or longitudinal reliability measurements. Sources: [xAI launch post](https://x.ai/news/introducing-grok-bot), [Create and manage Bots](https://docs.x.ai/grok-bot/bots).

### “It only comes back when approval is needed”

**Marketing claim with configurable controls:** Requests can state boundaries; actions can use allow/deny approvals and model-based Auto Review. The docs warn that Auto Review complements rather than replaces least privilege. An audit view of Bot actions is still listed as coming. Sources: [Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy), [Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises).

## 6. Grok Bot versus the converged Waldo direction

This comparison uses the current local convergence document as Waldo’s proposed direction, not as proof that Waldo has shipped these capabilities.

| Dimension | Grok Bot, publicly documented | Waldo direction | Decision |
|---|---|---|---|
| User metaphor | Named AI teammates with jobs | One durable Waldo relationship with optional specialist executors beneath it | **Adapt the simplicity; retain one-Waldo identity.** |
| Primary interaction | Messaging roster, conversations, computer view | Home/Today, Waldo conversation, Outcomes, Needs You, Kennel Home/Work | **Adapt the messaging immediacy without making chat the only truth surface.** |
| Agent creation | Name, job, description, profile | Express Outcome/purpose, context, allowed capabilities, approval/acceptance boundary | **Adopt short guided creation; compile the technical contract.** |
| Tools | Browse/add Plugins, OAuth, MCP beneath advanced policy, browser fallback | Capability manifests, grants, connectors, effects, reconciliation | **Adopt service-first connection UX; keep stronger authority semantics.** |
| Execution | Persistent user-scoped cloud VM; optional governed local commands/files | Cloud owns continuity/authority; Kennel owns local custody; cloud workspaces are adapters | **Adapt cloud persistence; do not copy the shared-secret boundary blindly.** |
| Scheduling | Bot-owned routines continue in cloud | Cloud-owned schedules tied to Outcomes/Open Loops and authority | **Adopt laptop-independent scheduling.** |
| Learning | Memory, saved skill, teach-by-demonstration draft | Governed context/memory/behavior proposals with provenance and evals | **Adapt demonstration; require proposal review and evidence.** |
| Collaboration | Bot group chats and asynchronous Bot handoffs | One Waldo orchestrates executors/people; shared purpose projections need explicit privacy boundaries | **Adapt visible handoffs; separately design human multiplayer.** |
| Completion | End-to-end work and conversational result/approval | Evidence admission, independent Verification, revision-bound Acceptance, surviving Open Loop | **Retain Waldo’s stronger closure contract.** |
| Personal context | Work preferences and durable Bot state | Body, calendar, commitments, relationships, work, health when consented | **Retain the wider human context; Health remains recommended, not required.** |
| Runtime/provider choice | No model picker; product-managed routing/failover | Replaceable executors below Waldo-owned contracts | **Adopt provider invisibility, while keeping portability and inspectable receipts.** |
| Security boundary | One computer and credential pool per user; not per Bot | Purpose-bound grants and minimized context per Outcome/Work Unit/executor | **Reject shared ambient authority as Waldo’s default.** |

Waldo source: [Waldo product and architecture convergence, 2026-08-11](./WALDO_PRODUCT_ARCHITECTURE_CONVERGENCE_2026-08-11.md).

## 7. Product implications for Waldo

### 7.1 Ratify complexity invisibility as a product invariant

**Proposed direction:** A person should express an Outcome, connect recognizable services, grant understandable permissions, and inspect consequences. Models, MCP, Markdown configuration, CLIs, leases, fences, runtime placement, recovery, and provider sessions remain implementation machinery or advanced controls.

This is consistent with the current convergence architecture, but Grok Bot raises the priority from “good interface” to category-defining requirement.

### 7.2 Give Waldo a simple account-level presence

**Proposed direction:** Waldo should feel like an account/presence reachable from every device, with one durable identity and continuous conversation/Outcome ledger. Kennel, mobile, web, cloud, and provider agents are presences or execution placements beneath it—not separate Waldo identities.

Do not copy Grok Bot’s multiplication of named personalities as Waldo’s default. Specialists may exist, but the person should not become the router or memory synchronizer between them.

### 7.3 Make “create help” a short human form

A useful Waldo form can ask:

1. What should become true?
2. What information may Waldo use?
3. What may it do without asking?
4. What always needs approval?
5. When should it run or check again?
6. What result will count as accepted?
7. Who, if anyone, may participate?

Waldo compiles these answers into purpose, context policy, capabilities, schedule, evidence requirements, verification, acceptance, sharing, and placement. Advanced users may inspect or export that contract; ordinary users do not author its files.

### 7.4 Make connections service-first and capability-specific

Present Gmail, Calendar, GitHub, Notion, Slack, health sources, and other services as understandable cards. Show:

- the account being connected;
- what Waldo can read;
- what it may change;
- what requires approval;
- which purposes can use it;
- how to revoke it.

MCP may implement a connection, but it should not be the user’s mental model.

### 7.5 Preserve Waldo’s local/cloud honesty

Grok Bot validates cloud continuity and optional local action, but not magical mobility of every task. Waldo should choose eligible placement while saying the real constraint:

- cloud-capable work continues when devices close;
- local-only work waits for Kennel to reconnect;
- safely portable work may checkpoint and resume elsewhere;
- the interface reports where data and authority are being used when that matters.

The user should not have to orchestrate placement, but “invisible” must not mean “uninspectable.”

### 7.6 Treat learned behavior as a reviewed proposal

The Grok Bot documentation gets an important trust detail right: a demonstrated workflow becomes a **draft** skill that must be tested. Waldo should go further by binding the proposal to sources, captured scope, approval boundaries, validation, version, and explicit promotion into a routine.

### 7.7 Design human multiplayer independently

Bot group chats do not solve shared human agency. Waldo still needs a deliberate shared-purpose model with:

- named human participants and roles;
- attribution for messages, grants, judgments, and actions;
- team-owned versus personal Outcomes;
- explicit context projection from personal Waldo into the shared purpose;
- exclusion of unrelated memory and health by default;
- a clear owner for each consequential step;
- revocation and departure semantics.

### 7.8 Do not copy Grok Bot’s shared-computer authority boundary

Grok Bot shares browser sessions, files, credentials, and local permission across all Bots for one user. That makes handoffs easy, but it also makes every Bot potentially capable of using every ambient credential on that machine.

Waldo should preserve project/workspace convenience while granting each Work Unit or executor the minimum purpose-bound capability it needs. A specialist identity must not silently inherit every personal or team permission.

## 8. Recommended product tests

Grok Bot makes the expected bar concrete. Waldo should be tested against these experience-level criteria:

1. A non-technical person gets a useful first result in five minutes without seeing a terminal, MCP, repository, or Markdown configuration file.
2. Connecting a supported service is a recognizable add-and-consent flow with explicit read/write/approval scope.
3. A cloud-capable scheduled responsibility continues after phone and laptop apps close.
4. A local-only responsibility waits honestly, preserves its re-entry point, and resumes when Kennel returns.
5. The same Waldo identity, Outcome state, Needs You items, and receipts appear on desktop and mobile.
6. Demonstrating a task creates an inspectable proposal, not immediately trusted automation.
7. A routine cannot send, purchase, delete, publish, or change production beyond its grant.
8. A person can understand what happened from evidence and consequence without watching raw agent activity.
9. Sharing a purpose never leaks unrelated personal memory, communication, or health context.
10. Removing one connector or device degrades only the capabilities that depended on it.

## 9. Open questions requiring hands-on verification

- What exact agent-creation UI ships after authentication, and how much is form versus conversation?
- Are Markdown skill files visible/editable in the Grok Bot app, or only represented as product-level Skills?
- How many Plugins are actually available to Grok Bot, as distinct from the wider Cursor or Grok catalogs?
- Which Plugins require admin setup, paid vendor plans, custom secrets, or MCP configuration?
- How reliable is teach-by-demonstration across dynamic interfaces, failures, and changed layouts?
- What state is retained, omitted, or corrupted across VM recovery and app upgrades?
- How does the product select between connector, browser, cloud terminal, and local-computer execution?
- Can a running task move between local and cloud, or can only the Bot choose a different capability on a later step?
- Can multiple humans participate in one Bot/group conversation today?
- Can one person publish a Bot role and its safe configuration for teammates without sharing their personal memory, files, sessions, or credentials?
- What exact data controller, retention, training, and deletion terms govern Grok Bot for each xAI/Cursor plan combination?
- How well do approvals and Auto Review prevent unintended external effects in real use?

## 10. Bottom line

Grok Bot is not merely a superficial competitor. It is first-party evidence that the market is converging on several ideas Waldo held early: a teammate metaphor, messaging as the command surface, easy role creation, click-to-connect services, persistent cloud execution, mobile continuity, teachable workflows, and scheduled work that survives the laptop.

The correct response is not to reshape Waldo into a clone or abandon the converged architecture. It is to make **complexity invisibility and account-level presence explicit, urgent product invariants** while retaining Waldo’s deeper thesis:

> one user-owned Waldo carries responsibility across life and work, chooses governed execution placement, admits evidence, asks for judgment at the right boundary, and keeps the consequence alive until it is verified, accepted, reopened, or consciously released.

Grok Bot validates that this must feel simple. It does not replace the need to make it trustworthy, personal, purpose-bound, and complete.

## Primary source index

- [xAI — Grok Bot product page](https://x.ai/bot)
- [xAI — Introducing Grok Bot](https://x.ai/news/introducing-grok-bot)
- [xAI Docs — Grok Bot overview](https://docs.x.ai/grok-bot/overview)
- [xAI Docs — Get started](https://docs.x.ai/grok-bot/get-started)
- [xAI Docs — Grok Bot for iOS](https://docs.x.ai/grok-bot/mobile)
- [xAI Docs — Create and manage Bots](https://docs.x.ai/grok-bot/bots)
- [xAI Docs — Message and collaborate](https://docs.x.ai/grok-bot/chat-and-collaboration)
- [xAI Docs — Files and results](https://docs.x.ai/grok-bot/files-and-results)
- [xAI Docs — Use the computer and apps](https://docs.x.ai/grok-bot/computer-and-apps)
- [xAI Docs — Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations)
- [xAI Docs — Approvals, security, and privacy](https://docs.x.ai/grok-bot/approvals-security-and-privacy)
- [xAI Docs — Teams and enterprises](https://docs.x.ai/grok-bot/teams-and-enterprises)
- [xAI Docs — Connectors](https://docs.x.ai/grok/connectors)
- [Apple App Store — Grok Bot by Anysphere](https://apps.apple.com/us/app/grok-bot/id6794501026)
