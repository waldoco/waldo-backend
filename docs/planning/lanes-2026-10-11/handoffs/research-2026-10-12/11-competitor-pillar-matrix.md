# Competitor capability matrix: ten personal agents, eight pillars plus health

Synthesis of three existing reports only (#1058, 02, 09), 2026-10-12. Read-only: no web access, no repo edits. For a quick scan, jump to the Overview table near the end.

## How to read

**Tags.** `[#1058]` is the Audit lane's competitor research (vendor pages fetched 2026-10-11). `[02]` is report 02 (read 2026-10-12; `/verified` means a first-party page read that day). `[09]` is report 09 (industry bar). Source qualifiers are kept after a slash: `/press`, `/search snippet`, `/owner transcription`, `/feed, first-party`, `/inference`. Where 02 only relays #1058, the tag is #1058. A superscript pins a sentence to one tag; unmarked text comes from one or more of the tags in its row.

**"Not documented" is not "absent".** It means the sources say nothing (#1058's "not stated" is unified to it). "None" is used only where a source says so. No product was tested hands-on, and vendor claims are not benchmarks.

**Verdicts** grade how deeply the sources document a pillar, not product quality. "strong" is specific, mechanism-level documentation of the pillar's core; "partial" is some facets or thin evidence; a bracketed note narrows it (open bugs, memory only, pairing only); "unverified" means the row rests on search snippets, owner transcription or press (all of OpenAI Dots). "n/a" is not used.

**Scope.** Approvals have no column: see P1 (pauses and stops), P5 (grants, revocation), P6 (where decided), P7 (purchases). Grok Bot is excluded (stale in #1058). "Instinct" is the competitor (Spear Street Technology; 02 is about 85 to 90 percent sure of the identification), not the Waldo lane. Report 09 adds new facts only for OpenClaw, Hermes and Poke; elsewhere it repeats 02.

## P1. Durable workflows

_Pillar scope: long-running or background work, resumption, idempotent actions._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Works in the background on schedules and events; interruptible, several tasks at once. Durable state in Postgres outside the runtime cell, continuous VM backup. Resumption, idempotency not documented. | `[#1058]` `[02/verified]` |
| OpenAI Dots | Proactive assistants that keep working across complex projects and everyday tasks.¹ Activity View shows ongoing and delegated tasks; user can add context, redirect or stop.² Resumption, idempotency not documented. | ¹ `[#1058/feed, first-party]` ² `[#1058/search snippet]` |
| Instinct | Not documented. Terms say actions 'may not always be reversible' and the user must verify and monitor them regularly. | `[#1058]` |
| Poke | Pro adds real-time automations running in the background; heavy usage 'often driven by frequently firing automations'. Resumption, idempotency, long-running tasks not documented. | `[#1058]` |
| Folk | Background items: 24/7 fare and shipment watching, price-drop watching, 'texts you when something changes'; Free allows 3 background items. Resumption and idempotency not documented. | `[#1058]` |
| Vellum Assistant | Task queue (queued, running, awaiting_review, done); run modes execute, notify, script, workflow; missed one-shots fire on restart, recurring runs not replayed. Open bugs: notifications logged 'ok' but undelivered. | `[#1058]` `[02/verified]` |
| OpenClaw | Cron jobs and run history persist; overdue jobs rescheduled after restart, not replayed; duplicate in-flight run-ids reported; interrupted one-shots with possible delivery 'Unknown'. Stopping a run cancels its approval. | `[02/verified]` |
| Hermes Agent | Missed cron runs catch up once; retries at 5, 15, 30 min only if no model call was made; sessions survive restarts; approvals time out at 300 s, fail closed. | `[02/verified]` |
| Letta | Conversations 'infinite length' via auto-compaction; full history stays searchable. Pending approvals survive a disconnect. Local schedules fire only while the app is open; overdue local one-shots may be marked missed. | `[02/verified]` |
| Khoj | Not documented. Automations run on a cron time and email results; durability, resumption and idempotency are not described. | `[02/verified]` |

**Best in class here**

- **OpenClaw**: cron jobs and run history persist; overdue jobs are rescheduled, not replayed; interrupted one-shots stay 'Unknown'; duplicate in-flight run-ids are reported; stopping a run cancels its approval. `[02/verified]`
- **Hermes Agent**: missed runs catch up once; retries only when no model call was made; sessions survive restarts; approvals time out closed after 300 s. `[02/verified]`
- **Vellum Assistant** (strong with open bugs): visible task states and four run modes, but notifications were logged 'ok' without delivery. `[#1058]` `[02/verified]`

**Parity bar**

- Job and run records that survive a restart, with a stated missed-run rule: OpenClaw reschedules, Hermes catches up once, Vellum fires missed one-shots but not recurring runs.
- Owner-visible task states: Vellum's queue states; Dots' Activity View of ongoing and delegated tasks (unverified).
- Honest delivery state: uncertain outcomes read 'Unknown' (OpenClaw), never 'ok' without delivery (the Vellum bug).
- Approval waits that survive a disconnect (Letta) or time out closed (Hermes), and a stopped run cancels its approval (OpenClaw). Idempotency appears only indirectly: OpenClaw reports duplicate run-ids; Hermes retries only when no model call was made.

## P2. Computer use

_Pillar scope: browser or desktop operation, a cloud computer._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Own VM with file system, terminal and full browser that fills forms and 'completes transactions'; standard browsing allowed by default; confidential VM still 'later this year'. | `[#1058]` |
| OpenAI Dots | Separate cloud computer or browser; saved passwords not exposed to the model.¹ Password changes are handed back to the user as a core safety requirement.² | ¹ `[#1058/owner transcription]` ² `[#1058/search snippet]` |
| Instinct | 'Uses a phone and computer in the same way that humans do'; examples: dispute a bill, schedule doctor's appointments. Terms: purchases share user info and payment method with the provider. | `[#1058]` |
| Poke | Browser use not documented. Poke Human (Ultra tier) hands reservations, calls, orders, rides to a real person at cost. Website build and deploy at yourname.poke.com (Jun 2026). | `[#1058]` |
| Folk | Own isolated cloud computer: browses, runs code, 'writes and ships code', builds apps, opens pull requests; shops to checkout, books restaurants; flight rebooking and provider switching 'not yet'. | `[#1058]` |
| Vellum Assistant | Browser and computer-use skills (computer use desktop-only); orders groceries, watches fares, books reservations. Credential Execution Service holds secrets, referenced by alias. | `[#1058]` |
| OpenClaw | Browser or desktop operation not documented. Exec approvals: allow-once, allow-always (bound to exact arguments and working directory), deny; permission modes read-only, guarded, workspace, full. | `[02/verified]` |
| Hermes Agent | Browser or desktop operation not documented. Dangerous commands: 'smart' auxiliary-model approval by default, or manual or off; a hardline blocklist applies even in 'yolo' mode. | `[02/verified]` |
| Letta | Browser or desktop operation not documented. Permission modes: standard, acceptEdits, unrestricted (CLI default), strict. | `[02/verified]` |
| Khoj | Not documented. | `[02]` |

**Best in class here**

- **Meta Muse**: own VM with file system, terminal and a full browser that fills forms and 'completes transactions'; standard browsing allowed by default. `[#1058]`
- **Folk**: own isolated cloud computer that browses, runs code, opens pull requests and shops to checkout, and lists flight rebooking and provider switching as 'not yet'. `[#1058]`

**Parity bar**

- An isolated cloud computer or VM with a full browser that fills forms and reaches checkout (Muse, Folk; Dots unverified).
- Credentials outside the model's reach: Vellum references secrets by alias; Dots reportedly never exposes saved passwords (owner transcription).
- Sensitive steps handed back to the owner: Dots' password changes (search snippet). Purchase approvals are in P7.
- Stated limits: Folk's 'not yet' list; Muse's confidential VM is still future work. Browser or desktop operation is not documented for Poke, OpenClaw, Hermes, Letta or Khoj.

## P3. Memory and skills

_Pillar scope: memory you can view, edit and forget; skills or recipes, including learned ones._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Persists across conversations; user can read, edit and download memory files, and ask it to forget specific things; training opt-out. Supersession, provenance and skills not documented. | `[#1058]` `[02/verified]` |
| OpenAI Dots | Learns from feedback.¹ View, edit and delete memory: not documented in any reachable source. Activity View corrections are task-scoped.² Skills not documented. | ¹ `[#1058/owner transcription]` ² `[#1058/search snippet]` |
| Instinct | Memory not documented. Privacy policy: indexed external data deletable in the workspace; disconnecting an integration does not automatically delete data. Skills not documented. | `[#1058]` |
| Poke | Memory referenced only as 'its memory'; view, edit, correct, delete not documented. 12 named first-party recipes (see P5); user-written or learned recipes not documented. | `[#1058]` |
| Folk | Memory graph; dashboard search, read, delete; forget requests in chat; CLEARMEMORY wipes all; imports from ChatGPT or Claude. Memory doc and FAQ disagree on edit. Provenance, skills not documented. | `[#1058]` |
| Vellum Assistant | Linked-wiki memory map with search, Create, Refine; can be turned off; corrections replace outdated understanding; eight types, isolated per user and channel. Custom skills exist; learned skills, deletion not documented. | `[#1058]` `[02/verified]` |
| OpenClaw | Markdown memory files the user edits directly; USER.md superseded in place; daily notes searchable; 'dreaming' excludes untrusted sources.¹ AgentSkills-compatible; Skill Workshop writes and updates skills with versions and undo.² | ¹ `[02/verified]` ² `[09/verified]` |
| Hermes Agent | Capped MEMORY.md and USER.md (frozen per-session snapshot); optional staged writes for user approval; full-text search over past sessions.¹ Agent writes and patches skills itself; optional skills.write_approval stages them.² | ¹ `[02/verified]` ² `[09/verified]` |
| Letta | Git-backed memory shared across all conversations; 'system/' files in the prompt every turn; /remember; 'dreaming' subagents consolidate memory. Desktop memory viewer; user-side edit, delete, skills not documented. | `[02/verified]` |
| Khoj | Retrieval over the user's own documents. A memories setting is hinted only by a plugin changelog; user view, edit, forget and skills not documented. | `[02/search snippet]` |

**Best in class here**

- **Meta Muse**: user can read, edit and download memory files, ask it to forget specific things, and opt out of training. `[#1058]` `[02/verified]`
- **Vellum Assistant**: corrections replace outdated understanding; memory map with search, Create and Refine; memory can be turned off; custom skills exist. `[#1058]` `[02/verified]`
- **Hermes Agent**: capped memory with optional staged writes for approval; full-text search of past sessions; agent-written skills with optional write_approval. OpenClaw's Skill Workshop adds versions and undo. `[02/verified]` `[09/verified]`

**Parity bar**

- Memory the owner can inspect and change: read, edit, download (Muse); edit files directly (OpenClaw); search, Create, Refine (Vellum); search, read, delete (Folk). A 'forget' request (Muse, Folk); a training opt-out (Muse).
- Corrections replace rather than accumulate (Vellum; OpenClaw's USER.md superseded in place). Per-memory provenance labels: not documented for Muse or Folk, and #1058 finds none stated by any vendor. `[#1058]`
- Agent-written memory is bounded or reviewable: Hermes's caps and staged writes; OpenClaw's 'dreaming' excludes untrusted sources.
- Skills: AgentSkills-compatible (OpenClaw, Hermes); agent-authored with versions and undo (OpenClaw) or staged approval (Hermes); Vellum has custom skills.

## P4. Triggers and scheduled jobs

_Pillar scope: reminders, automations, proactivity, event triggers, quiet hours and controls._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Runs on schedules and relevant events; notifies only when 'meaningfully new or needs your input'; user can turn proactivity off, down or up. Quiet hours not documented. | `[#1058]` `[02/verified]` |
| OpenAI Dots | Proactive assistants.¹ Read-only proactive app research;² Custom Rules cannot alter 'the restrictions on proactive research'.³ Schedules, event triggers, quiet hours not documented. | ¹ `[#1058/feed, first-party]` ² `[#1058/owner transcription]` ³ `[#1058/search snippet]` |
| Instinct | Not documented on vendor pages; the earlier 'proactive follow-ups' wording is no longer on the homepage as fetched. | `[#1058]` |
| Poke | Proactive 'in your texts'; uses integrations and memory 'right on time'; reminders; Pro adds real-time background automations; prompts review of unused recurring automations (Dec 2025). Interrupt policy not documented. | `[#1058]` |
| Folk | Timed check-ins, streaks, 'notices when you go quiet', nag mode, morning briefing, 24/7 fare and shipment watching, price-drop watching; recurring check-ins are paid. Interrupt policy not documented. | `[#1058]` |
| Vellum Assistant | Cron and RRULE schedules; hourly heartbeat with active-hours window surfaces only what needs attention; watchers poll Gmail, Outlook, GitHub, calendars, Linear with a watermark. Open bug: heartbeat silent six days. | `[#1058]` `[02/verified]` |
| OpenClaw | 30-minute heartbeat, active hours in the user's time zone, silent when nothing to say (NO_REPLY); flood guards; persisted cron; event-fired standing intents (24 h cooldown, 3 fires, 90-day expiry). | `[02/verified]` |
| Hermes Agent | Fresh session per cron run; [SILENT] suppresses delivery but failures always deliver; missed runs catch up once; cron runs cannot create jobs. No heartbeat documented; open DST drift bug. | `[02/verified]` |
| Letta | Schedules via --at, --cron, --every; each run gets a new conversation by default; cloud cron runs in UTC; no quiet hours, no heartbeat. Time zone for --at not documented. | `[02/verified]` |
| Khoj | Automations set up in the UI with a cron time, in the user's local time zone; results delivered by email. Silence when nothing is new not documented. | `[02/verified]` |

**Best in class here**

- **OpenClaw**: heartbeat inside active hours in the user's zone, silent when there is nothing to say, flood guards, persisted cron, and event-fired standing intents with a 24 h cooldown, 3 fires and a 90-day expiry. `[02/verified]`
- **Hermes Agent**: silent runs still deliver failures; missed runs catch up once; cron runs cannot create jobs. `[02/verified]`
- **Meta Muse**: an explicit interrupt bar ('meaningfully new or needs your input') plus an off, down or up proactivity dial; schedules and events. `[#1058]` `[02/verified]`

**Parity bar**

- Durable one-shot and recurring schedules plus event triggers: Muse events, Vellum watchers with a watermark, OpenClaw standing intents.
- A stated interrupt bar: a run may stay silent (OpenClaw, Hermes) but failures still surface (Hermes); the owner can dial proactivity (Muse).
- Active-hours control in the owner's time zone (OpenClaw; Vellum's window). Muse's quiet hours are not documented.
- Time-zone correctness: Hermes's open DST drift bug is the failure to avoid; Letta's cloud cron runs in UTC; Khoj uses the user's local zone.

## P5. Connectors and auth

_Pillar scope: which integrations, OAuth, MCP, revocation._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Sentinel gates connector actions: grants one-time, session, task, time-bounded or perpetual, exact-scope match; users can remove actions beyond OAuth scopes; revocation not documented. 15 named Small Business apps, custom connectors. | `[#1058]` `[02/verified]` |
| OpenAI Dots | 4,000+ app plugins (owner transcription, press).¹ Custom Rules set which supported actions the dot takes independently, with approval, or never; rules viewable in settings.² OAuth, MCP, revocation not documented. | ¹ `[#1058/owner transcription]` `[#1058/press]` ² `[#1058/search snippet]` |
| Instinct | Privacy names Google Workspace (Calendar, Gmail, Drive, Docs, Sheets, Slides, Tasks), unnamed model providers and payment processor. Google data deletable on revoke; disconnecting an integration does not auto-delete data. | `[#1058]` |
| Poke | Gmail and Outlook (mail, calendar, contacts); iCloud, Yahoo 'no immediate plans'. 12 named first-party recipes plus custom MCP servers by URL with optional key. Revocation, OAuth scopes not documented. | `[#1058]` |
| Folk | Gmail, Outlook, Google Calendar, Notion, Slack, Todoist, Strava named, 'hundreds more', unlimited on all plans; any MCP-compatible tool; sign-in link texted when needed; read-only Plaid bank link. Revocation not documented. | `[#1058]` |
| Vellum Assistant | Google Workspace, Slack, Notion; MCP, custom skills. Allow, deny or ask rules by scope, editable in Settings, deny wins ties; grant once, ten minutes or always; credential service holds secrets. | `[#1058]` `[02/verified]` |
| OpenClaw | Connector catalogue, OAuth and MCP not documented. Allow-always bound to exact arguments; automation grants stand until revoked, may expire, can be listed and revoked.¹ ClawHub skills: scan status, trust envelope.² | ¹ `[02/verified]` ² `[09/verified]` |
| Hermes Agent | Connector catalogue, OAuth and MCP not documented. Approval grants: once, session, always (permanent allowlist), deny. DM pairing codes expire after 1 h; allowlists deny by default. | `[02/verified]` |
| Letta | Connector catalogue, OAuth and MCP not documented. SDK canUseTool can allow (optionally with edited input) or deny with a reason; a guard blocks access to other agents' memory. | `[02/verified]` |
| Khoj | Connectors, OAuth, MCP and revocation not documented. Self-hosted automation email delivery needs Resend. | `[02/verified]` |

**Best in class here**

- **Meta Muse**: Sentinel grants run from one-time to perpetual with exact-scope match; users can remove actions beyond OAuth scopes; 15 named apps plus custom connectors. `[#1058]` `[02/verified]`
- **Vellum Assistant**: allow, deny or ask rules by scope, editable in Settings, deny wins ties; grant once, ten minutes or always; credential service holds secrets; MCP and custom skills. `[#1058]` `[02/verified]`
- **OpenClaw** (partial here, because connectors are not documented): the only product documenting an explicit list-and-revoke for standing grants; allow-always is bound to exact arguments. `[02/verified]`

**Parity bar**

- Mail and calendar connectors (Gmail and Outlook in Poke and Folk; Google Workspace in Instinct and Vellum) plus MCP or custom connectors (Poke by URL, Folk, Vellum, Muse).
- Grants as scoped records with a lifetime: Muse (one-time to perpetual, exact scope), Vellum (once, ten minutes, always), OpenClaw (bound to exact arguments).
- A revocation path the owner can use: OpenClaw lists and revokes standing grants; Vellum rules are editable in Settings; Muse's revocation is not documented; Instinct's disconnect does not auto-delete data.
- Credentials kept out of the model's reach (Vellum's credential service; Dots' saved passwords, see P2).

## P6. Text and voice channels

_Pillar scope: surfaces, one transcript across them, voice, push._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | iOS, Android, web, WhatsApp; one main chat plus side chats; approval dialogs appear in the client, not the chat. Voice, push and cross-surface continuity not documented. AI glasses 'coming soon'. | `[#1058]` `[02/verified]` |
| OpenAI Dots | ChatGPT, Slack, Teams and voice; texting later.¹ Activity View in the desktop app.² Cross-surface transcript and push not documented. | ¹ `[#1058/owner transcription]` ² `[#1058/search snippet]` |
| Instinct | Text or call; 'no new interfaces to learn'; voice data collected only if enabled. App, iMessage, WhatsApp, web chat not documented; assistant email addresses (press). | `[#1058]` `[#1058/press]` |
| Poke | Apple Messages, Telegram, WhatsApp, RCS; text or voice-message input; one phone number per account. No app or web chat documented. Live on Apple Messages for Business since 4 Jun 2026.¹ | `[#1058]` ¹ `[09/verified, press]` |
| Folk | iMessage and Telegram; WhatsApp 'switching on country by country'; not Signal, SMS, Discord or email chat; calls only to user's verified number; no app-store app. Push, cross-channel transcript not documented. | `[#1058]` |
| Vellum Assistant | Telegram (inline approval buttons), Slack, email, web, iOS, Android, desktop, phone; WhatsApp absent.¹ Notifications: iOS push, Telegram, Slack, web, desktop, CLI, not email or phone;¹ 02: all channels by default.² | ¹ `[#1058]` ² `[02/verified]` |
| OpenClaw | 25+ channels; all DMs share one session by default; identityLinks merges one person's accounts. iOS push via relay; approvals by card or /approve, never free-text 'yes'. Voice not documented. | `[02/verified]` `[09/verified]` |
| Hermes Agent | ~20 platforms (Telegram, WhatsApp, Signal, iMessage via BlueBubbles, email); sessions per chat and platform; README claims cross-platform continuity, docs show only /handoff; messaging approval is a typed 'yes'; ntfy channel. | `[02/verified]` |
| Letta | Telegram, Slack, Discord, WhatsApp, Signal (self-hosted); each chat routes to an agent and conversation, by default 'default'; DM policy pairing by default. Voice, push, channel approvals not documented. | `[02/verified]` |
| Khoj | Web, desktop, Obsidian, Emacs, phone, WhatsApp; automation results by email. Cross-surface continuity, voice and push not documented. | `[02/verified]` |

**Best in class here**

- **OpenClaw**: 25+ channels; all DMs share one session by default with identityLinks merging accounts; iOS push via relay; approvals by card or /approve, never free-text 'yes'. `[02/verified]` `[09/verified]`
- **Vellum Assistant**: native desktop, iOS and Android apps plus Telegram, Slack, email and phone; Telegram inline approval buttons; iOS push. Its notification targets differ between sources (see the P6 cell). `[#1058]` `[02/verified]`

**Parity bar**

- A native surface plus at least one messaging surface: Muse app, web and WhatsApp; Folk iMessage and Telegram; Poke Apple Messages, Telegram, WhatsApp and RCS.
- One owner transcript across surfaces is documented only by OpenClaw; Letta routes chats to a 'default' conversation, Hermes keeps per-platform sessions, Muse does not document it.
- Approvals settled by structured controls: Muse client dialog, OpenClaw cards, Vellum Telegram buttons. Hermes's typed 'yes' is the counter-example.
- Voice: Poke voice-message input, Folk calls, Vellum phone, Instinct call, Dots (unverified). Push: Vellum and OpenClaw iOS push.

## P7. Payments and identity

_Pillar scope: sign-in, purchases and their approvals, pricing model._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Purchases show exact details, need approval every time; single-use cards bound to merchant, amount, time. Free 'for most needs'; US only or US and Canada (posts differ). Sign-in not documented. | `[#1058]` `[02/verified]` |
| OpenAI Dots | Pro and Business Premium in eligible markets; Enterprise beta; first-dot allowances (not comparable unit economics); action review and approval.¹ Password-change hand-back is a core safety requirement.² Payments, sign-in not documented. | ¹ `[#1058/owner transcription]` `[#1058/press]` ² `[#1058/search snippet]` |
| Instinct | Terms: user appoints it as agent to enter binding agreements; safeguards 'may' be added, not guaranteed; no approval surface documented. Paid features non-refundable, no price published; private beta (press). | `[#1058]` `[#1058/press]` |
| Poke | Free $0, Pro $19/mo, Ultra $199/mo; credits $1 each, monthly reset, no carry-over. Approvals not documented; Nov 2025 note fixes 'approval loops when drafting emails' (email approval step inferred).¹ | `[#1058]` ¹ `[#1058/inference]` |
| Folk | Read-only Plaid link; 'never moves money and never cancels anything on its own'; user says 'send', emails go from user's Gmail. Free, Pro $9.99/mo, Max $100/mo (footer only). | `[#1058]` |
| Vellum Assistant | Free self-host; Cloud $30, $100, $200 per month (Mighty, Super, Ultra), $10 platform fee on top two, credits $1 each. Asks on high-stakes actions, including spending credits, until marked trusted. | `[#1058]` |
| OpenClaw | Purchases, payment approvals and sign-in not documented. identityLinks maps one person's accounts to one canonical peer; standing intents are owner-only on an authenticated channel; MIT-licensed. | `[02/verified]` |
| Hermes Agent | Purchases, payment approvals and sign-in not documented. DM pairing codes expire after 1 h; allowlists deny by default; MIT-licensed (Nous Research). | `[02/verified]` |
| Letta | Purchases, payment approvals, sign-in and pricing not documented. Apache-2.0 licensed; DM policy is pairing by default (Slack open). | `[02/verified]` |
| Khoj | Purchases, payment approvals, sign-in and pricing not documented. AGPL-3.0 licensed. | `[02/verified]` |

**Best in class here**

- **Meta Muse**: every purchase shows exact details and needs approval; single-use cards bound to merchant, amount and time. `[#1058]` `[02/verified]`
- **Folk**: read-only Plaid bank link; 'never moves money and never cancels anything on its own'; the user says 'send' and emails go from the user's own Gmail. `[#1058]`

**Parity bar**

- Every purchase shows exact details and needs owner approval each time (Muse); money movement and cancellations never happen on their own (Folk).
- Narrow payment instruments: single-use cards bound to merchant, amount and time (Muse); read-only bank access (Folk).
- Published tiers (Poke and Vellum with credits; Folk Free, Pro, Max); Muse is free 'for most needs' with no prices; Instinct publishes no price.
- No product documents its owner sign-in method; identity appears only as Poke's one phone number per account (P6) and OpenClaw's identity linking.

## P8. Evals and observability

_Pillar scope: public safety or eval claims, activity views, audit logs the user can see._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Avatar shows current work; tap for full activity log and approved permissions; launch post promises an audit trail of past and planned actions. Public security post; eval results not documented. | `[#1058]` `[02/verified]` |
| OpenAI Dots | Activity View shows ongoing and delegated tasks, status and steps taken; Custom Rules viewable in settings; 'Autoreview' cannot be altered by rules. Audit log, eval claims not documented. | `[#1058/search snippet]` |
| Instinct | Activity view, audit log and safety or eval claims not documented. Terms: users 'must verify Actions and monitor them regularly'. | `[#1058]` |
| Poke | Activity view not documented; usage bar and reset date shown on the subscription page. Public release notes exist (to 23 Jul 2026). Safety or eval claims not documented. | `[#1058]` |
| Folk | Activity log not documented; background items visible in settings and billing; wins and running totals kept in the text thread. Safety or eval claims not documented. | `[#1058]` |
| Vellum Assistant | Task states and schedule run history (status, duration, output, errors) via chat; no dedicated activity-log page documented; public roadmap lists open delivery bugs; MIT runtime. Eval claims not documented. | `[#1058]` `[02/verified]` |
| OpenClaw | Cron run history persists; /context list shows raw versus injected sizes; degraded summaries always warn the user; uncertain one-shots show delivery 'Unknown'. Eval claims not documented. | `[02/verified]` |
| Hermes Agent | Full-text search returns real past messages; delivery_failed tracked apart from failure streaks; memory entries scanned for injection. hermes doctor stayed green during a time-zone bug. Eval claims not documented. | `[02/verified]` |
| Letta | Desktop memory viewer; full history plus conversation search; docs warn a 'recovered' approval means the runtime got the command, not that the user decided. Eval claims not documented. | `[02/verified]` |
| Khoj | Activity views, audit logs and safety or eval claims not documented. | `[02]` |

**Best in class here**

- **Meta Muse**: avatar shows current work; tap opens the full activity log and approved permissions; the launch post promises an audit trail of past and planned actions; a public security post exists. `[#1058]` `[02/verified]`
- **OpenClaw** (partial here, because no activity view is documented): degraded summaries always warn the user, uncertain one-shots show delivery 'Unknown', and /context list shows what is injected. `[02/verified]`

**Parity bar**

- An owner-visible activity log or view that includes approved permissions (Muse); Dots' Activity View adds context, redirect and stop (unverified).
- Task states and run history the owner can ask for (Vellum; OpenClaw run history).
- Honest status: degraded or uncertain results shown as such (OpenClaw), failures tracked apart (Hermes), never 'ok' without delivery (the Vellum bug).
- No product documents eval results or safety metrics; transparency is Muse's public security post and Vellum's MIT runtime and public roadmap of open bugs.

## Health (the added column)

_Pillar scope: wearables or health-aware planning._

| Product | What it does (30 words or fewer) | Source tag |
|---|---|---|
| Meta Muse | Not documented on any page. | `[#1058]` `[02/verified]` |
| OpenAI Dots | Not documented. | `[#1058]` |
| Instinct | Privacy policy lists 'health-related information, such as medical appointments or emails from your healthcare provider' as sensitive data it may collect. No wearable integration documented. | `[#1058]` |
| Poke | Homepage advertises an Oura recipe ('sleep stages, readiness scores, and daily activity insights'); Fitbit, Strava in logo strip. The Oura page renders no content; the Health category names no device. | `[#1058]` |
| Folk | Strava connection; calorie and protein logging from meal photos; fitness plans, sleep and screen-time coaching as text routines; 'not a therapist', shares crisis resources. No wearable documented. | `[#1058]` |
| Vellum Assistant | None shipped. Roadmap lists 'Health & wellness' and 'Apple Watch', both 'Someday'. | `[#1058]` `[02/verified]` |
| OpenClaw | iOS health.summary: today-only aggregates, on demand, off by default (device toggle plus gateway allowlist); raw samples stay on device, aggregates 'may remain in chat history'; a missing metric is ambiguous. | `[02/verified]` |
| Hermes Agent | Not documented. | `[02]` |
| Letta | Not documented. | `[02]` |
| Khoj | Not documented. | `[02]` |

**Best in class here**

No product is strong here, and none documents health-aware planning. The documented leaders, in order of depth:

- **OpenClaw** (data path only): opt-in iOS HealthKit aggregates, on demand, today only, raw samples kept on the device. `[02/verified]`
- **Folk**: Strava connection, calorie and protein logging from meal photos, sleep and screen-time coaching routines with a 'not a therapist' boundary. `[#1058]`
- **Poke** (advertised, unverified): an Oura recipe on the homepage whose page renders no content. `[#1058]`

**Parity bar**

- No product documents health-aware planning; the documented bar is data access only.
- Opt-in and bounded access: off by default, on demand, today-only aggregates, raw samples on the device (OpenClaw).
- A missing metric is ambiguous (OpenClaw).
- Adjacent features: Strava, meal-photo logging, coaching with crisis resources (Folk); Instinct's policy treats health content as sensitive data.

## Overview: products by pillars

Verdicts are derived from the pillar tables above (tags are there). They grade documentation depth in the three sources, not product quality; a bracketed note narrows the verdict.

| Product | P1 | P2 | P3 | P4 | P5 | P6 | P7 | P8 | Health |
|---|---|---|---|---|---|---|---|---|---|
| Meta Muse | partial | strong | strong (memory only) | strong | strong | partial | strong | strong | not documented |
| OpenAI Dots | partial (unverified) | partial (unverified) | partial (unverified) | partial (unverified) | partial (unverified) | partial (unverified) | partial (unverified) | partial (unverified) | not documented |
| Instinct | not documented | partial | not documented | not documented | partial | partial | partial | not documented | partial (policy only) |
| Poke | partial | not documented | partial | partial | partial | partial | partial | not documented | partial (advertised) |
| Folk | partial | strong | strong (memory only) | strong | strong | partial | strong | partial | partial |
| Vellum Assistant | strong (open bugs) | partial | strong | strong (open bugs) | strong | strong | partial | partial | none |
| OpenClaw | strong | not documented | strong | strong | partial | strong | partial (identity linking) | partial | partial (data only) |
| Hermes Agent | strong | not documented | strong | strong | partial | strong | partial (pairing only) | partial | not documented |
| Letta | partial | not documented | partial | partial | partial | partial | partial (pairing only) | partial | not documented |
| Khoj | not documented | not documented | not documented | partial | not documented | partial | not documented | not documented | not documented |

P1 durable workflows, P2 computer use, P3 memory and skills, P4 triggers and scheduled jobs, P5 connectors and auth, P6 text and voice channels, P7 payments and identity, P8 evals and observability. Health is the added column.

## Notable differentiators to watch

- **No one documents health-aware planning.** Nearest: OpenClaw's iOS HealthKit path (02 says it is the only documented one among the agents it read and narrows any 'only agent that reads Apple Health' claim, `[02/inference]`), Poke's advertised Oura recipe (page empty), Folk's Strava and meal-photo logging; Vellum lists health as 'Someday'. `[#1058]` `[02/verified]`
- **Meta Muse's Sentinel.** One authority for connector actions: allow, deny or ask; the dialog sits in the client, not the chat, and shows the exact action; purchases are approved every time; a process that has read user data loses auto-allow. Undo and grant revocation are not documented. `[#1058]` `[02/verified]`
- **One owner transcript.** OpenClaw: all DMs share one session by default, identityLinks merges accounts, free-text 'yes' does not authorize, the first committed answer wins across devices. 02 calls this default unique to OpenClaw among those it read. `[02/verified]` `[09/verified]`
- **OpenAI Dots (unverified).** Custom Rules (independent, approval or never), an Activity View to add context, correct, redirect or stop, 4,000+ app plugins, a separate cloud computer with saved passwords not exposed to the model. The 29 Sep launch is first-party confirmed by OpenAI's news feed; the rest rests on owner transcription, search snippets and press, not a fetched OpenAI page. `[#1058/owner transcription]` `[#1058/search snippet]` `[#1058/press]` `[#1058/feed, first-party]`
- **Silence and delivery honesty.** Silence is a model-decided outcome in OpenClaw (`NO_REPLY`), Hermes (`[SILENT]`, but failures always deliver) and Muse ('meaningfully new or needs your input'). Vellum shows the opposite failure in its open bugs: notifications logged 'ok' but undelivered, heartbeat silent six days. `[02/verified]` `[#1058]`
- **Agents that write their own skills and memory.** OpenClaw's Skill Workshop (versions, undo), Hermes's `skill_manage` (optional `write_approval`), 'dreaming' consolidation in OpenClaw and Letta. A ClawHub supply-chain audit (Jan to Feb 2026) reports 341 malicious skills of 2,857. `[09/verified]` `[02/verified]` `[09/search snippet]`
- **Channel reach.** Poke is live on Apple Messages for Business since 4 Jun 2026; 'first and only AI agent' is Poke's own claim. Folk calls only the user's verified number. Instinct is text or call. `[09/verified, press]` `[#1058]`
- **Trust and counterparty risks.** Amazon blocked Muse on 20 Sep. Instinct's terms give broad agency with non-guaranteed safeguards; secondary-source snippets report an email sent without approval, a successful injection test and Gmail copies kept after disconnect. 02 says to read these as illustrations, not established fact. `[#1058/press]` `[#1058]` `[02/search snippet]`
