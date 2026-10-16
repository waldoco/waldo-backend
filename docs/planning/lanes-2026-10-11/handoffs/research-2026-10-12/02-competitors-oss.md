# Competitors and open-source personal agents: how they handle what Waldo promises

Prepared 2026-10-12 by a read-only research agent for the overnight orchestrator. Nothing was edited, committed, pushed, posted, cloned or signed up for.

## Provenance tags

- `[verified]`: read today (2026-10-12) on a first-party page: a vendor page, an official docs domain, or the canonical GitHub repo or its issue tracker. Pages went through a summarising fetch tool, not saved as raw HTML. Short quotes are what that tool returned.
- `[#1058]`: taken from the Audit lane's refresh, PR waldoco/waldo-backend#1058 (branch `audit/competitor-refresh-20261011`, head `65fc2031`, file `docs/planning/waldo-agent-mvp/COMPETITOR_RESEARCH.md`). That lane fetched those pages on 2026-10-11; I did not re-fetch them.
- `[press]` / `[secondary]`: press, Wikipedia, review blogs or competitor blogs. Used only for context and risk examples, never as fact in a matrix cell.
- `[search snippet]`: a search engine's excerpt; the page itself was not fetched.
- `[inference]`: my conclusion, not a vendor statement.
- "Not documented" means it is not on the pages I fetched. It does not mean the feature is absent.

Docs for the open-source projects change weekly. The star counts and versions below are as observed on 2026-10-12. None of the GitHub pages showed a release tag.

## Identification of "Instinct" and "MetaMuse"

| Owner's name | Identified as | Confidence | Basis |
|---|---|---|---|
| MetaMuse | **Meta Muse**, Meta's personal AI agent. Launched 8 Sep 2026 (post updated 30 Sep). iOS, Android, muse.ai web and WhatsApp. | High (~95%) | #1058 pins it. I re-read three Meta first-party pages today. Name clashes ruled out: the Interaxon Muse EEG headband (a wellness wearable, not an agent) and "Metamuse", the podcast of the Muse thinking app (not an agent). |
| Instinct | **Instinct**, from Spear Street Technology, Inc. (d/b/a Instinct), instinct.com. A personal agent you text or call. | High-moderate (~85-90%) | #1058 pins it, and it is the only personal-agent product by that name I found. It sits in the same competitive set: press lists it as a Personal Agent Protocol partner [press via #1058] and covers it among agents that live in your texts [press]. Name clashes ruled out: Garmin's Instinct watch line and Instinct Science (veterinary software). Note that "Instinct" is also the name of a Waldo contributor lane (`docs/planning/lanes-2026-10-11/instinct/`). That lane is unrelated. |

## Capability matrix

Products × dimensions. Cells are terse; the per-product notes carry the detail and the URLs. The Meta Muse and open-source rows were read on 2026-10-12. The Instinct row is from #1058 (2026-10-11).

| Product | Memory | Proactivity | Long sessions and compaction | Tools and approvals | Channels / one transcript? | Health / wearables | Onboarding / time zone / push |
|---|---|---|---|---|---|---|---|
| **Meta Muse** (closed) | Persists across conversations. User can read, edit and download the memory files and tell it to "forget" things. Training opt-out. Retrieval and supersession not documented. [verified] | Runs in the background on schedules and events. Notifies only when something is "meaningfully new or needs your input". User can turn proactivity off, down or up. Goals and Ideas tabs. Quiet hours not documented. [verified] | Main chat is "one long conversation"; side chats give separate context. Says it "can manage lots of context". Mechanism not documented. [verified] | Sentinel is the sole authority: allow, deny or ask. The approval dialog appears in the client, **not in the chat**, and shows the exact action. Grants: one-time, session, task, time-bounded or perpetual, with exact-scope match. Purchases need approval every time. Read-only actions proceed. Undo and revoke not documented. [verified] | App, web, WhatsApp. Whether conversation or memory carries across surfaces is not documented. [verified] | Not documented. [verified] | Tips "in your first days". Time zone not documented. Push not documented explicitly. [verified] |
| **Instinct** (closed) | Not documented. Privacy policy: indexed data can be deleted; disconnecting does not auto-delete. [#1058] | Not on vendor pages. [#1058] | Not documented. | Terms: acts as the service "may deem" responsive; safeguards "may" be added and are not guaranteed; the user must monitor; actions may be irreversible. No approval UI documented. [#1058] | Text or call. [#1058] Assistant email addresses [press]. | Privacy policy anticipates health-related content (appointments, provider emails). No wearables. [#1058] | Invite-only [press]. Not documented otherwise. |
| **OpenClaw** (MIT, ~392k stars) | Markdown files. USER.md and MEMORY.md load at session start. Daily notes are searchable with hybrid vector and keyword search. Users edit the files directly. USER.md is superseded in place. A "dreaming" pass promotes notes and excludes untrusted ones. A silent memory save runs before compaction. [verified] | Heartbeat every 30 min in the main session. Active hours use the user's time zone. Nothing to say is a `NO_REPLY` or a structured `notify:false`. Flood guards. Persisted cron automations. Event-triggered "standing intents". [verified] | Auto-compacts near the context limit. Keeps a recent tail of about 20k tokens. "Safeguard" mode checks for pending asks and exact identifiers, and a degraded summary always warns the user. Full history stays on disk. `/compact` takes focus instructions. [verified] | Permission modes. Native approval cards, or `/approve <id> allow-once\|deny`. A free-text "yes" does **not** authorize. Allow-always is bound to exact arguments. Automation grants are standing until revoked, can expire, and can be listed and revoked. The first committed answer wins across devices. [verified] | 25+ channels. Default `dmScope: main`: **all DMs share one session**. `identityLinks` merges one person's accounts. Groups are kept separate. [verified] | iOS node `health.summary`: today-only aggregates, on demand, off by default. Raw samples stay on the device, but aggregates "may remain in chat history". [verified] | Onboarding wizard. `userTimezone` (default is the host's). Each turn gets a date and time-zone block with no live clock. Inbound messages are timestamped in the user's zone. iOS push goes through a relay using App Attest. [verified] |
| **Hermes Agent** (Nous, MIT, ~253k stars) | MEMORY.md (2,200 chars) and USER.md (1,375 chars) form a frozen snapshot per session. At the cap, the agent must consolidate. Optional staged writes for the user to approve or reject. Full-text search over all past sessions. Injection scanning. Plug-in providers (Honcho, Mem0…). [verified] | Cron jobs run in a fresh session per run. A `[SILENT]` marker suppresses delivery, but **failures always deliver**. Missed runs catch up once. Retries at 5, 15 and 30 min. Failure alerts are de-duplicated. Cron runs cannot create cron jobs. No ambient heartbeat documented. [verified] | Triggers at 50% of the window (75% for windows under 512K). Protects the first 3 messages and a recent tail. Prunes old tool output. **Structured summary template**, updated in place. Keeps an identifier index and verbatim user quotes. Old turns are soft-archived and searchable, never deleted. [verified] | Dangerous commands: "smart" (an auxiliary model) by default, or manual or off. Options: once, session, always, deny. Times out after 300 s and fails closed. In messaging, approval is a **text "yes"**. Unattended runs are denied. [verified] | ~20 platforms (Telegram, WhatsApp, Signal, iMessage via BlueBubbles, Email, SMS…). **Sessions are per chat, keyed by platform.** The README claims "cross-platform conversation continuity", but the docs show only `/handoff` and shared search. [verified] | Not documented. | Time zone is an IANA name or `HERMES_TIMEZONE`; empty means server-local. Bug: an invalid zone was silently ignored (#111725, closed). Bug: DST drift when the zone is empty (#119969, open). ntfy channel. [verified] |
| **Letta / Letta Code** (Apache-2.0, ~25k stars) | Memory is a git repo, shared across all of an agent's conversations. `system/` files are in the prompt every turn; the rest are read on demand. `/remember`. "Dreaming" subagents consolidate memory, triggered by step count or a compaction event. [verified] | Schedules (`letta cron add`). Each run gets a new conversation by default; `--conversation default` targets the main one. Cloud runs in UTC. No quiet hours. No heartbeat. [verified] | Auto-compacts older messages; conversations are "infinite length". The summary "may omit exact wording or provenance", but full history plus conversation search remain. `/fork` and `/btw` for side questions. [verified] | Permission modes. SDK `canUseTool` can allow (optionally with **edited input**) or deny with a reason. Pending approvals survive a disconnect. [verified] | Telegram, Slack, Discord, WhatsApp, Signal (self-hosted). Each chat routes to an agent and conversation, by default **"default"**. Memory is shared across conversations. [verified] | Not documented. | Cloud cron runs in UTC; local cron uses the machine's zone. Push not documented. [verified] |
| **Vellum Assistant** (MIT, ~1.4k stars) | README: eight memory types, isolated per user and per channel. [verified] Corrections "replace outdated understanding". [#1058] | Hourly heartbeat that surfaces only what needs attention. Active-hours window. Watchers with a watermark. Missed one-shots fire on restart; missed recurring runs do not replay. [verified] **Open bugs: notifications logged successful but never delivered; heartbeat silent for 6 days.** [verified] | Per-turn recall is bounded separately from compaction. [#1058] Mechanism not documented. | "Grant once, for ten minutes, or always". Default deny. [verified] Risk tiers; Allow / Deny / Allow & Create Rule; "Show details" shows the full input. [#1058] | macOS, Windows, iOS, Web, Voice, Email, Telegram, Slack, Twilio. [verified] Notifications go to all channels by default. [verified] | Roadmap: "Health & wellness" and "Apple Watch" both "Someday". [verified] | iOS push. [#1058] Time zone not documented. |
| **Khoj** (AGPL-3.0, ~38k stars) | Retrieval over the user's own documents. A memories setting is hinted only by a plugin changelog. [search snippet] | Automations set up in the UI with a cron time. "Uses your local time zone". Results arrive **by email**. [verified] | Not documented. | Not documented. | Web, desktop, Obsidian, Emacs, phone, WhatsApp. Continuity not documented. [verified] | Not documented. | Local time zone for automations. [verified] |

Other products #1058 covers, not re-fetched here, one line each, `[#1058]`:

- **Folk:** memory dashboard with search, delete and forget, plus a CLEARMEMORY wipe. Asks before sending email or invites. Calls only the user's verified number.
- **Poke:** Apple Messages, Telegram, WhatsApp and RCS. Approvals not documented.
- **OpenAI Dots:** Custom Rules (independent / approval / never) and an Activity View. These rest on search snippets only; the pages returned 403.

## Per-product notes

### Meta Muse

Sources, all `[verified]` on 2026-10-12:

- Design page: https://introducing.muse.ai/
- Launch post: https://about.fb.com/news/2026/09/introducing-muse-personal-ai-agent/ (dated 8 Sep, updated 30 Sep 2026)
- Security post: https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse

Small-business connectors are in #1058.

- **Main chat.** Muse is designed as one long conversation "you'd have with another person". You can interrupt it, or send several tasks without waiting. Side chats were added because testers wanted separate context per topic. Whether side chats share memory with the main chat is not documented.
- **Visibility.** A snippet of current work appears under the avatar. Tapping it opens the full activity log and the approved permissions. A Goals tab holds plans, and an Ideas tab holds suggestions drawn from goals, patterns and conversations. The launch post promises a complete audit trail of what Muse has done and plans to do.
- **Proactivity.** Background work runs on a schedule and in response to relevant events. Muse surfaces results only when they are meaningfully new or need input, and unprompted messages must be "worth the interruption". The user can turn proactivity off, down or up. Quiet hours and push are not documented.
- **Approvals.**
  - When Sentinel decides to ask, execution stops and a dialog appears in the Muse client, not in the chat. The answer goes straight to Sentinel.
  - Grants are one-time, session, task, time-bounded or perpetual, and Sentinel chooses which types to offer. Grants are "strict capabilities, not conversational suggestions", and a later call must match the granted scope exactly.
  - Read-only, previously allowed and low-risk actions proceed without a prompt. Purchases show exact details every time and use single-use cards bound to merchant, amount and time.
  - Users can remove individual actions beyond what OAuth grants, e.g. Gmail settings access.
  - Taint tracking: a process that has read user data loses auto-allow.
  - The email connector filters one-time codes, password-reset links and magic links.
  - Undo and grant revocation are not documented; the VM is backed up so it can be restored.
- **Memory.** Users can "inspect, edit and download these files freely", including Muse's memory about them. Per-item forgetting works on request. Users can opt out of training on their interactions.
- **Gaps.** Compaction, cross-surface transcript, time zones, push mechanics and health are all not documented. No Muse help centre was found [search].

### Instinct

Sources: the homepage, privacy policy and terms at instinct.com, as summarised in #1058 (fetched 2026-10-11; `/faq` and `/blog` were empty). Not re-fetched today: #1058 had found the FAQ and blog empty, and nothing new was expected.

- Every product claim beyond "text or call" is undocumented on vendor pages. The terms give the service broad agency and make no guarantee of safeguards. [#1058]
- Risk examples only, `[search snippet]` of secondary sources (review blogs and TechCrunch). I did not fetch these pages:
  - an email reportedly sent without approval;
  - a successful email-based prompt-injection test;
  - Gmail copies retained after Google was disconnected.

  Treat these as illustrations of what goes wrong when approvals are not a hard gate, not as established fact. Snippet source: https://www.eesel.ai/blog/instinct-ai-review. TechCrunch items are as cited in #1058.

### OpenClaw (formerly Clawdbot, then Moltbot)

Repo: https://github.com/openclaw/openclaw (MIT, ~391.7k stars; no release tag shown). Docs: https://docs.openclaw.ai (linked from the README). The rename history (Clawdbot to Moltbot on 27 Jan 2026, then to OpenClaw on 30 Jan 2026) is `[secondary]`: https://en.wikipedia.org/wiki/OpenClaw. All pages below are `[verified]` on 2026-10-12.

- **Sessions and continuity** (https://docs.openclaw.ai/concepts/session).
  - `session.dmScope` defaults to `main`, so all DMs share the main session "for continuity". The alternatives are `per-peer`, `per-channel-peer` (recommended for multi-user setups) and `per-account-channel-peer`.
  - `session.identityLinks` maps one person's identities across channels to one canonical peer.
  - Groups default to `per-group`.
  - Resets: none by default (compaction manages growth). Optional daily reset at a set hour, or reset after N idle minutes. Heartbeat and cron events do not count as activity for the idle timer.
- **Heartbeat** (https://docs.openclaw.ai/gateway/heartbeat).
  - Defaults: `every: 30m`, in the main session, `target: owner` (never a group).
  - `activeHours` takes a time zone: `"user"` means `agents.defaults.userTimezone`.
  - Nothing to report means `NO_REPLY`, or a `heartbeat_respond` call with `notify:false`. An alert is `notify:true` plus `notificationText`, and the structured call takes precedence over text.
  - Visibility flags: `showOk` (off by default), `showAlerts` and `useIndicator`.
  - Anti-spam rules:
    - the default prompt tells the agent not to infer or repeat old tasks from prior chats;
    - heartbeat-only replies do not keep sessions alive;
    - scheduled heartbeats defer while queues are busy;
    - event wakes are at least 30 s apart, with a flood guard after 5 starts in 60 s.
  - The first alert explains the periodic checks and how to switch them off.
  - Cost: `isolatedSession: true` cuts each run from about 100K tokens to about 2-5K.
- **Automations / cron** (https://docs.openclaw.ai/automation/cron-jobs/how-it-works).
  - Jobs and run history persist in SQLite.
  - Overdue jobs are rescheduled after a restart, not replayed immediately.
  - Interrupted one-shots whose delivery may have started stay disabled with delivery **"Unknown"**.
  - Jobs that keep failing auto-disable and notify the owner.
  - A run-id that is already in flight is reported as a duplicate.
  - One-shots auto-delete only after delivery is confirmed.
- **Standing intents** (https://docs.openclaw.ai/concepts/standing-intents).
  - Event-conditioned "prospective memory", created by the agent's `intent` tool. Owner only; needs an authenticated channel and sender.
  - Defaults: 24 h cooldown, at most 3 fires, 90-day expiry. Cancellation happens only on explicit request.
  - Matching uses a deterministic keyword prefilter (see the caution under Implications).
- **Compaction** (https://docs.openclaw.ai/concepts/compaction).
  - Auto-compacts near the limit or after an overflow error, then retries.
  - Tool calls stay paired with their results. The recent tail is `keepRecentTokens` (default 20,000).
  - Summarizer input is budgeted: half for the newest messages, a quarter for older user requests and decisions, the rest for the oldest messages plus samples. Gaps are marked with the count of omitted messages.
  - `compaction.mode: "safeguard"` (the default for new configs) checks summary structure, pending asks and exact identifiers, and retries. If it still fails, it stores the best summary and marks it degraded.
  - A degraded summary always shows the user a warning; routine compaction is silent (`notifyUser: false`).
  - `identifierPolicy: "strict"`.
  - "The full conversation history stays on disk."
  - Memory page: a silent memory-save turn runs before compaction (default on) and appends to the day's note.
- **Memory** (https://docs.openclaw.ai/concepts/memory).
  - USER.md holds directives and is superseded in place. MEMORY.md holds curated facts and is loaded at start; it is truncated in context if too big, while the file stays intact. `memory/YYYY-MM-DD.md` daily notes are indexed.
  - `memory_search` (hybrid) and `memory_get`.
  - "Dreaming" (on by default) promotes candidates through score and diversity gates and excludes untrusted and system-derived candidates.
  - `/context list` shows raw vs injected sizes and truncation.
- **Approvals** (https://docs.openclaw.ai/gateway/permission-modes and https://docs.openclaw.ai/cli/approvals).
  - Modes: `read-only`, `guarded` (human review), `workspace` (a model reviewer returns allow, deny or ask-human) and `full`.
  - In messaging channels the approval request appears as a native card where supported, else `/approve <id> allow-once|deny`. "Free-text replies such as 'yes' do not authorize changes."
  - Changing modes cancels pending approvals. Stopping a run cancels its approval, and a later approve cannot revive it. There is no undo of side effects.
  - Exec decisions are `allow-once`, `allow-always` and `deny`. Allow-always is bound to the exact arguments and working directory.
  - For automations, allow-always creates a scoped standing grant that lasts until revoked, with optional expiry via `--expires-in-days`. Grants can be listed and revoked.
  - `askFallback` defaults to `deny`.
- **iOS app and push** (https://docs.openclaw.ai/platforms/ios).
  - The app is a chat surface and a device node.
  - Push for App Store builds goes through a relay. The app registers with App Attest; the relay holds the APNs credentials; the gateway signs each send. Silent push triggers background wakes, and a wake counts only once the gateway acknowledges it.
  - The approval card shows a sanitized preview, the expiry, and only the decisions on offer. "The first committed answer wins", with state shared across clients. Actions stay disabled until the gateway confirms the request is still pending.
- **HealthKit** (https://docs.openclaw.ai/platforms/ios-healthkit).
  - `health.summary` returns steps, sleep duration, resting heart rate and workouts, for today only and on demand.
  - Off by default. Enabling it needs both the on-device toggle and a gateway allowlist entry.
  - "Raw samples do not leave the device"; aggregates go to the AI provider and "may remain in chat history".
  - HealthKit does not reveal denied read access, so a missing metric is ambiguous.
  - Read-only; not medical advice.
- **Time zone** (https://docs.openclaw.ai/concepts/timezone).
  - `agents.defaults.userTimezone`, defaulting to the host's zone.
  - Each turn gets a "Temporal Context" block, outside the system prompt, with the local date and zone but no live clock, so the cached prefix stays stable. Exact time comes from a `session_status` tool.
  - Inbound messages carry envelopes like `[Signal +1555 Sun 2026-01-18 00:19:42 PST]`. Tool payloads always include UTC.

### Hermes Agent (Nous Research)

Repo: https://github.com/NousResearch/hermes-agent (MIT, ~252.8k stars; no release shown). Docs: https://hermes-agent.nousresearch.com/docs/ (linked from the README). All `[verified]` on 2026-10-12.

- **Memory** (https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).
  - MEMORY.md holds the agent's notes (2,200 chars); USER.md holds the user profile (1,375 chars).
  - Loaded once as a frozen snapshot at session start. Mid-session writes reach disk immediately but enter the prompt only in the next session.
  - Tool actions: add, replace and remove, matched by substring. Over the cap, the tool errors and the agent must consolidate in the same turn.
  - The agent saves preferences and corrections automatically and skips ephemera and raw dumps.
  - `write_approval: true` stages writes behind `/memory pending|approve|reject`.
  - Entries are scanned for injection and exfiltration patterns.
  - `session_search` runs full-text search over all CLI and messaging sessions in one SQLite database. It returns real messages, not summaries.
  - Plug-in providers: Honcho, Mem0, Supermemory and others.
- **Context compression** (https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching).
  - `compression.threshold` defaults to 0.50 of the window (floored at 0.75 for windows under 512K). A separate gateway safety net fires at 85%.
  - Protects the first 3 messages and a recent tail (lean mode: about 2.5% of the window, clamped to 10-25K tokens).
  - Old tool outputs over 200 chars are replaced with a placeholder.
  - The summary template has fixed sections: Goal; Constraints & Preferences; Progress (Done / In Progress / Blocked); Key Decisions; Relevant Files; Next Steps; Critical Context.
  - The summary budget is 20% of the compressed content, from 2K up to the lesser of 12K tokens or 5% of the window. Later compactions update the existing summary.
  - Lean mode keeps an identifier index (PR numbers, SHAs, paths, error strings), quotes real user messages verbatim, and adds a `session_search` pointer for recovering what was summarized away.
  - Pre-compaction turns are soft-archived (`compacted=1`): searchable and never deleted.
  - Prompt caching keeps the system prompt stable across turns.
- **Sessions** (https://hermes-agent.nousresearch.com/docs/user-guide/sessions and https://hermes-agent.nousresearch.com/docs/user-guide/messaging).
  - Gateway keys look like `agent:main:telegram:dm:<chat_id>`: one session per DM chat.
  - The only cross-platform mechanism documented is `/handoff <platform>`, which moves a live CLI conversation to a platform's home channel.
  - No idle or daily reset by default ("one continuous session" that survives restarts).
  - DM pairing codes expire after 1 h; allowlists deny by default.
  - Background tasks report back as "✅ Background task complete" or "❌ Background task failed".
- **Cron** (https://hermes-agent.nousresearch.com/docs/user-guide/features/cron).
  - Each run is a fresh session; `continuity` can inject the previous output. Delivery goes to the origin chat, a named platform, or all home channels.
  - `[SILENT]` suppresses delivery, but "Failed runs always deliver".
  - A pre-check script can skip the agent entirely.
  - Catches up once after an outage, not once per missed slot.
  - Transient retries run at 5, 15 and 30 min, and only when no model call was made.
  - After 3 consecutive failures there is a review nudge. The same incident alerts once and repeats every 6 h.
  - `delivery_failed` is tracked apart from the failure streak.
  - Cron sessions cannot create cron jobs (`cron.allow_agent_scheduling: false` by default).
- **Approvals** (https://hermes-agent.nousresearch.com/docs/user-guide/security).
  - `approvals.mode` defaults to `smart`: an auxiliary model auto-approves low risk, auto-denies the dangerous, and escalates the uncertain. `manual` and `off` are the alternatives.
  - Options: once, session, always (added to a permanent allowlist) and deny (the default).
  - `approvals.timeout` is 300 s and a timeout denies (fail-closed).
  - **In messaging platforms, approval is a text reply** ("yes", "ok", "go").
  - Cron, one-shot and API runs deny dangerous commands by default.
  - A hardline blocklist applies even in "yolo" mode.
- **Time zone** (https://hermes-agent.nousresearch.com/docs/user-guide/configuration plus issues).
  - Set with `timezone:` (IANA) or `HERMES_TIMEZONE`; empty means server-local.
  - Issue https://github.com/NousResearch/hermes-agent/issues/111725 (closed 16 Sep 2026): an invalid zone was silently ignored, so the clock and all cron ran on server time while `hermes doctor` stayed green.
  - Issue https://github.com/NousResearch/hermes-agent/issues/119969 (open, opened 23 Sep 2026): with no zone set, cron and one-shots fire an hour off after DST, because a fixed UTC offset is reused.

### Letta (formerly MemGPT), now centred on Letta Code

Repo: https://github.com/letta-ai/letta (Apache-2.0, ~25.1k stars; the README says "actively developed"; the V1 API server is retired to an `archive` branch). Docs: https://docs.letta.com/. All `[verified]` on 2026-10-12.

- **Memory** (https://docs.letta.com/configuration/memory/index.md and https://docs.letta.com/agent-sdk/memory/index.md).
  - Memory is a git-backed file system, shared across all of an agent's conversations. Files under `system/` are in the prompt every turn; others appear as a file tree the agent reads on demand.
  - `/remember <lesson>`.
  - "Dreaming" subagents review recent conversations and update memory. Triggers: `step-count` (example: 25) or `compaction-event`. An optional second pass reviews proposed updates before they apply.
  - A memory viewer exists in the desktop app. User-side edit and delete are not documented.
- **Conversations and compaction** (https://docs.letta.com/concepts/conversations/index.md).
  - One agent can have many conversations, all sharing memory.
  - Auto-compaction summarizes older messages and keeps recent ones, so conversations can be "infinite length".
  - Letta states the summary may omit exact wording or provenance, and that full history stays available through conversation search.
  - `/fork` branches a conversation; `/btw` answers a side question in the background.
- **Schedules** (https://docs.letta.com/configuration/schedules/index.md).
  - Created with `--at`, `--cron` or `--every`.
  - Each run gets a new conversation by default; `--conversation default` targets the main thread.
  - Cloud cron is evaluated in UTC.
  - Local schedules fire only while the app is open. An overdue local one-shot (more than 5 min late) may be marked missed.
  - No quiet hours.
- **Channels** (https://docs.letta.com/self-hosting/channels/index.md).
  - Telegram, Slack, Discord, WhatsApp and Signal.
  - Routes bind a chat ID to an agent and conversation, by default `"default"`.
  - DM policy is `pairing` by default (Slack is `open`).
- **Approvals** (https://docs.letta.com/agent-sdk/permissions/index.md and https://docs.letta.com/configuration/permissions/index.md).
  - Modes: `standard` (the SDK default), `acceptEdits`, `unrestricted` (the CLI default) and `strict`.
  - `canUseTool` returns allow, optionally with `updatedInput` (edit before run), or deny with a message, optionally interrupting the turn.
  - Pending approvals survive a disconnect via `recoverPendingApprovals()`. The docs warn that "recovered" means the runtime got the command, not that the user decided.
  - A guard blocks access to other agents' memory.

### Vellum Assistant (open-source runtime)

- Repo: https://github.com/vellum-ai/vellum-assistant (MIT, ~1.4k stars). `[verified]`
- Scheduling: https://www.vellum.ai/docs/key-concepts/scheduling `[verified]`
- Roadmap: https://www.vellum.ai/roadmap `[verified]`
- Other docs: per #1058.

Notes:

- **Heartbeat.** `heartbeat.intervalMs` defaults to 1 h, with an active-hours window. It runs in a separate background conversation and "only surfaces things when they need your attention".
- **Watchers.** Gmail, Outlook, GitHub, Google and Outlook calendars, and Linear, polled every 15-60 s with a watermark against duplicates.
- **Run modes.** Execute, notify (no model), script, workflow.
- **Restarts.** Missed one-shots fire on restart; missed recurring runs do not replay.
- **Delivery.** Notifications go to all channels by default.
- **Open roadmap bugs:**
  - "Unattended notifications not reaching devices" (observed 30 Sep; logged as successful but undelivered);
  - one-shot timers reported fired but not delivered on web (28 Sep);
  - heartbeat "permanently silent" with zero runs over six days (30 Sep-5 Oct).
- **Health.** "Health & wellness" and "Apple Watch" are "Someday".
- **Approvals.** The README offers "grant once, for ten minutes, or always", with deny as the default.
- **Memory.** Eight memory types, isolated per user and per channel.

### Khoj

Repo: https://github.com/khoj-ai/khoj (AGPL-3.0, ~37.6k stars; no deprecation notice; it promotes a sibling open-source product, "Pipali"). Docs: https://docs.khoj.dev. `[verified]`

- Automations (https://docs.khoj.dev/features/automations) are created in the web UI with a cron time, use the user's local time zone, and deliver research **by email**. Self-hosting needs Resend for that.
- Clients: browser, desktop, Obsidian, Emacs, phone, WhatsApp.
- A memory feature is not documented in the docs; a plugin changelog mentions disabling memories. [search snippet]
- Of the open-source agents here, Khoj is the least relevant to Waldo's proactive and approval loop. [inference]

## Cross-cutting observations

1. **Approval authority sits outside the conversation in the strongest designs.** [verified]
   - Muse puts the dialog in the client, outside the chat, and answers go to Sentinel.
   - OpenClaw refuses a free-text "yes" and uses cards or `/approve <id>`.
   - Hermes is the counter-example: in messaging, approval is a typed "yes".
2. **One shared transcript across channels is the default only in OpenClaw.** [verified]
   - OpenClaw: `dmScope: main` plus `identityLinks`.
   - Letta can route every chat to its "default" conversation.
   - Hermes keys sessions per platform and chat, despite its README.
   - Muse does not document it.
3. **Silence is a first-class, model-decided outcome of a proactive run.** Examples: OpenClaw's `NO_REPLY` and `heartbeat_respond`, Hermes's `[SILENT]`, Muse's interrupt bar, Vellum's "only surfaces". Failures are the exception: Hermes always delivers failures, and OpenClaw auto-disables failing jobs and notifies the owner. [verified]
4. **Compaction designs converge on the same rules.** [verified]
   - Never delete history.
   - Keep a recent tail verbatim.
   - Preserve identifiers and pending asks.
   - Give the model a retrieval path for whatever was summarized away: Hermes's `session_search` pointer, Letta's conversation search, OpenClaw's memory search.
   - Warn when the summary is degraded.
5. **Delivery honesty is where the shipped systems are weakest.** Vellum has open bugs where notifications were "logged as successful" but never delivered. OpenClaw marks uncertain one-shots "Unknown". [verified]
6. **Health.** No product documents health-aware *planning*. OpenClaw now has the only documented HealthKit path among these agents: today-only aggregates, on demand, which "may remain in chat history". [verified] [inference] This narrows any "only agent that reads Apple Health" claim; it does not touch health-aware planning.
7. **Time zone failures are silent by default.** Hermes falls back to server time on a bad or empty zone (one issue closed, one open). OpenClaw defaults to the host's zone but has a clean per-turn date-and-zone block. [verified]

## Implications for Waldo

Before writing this list I checked Waldo's own code read-only, so it does not recommend what already exists. The checks were `git grep` and `git show` on `origin/beta-mvp` @ `4bb040f5`, plus `heartbeat.ts` at the worktree HEAD. Grep is not exhaustive, so treat "not found" as a lead.

**Heartbeat** (`packages/runtime/src/channels/heartbeat.ts`):

- A deterministic 30-min tick with no model turn.
- Quiet hours suppress sends.
- An unchanged past-due loop is re-notified only after a 4 h cooldown.
- Every tick's decision is recorded in `schedule_runs`. Ambiguous attempts are quarantined; only a validated provider ACK settles delivery.

**Approvals** (`packages/runtime/src/channels/approvals.ts`, `app-approvals.ts`, `whatsapp-api.ts`):

- Decisions arrive as button callbacks to the approval desk. The app has its own endpoint that rejects a reused request (`request_reused`), and WhatsApp buttons are converted into the same callback.
- I found **no typed-text approval path**.
- Once one surface decides, the other surfaces' buttons are cleared (best effort).
- An approval claimed before its effect resolves reads `outcome_unknown`, never done.
- Effects carry a 10-minute undo where the provider allows it.
- A card that cannot show the full content carries no approve button.
- Email sends are bound to a digest of the exact message.

**Long sessions** (`packages/runtime/src/conversation/window.ts`):

- A token-aware rolling window with a ~100k-token ceiling that drops the oldest messages and never fails the turn.
- Drops are only written to a trace log (`owner-turn.ts` `onWindow`). They are not shown to the model or the owner, and there is no summary of what was dropped.
- `provider.ts` also trims history oldest-first to the sanitiser's limits.
- Oversized tool outputs are trimmed with a retrieval pointer (`read_tool_output`).
- `search_episodes` searches past conversations by keyword and reads a stored turn in full by its ref.
- The working-memory carryover contract (`packages/contracts/src/runtime/working-memory.ts`) has no runtime caller (case-insensitive grep).

**Already aligned; keep it, don't rebuild.** Several of these go beyond anything the competitors document:

- ACK-settled delivery and `outcome_unknown`. Vellum's open bugs and OpenClaw's "Unknown" state show this is the hard part.
- A 10-minute undo. No competitor page documents undo, and OpenClaw explicitly does not roll back side effects.
- Button-only approval authority with cross-surface clearing. This matches OpenClaw and Muse, and is stricter than Hermes's typed "yes".
- No approve button when the content cannot be shown in full.
- Firing the latest elapsed occurrence once after missed runs. This matches Hermes (catch up once) and Vellum (recurring runs not replayed).
- Retrieval paths for out-of-view material (`search_episodes`, `read_tool_output`). This matches Hermes `session_search` and Letta's conversation search.
- Provenance and corrections-replace in memory. #1058 found no vendor page stating provenance.

### Useful tonight (small, reversible: tests, prompt, config)

1. **Tell the model when the rolling window has dropped older turns.** Today the drop is only logged.
   - Add one bounded line of context, e.g. "N earlier messages in this conversation are out of view; use `search_episodes` to recall them." The line carries a count only, no content.
   - Sources:
     - OpenClaw's summarizer marks gaps with the number of omitted messages (https://docs.openclaw.ai/concepts/compaction).
     - Hermes adds a `session_search` pointer for recovering what was summarized away (https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching).
     - Letta points to conversation search for wording the summary lost (https://docs.letta.com/concepts/conversations/index.md).
   - It is small and reversible. It gives the model context rather than a fixed rule, and needs no new persistence. A single trigger is a long app main-chat session that crosses ~100k tokens. [inference]
2. **Guard tests for Waldo's existing button-only approval authority.** These pin current behaviour; a runtime change is needed only if a test fails.
   - (a) A typed "yes" or "send it" while an approval is pending does not settle it. I found no typed path; the test keeps it that way. Source: OpenClaw, "Free-text replies such as 'yes' do not authorize changes" (https://docs.openclaw.ai/gateway/permission-modes); Muse puts the dialog outside the chat (https://research.meta.ai/blog/security-and-safety-for-ai-agents-our-approach-with-muse).
   - (b) Server-side, the second decision on the same approval from another surface (app vs Telegram) is rejected cleanly, not just visually cleared. Source: OpenClaw, "The first committed answer wins" (https://docs.openclaw.ai/platforms/ios).
   - (c) Stopping or cancelling the run cancels its pending approval, and a later tap cannot revive it. Source: https://docs.openclaw.ai/gateway/permission-modes.

   If the owner *wants* conversational approval on some surface, (a) becomes an owner decision, not a test. Do not "fix" it overnight. [inference]
3. **Time zone honesty.**
   - An unset `'UTC'` placeholder must never reach the model as if it were the owner's real zone. Lane memory says the zone is auto-written only over `'UTC'`, so `'UTC'` doubles as "not set". If the zone is unknown, the model should say so. This is Hermes #111725 in Waldo's terms: an invalid zone was silently replaced by server time while health checks stayed green (https://github.com/NousResearch/hermes-agent/issues/111725).
   - Add a DST-transition test for reminders and day cards using the owner's IANA zone, so scheduling follows zone rules, not a fixed offset. Source: Hermes's open bug #119969 (https://github.com/NousResearch/hermes-agent/issues/119969).
   - Optional: show the owner-local date and zone each turn outside the cached prefix, with exact time via a tool, and stamp inbound turns in the owner's zone. Source: https://docs.openclaw.ai/concepts/timezone.
4. **"Missing is not low" check for health.** HealthKit does not reveal denied read access, so a missing metric is ambiguous (https://docs.openclaw.ai/platforms/ios-healthkit). Add or confirm a prompt rule plus a test that missing or revoked metrics read as "no data" and never as a low score. This is already a stated Waldo constraint; the citation adds the platform reason.

   Do **not** copy OpenClaw's choice to let health aggregates "remain in chat history". Waldo forbids raw or derived numeric health values in transcripts and DO memory.

### Later (needs an ADR, contract, persistence or app work)

1. **Summarize what the window drops in the long app main chat.** Waldo already windows by tokens and has retrieval through `search_episodes` and `read_tool_output`. What it lacks is a summary of the dropped span and a guaranteed carry-over of open items. Spec ingredients:
   - **Never delete history; the summary is a derived view.** Waldo's stored rows already stay put. Sources: https://docs.openclaw.ai/concepts/compaction, plus Hermes soft-archive and Letta full history.
   - **Keep a verbatim recent tail by token budget**, and keep tool calls paired with their results. Sources: OpenClaw `keepRecentTokens` 20k; Hermes 10-25K tail.
   - **Structured summary sections, updated in place.** Source: Hermes Goal / Constraints & Preferences / Progress / Key Decisions / Next Steps / Critical Context (https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching).
   - **Carry pending approvals, open loops and exact identifiers across the boundary.** Source: OpenClaw safeguard mode checks pending asks and identifiers.
   - **Degrade visibly.** Source: OpenClaw always warns on a degraded summary.
   - **Give the model a pointer and tool for what's out of view.** Sources: Hermes `session_search` pointer; Letta conversation search.
   - **Waldo constraints** [inference]:
     - The owner DO is the one writer of the summary.
     - The summary and any pre-compaction memory save go through Scribe and carry no raw health values. OpenClaw's silent save writes raw notes to disk, which is not acceptable here.
     - Memory consolidation can hook the compaction event, as Letta's `compaction-event` trigger does (https://docs.letta.com/agent-sdk/memory/index.md).
2. **Standing-grant taxonomy (ADR).**
   - Muse: one-time, session, task, time-bounded or perpetual, with exact-scope match.
   - OpenClaw: automation allow-always is a standing grant that lasts until revoked, with optional expiry, list and revoke (https://docs.openclaw.ai/cli/approvals).
   - Vellum: once, ten minutes, or always, with deny as the default.
   - Hermes: a 300 s timeout that fails closed.

   Waldo's constraint (grants scoped by owner, resource, parameter, time and budget, revocable, rechecked) already points here. The transferable detail: a grant is a record with scope and lifetime, shown on the card along with its expiry, as OpenClaw's iOS card does.
3. **One owner transcript across channels.** OpenClaw's default (`dmScope: main` plus `identityLinks`, https://docs.openclaw.ai/concepts/session) and Letta's "default" conversation routing support Waldo's one-brain, app-first direction. Tag each turn with a channel envelope, OpenClaw style, so the model and the app know where a turn came from. OpenClaw recommends per-peer isolation only for multi-user installs, and Waldo is single-owner per DO. [inference] Side threads, if any: Muse side chats; Letta `/fork` and `/btw`.
4. **Activity and "what Waldo is doing" surface.** Muse: a work snippet under the avatar, then the full log plus approved permissions (https://introducing.muse.ai/). Vellum: task states queued / running / awaiting_review / done [#1058]. This is an additive app.v1 change, so tell the app lane first.
5. **Memory UX.**
   - In-app edit, forget and download, as in Muse.
   - Optionally staged writes the owner approves (Hermes `write_approval`).
   - Size caps that force consolidation (Hermes 2,200 / 1,375 chars).
   - Consolidation that excludes untrusted sources (OpenClaw dreaming).

   Waldo's provenance model stays the differentiator. [#1058]
6. **Proactivity controls and cost.**
   - A model-decided "nothing worth sending" outcome for future *optional* model-written nudges, such as watcher-style alerts on email or calendar changes. Failures always surface. Sources: OpenClaw `heartbeat_respond` `notify:false` and `NO_REPLY` (https://docs.openclaw.ai/gateway/heartbeat); Hermes `[SILENT]` with "Failed runs always deliver" (https://hermes-agent.nousresearch.com/docs/user-guide/features/cron); Muse's "meaningfully new or needs your input" (https://introducing.muse.ai/).
     - It does not apply to today's deterministic heartbeat, or to owner-expected messages: morning brief, day cards, nightly.
     - The judgment stays with the model. No keyword or interest filter.
     - OpenClaw's default heartbeat prompt also tells the agent not to bring back old tasks from prior chats.
   - User dial off / down / up (Muse).
   - Active hours in the owner's zone, plus visibility flags and flood guards (OpenClaw heartbeat).
   - Run model-written proactive turns in an isolated, bounded context (OpenClaw `isolatedSession`, about 100K to 2-5K tokens; Hermes fresh session plus optional continuity; Letta new conversation per scheduled run) and deliver the result into main chat.
   - Relevant to the ~6 s per model call latency baseline. [inference]
7. **Scheduler hardening.**
   - Auto-disable a job after repeated failures and notify the owner (OpenClaw).
   - De-duplicate failure alerts with a repeat interval, and track `delivery_failed` apart from the failure streak (Hermes).
   - Scheduled machine turns cannot create schedules unless explicitly allowed (Hermes `cron.allow_agent_scheduling: false`). Check whether Waldo machine turns can create reminders today.
8. **Event-conditioned "standing intents"** (OpenClaw: cooldown 24 h, 3 fires, 90-day expiry, explicit cancel only, https://docs.openclaw.ai/concepts/standing-intents). Caution: OpenClaw fires on a deterministic keyword prefilter. Under Waldo's rules, a prefilter may only shortlist candidates; the model decides relevance.
9. **Push delivery architecture.** OpenClaw's relay pattern: App Attest registration, the relay holds the APNs credentials, the gateway signs each send, and a wake counts only once the gateway acknowledges it (https://docs.openclaw.ai/platforms/ios). It is a reference for the "direct APNs + keyless" spike noted in Waldo's lane memory.

## Sources that could not be fetched, and gaps

- **Instinct:** not re-fetched today; #1058's 2026-10-11 reads stand, and its `/faq` and `/blog` were empty then. All product behaviour beyond text or call is undocumented.
- **Meta Muse:** no help centre found. Cross-surface continuity, compaction, time zone and push mechanics are undocumented.
- **OpenAI Dots:** pages returned HTTP 403 to the Audit lane on 2026-10-11 [#1058]. Not attempted today.
- **OpenClaw:** user-facing push notification types are not documented. The `llms.txt` index was only partly read (200k of 211k chars).
- **Hermes:** no ambient heartbeat feature found. The `/handoff` semantics for platform-to-platform moves were not explored.
- **Letta:** approvals in messaging channels, user-side memory edit and delete, and the time zone for `--at` are not documented.
- **Khoj:** memory is not documented. Silence when there is nothing new is not documented.
- **Not covered:** other OpenClaw-style forks (e.g. nanobot) and memory layers (Mem0, Honcho) as standalone products.
