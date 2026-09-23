# Harness gap inventory (2026-09-24)

> Vocabulary: the owner settled all product words on 2026-09-24. [VOCABULARY_AND_BRAND_2026-09-24.md](VOCABULARY_AND_BRAND_2026-09-24.md) is the source; where this doc uses an older word (Afternoon check-in, update cards, Approve / Change / Skip, Weight as demand, Readiness), read it by that doc. Form / Load / Recovery are the body and day words; Weight is body mass only; Fetch is the sweep and its output is a fetch alert; Handoff is work Waldo offered or took on, tracked as an open loop.

The building blocks a complete personal-agent harness needs, checked against the peer set and against waldo-backend on `beta-mvp`. Waldo claims come from the code as of `7f76435`. Peer claims come from COMPETITOR_RESEARCH.md, the PEER_EXPERIENCE doc (sections 2.6 Hermes and 2.7 OpenClaw), TOOL_LOOP_BUDGET.md, WEB_SEARCH_SELECTION.md, ADOPTION_DIRECTION.md, WALDO_BRAINSTORM_LIST.md and WALDO_BRAIN_RECONCILIATION.md. These are secondhand summaries; I didn't re-check any peer repo for this pass.

Labels: **Built** means it is in code and deployed to staging. **Contract** means it has tests only, with no live run yet. **None** means it doesn't exist.

Nothing below has had a live end-to-end run since console v1. The owner asked for one combined E2E after the queue is built, so every "Built" row still needs that run.

## Summary

We lack six things most frontier agents have:
- web search and page read
- a general action surface: send email, act in a browser, run code
- MCP or a plugin surface
- compaction for long threads
- steering or interrupting a run in progress
- a model fallback that has actually run live

We also lack one that is central to our own product: an open-loop ledger the owner can see. We have one thing ahead of the peers: a durable per-owner runtime with an approval ledger and a trace for every turn.

## 1. Agent loop

- **Others:** Hermes allows 500 rounds by default and hands back a summary when it hits the cap. pi has no round cap and only guards against pauses where no tool is called. The OpenAI Agents SDK defaults `max_turns` to 10. Claude Code and pi both let you steer a run in progress.
- **Waldo:**
  - Native tool calling (7928671).
  - A 25-round budget, a no-progress stop, and a tools-off last answer so every turn ends in words (af2a754).
  - `loop-governor` dedup.
- **Left:**
  - Steer or cancel from a new Telegram message. The port has `steer`, but work units mark it unsupported.
  - Compaction for long threads.
  - Long jobs in the background. The chat loop is the only loop that runs live.
- **Nobody flagged:**
  - Turns are serialized in memory (`telegram-owner-do.ts` serial queue), so two messages queue rather than race. The real race was the two post-turn memory writers running outside that queue. Fixed in 96c7683: the next turn waits for them.
  - No turn had a wall-clock timeout. Fixed in 96c7683 (150s).

## 2. Tools

- **Others:** Hermes and OpenClaw have tens of tools, including web, browser, shell, files and messaging. Muse, Poke and Instinct act across email, calendar, browser and messages.
- **Waldo:** the live chat tools are:
  - `get_context`
  - `search_episodes` (c392457)
  - `set_reminder`, `list_reminders`, `cancel_reminder` (bd93d45)
  - `query_calendar` and `propose_calendar_change` (530f91c)
  - `draft_email`, which writes Gmail drafts (9df318a, 27c2f1b)
- **Left:**
  - Web search and page read. WEB_SEARCH_SELECTION.md is waiting on the owner's provider pick.
  - Gmail send and draft.
  - Contacts.
  - Weather.
  - Browser actions.
  - Any "do it for me" action beyond calendar proposals.
- **Nobody flagged:**
  - Tool results are not size-capped per tool. One large Gmail read could fill the context.
  - No tool has an idempotency key tied to its approval. That matters as soon as a send tool exists.

## 3. Memory

- **Others:** Hermes keeps FTS5 over sessions and memory the agent writes itself. Town keeps an editable profile. mem0 and Hindsight keep typed memories.
- **Waldo:**
  - Four core memory files the model revises (31e4155).
  - FTS5 episode search and a nightly pass (c392457).
  - Spots v0 with nightly constellation promotion (bc27e05).
  - The console can forget spots and nodes (5df4052).
- **Left:**
  - Memory records don't store class, recorded time or provenance (reconciliation gap 3).
  - Profile Claims and Relationships are named in the contracts but not built.
  - Hybrid or vector recall.
  - Undoing a memory edit from chat.
- **Nobody flagged:**
  - Nothing checks that forgotten facts stay forgotten. The nightly pass could learn them again from old episodes.
  - Memory can't be exported.

## 4. Scheduler

- **Others:** Hermes and OpenClaw run cron jobs and commitments. Town has routines.
- **Waldo:**
  - Reminders and routines on the DO alarm (bd93d45).
  - Day cards (63d8c41, 91cad99).
  - Update cards (7e958f5).
  - Event briefs (317b8f6).
  - `/fire` for manual triggers (032e2c3).
- **Left:**
  - Wakeup coalescing (brainstorm C3).
  - Quiet hours as a setting the owner can change.
  - Owner-defined recurring tasks that go beyond reminders.
- **Nobody flagged:**
  - A missed alarm is not reported anywhere if the DO is evicted or a deploy lands mid-fire.
  - Timezone is a deploy var (`WALDO_OWNER_TIMEZONE`), so it goes stale when the owner travels.

## 5. Proactivity

- **Others:** Instinct and Poke message the user first, with reasons. OpenClaw caps commitments at 3 a day.
- **Waldo:** the Brief, check-in and Close cards; update cards; event prep briefs. The owner removed the push cap.
- **Left:**
  - Proactive nudges driven by open loops.
  - Follow-up on unanswered items.
  - Health-driven cards. These are blocked until the app API exists.
- **Nobody flagged:**
  - Nothing measures whether a proactive message was useful: no reaction or dismiss signal feeds back into the choice of what to send next.

## 6. Approvals

- **Others:** Google ADK tool confirmation, Claude Code permission modes, Kennel's "user alone Accepts".
- **Waldo:** the approval door and ledger with Approve, Change and Skip (530f91c).
- **Left:**
  - Approval only covers calendar proposals. Other effect classes have none.
  - Standing grants ("always allow X") with a scope and expiry.
  - An approval queue in the console.
- **Nobody flagged:**
  - Approval cards didn't expire, and moves didn't check the event version. Fixed in 96c7683: 12h expiry plus an etag/If-Match check.

## 7. Observability

- **Others:** Langfuse or OTel in Hermes-class stacks. Claude Code has transcripts.
- **Waldo:**
  - Langfuse OTLP traces (5008729, 68fe5bd, 953b966).
  - `/trace` and the persisted trace log (032e2c3).
  - `pricing.ts` for cost.
- **Left:**
  - Dashboards and alerts on errors or cost.
  - A cost budget per day.
- **Nobody flagged:**
  - With `LANGFUSE_CAPTURE_TEXT` on, owner message text goes to a third party. That needs a retention decision before beta users.

## 8. Evals

- **Others:** OpenAI Agents SDK traces feed evals. Claude Code and Hermes have benchmark suites.
- **Waldo:** contract tests (1272 runtime tests), guards, and the `/e2e` checklist (032e2c3). There is no model-graded eval set.
- **Left:**
  - Scenario evals: multi-turn, a health emergency, the clinical redirect, memory correctness, proactive quality.
  - Regression runs on model swaps.
- **Nobody flagged:** this is our biggest honest gap against every frontier lab. We can't say whether a prompt or model change made Waldo better or worse.

## 9. Channels

- **Others:** OpenClaw and Hermes reach 10+ channels (Telegram, WhatsApp, Slack, Discord, iMessage, SMS, voice). Instinct uses iMessage, WhatsApp, Slack and voice.
- **Waldo:**
  - Telegram text (f1b19a5).
  - Voice-in (eab3c7b).
  - Photos and documents (d3cbb76).
  - The console on the web (0cdd7c3, 5df4052).
- **Left:**
  - WhatsApp (blocked on Meta credentials).
  - SMS (needs a provider).
  - Voice replies.
  - The mobile app.
- **Nobody flagged:** there is no identity link across channels yet. It is one Telegram owner id.

## 10. Connectors

- **Others:** Muse and Instinct connect Gmail, Calendar, Drive, Slack and more. MCP is common, though pi keeps it out of its core.
- **Waldo:** the Google OAuth flow and client (9df318a, 27c2f1b), and console connect and disconnect (5df4052).
- **Left:**
  - Staging has no `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET`, so Google is not live.
  - Wearables.
  - Weather.
  - An MCP client.
- **Nobody flagged:**
  - Token refresh failure is not surfaced to the owner.
  - No connector health row exists outside the console.

## 11. Auth

- **Others:** account login plus an OAuth vault.
- **Waldo:** the owner is identified by Telegram id; the console uses a one-time Telegram link with CSRF (0cdd7c3, 5df4052); the `mint-agent-jwt` package exists.
- **Left:**
  - Multi-user signup.
  - Phone OTP (needs an SMS provider).
  - The move to the new Supabase project.
- **Nobody flagged:**
  - The single-owner id is a hardcoded deploy var. It needs the post-mvp-cleanup label.
  - No design yet covers account recovery if the owner's Telegram account is lost.

## 12. Console

- **Others:** Kennel's home tab is meant to show a day view of open loops. Hermes has diagnostics. The owner's own ask lists /ci, /fire, /trace and /later.
- **Waldo:** console v1 with actions (5df4052), Files (7f76435), and `/fire`, `/trace` and `/e2e` (032e2c3).
- **Left:**
  - `/ci` and `/later` do not exist.
  - The open-loops home.
  - Approval and scheduler views.
- **Nobody flagged:** the console isn't built for mobile. The owner lives in Telegram on a phone.

## 13. Files

- **Others:** Claude Code and Hermes read and write local files. Instinct creates and hosts Files.
- **Waldo:** incoming media is saved to `owner_files`, with open and remove in the console (7f76435).
- **Left:**
  - Waldo creating files: docs, exports.
  - Search over stored files.
  - Retention.
- **Nobody flagged:** files sit in DO storage, and that has size limits. Large media needs R2.

## 14. Multi-agent

- **Others:** Hermes subagents (50 rounds), Claude Code subagents, OpenAI Agents handoffs, and Superset running agents in parallel.
- **Waldo:** coordinator modules and outcome tables. There is no subagent in the live chat path.
- **Left:**
  - Background workers.
  - Kennel driving Claude Code, with Waldo tracking the outcome (ADOPTION_DIRECTION).
  - Agent-to-agent communication (next horizon).
- **Nobody flagged:** the coordinator code (about 2k lines in `waldo-coordinator.ts`) has no live caller from chat. Either wire it in or mark it parked.

## 15. Guardrails

- **Others:** OpenAI Agents input and output guardrails, Claude Code permission rules.
- **Waldo:**
  - The clinical advise-and-redirect with a notice (ea4828f), and personal dosing stays blocked.
  - The egress policy hook.
  - Guards: model ids only in `roster.ts`, and the health-leak check.
- **Left:**
  - Prompt-injection handling for tool content such as email and web.
  - A rate limit per sender.
- **Nobody flagged:**
  - Once Gmail read goes live, email text enters the prompt with no provenance marker. That is the first injection surface.

## 16. Skills

- **Others:** Claude Code and Hermes keep markdown skills, and Hermes lets the agent write them itself. Kennel also has skills.
- **Waldo:** `skills/loader.ts`, `budget.ts` and `mutable-reader.ts` exist, but the live chat prompt doesn't load any skills.
- **Left:**
  - Wiring skills into chat.
  - An owner-authored skill format.
  - The review gate for any skill the agent writes (ADOPTION_DIRECTION rejects unreviewed writes).
- **Nobody flagged:** none.

## Blocks the list above doesn't cover

- **Open-loop ledger.** This is the product's spine per the Technical Brief and the Kennel home concept. The tables exist (outcomes, judgment requests); nothing the owner can see does.
- **Model routing and fallback.** The gateway has a `fallback_step` field. No fallback path has been exercised live, and the escalation rule isn't decided.
- **Data export and deletion** for beta users.
- **Health signal.** It is not live (`health: null`). It is our intended edge and is blocked on the app API or a wearable connector.

## Blockers waiting on the owner

- Google OAuth client
- Meta WhatsApp credentials
- New Supabase credentials
- Search provider
- STT key
- SMS provider for OTP

## Update (96c7683) and decisions for the owner

- Fixed in code: approval expiry and version check, turn timeout, post-turn writers serialized, a specific reply on the second clinical failure, a tool result cap (16k), and late alarm fires shown in /trace.
- Still open in code: the forget barrier (W1 memory admission).
- Owner decisions:
  - Langfuse text-capture retention before beta users.
  - Whether to mark Gmail and web content as untrusted in the prompt (recommended).
- See also: OWNER_SETUP_2026-09-24.md and VOCABULARY_AND_BRAND_2026-09-24.md.
