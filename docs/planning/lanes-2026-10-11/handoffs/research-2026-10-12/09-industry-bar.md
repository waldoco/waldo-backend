# Industry standard for Waldo's eight agent pillars (as of 12 Oct 2026)

Prepared 12 Oct 2026 by a read-only web research agent. Method: WebSearch and WebFetch only. Nothing was signed up for, logged into, downloaded, executed, submitted or posted.

## How to read this

**Labels**
- `[verified]`: I fetched the page today (12 Oct 2026). Fetches go through a summarising tool, so wording is paraphrased. The date given is the page's own publication or "last updated" date when it shows one.
- `[search snippet]`: I saw only a search-engine result or excerpt. Pages that returned 403 or were not found are in this group.
- `[02]` / `[04]`: taken from the earlier research files `docs/planning/lanes-2026-10-11/handoffs/research-2026-10-12/02-competitors-oss.md` and `04-harness-context.md`. That agent fetched those pages on 12 Oct; I did not re-fetch them.
- `[inference]`: my own conclusion.

**Scope**
- Every "Table stakes" and "Leading" bullet is my synthesis from the cited sources, so each carries `[inference]`.
- This file does **not** assess Waldo. I read no Waldo source. The per-pillar "Questions for Waldo" lines are comparisons to run, not findings.
- Topics already covered on 12 Oct are cited only where needed:
  - context engineering, harnesses, tools and Tool Search;
  - Claude context editing, memory, compaction and caching;
  - OpenAI caching and compaction;
  - Letta, Hermes and OpenClaw compaction;
  - the competitor matrix.

---

## P1. Durable workflows

### Evidence

**Anthropic**
- **"Scaling Managed Agents: Decoupling the brain from the hands"** (8 Apr 2026), https://www.anthropic.com/engineering/managed-agents `[verified]`
  - The system splits into three parts:
    - the *brain*: Claude plus a stateless harness loop;
    - the *hands*: sandboxes and tools behind one `execute(name, input)` interface;
    - the *session*: an append-only durable event log outside both, and outside the context window.
  - On a harness crash, a new harness calls `wake(sessionId)`, loads the log with `getSession(id)`, resumes from the last event, and records progress with `emitEvent`.
  - The harness reads slices of the log with `getEvents()`, so compaction never loses data permanently.
  - Sandbox failures come back to Claude as tool errors, and a fresh container can be provisioned.
  - OAuth tokens sit in a vault, behind a proxy that uses a session-scoped token. Credentials never enter the sandbox.
  - Provisioning containers on demand cut time-to-first-token by about 60% at p50 and over 90% at p95.
- **Claude Managed Agents docs** (beta header `managed-agents-2026-04-01`), https://platform.claude.com/docs/en/managed-agents/overview `[verified]`
  - Core concepts are agent, environment, session and events.
  - Event history is persisted server-side, and you can steer or interrupt mid-run.
  - Scheduled deployments run on cron.
  - Managed Agents is **not eligible for Zero Data Retention or HIPAA BAA** coverage.
- **Claude Agent SDK sessions**, https://code.claude.com/docs/en/agent-sdk/sessions `[verified]` (no date shown)
  - `continue`, `resume` and `fork` work on the conversation, not the filesystem. File checkpointing is a separate feature.
  - A `SessionStore` adapter mirrors transcripts to shared storage so another host can resume.
  - The docs say that passing captured application state into a fresh session is often more robust than shipping transcript files.
- **"Effective harnesses for long-running agents"** `[04]`: at session start, read a progress file, a feature list and git history; compaction alone is not enough.

**Cloudflare** (Waldo's substrate)
- **Agents `schedule()`** (updated 3 Jun 2026), https://developers.cloudflare.com/agents/api-reference/schedule-tasks/ `[verified]`
  - Tasks live in the Durable Object's SQLite and are woken by DO alarms. They survive restarts.
  - Cron schedules are idempotent by default. Delay and Date schedules are not, unless `idempotent: true` is set.
  - A `retry` option is available.
  - `scheduleEvery` skips a run if the previous one is still going.
  - Limits: 2 MB per task, practical limit of tens of thousands of tasks per agent, one-minute cron precision.
- **Agents `runWorkflow()` / `AgentWorkflow`** (updated 26 Jun 2026), https://developers.cloudflare.com/agents/runtime/execution/run-workflows/ `[verified]`
  - Durable `step` helpers do not repeat on retry: `reportComplete`, `sendEvent`, `updateAgentState`.
  - Non-durable helpers (`reportProgress`, `broadcastToClients`) may repeat.
  - Approvals use `waitForApproval(step, {timeout})` with `approveWorkflow()` / `rejectWorkflow()`.
  - Status is tracked in a `cf_agents_workflows` SQLite table with the states queued, running, paused, waiting, complete, errored and terminated. The docs recommend a retention policy.
  - Limits: 10k steps by default (25k configurable), 10 MB state, 30 minutes per step, event waits up to one year.
- **Human-in-the-loop guide** (updated 14 Jul 2026), https://developers.cloudflare.com/agents/concepts/human-in-the-loop/ `[verified]` describes three layers:
  - **Workflow approval:** the wait can last months without a running Agent.
  - **MCP elicitation:** form or URL mode, typically finishing within minutes.
  - **Durable Code Mode approval:** set `requiresApproval: true` on a connector method. On approval, the same code re-runs under the same execution ID. Completed calls replay from the durable log, and only the approved call executes.
  - Pending approvals survive DO hibernation.
  - `schedule()` can drive reminders and escalation.
  - On timeout, the approval comes back empty; the example then escalates or throws.
- **AIChatAgent tools** use the AI SDK's `needsApproval`, either a fixed boolean or a function of the tool input `[search snippet]`.
- **Rules of Workflows** (updated 8 Oct 2026), https://developers.cloudflare.com/workflows/build/rules-of-workflows/ `[verified]`
  - Steps can retry, so they should be idempotent.
  - For non-idempotent calls such as charging a card, first check inside the step whether the action already happened.
  - Only step return values persist.
  - Step names are cache keys and must be deterministic.
  - Code outside steps can run more than once.
- **`step.waitForEvent`** (updated 2 Jun 2026), https://developers.cloudflare.com/workflows/build/events-and-parameters/ `[verified]`
  - Default timeout is 24 hours; the maximum is 365 days.
  - Events sent early are buffered until the workflow reaches the wait.
  - On timeout the instance fails unless the error is caught.

**Other engines**
- **Temporal human-in-the-loop cookbook**, https://docs.temporal.io/ai-cookbook/human-in-the-loop-python `[verified]`. Last updated 20 Jan 2026 per `[search snippet]`.
  - An approval signal and `wait_condition` with a durable timer pause the workflow for risky actions only.
  - The sample times out after 5 minutes. Rejected or timed-out actions are cancelled.
- **Inngest durable agents**, https://www.inngest.com/docs/learn/durable-agents `[verified]`
  - Every model and tool call is a memoized step with its own retries. `NonRetriableError` stops retries.
  - `waitForEvent` pauses without holding a worker.
  - The docs warn that a tool can change an external system and fail before its result is saved, so writes, sends and payments need idempotency keys.
  - Also covered: per-user concurrency keys, cancellation, and caps of 4 MiB per step and 32 MiB per run.
- **Restate durable agents**, https://docs.restate.dev/ai/patterns/durable-agents `[verified]`
  - A journal records each step. Replay skips completed steps.
  - Tool side effects go inside `ctx.run()`.
  - The page claims effects run exactly once but does not explain how.
  - Durable approvals and sessions appear only in the AI overview `[search snippet]`.
- **DBOS**, https://docs.dbos.dev/why-dbos `[verified]`
  - Postgres checkpoints let a workflow resume from its last completed step.
  - Durable sleep and notifications support waits of days or weeks.
  - You can fork a workflow from a given step for evals.
  - Exactly-once and idempotency claims, and the caveat that external effects can already have happened before a crash, are `[search snippet]` only.
- **LangGraph interrupts**, https://docs.langchain.com/oss/python/langgraph/interrupts `[verified]`
  - `interrupt()` plus `Command(resume=…)` requires a checkpointer and a `thread_id`.
  - On resume, **the node re-runs from the top**, so any side effect before the interrupt must be idempotent.
  - Resume values are matched to interrupts by index.
  - `response_schema` validates resume values (langgraph ≥1.2.12).

### Table stakes `[inference]`
- **A durable run log outside the model and any single process.** Any worker resumes from the last recorded step. Sources: Managed Agents, Restate, Temporal, DBOS, Inngest, LangGraph.
- **Approval waits that hold no compute and survive restarts or hibernation.** Each wait has an explicit timeout outcome: escalate, reject, or proceed without approval. Sources: Cloudflare, Temporal, Inngest, LangGraph.
- **Engines do not make external effects exactly-once.** Every write, send or payment needs an idempotency key, or a check inside the step that it hasn't already happened. Sources: Cloudflare Rules, Inngest, the DBOS caveat.
- **Durable, deduplicated schedules**, plus per-user concurrency limits, cancellation, and step, time and token budgets.

### Leading `[inference]`
- **Brain / hands / session decoupling** (Managed Agents). The log is readable in slices, so the context is a view of the log, not the store.
- **Approval that resumes by deterministic replay.** Same execution ID; completed calls come from the log; only the approved call runs. Sources: Cloudflare durable Code Mode, Restate journals.
- **Credentials outside the execution environment**, held in a vault behind a proxy with session-scoped tokens.
- **Typed, schema-validated resume payloads** (LangGraph `response_schema`).
- **Operability:** a queryable run-status table, pause/resume/restart/terminate, retention, and fork-from-step for debugging and evals. Sources: Cloudflare, DBOS.

### Patterns to compare against
1. Cloudflare Agent + `AgentWorkflow` + `waitForApproval()` + durable step helpers: https://developers.cloudflare.com/agents/runtime/execution/run-workflows/
2. The Managed Agents session log with `wake` / `getSession` / `emitEvent`: https://www.anthropic.com/engineering/managed-agents
3. Inngest's idempotency-key and `waitForEvent` discipline: https://www.inngest.com/docs/learn/durable-agents

### Gates
- No regulatory gate.
- Hosted options carry a data-retention constraint: Managed Agents has no ZDR and no HIPAA BAA `[verified]`.
- Cloudflare Workflows limits: 10 MB state, 30-minute steps, waits of at most one year `[verified]`.

### Questions for Waldo (not assessed)
- Does every external effect carry a key that survives DO eviction and replay?
- Is the pending-approval timeout an explicit, owner-visible outcome?

---

## P2. Can use a computer

### Evidence

**Anthropic**
- **Computer use tool**, https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool `[verified]` (no date shown)
  - The current version is `computer_toolset_20260801`: GA on the Claude API and Google Cloud, no beta header, 17 member tools including `zoom`, and batched actions.
  - On the Claude API, Claude 5.5-era models reject the older `computer_20251124` and `computer_20250124`.
  - It is not available in Managed Agents.
  - Security guidance:
    - use a dedicated VM or container with minimal privileges;
    - restrict network access to a domain allowlist;
    - get human confirmation for consequential actions (cookies, financial transactions, terms of service);
    - provider classifiers scan screenshots for prompt injection;
    - putting credentials in the prompt raises injection risk;
    - **inform end users and get their consent before enabling the tool.**
- **Browser use toolset** `browser_toolset_20260801`, https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool `[verified]` (no date shown)
  - It runs client-side, with 27 member tools plus 4 optional ones.
  - It works from the accessibility tree with element references (`[ref_N]`) and supports tabs.
  - GA on the Claude API and Google Cloud. **ZDR-eligible**, excluding covered models.
  - Security guidance:
    - enforce the domain allowlist at the network layer and recheck it after redirects;
    - block loopback and private ranges;
    - refuse any scheme other than http or https;
    - use a fresh profile with no stored credentials;
    - keep `javascript_exec` and `file_upload` off unless the task needs them;
    - the **executor** approves purchases, account changes, messaging and acceptance of terms, and checks every call in a multi-call turn.
- **"Mitigating the risk of prompt injections in browser use"** (24 Nov 2025), https://www.anthropic.com/research/prompt-injection-defenses `[verified]`
  - Defences are layered: RL training, classifiers on all untrusted content, and red teaming.
  - Claude Opus 4.5 had about 1% attack success rate against an adaptive best-of-N attacker given 100 attempts.
  - The post says "No browser agent is immune to prompt injection."
- **"How we contain Claude across products"** (25 May 2026), https://www.anthropic.com/engineering/how-we-contain-claude `[verified]`
  - Contain at the environment layer first: gVisor, Seatbelt / bubblewrap, or full VMs.
  - Treat egress allowlists as capability grants.
  - Keep credentials outside the agent's environment, using a scoped, revocable session token.
  - Prompt-injection attack success was about 0.1% on single attempts and about 5–6% after 100 adaptive attempts.
  - Auto mode catches about 83% of overeager actions.
  - Listed gaps:
    - exfiltration through an approved domain;
    - a phished user instruction succeeded 24 of 25 times.
- Secondary reports of Opus 5 at "0%" in browser-agent tests are `[search snippet]` and depend on the setup. Not relied on here.
- **Claude in Chrome permissions guide** (updated 12 Aug 2026), https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide `[verified]`
  - GA in Cowork and Claude Code; beta in the Chrome browser.
  - Three modes:
    - **Manual:** asks before each action.
    - **Auto:** a safety check reviews each action and blocks unsafe ones.
    - **Skip all approvals:** no pauses and no automatic checks.
  - Permissions are set per site.
  - Claude always asks before downloads, entering sensitive information, or granting authorizations.
  - **Prohibited in every mode:** purchases, trades, creating accounts, handling card or ID data, permanent deletions, and following instructions found in emails or web content.

**OpenAI**
- **Computer use guide**, https://developers.openai.com/api/docs/guides/tools-computer-use `[verified]` (no date shown)
  - The recommended path is code execution: the model writes Playwright or PyAutoGUI scripts. The structured `computer` tool is the alternative.
  - Confirm purchases, data transmission (typing sensitive information counts) and destructive changes.
  - Treat "screen content as untrusted."
  - Set step, time and cost limits; support cancellation; verify the actual outcome.
  - Use an allow list and an isolated browser or VM.
- **ChatGPT agent help page**, https://help.openai.com/en/articles/11752874-chatgpt-agent `[search snippet]` (HTTP 403 today)
  - Confirmations for high-impact actions.
  - "Watch mode" on certain sites.
  - Takeover mode for logins, during which screenshots are not captured.
  - Prompt-injection monitoring.

**Infrastructure and tools**
- **Cloudflare Playwright MCP on Browser Run** (updated 21 Apr 2026), https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/ `[verified]`
  - A fork of Microsoft Playwright MCP that works from accessibility snapshots, not pixels.
  - Deploys on Workers with a `BROWSER` binding plus a Durable Object.
  - A CDP endpoint arrived in April 2026 `[search snippet]`.
- **browser-use Cloud**, https://docs.browser-use.com/introduction `[verified]`: V4's `secretBindings.allowedDomains` scopes where each secret may be entered.
- **Stagehand / Browserbase** `[search snippet]`: `act` / `extract` / `observe` / `agent`, self-healing selectors, server-side action cache.

### Table stakes `[inference]`
- **An isolated, credential-free browser or VM per task.** Network-layer egress allowlist; private ranges and non-http(s) schemes blocked.
- **Executor-enforced human confirmation** for purchases, sends and posts, account changes, ToS or cookie consent, and entering sensitive data. The model's own judgement is not the gate.
- **Page content can never grant permission.** Provider injection classifiers stay on.
- **Logins by user takeover or a dedicated low-privilege account.** Avoid putting passwords in prompts; Anthropic permits it but warns that it raises injection risk.
- **Step, time and cost caps, cancellation, and outcome verification.**
- **End-user disclosure and consent before enabling.**

### Leading `[inference]`
- **Accessibility tree first, screenshots as fallback** (Claude browser toolset, Playwright MCP).
- **Classifier-reviewed autonomy that escalates to a human** (Chrome Auto mode, Claude Code auto mode).
- **A hard prohibited-action list that no mode can lift** (Chrome).
- **Per-secret domain binding** (browser-use).
- **Containment designed for residual injection risk** rather than assuming the model resists it.
- **Cryptographic agent identity to websites** (see P7).

### Patterns to compare against
1. The Claude browser toolset's security checklist: https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool
2. The Claude in Chrome mode and prohibition model: https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide
3. Cloudflare Browser Run with Playwright MCP, a substrate fit: https://developers.cloudflare.com/browser-run/playwright/playwright-mcp/

### Gates
- Anthropic's docs require end-user consent before enabling computer or browser use `[verified]`.
- Bot defences on target sites; see P7 signed agents.
- Residual prompt-injection risk is non-zero by the vendors' own figures `[verified]`.

### Question for Waldo (not assessed)
Is any purchase or send reachable from a browsing session without the approval desk?

---

## P3. Skills (memory is covered elsewhere)

### Evidence

**The standard**
- **Agent Skills specification**, https://agentskills.io/specification `[verified]` (no date shown)
  - A skill is a directory containing `SKILL.md`.
  - `name`: at most 64 characters, lowercase letters, digits and hyphens, matching the directory name.
  - `description`: at most 1,024 characters, saying what the skill does and when to use it.
  - Optional fields:
    - `license`;
    - `compatibility` (at most 500 characters);
    - `metadata`;
    - `allowed-tools`, which is experimental.
  - Optional directories: `scripts/`, `references/`, `assets/`.
  - Progressive disclosure:
    - metadata, about 100 tokens;
    - instructions, under 5,000 tokens recommended, and under 500 lines;
    - resources loaded on demand.
  - Validate with `skills-ref validate`.
- **"Equipping agents for the real world with Agent Skills"** (16 Oct 2025), https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills `[verified]`
  - Updated 18 Dec 2025, when Skills was published as an open standard.
  - Install skills only from trusted sources, and audit the rest.
  - Anthropic hopes agents will eventually create, edit and evaluate their own skills.

**Anthropic platform**
- **Claude Agent Skills docs**, https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview `[verified]`
  - Using skills on the API requires the code execution tool. The container has **no network access and no runtime package installation**.
  - Custom skills uploaded through the API are shared workspace-wide.
  - Skills do not sync across surfaces.
  - Treat a skill like installing software: a malicious skill can exfiltrate data.
  - Enterprise skill content scanning does not cover skills uploaded through the API.
  - **Skills are not covered by ZDR.**
- **"Code execution with MCP"** (4 Nov 2025), https://www.anthropic.com/engineering/code-execution-with-mcp `[verified]`: agents save working code as reusable functions, and adding a `SKILL.md` turns those into skills.

**Open-source agents**
- **OpenClaw skills**, https://docs.openclaw.ai/tools/skills `[verified]` (no date shown)
  - Compatible with AgentSkills.
  - Seven load locations with a precedence order.
  - Gating through `requires.bins`, `requires.env`, `requires.config` and an OS filter.
  - ClawHub shows scan status (VirusTotal, ClawScan), `skills verify` checks a trust envelope, and an `installPolicy` can run a check before installs.
  - **Skill Workshop**: the agent creates and updates its own skills, keeps prior versions, and supports undo.
  - The skill index costs about 24 tokens per skill, with a cap; `skills_search` finds skills dropped from the index.
- **Hermes skills**, https://hermes-agent.nousresearch.com/docs/user-guide/features/skills `[verified]`
  - Compatible with agentskills.io, with an index of about 3k tokens.
  - The agent creates and patches skills itself through `skill_manage`, and a background review can stage changes.
  - Install scanning covers exfiltration, injection, destructive commands and supply-chain signals. A "dangerous" verdict cannot be forced.
  - The optional `skills.write_approval` setting stages agent-written skills until the user approves them. By default the agent writes freely.
- **ClawHub "ClawHavoc" supply-chain attack** (Jan–Feb 2026; Koi Security audit found 341 malicious skills out of 2,857) `[search snippet]`, e.g. https://www.esecurityplanet.com/threats/hundreds-of-malicious-skills-found-in-openclaws-clawhub

### Table stakes `[inference]`
- **SKILL.md / agentskills.io format with progressive disclosure.** Only name and description stay resident.
- **Skills are code.** Use trusted sources or audit them, scan at install, and gate them by environment and allowlist.
- **A token budget for the skill index**, with search for overflow.

### Leading `[inference]`
- **Agent-authored skills** distilled from successful runs and from user corrections, with versioning, undo, and optional staged human approval (OpenClaw Workshop, Hermes `write_approval`).
- **Instructions paired with deterministic scripts** whose code never enters context.
- **Supply-chain controls:** verified trust envelopes, install policy, and quarantine.
- **Skills validated and evaluated before activation.**

### Patterns to compare against
1. The agentskills.io specification: https://agentskills.io/specification
2. Hermes `skill_manage` with `write_approval`: https://hermes-agent.nousresearch.com/docs/user-guide/features/skills
3. OpenClaw gating plus Workshop versions and undo: https://docs.openclaw.ai/tools/skills

### Gates
- No regulatory gate.
- Security: marketplace poisoning.
- Retention: API skills are not ZDR-covered `[verified]`.

### Question for Waldo (not assessed)
Do agent-written procedures go through the same owner review as memory proposals?

---

## P4. Triggers and scheduled jobs

### Evidence

**Platform primitives**
- **Cloudflare Agents `schedule()` / `scheduleEvery()`**: see P1 `[verified]`. Managed Agents also offers cron "scheduled deployments" `[verified]`.
- **Gmail push notifications** (updated 15 Sep 2026), https://developers.google.com/workspace/gmail/api/guides/push `[verified]`
  - Call `users.watch` with a Pub/Sub topic, and grant publish rights to `gmail-api-push@system.gserviceaccount.com`.
  - The watch lapses after 7 days; Google recommends renewing daily.
  - The payload carries only the email address and a `historyId`; fetch the changes with `history.list`.
  - Limit: **1 notification per second per user**. The excess is dropped.
  - Notifications can be delayed or lost, so **fall back to periodic `history.list`**.
  - Avoid handlers that change the mailbox and so trigger more notifications.
- **Google Calendar push** (updated 11 Sep 2026), https://developers.google.com/workspace/calendar/api/guides/push `[verified]`
  - Watch channels need an HTTPS webhook with a valid certificate.
  - **Channels do not renew automatically.**
  - The first message on a channel is a `sync` message.
  - Notifications carry no data, so a follow-up sync is required.
  - Notifications can be dropped.
  - `X-Goog-Channel-Token` lets you verify the sender.

**Products** (all `[02]` unless marked)
- **OpenClaw**
  - A heartbeat every 30 minutes, within active hours in the user's time zone.
  - A run with nothing to say returns `NO_REPLY` or `notify:false`. Flood guards apply.
  - Cron jobs persist.
  - **Standing intents** fire on events, with a 24-hour cooldown, at most 3 fires and a 90-day expiry.
- **Hermes cron**
  - Each run gets a fresh session.
  - `[SILENT]` suppresses delivery, but failures always deliver.
  - A missed run catches up once. Retries come at 5, 15 and 30 minutes.
  - A cron run cannot create another cron job.
- **Meta Muse**
  - Runs on schedules and events.
  - Notifies only when something is meaningfully new or needs input.
  - The user can turn proactivity off, down or up.
- **ChatGPT Tasks**, https://help.openai.com/en/articles/10291617 `[search snippet]`
  - Active-task caps by plan: Go 3, Plus 5, Business 10, Pro 15.
  - Notifies on a meaningful update.
  - No webhooks.
- **ChatGPT Pulse** (Sep 2025) `[search snippet]` (the announcement returned 403)
  - Research runs overnight, asynchronously, and delivers a **finite** set of daily cards.
  - The user steers it with a "curate" control and thumbs feedback.
  - Gmail and Calendar connectors are optional and off by default.

**App Store**
- **4.5.4**, https://developer.apple.com/app-store/review/guidelines/ `[verified]`
  - The app cannot require push notifications.
  - **Pushes must not carry sensitive personal or confidential information.**
  - Marketing pushes need explicit opt-in.

**Gap:** primary evidence on quiet hours and notification budgets is thin today. The Apple HIG notifications page rendered empty, so the iOS interruption-level guidance is **not verified** here. The verified practice in hand is:
- OpenClaw's active hours and flood guards `[02]`;
- Muse's proactivity dial `[02]`;
- Hermes's silence-unless-failed rule `[02]`;
- ChatGPT's caps on active tasks `[search snippet]`.

### Table stakes `[inference]`
- **Durable schedules in the owner's IANA time zone** that survive restarts, are deduplicated, and handle DST correctly. The Hermes DST bug is in `[02]`.
- **Provider push for events** (Gmail watch through Pub/Sub, Calendar channels), plus renewal jobs and a **polling fallback**, because pushes get dropped.
- **Silence is a model-decided outcome of a proactive run, but failures always surface.**
- **Owner control over proactivity and active hours.** No sensitive content in push payloads.
- **Caps on standing jobs and on notifications per window.**

### Leading `[inference]`
- **Event-conditioned standing intents** with a cooldown, a fire cap, an expiry and explicit cancel (OpenClaw).
- **A finite daily brief built overnight** and tuned by owner feedback (Pulse).
- **An explicit "meaningfully new or needs your input" bar** with a user dial (Muse).
- **Catch-up and retry ladders.** Jobs cannot spawn jobs (Hermes).

### Patterns to compare against
1. Gmail `watch` → `history.list`, with daily renewal and a fallback poll: https://developers.google.com/workspace/gmail/api/guides/push
2. OpenClaw heartbeat plus standing intents: https://docs.openclaw.ai/gateway/heartbeat and https://docs.openclaw.ai/concepts/standing-intents
3. Cloudflare `schedule()` idempotency flags: https://developers.cloudflare.com/agents/api-reference/schedule-tasks/

### Gates
- App Store 4.5.4 `[verified]`.
- Gmail event triggers require reading message history, and every general Gmail read scope on Google's scopes page is **restricted**. Mail triggers therefore inherit the P5 verification and CASA gate `[inference]`, based on the scopes page `[verified]`.

### Question for Waldo (not assessed)
What happens when a Gmail or Calendar push is lost, or a watch expires unrenewed?

---

## P5. Connectors and auth

### Evidence

**MCP specification**
- **Current revision: 2026-07-28.** Authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization `[verified]`. Changelog: https://modelcontextprotocol.io/specification/2026-07-28/changelog `[verified]`. The previous revision was 2025-11-25.
- **Authorization requirements**
  - Based on OAuth 2.1.
  - Servers **MUST** publish Protected Resource Metadata (RFC 9728), and clients MUST use it to discover the authorization server (via RFC 8414 or OIDC).
  - Client registration uses one of three mechanisms. The selection order is defined on the client-registration sub-page, which I did not fetch.
    - **Client ID Metadata Documents (SHOULD)**;
    - pre-registration;
    - Dynamic Client Registration (MAY), **now deprecated**.
  - PKCE.
  - The **RFC 8707 `resource` parameter is required** in both authorization and token requests.
  - Servers validate token audience. Token passthrough is forbidden.
  - **Clients validate `iss` (RFC 9207)** and **key stored credentials by issuer.**
  - Step-up authorization on `insufficient_scope`, with the client requesting the union of old and new scopes.
- **Other changes in this revision**
  - The protocol is now **stateless**: no `initialize` handshake, no `Mcp-Session-Id`.
  - New `server/discover` and `subscriptions/listen`.
  - Tasks moved to an extension.
  - **Multi Round-Trip Requests** replace server-initiated elicitation and sampling.
  - OpenTelemetry trace context travels in `_meta`.
  - `tools/list` should return tools in a deterministic order, for cache hits.
- **Deprecated:** Roots, Sampling, Logging, HTTP+SSE and DCR, with a 12-month deprecation window.

**Anthropic**
- **MCP connector in the Messages API** (beta `mcp-client-2025-11-20`), https://platform.claude.com/docs/en/agents-and-tools/mcp-connector `[verified]`
  - Remote servers only (Streamable HTTP or SSE), and **tools only**.
  - The caller handles OAuth and token refresh and passes `authorization_token`.
  - `mcp_toolset` supports allow and deny lists and per-tool `defer_loading`.
  - **Not ZDR-eligible.**
- **Managed Agents** `[verified]`: credentials sit in a vault, and a proxy uses a session-scoped token, so the harness never sees them. See P1.

**Managed-auth vendors**
- **Arcade** (updated 6 Oct 2026), https://docs.arcade.dev/en/home `[verified]`: manages per-user tokens, authorizes each action, and offers MCP gateways.
- **Nango**, https://nango.dev/docs/getting-started/use-cases/tool-calling `[verified]`: per-user connections; credentials stay out of the model loop; actions exposed as tools; an MCP server; every execution logged.
- **Composio** `[search snippet]`: per-user "connected accounts" and Connect Links issued just in time.
- **Auth0 for AI Agents** (GA 19 Nov 2025), https://auth0.com/blog/auth0-for-ai-agents-generally-available/ `[verified]`
  - Token Vault.
  - **Async authorization (CIBA)** through Guardian push.
  - FGA for RAG.
  - Auth for MCP is still Early Access.

**Google OAuth gates**
- **Restricted-scope verification** (updated 19 Aug 2026), https://developers.google.com/identity/protocols/oauth2/production-readiness/restricted-scope-verification `[verified]`
  - A **security assessment by an approved assessor (App Defense Alliance CASA)** is required when restricted-scope data is stored on, or transmitted through, servers.
  - **Reassessment at least every 12 months.**
  - The privacy policy must comply with Limited Use.
  - Exceptions:
    - personal use: only you, or a few users all personally known to you;
    - development or testing;
    - internal-only apps.
  - Review takes weeks.
- **Gmail scopes** (updated 10 Sep 2026), https://developers.google.com/workspace/gmail/api/auth/scopes `[verified]`
  - `gmail.send`: **sensitive**.
  - `gmail.readonly`, `gmail.compose`, `gmail.insert`, `gmail.modify`, `gmail.metadata`, `gmail.settings.basic` and full `mail.google.com`: **restricted**.
- **Drive scopes** (updated 3 Sep 2026), https://developers.google.com/workspace/drive/api/guides/api-specific-auth `[verified]`
  - `drive.file`: **non-sensitive** and recommended.
  - `drive`, `drive.readonly` and `drive.metadata*`: restricted.
- **Calendar scopes**: the page I fetched did not classify them, so no claim is made.
- **CASA help page**, https://support.google.com/cloud/answer/13465431 `[verified]`
  - Assurance levels are **AL1 and AL2**.
  - Revalidation is annual.
  - The assessor issues a Letter of Validation, and the assessment is the final step of review.
  - The figures of $500–4,500 and 2–6 weeks are `[search snippet]` only.
- **Unverified apps**, https://support.google.com/cloud/answer/7454865 `[verified]`
  - An app requesting **sensitive or restricted** scopes without verification shows the unverified-app screen and is capped at **100 new users** in total.
  - Verification requires a privacy policy URL, domain ownership verified in Search Console, and a submitted request.
  - Restricted scopes add the CASA security assessment on top of that.
  - So `gmail.send`, which is sensitive, still needs verification before more than 100 users, but no CASA.
- **Granular consent** (updated 26 May 2026), https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions `[verified]`
  - Users can grant only some of the requested scopes.
  - Check which scopes were granted.
  - Use incremental authorization, and disable only the affected features.
  - Re-ask only when the user signals they want that feature.

### Table stakes `[inference]`
- **Per-user OAuth with least privilege and incremental scopes.** Handle granular consent's partial grants.
- **Tokens in a vault, refreshed server-side, and never in prompts, logs or sandboxes.** Tools act through a broker or proxy.
- **Remote MCP clients that implement current authorization:** PRM discovery, PKCE, resource indicators, `iss` validation, audience-bound tokens, no passthrough.
- **Per-connector status and revocation the owner can see.**
- **Google verification completed for every sensitive or restricted scope before growth.**

### Leading `[inference]`
- **CIMD client registration** and issuer-keyed credential storage, with DCR deprecated.
- **Just-in-time step-up consent** when a tool hits a missing scope (MCP `insufficient_scope`, Composio Connect Links).
- **Out-of-band asynchronous approval** for background actions (CIBA).
- **Deferred tool loading** for large connector catalogs (`defer_loading` plus Tool Search; covered in `[04]`).
- **Scope minimization by design:** `drive.file` instead of `drive`, `gmail.send` instead of read scopes, wherever the feature allows.

### Patterns to compare against
1. MCP 2026-07-28 authorization: https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization
2. Managed Agents vault plus proxy: https://www.anthropic.com/engineering/managed-agents
3. Google granular consent with incremental authorization: https://developers.google.com/identity/protocols/oauth2/resources/granular-permissions

### Gates
- Sensitive scopes such as `gmail.send` need verification, and the app is capped at 100 users until then.
- Restricted Gmail and Drive scopes need verification plus CASA, reassessed annually.
- Granular consent.
- The MCP connector is not ZDR-eligible.

### Question for Waldo (not assessed)
Which Gmail and Drive scopes are actually requested, and are any of them restricted?

---

## P6. Text and voice channels

### Evidence

**Voice frameworks**
- **LiveKit Agents**, https://docs.livekit.io/agents/ `[verified]`
  - Python or Node.js agents join WebRTC rooms as participants.
  - An STT-LLM-TTS pipeline, or realtime models.
  - A custom turn-detection model, and interruption handling.
  - SIP telephony.
  - Multi-agent handoffs.
  - Tool calls can be forwarded to the frontend.
  - Apache 2.0.
- **Pipecat**, https://docs.pipecat.ai/getting-started/introduction `[verified]`
  - An open-source Python framework (BSD-2) that orchestrates 150+ services.
  - Client SDKs, including iOS and React Native.
  - Managed hosting through Pipecat Cloud.
  - Transport and turn-detection details were not on the page I fetched.
- **OpenAI Realtime API**, https://developers.openai.com/api/docs/guides/realtime `[verified]`
  - Speech-to-speech with `gpt-realtime-2.1`.
  - WebRTC for browsers, WebSocket for servers.
  - **Ephemeral client secrets** (`POST /v1/realtime/client_secrets`) keep the API key on the server.
  - Tools, handoffs and guardrails.
  - An optional safety-identifier header.
- **ElevenLabs Agents**, https://elevenlabs.io/docs/agents-platform/overview `[verified]`
  - ASR, any LLM, TTS, and a proprietary turn-taking model.
  - Swift, Kotlin and React Native SDKs.
  - SIP and Twilio.
  - Workflows and RAG.
  - **Automated tests, conversation analysis and A/B tests.**
  - Configurable retention.

**One transcript or many**
- **OpenClaw sessions**, https://docs.openclaw.ai/concepts/session `[verified]`
  - By default (`dmScope: main`), **all DMs share one session.**
  - `identityLinks` merges one person's identities across channels.
  - Groups get their own sessions.
  - `per-channel-peer` is recommended for multi-user setups.
- **Other products** `[02]`
  - Hermes keys sessions per platform.
  - Letta routes chats to a "default" conversation.
  - Muse runs on app, web and WhatsApp, but does not document continuity across them.
  - The strongest designs settle approvals outside free text.

**WhatsApp**
- **Meta Terms for WhatsApp Business Platform §4.7 "AI Providers"** (Last Modified 23 Sep 2026), https://www.facebook.com/legal/Meta-Terms-for-WhatsApp-Business-Platform `[verified]`
  - AI providers may not use the platform where AI is the "primary (rather than incidental or ancillary) functionality."
  - Meta decides what counts.
  - Platform data may not be used to train AI models.
  - Availability in "certain countries" is linked to a separate AI Providers page.
- **AI Providers pricing page**, https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing/ai-providers/ `[verified]` (most recent date shown: 12 May 2026)
  - General-purpose assistants are **only permitted where Meta is legally required** to allow them.
  - Italy was added from 16 Feb 2026, Brazil from 11 Mar 2026.
  - European markets were charged per non-template message from 11 Mar until 12 May 2026.
- **EU Commission interim measures, 9 Jun 2026** (case AT.41034) `[search snippet]`
  - Meta must restore **free** access in the EEA except Italy, on the terms in place before 15 Oct 2025, until the case is decided.
  - Meta has said it will appeal.
  - Current EEA practice is unverified.

**Apple**
- **Apple Messages for Business docs** (v3.1, 21 Jul 2026), https://register.apple.com/resources/messages/messaging-documentation `[verified]`
  - An **Apple-approved Messaging Service Provider** is required.
  - "Customers must always be able to reach a live agent."
  - Automation must reply within **5 seconds** and identify itself as automated.
  - Every example is customer-initiated.
- **Poke** went live on Messages for Business on 4 Jun 2026, https://9to5mac.com/2026/06/04/apples-messages-app-on-iphone-now-has-a-third-party-ai-agent/ `[verified]`, press. "First and only AI agent" is Poke's own claim.
- **No official iMessage bot API.** Community bridges such as BlueBubbles need an always-on Mac `[search snippet]`.

### Table stakes `[inference]`
- **One owner identity and one memory across surfaces.** Each turn carries a channel envelope, with per-surface delivery receipts.
- **Approvals settled by structured controls**, never by a free-text "yes", with the same semantics on every surface.
- **Ship only on channels whose terms permit a general-purpose assistant.**
- **Voice:** streaming STT, LLM and TTS (or speech-to-speech), turn detection, barge-in, and short-lived client credentials.

### Leading `[inference]`
- **A single continuous DM transcript by default** across channels, with identity linking (OpenClaw).
- **Realtime speech-to-speech over WebRTC**, with tools and SIP telephony (LiveKit, OpenAI, ElevenLabs).
- **Voice-specific evals:** simulated conversations and A/B tests (ElevenLabs).
- **First-party-approved channel status** rather than a bridge (Poke on Messages for Business).

### Patterns to compare against
1. OpenClaw `dmScope` with `identityLinks`: https://docs.openclaw.ai/concepts/session
2. OpenAI Realtime with ephemeral client secrets over WebRTC: https://developers.openai.com/api/docs/guides/realtime
3. LiveKit Agents: https://docs.livekit.io/agents/

### Gates
- **WhatsApp §4.7.** The EEA position is legally contested.
- **Apple Messages for Business:** MSP, a live agent, and the 5-second first reply.
- **No iMessage bot API.**
- **App Store 5.1.2(i):** explicit permission before sharing personal data with third-party AI, which covers voice audio sent to providers `[verified rule; application is inference]`.

### Question for Waldo (not assessed)
Do approvals behave the same way on the app and on Telegram, including when two decisions race?

---

## P7. Payments and identity

### Evidence

**Agent identity**
- **IETF `draft-ietf-webbotauth-httpsig-protocol-00`** (1 Sep 2026), https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol `[verified]`
  - A working-group draft; authors are from Cloudflare and Google.
  - A `Signature-Agent` header points to a JWKS key directory at a well-known URI.
  - Signatures carry `created` and `expires` (24 hours or less recommended), a thumbprint `keyid`, and `tag=web-bot-auth`.
  - The signature must cover `@authority` or `@target-uri`.
  - The draft does not authenticate humans and does not define authorization.
- **Cloudflare verified bots and signed agents** (updated 8 Oct 2026), https://developers.cloudflare.com/bots/concepts/bot/signed-agents/ `[verified]`
  - Verification is by Web Bot Auth or IP validation, under a policy of honest identification and respect for robots.txt.
  - Approved bots and agents are listed in the BotBase / Radar directory.
  - Since 1 Jul 2026, a **Direct vs Intermediary** label separates operator-run bots from multi-user agent services.
  - Cloudflare is experimenting with RFC 7239 `Forwarded` to carry end-user information.
- **Visa Trusted Agent Protocol**, https://developer.visa.com/capabilities/trusted-agent-protocol/overview `[verified]` (no date shown)
  - Aimed at merchants and the CDNs that sit in front of them.
  - Signatures are merchant- and purpose-specific, time-bound, and cannot be replayed.
  - Carries agent intent and optional consumer-recognition data.
  - The page says the product is still being developed and deployed, and may not be available in every market.
  - Launched 14 Oct 2025 with Cloudflare `[search snippet]`.
- **Mastercard Agent Pay** `[search snippet]` (the page returned 403)
  - Agentic tokens.
  - Agents are registered and verified.
  - Merchants are advised to check Web Bot Auth at the CDN.
- **OAuth for agents** `[search snippet]`
  - ID-JAG / Cross-App Access (`draft-ietf-oauth-identity-assertion-authz-grant`) is in the OAuth working group and underpins MCP enterprise-managed authorization.
  - The on-behalf-of draft (`-02`, Aug 2025) has likely expired.
  - AAuth (`draft-rosenberg-oauth-aauth-01`, Oct 2025) is an individual draft.
- **Auth0 for AI Agents** `[verified]`: CIBA async approval. See P5.

**Agentic payments**
- **Stripe agentic commerce**, https://docs.stripe.com/agentic-commerce `[verified]`
  - Sellers integrate through **ACP or UCP**.
  - Machine payments use **MPP or x402**.
  - Agent-side features are in **private preview**: embedded checkout, Link Agent Wallet, and shared payment tokens.
- **Shared payment tokens (SPTs)**, https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens `[verified]` (API version `2026-09-30.preview`)
  - The agent issues an SPT scoped to one seller profile, a currency, a **maximum amount** and an **expiry**.
  - SPTs are revocable.
  - States: `active`, `requires_action` (for example 3-D Secure), and `deactivated`.
  - Webhooks report each transition.
  - Stripe may use network agentic tokens (Mastercard Agent Pay, Visa Intelligent Commerce).
  - Available in the US, Canada and selected European countries.
- **Google AP2**, https://ap2-protocol.org/ `[verified]`
  - Built on verifiable digital credentials: a **Checkout Mandate** and a **Payment Mandate**, each with an open stage (constraints) and a closed stage (final authorization).
  - Flows cover the human present and the human not present.
  - An extension for A2A and MCP, with UCP integration.
  - Version 0.2, donated to the FIDO Alliance.
  - Cards first.
- **UCP**, https://ucp.dev/ `[verified]`
  - Co-developed by Google, Shopify, Walmart, Target, Amazon, Microsoft, Meta, Stripe and others.
  - Covers discovery, cart, checkout, OAuth identity linking and orders.
  - Payments use AP2 mandates.
- **x402** (updated 25 Aug 2026), https://www.x402.org/ `[verified]`
  - Uses HTTP 402 and is stablecoin-first.
  - Governed by the x402 Foundation under the Linux Foundation.

**Owner sign-in and accounts**
- **App Store Review Guidelines** `[verified]`
  - **4.8:** if a third-party or social login such as Google is the primary login, the app must also offer an equivalent login that limits data to name and email and allows a private email. Exemptions exist.
  - **5.1.1(v):** apps that support account creation must offer in-app account deletion.
  - **3.1.3(e):** physical goods and services must be paid for outside in-app purchase.
- **FIDO passkeys**, https://fidoalliance.org/passkeys/ `[verified]`: phishing-resistant; synced or device-bound.
- **The iOS 26 passkey account-creation API** `[search snippet]`.

### Table stakes `[inference]`
- **Owner sign-in through platform-native options** with passkey support, an App Store 4.8-compliant equivalent login unless exempt, and in-app account deletion.
- **The agent never holds raw card data.** It pays with scoped, revocable delegated credentials such as SPTs or network agentic tokens.
- **Explicit owner approval for every purchase.** Muse requires it every time `[02]`; early network rollouts approve each purchase `[search snippet]`; Claude in Chrome prohibits purchases outright `[verified]`.
- **Honest self-identification when browsing.**

### Leading `[inference]`
- **Cryptographically signed agent requests** (Web Bot Auth, Visa TAP), listed in directories and labelled Intermediary.
- **Verifiable mandates binding owner intent → cart → payment** (AP2), enabling bounded purchases without the human present.
- **Asynchronous out-of-band approval** (CIBA).
- **Machine payments for paid tools and APIs** (x402, MPP).

### Patterns to compare against
1. Stripe SPTs: https://docs.stripe.com/agentic-commerce/concepts/shared-payment-tokens
2. AP2 mandates: https://ap2-protocol.org/
3. The Web Bot Auth draft plus Cloudflare signed agents: https://datatracker.ietf.org/doc/html/draft-ietf-webbotauth-httpsig-protocol and https://developers.cloudflare.com/bots/concepts/bot/signed-agents/

### Gates
- Stripe's agent features are in private preview, and SPTs are limited by country `[verified]`.
- Card-network programmes are enrolment-based and not available in every market `[verified for Visa; snippet for Mastercard]`.
- App Store 4.8, 5.1.1(v) and 3.1.3(e) `[verified]`.
- 3-D Secure / SCA can interrupt agent payments: SPT `requires_action` `[verified]`.

### Question for Waldo (not assessed)
Is payment a launch pillar at all, or only identity and sign-in?

---

## P8. Evals and observability

### Evidence

**Anthropic**
- **"Demystifying evals for AI agents"** (9 Jan 2026), https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents `[verified]`
  - Vocabulary: task, trial, grader, transcript, outcome, evaluation harness, agent harness.
  - Three grader types: code-based, model-based and human.
  - **Capability evals** start at a low pass rate. **Regression evals** should sit near 100%.
  - **pass@k** (at least one success) suits tasks where one good answer is enough. **pass^k** (every trial succeeds) suits customer-facing consistency.
  - **Start with 20–50 tasks drawn from real failures.**
  - Read transcripts before trusting scores.
  - **Calibrate LLM judges against humans.** Give the judge an "Unknown" option, and use one judge per rubric dimension.
  - Combine offline evals, production monitoring, A/B tests, user feedback and transcript review.
  - For conversational agents, grade the end state, constraints on the transcript and a rubric, using a **simulated user**.
- **"Building agents with the Claude Agent SDK"** (29 Sep 2025), https://claude.com/blog/building-agents-with-the-claude-agent-sdk `[verified]`
  - Verify work with rules, visual feedback, or an LLM as judge.
  - Build the eval set from real usage.
- **Claude Code auto mode** (25 Mar 2026), https://www.anthropic.com/engineering/claude-code-auto-mode `[verified]`. This is an example of evaluating a safety layer on real traffic:
  - 0.4% false-positive rate;
  - 17% of real overeager actions missed;
  - 5.7% of synthetic exfiltration attempts missed.

**OpenTelemetry**
- **GenAI semantic conventions**, now in https://github.com/open-telemetry/semantic-conventions-genai `[verified]`. Agent spans doc: https://raw.githubusercontent.com/open-telemetry/semantic-conventions-genai/main/docs/gen-ai/gen-ai-agent-spans.md `[verified]`
  - Status: **Development**. The repo shows no release.
  - Span operations: `create_agent`, `invoke_agent`, `invoke_workflow`, `plan`, `execute_tool`.
  - `gen_ai.operation.name` and `gen_ai.provider.name` are required.
  - Set `gen_ai.conversation.id` only when a real conversation ID exists; don't invent one.
  - **Message content is opt-in** and flagged as likely to contain PII.
- MCP 2026-07-28 standardises `traceparent` in `_meta` `[verified]`.

**Tools**
- **Langfuse**, https://langfuse.com/docs/evaluation/overview `[verified]`
  - Online evaluation scores live traces. Offline evaluation runs on datasets.
  - LLM-as-judge can run on live traces.
  - Datasets can be built from production traces.
  - Experiments run through the UI, SDK or OTel.
  - A **GitHub Action fails a PR** when a score crosses its threshold.
  - Annotation queues and user feedback scores.
  - **Score analytics compare human and AI agreement.**
- **Braintrust**, https://www.braintrust.dev/docs `[verified]`
  - The loop: instrument → observe → annotate → evaluate → deploy.
  - "Loop", an AI assistant, builds scorers and datasets.
- **Arize Phoenix**, https://arize.com/docs/phoenix `[verified]`
  - OTel and OpenInference tracing.
  - LLM, code and human evaluators.
  - Datasets and experiments.
  - Prompt management.
- **Inspect AI** (UK AI Security Institute), https://inspect.aisi.org.uk/ `[verified]`
  - Tasks, solvers and scorers.
  - Agent evals, including external agents.
  - Sandboxed execution.
  - `model_graded_qa`.

### Table stakes `[inference]`
- **Trace every model call, tool call and agent run with stable IDs**, aligned to the OTel GenAI conventions. Pin the version, since they are still in Development.
- **An offline regression suite built from real failures** (20–50 tasks to start), run in CI, gating prompt, model and tool changes.
- **Code graders wherever the outcome is checkable.** LLM judges calibrated against human labels, with an escape option.
- **Online scoring plus owner feedback in production.** Content capture is opt-in and redacted.
- **A trace → dataset loop:** every production failure becomes a test case.

### Leading `[inference]`
- **pass^k and multiple trials** for consistency-critical behaviours.
- **Simulated-user multi-turn evals**, graded on end state, transcript constraints and a rubric.
- **Safety layers measured on real traffic:** false-positive and miss rates.
- **Judge-human agreement tracked as a metric.**
- **Sandboxed agent evals** (Inspect).

### Patterns to compare against
1. Anthropic's eval roadmap: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
2. Langfuse online and offline evaluation, with judge calibration and CI gating: https://langfuse.com/docs/evaluation/overview
3. OTel GenAI agent spans: https://github.com/open-telemetry/semantic-conventions-genai

### Gates
- No platform gate.
- Privacy: the OTel content attributes are opt-in and sensitive `[verified]`.
- Art. 9 health data in traces or eval fixtures is a legal and policy constraint, not a platform one `[inference]`.

### Question for Waldo (not assessed)
Is there a pass^k-style consistency check on owner-facing behaviours such as approvals and quiet hours?

---

## Harness addendum (Anthropic, not in the already-covered list)

- **"Building agents with the Claude Agent SDK"** (29 Sep 2025) `[verified]`
  - The loop: gather context → take action → verify → repeat.
  - Start with agentic search before semantic search.
  - Use subagents for context isolation.
  - Verify with rules, visuals, or an LLM judge.
- **"Code execution with MCP"** (4 Nov 2025) `[verified]`
  - Present MCP tools as code APIs: about 150k tokens fell to about 2k in the example.
  - Tokenize PII so it moves between tools without entering the model's context.
  - Saved code can become skills.
  - Needs a sandbox.
- **Programmatic tool calling** (GA; requires `code_execution_20260120` or later), https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling `[verified]`
  - Tools opt in with `allowed_callers`, and intermediate results stay out of context.
  - **`allowed_callers` is not a security boundary.**
  - **Not ZDR-eligible.**
  - Excludes MCP-connector tools and the computer and browser toolsets.
- **Subagents (Agent SDK)**, https://code.claude.com/docs/en/agent-sdk/subagents `[verified]`
  - Give context isolation, parallelism and tool restriction.
  - Defaults: nesting depth 3, concurrency 20. A spend cap is available.
  - Subagent output is scanned for instruction-shaped text before the parent reads it.
- **Permissions and hooks (Agent SDK)**, https://code.claude.com/docs/en/agent-sdk/permissions `[verified]`
  - Evaluation order: hooks → deny → ask → mode → allow → `canUseTool`.
  - Modes include `dontAsk` and `auto`.
  - A `PreToolUse` hook is the only check that runs on every call.
- **"How we built Claude Code auto mode"** (25 Mar 2026) `[verified]`
  - A two-stage transcript classifier that cannot see tool results or the agent's own messages.
  - An input-side probe screens tool output for prompt injection.
  - Escalates to a human after 3 consecutive or 20 total denials.
- **"How we contain Claude across products"** (25 May 2026) `[verified]`
  - Containment before supervision.
  - Egress allowlists are capability grants.
  - Credentials stay out of the agent's environment.
  - Known gaps are published.
- **"Scaling Managed Agents"** (8 Apr 2026) `[verified]`: see P1.
- **"Harness design for long-running application development"** (24 Mar 2026) `[search snippet]`
  - Planner, generator and evaluator agents.
  - Context resets with structured handoffs, preferred over compaction in place.
  - Re-examine the harness with each model release.

---

## Platform gates most likely to block a launch (ranked)

Ranking test `[inference]`: a hard contractual or legal prohibition, or an external approval whose lead time Waldo cannot compress.

1. **Google OAuth verification, in two tiers**
   - **Sensitive scopes** (for example `gmail.send`) need app verification: a privacy policy, Search Console domain ownership, and a submitted request. Until then the app shows the unverified screen and is capped at 100 new users.
   - **Restricted scopes** (`gmail.readonly`, `gmail.modify`, `gmail.metadata`, full `drive`) need that verification plus an approved-assessor CASA whenever the data is stored on or transmitted through servers. The CASA is repeated every 12 months, and Limited Use applies.
   - `drive.file` is non-sensitive.
   - Exceptions include personal use (only you, or a few users personally known to you) and testing.
   - Sources: pages updated 19 Aug and 10 Sep 2026, plus the unverified-apps page `[verified]`.
2. **The App Store Review bundle** `[verified]`
   - **4.8:** an equivalent privacy-preserving login if Google is the primary login, unless an exemption applies.
   - **5.1.1(v):** in-app account deletion.
   - **5.1.2(i):** explicit permission before sharing personal data with third-party AI.
   - **5.1.3:** no advertising use of health data, and no iCloud storage of it.
   - **4.5.4:** no sensitive personal information in pushes.
3. **WhatsApp Business §4.7 "AI Providers"** (last modified 23 Sep 2026) `[verified]`
   - A general-purpose assistant is prohibited except where Meta is legally required to allow it.
   - The EEA position depends on the EU's 9 Jun 2026 interim measures `[search snippet]`, which Meta is appealing.
4. **Provider data retention for health-bearing turns** `[verified]`
   - Not ZDR-eligible: Managed Agents (no HIPAA BAA either), the MCP connector, programmatic tool calling, and Agent Skills.
   - ZDR-eligible: the browser toolset.
   - This gates adopting several "leading" Anthropic patterns wherever Art. 9 data could flow `[inference]`.
5. **Apple Messages for Business, for any iMessage presence** (v3.1, 21 Jul 2026) `[verified]`
   - An approved MSP, a reachable live agent, and a first reply within 5 seconds.
   - There is no official iMessage bot API.
   - Poke is the only documented AI-agent route.

**Next tier, not top five:**
- payment-network and Stripe agent-feature enrolment (private preview);
- Cloudflare signed-agent registration for browsing;
- Anthropic's end-user consent requirement for computer and browser use;
- the Google Calendar scope classification, which I did not verify.

---

## Not verified today, and caveats

- **Returned 403 or not found:**
  - the ChatGPT agent help page;
  - ChatGPT Pulse;
  - Mastercard Agent Pay;
  - the EU press release (ip_26_1276);
  - the Apple HIG notifications page, which rendered empty.
- **Snippet only:**
  - ChatGPT Tasks caps;
  - Stagehand;
  - Composio;
  - the IETF OAuth-for-agents drafts other than webbotauth;
  - CASA fees and timelines;
  - the ClawHavoc counts;
  - secondary prompt-injection figures for Opus 4.6, 4.8 and 5;
  - Anthropic's "Harness design" post;
  - Restate durable approvals and sessions;
  - DBOS exactly-once claims.
- **Pages I verified that did not cover these topics:**
  - Pipecat transports and turn detection;
  - Braintrust online scoring and CI;
  - OpenAI Realtime over SIP;
  - Calendar scope classification.
- **Not checked at all:** the classification of Google Tasks scopes. Waldo uses Tasks.
- **App Store Review Guidelines:** the page's last-updated date was not captured, because the fetch truncated the page.
- **Vendor docs change weekly.** Dates are as shown on 12 Oct 2026.
