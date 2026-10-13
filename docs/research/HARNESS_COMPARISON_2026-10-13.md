# Harness comparison: Waldo's agent runtime against reference systems

Date: 2026-10-13. Author: the backend lead session (claude.ai/code `session_01ARsyYdWNBCNEUBLNrnbtrP`). Source read at `beta-mvp` `08350959fb4422a3c0a6fc4d7036c22720ff6966` unless a PR is named; file and line references are at that commit. Reference-system quotes come from primary sources read on 2026-10-13; where a vendor's documentation host was unreachable from the cloud session, the quote is tagged `[search snippet]` and is unverified wording. The research notes with every quote and URL are in the session's scratchpad; this document carries the comparison and its conclusions.

Tags: `[verified]` means read in source or reproduced in a test this session; `[inference]` means a conclusion drawn from what was read, not itself observed.

## 1. Purpose and method

The handoff asked for a comparison of Waldo's harness (durable execution, memory, context, permissions, proactivity, contract safety, time, observability) against mature agent systems, with primary sources, concrete file-and-line observations, and bounded fixes where the gap is real. The method per area:

1. Read the reference system's mechanism from its own documentation or source.
2. Read Waldo's mechanism from source at the pinned commit.
3. Name the gap, who it hurts, how confident the reading is, and the smallest fix that closes it, or say that Waldo is at parity or stronger.
4. Where a fix changes a store, a writer, an authority boundary or a health-data destination, it is an ADR proposal for the owner, not a commit (CLAUDE.md "Stable constraints").

## 2. Summary

| Area | Waldo today | Verdict | Action |
| --- | --- | --- | --- |
| Alarm slot and wakes | One `setAlarm` seam, guarded; one arbiter over the persisted due keys, plus narrow writers that min against the current alarm | Parity with the Agents SDK Lifecycle; one structural weakness (the #1128 class) | Bounded: a single wake arbiter every writer must call, with a conformance test (§3.1) |
| Alarm handler failure | No top-level catch in `alarm()`; platform retries then silence | Gap | Bounded: fallback re-arm on an uncaught throw (§3.2) |
| Scheduled work, missed runs | Latest elapsed occurrence fires once; the rest recorded `missed` | Parity with Hermes; stronger than Claude Code `/loop` | None |
| Proactive volume | Deterministic heartbeat, quiet hours, cooldowns, delivery caps | Parity or stronger | One gap: repeated schedule failures are recorded, not surfaced to the owner (§5.2) |
| Memory | Claims with validity window and supersession; forget barriers; nightly grounding in review (#1149) | Parity with Graphiti's invalidation; stronger on the right to forget | ADR proposal: separate world time from system time on claims (§4.1) |
| Context | Per-turn composer, cross-turn tool ledger, turn-only tool output, just-in-time recall, bounded subagents | Parity on composition; the window is drop-oldest with no summary | ADR proposal: compaction row for long chains (§4.4) |
| Permissions | Run scope re-admitted before every effect; frozen intents; approval cards resume the effect, not the model | Stronger than LangGraph for effects; parity with the Agent SDK pipeline | Standing grants not built; ADR when built (§6.2) |
| MCP | Catalogue allowlist, annotations treated as untrusted, edge-held tokens | Parity with the 2025-06-18 spec's trust rules | Generic OAuth discovery not built; recorded, not needed for launch (§6.3); #1168 closes the edge's effect rail (§12) |
| Contract drift | Additive app.v1, byte pins, tolerant display readers in the app | Parity with proto3/Avro reading rules | Two bounded gaps: no additivity guard, no consumer-driven fixture check (§7) |
| Time zones | IANA zone validated and carried; local days and daily occurrences re-resolved at the edge | Parity with IANA/Temporal guidance | Bounded: one ageing function for the health score (§8) |
| Observability | Text capture only outside production; console strips text; bounded labels | Parity with OTel GenAI opt-in and Langfuse masking | ADR proposal: turn-only tool text omitted from traces (§9.1) |
| Evals | Scenario harness with model-input assertions; development memory eval | Behind the reference guidance (outcome grading, pass^k) | Proposal to the owner: a bounded model-graded eval on staging (§9.2) |
| Cancellation | Fences stop effects; the gateway fetch ignored the run signal | Gap, fixed in #1160 | Done (§10) |

## 3. Durable execution and scheduling

### 3.1 The alarm slot: one seam, one arbiter, four narrow writers

**Observation `[verified]`.** A Durable Object has one alarm. Waldo reserves `packages/runtime/src/scheduler/alarm-slot.ts` as the only file that may call `setAlarm` (lines 1–6, citing ADR-0065), and `scripts/guards/guard-setalarm.mjs` blocks the call elsewhere. Each wake source keeps its own due key (`APP_INBOX_DUE_KEY` line 10, `COMMON_EXECUTION_DUE_KEY` line 19, `WHATSAPP_PENDING_DUE_KEY` line 21, the transport and schedule due times), `rearmSharedAlarm` (lines 31–43) is the arbiter: it reads eight persisted due keys plus the schedule's due time (lines 32–40) and arms `max(min(bounds), now + retry)`; the four narrow writers (`persistAppInboxWake` 13–17, `armWhatsappPendingWake` 24–27, `persistTransportWake` 46–54, `persistInboxWake` 57–63) each arm `Math.min(getAlarm(), due)` without reading the list. The alarm handler (`packages/runtime/src/channels/owner-do.ts:1378`) hands link mode to the link drain before anything else, otherwise drains the app inbox and then one kind of work per wake, chosen round-robin among transport, schedule and browser (lines 1421–1427), each branch re-arming through the seam.

**Reference.** Cloudflare's alarms documentation: "Each Durable Object is able to schedule a single alarm at a time by calling `setAlarm()`" and "you can manage many scheduled and recurring events by storing your event schedule in storage and having the `alarm()` handler process due events, then reschedule itself for the next one" (developers.cloudflare.com/durable-objects/api/alarms/). The Agents SDK makes that one table explicit: the Scheduler "contributes its earliest pending row to Lifecycle's shared physical alarm" and "Lifecycle runs the alarm event loop, retry policy, and physical alarm arming. Scheduler owns no storage of its own" (github.com/cloudflare/agents, `packages/agents/src/schedules/scheduler.ts`, `examples/next/schedules/README.md`).

**Gap and impact.** The seam is right, and the arbiter already reads a list of due keys; the weakness is that the list lives inside one function while four narrow writers bypass it, so a new wake source must be added to the list by hand, and the wake bug fixed in #1128 (merged 2026-10-13: the app drain's re-arm dropped the schedule's next wake) is exactly that omission. The owner-visible symptom was a missed brief or reminder after an app message. Confidence that the class recurs with the next wake source: high `[inference]`.

**Fix.** Bounded, no ADR: one exported list of due keys in `alarm-slot.ts` that `rearmSharedAlarm` reads and the narrow writers also min against, and a conformance test that fails when a due key is written anywhere in the runtime but is missing from that list. Folding the keys into one wake table (the Agents SDK shape) would be a store change and is listed as an optional ADR in §11.

### 3.2 The alarm handler's failure path

**Observation `[verified]`.** `alarm()` at `owner-do.ts:1378` has no top-level `try`. Its branches re-arm in `finally` where they drain (lines 1428 and 1458 for the inbox and transport branches), but an exception thrown before a branch's `finally`, or from the setup itself (`this.setup(channel)`, `await ready`), leaves the handler to the platform.

**Reference.** Cloudflare: "Alarms have guaranteed at-least-once execution and are retried automatically when the `alarm()` handler throws. Retries are performed using exponential backoff starting at a 2 second delay from the first failure with up to 6 retries allowed", and the handler receives `retryCount`/`isRetry`; the docs recommend catching and rescheduling when unbounded retries are needed (same page).

**Gap and impact.** After six platform retries a persistent throw leaves no alarm armed. For that owner, briefs, reminders, heartbeat ticks, retention sweeps and notice writes stop until the next inbound message arms a wake. A throw inside the schedule branch is logged (`owner-do.ts:1490`) and `dispatchDue` re-arms in its own `finally` (`multiplexer.ts:256–257`); the uncovered throws are in the setup and maintenance work before the branches (lines 1379–1417), and nothing tells the owner. Confidence: medium-high `[inference]` from the documented platform behaviour; not reproduced on a deployment.

**Fix.** Bounded, no ADR: wrap the handler body; on an uncaught error, arm a fallback wake (30 minutes, the heartbeat period) through the seam, log one typed line (`hop: 'alarm', code: 'rethrown'`, no error text), and rethrow so the platform's retry still runs. Test: an executor that throws leaves `getAlarm()` non-null. This is a mitigation at the event layer; the structural fix is §3.1's arbiter, which makes "re-arm" one call that cannot be skipped.

### 3.3 Missed runs, durable waits and retries

**Observation `[verified]`.** `packages/runtime/src/scheduler/multiplexer.ts:196–213` implements the C3 missed-run policy: after a gap, fire only the latest elapsed occurrence once and record every skipped intermediate as `missed`, never a catch-up burst; `settleRun` (line 443) records `ok | failed | quarantined | missed` per run in `schedule_runs`. Cron recurrences carry an IANA zone and are validated before anything is armed (lines 87–95). App work has an attempt id and a 15-minute deadline (`app-inbox.ts` `claim`), and `recover()` marks a running row whose attempt is not live as interrupted (`app-inbox.ts:66–72`), which is the start-to-close detection Temporal describes.

**Reference.** Hermes: "each job that stayed due fires **once** under the normal misfire catch-up rules, not once per missed tick" and "Missed ticks coalesce" (github.com/NousResearch/hermes-agent, `cron.md`, `heartbeat.md`). Claude Code: "No catch-up for missed fires" and "Recurring tasks automatically expire 7 days after creation" (code.claude.com/docs/en/scheduled-tasks). Temporal: "Unlike Activities, Workflow Executions do not retry by default" and heartbeats bound long activities (docs.temporal.io). Cloudflare Workflows: steps retry individually, "Because a step might be retried multiple times, your steps should (ideally) be idempotent."

**Verdict.** Parity with Hermes on coalescing and stronger than Claude Code's no-catch-up. Waldo's "one retry owner, bounded work, cancellation fencing" constraints (CLAUDE.md) are the Workflows/Temporal rules applied to a single object. No fix.

## 4. Memory

### 4.1 Validity windows and supersession

**Observation `[verified]`.** `packages/runtime/src/memory/claims.ts` keeps `valid_from`, `valid_to`, `supersedes_id`, `learned_at` and `verification_status` on every claim (type at line 10; columns at 326–327; insert at 402 stamps `learned_at` with the write time, leaves `valid_from` null (no runtime writer populates it; the Hall blocks take theirs from `observed_at`, `contracts/src/memory/hall.ts:38, 107`) and sets `owner-grounded` or `provisional`). A correction retires the old row (`status = 'superseded', valid_to = ?` at 425–432) and inserts the replacement with `supersedes_id`; nothing is deleted by a correction. The owner's forget is different: `forget()` (439–451) removes the claim's text and leaves a hashed barrier (`barrier()` 442–453, `forget_barriers` 333–351); `forgetNode()` (490) deletes the node and its edges; `memory/forget-guard.ts` is the stored-text coverage predicate the forget paths share.

**Reference.** Graphiti: "Facts have validity windows. When information changes, old facts are invalidated — not deleted. Query what's true now, or what was true at any point in time"; edges carry `valid_at`/`invalid_at` (world time) and `created_at`/`expired_at` (system time), and a contradiction sets `invalid_at = resolved_edge.valid_at` and `expired_at = now` (github.com/getzep/graphiti, `edges.py`, `edge_operations.py`). Mem0's current docs: "ADD-only; memories accumulate" with MD5 dedupe (github.com/mem0ai/mem0, `add.mdx`, `main.py`); its older prompt still mandates DELETE on contradiction. Letta edits blocks in place ("To delete memories, use an empty string").

**Gap and impact.** Waldo matches Graphiti's invalidate-not-delete and goes further with an enforced right to forget. The columns exist but carry system time only: `learned_at` is the system-time stamp, `valid_from` is never populated, and `valid_to` takes the correction time rather than when the world changed. "Since when do you live in Mumbai?" is answered with the day the owner told Waldo, not the day they moved. Low impact for launch; it matters once the brief reasons over durations. Confidence: medium.

**Fix.** ADR proposal (store change): populate `valid_from` and `valid_to` as world time the model may set from the owner's words ("I moved last month"), defaulting to the write time when unsaid, and add `expired_at` as the system-time retirement distinct from `valid_to`. The claim writer and the forget guard are the only writers to touch; the `remember` tool schema gains an optional `valid_from`.

### 4.2 Provenance, grounding and sleep-time work

**Observation `[verified]`.** Episodes are the provenance stream (`search_episodes`, the episodes index that #1144 fills at store time); the nightly grounding proposed in #1149 (open at the pinned commit; until it lands every nightly claim stays `provisional`) promotes provisional claims to owner-grounded from owner-authored text, and was returned to its builder for one real fault (pasted quotes counted as owner text). `status = 'superseded'` with `supersedes_id` is Cognee's "tag the assertions a more recent one replaced"; `verification_status` (owner-grounded or provisional) is the provenance grade; the nightly pass is Letta's sleep-time agent.

**Reference.** Graphiti: "**Episodes** (provenance) | Raw data as ingested — the ground truth stream. Every derived fact traces back here". Cognee's `cognify.py`: "OPTIONAL: for the relationships declared single-valued, tag the assertions a more recent one replaced". Letta: sleep-time agents hold the block-editing tools while the chat agent keeps `send_message`, `conversation_search`, `archival_memory_search` (`constants.py`, archive branch).

**Verdict.** Parity. The #1149 fault is a reminder that owner-grounding is an authority decision and belongs behind the quote-range check the `remember` path already has; the builder's fix carries the ranges into the episode index.

### 4.3 Development eval, not a judge

**Observation `[verified]`.** `packages/runtime/test/memory-golden-eval.test.ts` is, in its own words, "a repeatable development eval, not a private held-out set, LLM answer judge, or a live latency measurement"; it scores recall over synthetic owners with the expected id never supplied. See §9.2 for the eval gap.

### 4.4 Context composition and the conversation window

**Observation `[verified]`.** The ContextComposer builds each turn from source callbacks (`packages/runtime/src/context-composer/composer.ts`, `owner-turn.ts`, `recall.ts`, `materials.ts`). Across turns, the tool-output ledger keeps the newest six fragments per kind at 500 characters each (`conversation/tool-output-ledger.ts:49–50`), and a `turn_only_output` handler's result never enters it (#1157). Recall is just-in-time (`search_episodes`, `hideHistory`), and subagents run on a bounded round budget shared with the parent and return a compact report (`conversation/subagent.ts:15–16, 88–89`). The conversation itself is bounded by a token-aware rolling window of about 100k tokens that drops the oldest rows and never fails (`conversation/window.ts:3–6, 41–61`), applied in `conversation/joined-path.ts:66–70` and traced as the `context_window` hop (`channels/owner-turn.ts:254`). There is no summarising step: a grep of `conversation/` and `channels/owner-turn.ts` for summarise, compact, condense, prune and evict finds only the tool-output `summary` fields, and the working-memory compaction attachment contract (`contracts/src/runtime/working-memory.ts`) has no runtime reference.

**Reference.** Anthropic: "good context engineering means finding the smallest possible set of high-signal tokens", "Compaction is the practice of taking a conversation nearing the context window limit", and "Structured note-taking, or agentic memory, is a technique where the agent regularly writes notes" (anthropic.com/engineering/effective-context-engineering-for-ai-agents). Claude Code: "Compaction replaces the conversation with a structured summary. System prompt, CLAUDE.md, memory, and MCP tools reload automatically" (code.claude.com/docs/en/context-window).

**Verdict.** Parity on composition, the ledger and just-in-time retrieval. The gap is at the window: when a long chain passes the bound, the oldest rows leave the model's view with nothing in their place, so a fact stated early in a long thread is lost to the turn unless memory or recall carries it. ADR proposal 5 (§11) replaces that silent drop with a summary row.

## 5. Proactivity

### 5.1 The heartbeat, quiet hours and the gate

**Observation `[verified]`.** `packages/runtime/src/channels/heartbeat.ts` runs a deterministic tick every 30 minutes (`HEARTBEAT_EVERY_MS`), scans due open loops (`DUE_SCAN_LIMIT` 20), re-notifies a loop only after a 4-hour cooldown (`RENOTIFY_COOLDOWN_MS`), releases quiet-hours-held day cards, and records every tick in `schedule_runs`; "The tick is deterministic - no LLM turn - so it needs no LoopPolicy entry and cannot spend tokens." Quiet hours are the owner's (`loops.ts:11–13, 96–100`, zone-aware), and the delivery gate applies per-kind caps and cooldowns before a send (`delivery-gate/gate.ts:28–91`). Day cards say sent, skipped, held or pending (#1135).

**Reference.** ChatGPT Pulse `[search snippet]`: nightly research into morning cards, steered by thumbs up/down and curation, "It requires saved memory and chat history to be turned on". Hermes heartbeat: "Whenever the session is idle and the interval has elapsed, the prompt fires as a normal user turn" and "The injected prompt tells the agent to reply briefly and stop when nothing meaningful changed, so an idle heartbeat doesn't generate busywork". Claude Code `/loop`: "A scheduled prompt fires between your turns, not while Claude is mid-response" with a 7-day expiry.

**Verdict.** Waldo's tick is stricter than both (no model turn at all; the model only runs when a card or loop is due), and the gate's caps and cooldowns are the "don't invent work" guard made deterministic. The owner steering Pulse offers (thumbs, curate) maps to the rating route the contract declares and the runtime does not yet serve (declared in `contracts/src/app/core.ts`, unserved by the runtime; a Phase 2 slice). No harness fix.

### 5.2 Repeated failures are recorded, not surfaced

**Observation `[verified]`.** `multiplexer.ts:443` settles each run as `ok | failed | quarantined | missed` and `nightly-diagnostic.ts` reads the runs; after three failed attempts a quarantine-eligible kind such as the brief is quarantined for 24 hours (`multiplexer.ts:26–27, 327–341`; `contracts/src/runtime/schedule.ts:121`); `conversation/tool-loop.ts:43–45` withdraws a subagent's tools after a failure streak (`conversation/subagent.ts:68–77` describes it). I found no owner-facing signal for a schedule that fails on consecutive runs; the operator has the `machine_turn` and `late_fire` log lines (`owner-do.ts:1490, 1495`) and a pull-only diagnostic for the nightly schedule (`nightly-diagnostic.ts`) `[inference: no owner-facing signal exists]`.

**Reference.** Hermes cron: a `failure_streak` per job "drives review nudges" and a hosted-scheduler misfire sweep reclaims undelivered fires (`cron.md`).

**Gap and impact.** A brief whose entry fails three attempts is quarantined for a day and looks, to the owner, like a brief that never came; the runs table knows, the owner does not. Confidence: medium.

**Fix.** Contract-first and bounded: an additive `schedule_health` field on the settings projection (`{ kind, consecutive_failures, last_ok_at }` per schedule kind) in app.v1, then the runtime fills it from `schedule_runs`; the app shows a one-line notice when an entry is quarantined or has failed three consecutive attempts. No new store; the runs table is the writer.

## 6. Permissions, approvals and tool trust

### 6.1 The run scope is the permission pipeline

**Observation `[verified]`.** Every effect path re-admits the run scope before it acts: `app-inbox.ts` `scope()` (lines 105–111) throws `ClosedRunError` when the row is no longer running, its text or attempt changed, the session or owner differ, the deadline passed or the signal aborted; the owner object's `assertOwnerIdentity` re-checks the record, scope, run, attempt, `do_name`, surface, conversation ref and trace (`owner-do.ts:2263–2267` for the app turn, `2226–2233` for Telegram, which adds the subject), and the admission calls compare the physical object id (`owner-do.ts:2244, 2291`). Approval proposals are frozen with a payload digest (`approvals.ts:19, 307, 461, 835`; the operation ref in `owner-effect-ledger.ts:119`), and an approved card executes the frozen effect (`executeMcp` with the approval intent), never a re-run of the model. #1140 adds `question`, `labels` and `undo_until` to the card contract; #1160 adds the owner's stop.

**Reference.** Claude Agent SDK: "hooks run before every other step, and a hook deny applies even in `bypassPermissions` mode"; "The callback can stay pending indefinitely"; for long waits "a `PreToolUse` hook ... returns the `defer` decision ... so the process can exit and resume later from the persisted session" (code.claude.com/docs/en/agent-sdk/permissions). OpenAI Agents SDK: `needs_approval`, `RunState` that "survive[s] `state.to_string()` / `RunState.from_string(...)`", sticky `always_approve`. LangGraph: "The node restarts from the beginning of the node where the `interrupt` was called when resumed, so any code before the `interrupt` runs again".

**Verdict.** Waldo's approval is the OpenAI/Agent SDK `defer` shape with a stronger invariant: what resumes is a frozen effect, so the approved action cannot drift from what the owner saw. LangGraph's re-run-the-node is the shape Waldo's rules forbid ("intent-before-I/O, frozen intent/digests", CLAUDE.md). Parity or stronger.

### 6.2 Standing grants

**Observation `[verified]`.** CLAUDE.md requires that "Grants are owner/resource/parameter/time/budget scoped, revocable and rechecked before dispatch/resume." The runtime has a single-use grant store (`authority_grants`, `do-schema.ts:1062–1085`, `CHECK (use_limit = 1)`, with expiry and a revocation generation, written by `coordinator/judgment-authority-module.ts:366–388`) and `standing_orders` (`channels/standing-orders.ts`, whose write tools stay ACL-bound to owner-confirmed turns); I found no multi-use standing grant that pre-authorises an effect `[inference: not built]`. Every consequential action still goes through a card.

**Reference.** OpenAI's sticky decisions (`always_approve` / `always_reject`) survive serialization; the Agent SDK's allow rules are per tool and input pattern.

**Verdict.** Not a gap for launch: the card per action is the safer default. When built, it is an authority change and an ADR (the CLAUDE.md constraint already says so). Recorded in §11.

### 6.3 MCP trust

**Observation `[verified]`.** #1146 (landed `08350959`) refuses any tool on a Google host that is not an exact catalogue read, before auth, network or the desk (`tools/live/mcp.ts:83, 156, 209`); `fixed_args` land after the model's; the bearer never leaves the edge for proxied servers (`supabase/functions/connector-proxy/index.ts`). The follow-up PR from this session closes the edge's effect rail to non-catalogue tools and moves the fixed-argument merge into `executeMcp`. The generic OAuth flow is explicitly out of scope in source: "Third-party OAuth MCP servers are the generic flow's job (RFC 9728), not this shortcut's" (`mcp.ts:107–110`).

**Reference.** MCP 2025-06-18: "clients **MUST** consider tool annotations to be untrusted unless they come from trusted servers"; "MCP servers **MUST** implement OAuth 2.0 Protected Resource Metadata (RFC9728)"; "MCP clients **MUST** implement Resource Indicators for OAuth 2.0 as defined in RFC 8707" (modelcontextprotocol.io/specification/2025-06-18).

**Verdict.** Parity on trust (Waldo ignores `readOnlyHint` and keys on its own catalogue, which is what the spec's untrusted-annotation rule asks). RFC 9728/8707 discovery is not built; it is only needed for third-party servers, which the launch does not promise. Recorded.

## 7. Contract drift

**Observation `[verified]`.** app.v1 is additive-only and the app pins byte copies of the contract files from the merge commit (handoff rule). In the app, `src/agent/contracts/app-routes-v1.ts:10–30` reads display pages tolerantly (`projectionV1 = tolerant(appControlProjectionV1Schema)`; `historyV1` drops undeclared keys and any part that fails its own strict schema so the row's text still shows) and keeps everything it acts on strict (session, send, receipts, action results). That is why #1135's `cards[].state` and #1139's `receipt` part could not blank installed builds, and why #1133's `renew_after` had to move to its own route rather than widen the session response. On the backend, the guard list (`scripts/guards/`) pins released protocol bytes (`guard-responsibility-released-*-bytes.mjs`) but has no guard for app.v1 additivity, and no test parses real Worker output with the app's pinned schemas.

**Reference.** proto3: "Adding new fields is safe", "old binaries simply ignore the new field when parsing", "Field numbers **should never be reused**" (protobuf.dev). Avro: a reader field "that contains a default value" is filled when the writer lacks it; a reader field with no default that the writer lacks is an error (avro.apache.org specification). Pact: "Provider verification passes if each request generates a response that contains at least the data described in the minimal expected response" (docs.pact.io). Stripe: versions pinned per request, 72-hour rollback after an upgrade `[search snippet]`. zod: objects strip unknown keys by default; `z.strictObject` errors on them; `z.looseObject` passes them through (zod.dev/api).

**Gap and impact.** The reading rules are right (tolerant where display, strict where action). Two process gaps: (1) nothing deterministic stops a backend PR from removing or retyping an app.v1 field; the gate relies on review. (2) The pin is a manual byte copy and the app never parses the Worker's real emissions in CI, so an emitter that violates its own schema is caught only on a device. Both are the class Pact exists for. Confidence: high.

**Fix.** Both bounded, no ADR: (a) `guard-app-v1-additive.mjs`: compare `packages/contracts/src/app/*.ts` zod shapes against the last pinned commit (recorded in a small manifest the pin PR updates) and fail on a removed, renamed or retyped field or a narrowed enum; new fields must be optional or defaulted (the Avro rule). (b) The backend's existing route tests write one JSON fixture per app.v1 route into `packages/contracts/fixtures/app-v1/`; the app's CI parses each fixture with its pinned schemas (its tolerant readers for pages, strict for actions). The fixture set is the Pact file; the app's parse is provider verification in reverse. Fixtures carry synthetic values only (`guard-health-leak` already scans fixtures).

## 8. Time zones

**Observation `[verified]`.** The owner's zone is validated with `Intl.DateTimeFormat` (`owner-do.ts:203`, `app-health.ts:37`) and carried as an IANA name; local-day windows are computed from the zone (`health/scores/time.ts:24` `localDayWindow`); daily occurrences are re-resolved per run (`multiplexer.ts:686` `nextDailyLocalOccurrence(time, timezone, now)`), so a rules change moves the wall-clock event with the owner, not the stored instant. The Worker never relies on a host zone. The one asymmetry (from #1131's review): the health route ages a stored score by the row's own zone and compile time (`app-health.ts:115–118`) while the prompt ages by the owner's saved zone; a zone change across a day boundary can make the two disagree on "today".

**Reference.** IANA tz theory: "The tz database predicts future timestamps, and current predictions will be incorrect after future governments change the rules" (data.iana.org/time-zones/theory.html). Temporal: "The IANA Time Zone Database is updated several times per year in response to political changes around the world" and the `offset` option decides whether to keep the exact time or the wall-clock time when rules change (tc39.es/proposal-temporal). ECMA-402: an unknown `timeZone` throws `RangeError`. Cloudflare: "The local `workerd` runtime runs with `TZ=UTC`", "Cron Triggers execute on UTC time".

**Verdict.** Parity. Fix for the asymmetry, bounded: one `ageHealthRow(row, zone, now)` in `health/scores/` used by the route and the prompt, with the zone chosen once (the owner's current zone, since the owner is the reader); and the `source_as_of`/`stale_at` columns that Brain's ADR-0081 §2 lists but the row lacks (an owner migration, §11).

## 9. Observability and evals

### 9.1 Text capture and health values

**Observation `[verified]`.** `packages/runtime/src/observability/trace-privacy.ts:62–66`: free-form text is exported "ONLY outside production" and only with `LANGFUSE_CAPTURE_TEXT` on; `gateTraceEntry` (line 40) strips `detail`, `error` and `guard` with capture off, and `text` on the `constellation_evidence` and `health_context` hops; turn text is each sink's job: the console sink strips it (`owner-do.ts:1753, 1758`) and the OTLP exporter is gated on the same switch (`otlp-turns.ts:60`); metric labels are bounded (security checklist). `guard-health-leak.mjs` scans fixtures and logs for health values. #1157's `turn_only_output` keeps a health tool's result out of the cross-turn ledger and the object's storage; its text still rides the per-tool trace event when capture is on (staging testers, per the 10 Oct ruling).

**Reference.** OpenTelemetry GenAI semantic conventions: message content is Opt-In, "OpenTelemetry instrumentations SHOULD NOT capture them by default, but SHOULD provide an option for users to opt in", and "Store content externally and record references on the spans ... recommended in production environments where ... sensitive data needs to be handled securely" (github.com/open-telemetry/semantic-conventions-genai). Langfuse: masking "before trace data leaves your application"; `mask_otel_spans` at export stage (langfuse.com/docs/observability/features/masking).

**Verdict.** Parity. Proposal (health destination, so the owner decides): a `turn_only_output` handler's output text is also omitted from the trace event under capture, leaving `ok`, `code` and `ms`. One line in the owner turn's log call; it narrows a destination rather than adding one.

### 9.2 Evals

**Observation `[verified]`.** `packages/runtime/test/scenario-harness.test.ts` runs L1 scenarios with model-input assertions (what the model was shown, which tools ran, with hop time bounds) and the fake-gateway turn tests in this session assert the same (trajectory grading in unit tests). `memory-golden-eval.test.ts` is a development recall eval. `docs/evals/W7_EVALS_V0_RESULTS.md` records the last results. `packages/runtime/evals/run.ts` is a model-judged outcome eval (a model judge scores each case against its rubric; `docs/evals/W7_EVALS_V0_RESULTS.md` records one 22-of-42 run with a live key), but it is manual, judged by the same model it grades, single-run and outside the gate; no pass^k measurement exists `[verified]`.

**Reference.** Anthropic, "Demystifying evals for AI agents": graders are code-based, model-based or human; model graders are "Non-deterministic", "More expensive than code", and "Require calibration with human graders"; "pass^k ... measures the probability that all k trials succeed"; "it's often better to grade what the agent produced, not the path it took". Platform guidance: "Generally best practice to use a different model to evaluate than the model used to generate the evaluated output".

**Gap and impact.** Waldo's tests grade trajectories deterministically, which is the right cheap layer, but the model-graded eval is manual, self-judged and outside the gate, so a prompt or model change that keeps the trajectory and degrades the reply is invisible until someone runs it or the owner notices. Confidence: high.

**Fix.** Proposal to the owner (costs tokens, runs on staging): promote `evals/run.ts` to a nightly run on staging with synthetic owners (no real owner data), the 20-task set from the capability-gap document as its rubrics, a different grader model with thinking on, three trials reported as pass^3, with the trajectory assertions kept as the gate. Bounded; no runtime change beyond a test-only entrypoint.

## 10. Cancellation reaches the transport

**Observation `[verified]`.** Before #1160, `packages/runtime/src/llm/gateway.ts` `safeFetch` (line 111) aborted its fetch only on its own timeout; the run scope's signal was ignored, while `llm/openai.ts:55–58` already listened to it. A Telegram `/stop` (`owner-do.ts:1515–1521`) closed the row and fenced effects (the app had no stop route before #1160), but the in-flight gateway request ran to completion, the reply was discarded at the fence, and the object's serial drain held the owner's next message behind it. #1160 (reviewed PASS WITH NITS, the nit taken) wires the run signal into the gateway fetch, with a unit test on the transport's signal and an end-to-end assertion that the gateway saw the abort before the gate released.

**Reference.** The Agent SDK's `canUseTool` receives a `signal`; Workers `fetch` honours `AbortSignal`. The rule is the one the OpenAI adapter already followed.

**Verdict.** Fixed. The general lesson for the harness: a fence stops effects, not spend or latency; every I/O the turn awaits must take the run's signal.

## 11. ADR proposals for the owner

Each of these changes a store, a writer, an authority boundary or a health-data destination, so under CLAUDE.md it is a proposal, not a commit.

1. **Health score row freshness fields** (ADR-0081 amendment, migration): add `source_as_of` and `stale_at` to the stored score so the route and the prompt age the same facts (§8). Owner migration.
2. **Turn-only tool text omitted from traces** (health destination narrowing): `turn_only_output` handlers export no tool text even under capture (§9.1).
3. **Claims: world time versus system time** (store change): `expired_at` for retirement, `valid_from`/`valid_to` for the world, settable from the owner's words (§4.1).
4. **One wake table** replacing the per-source due keys (store change); the arbiter's due-key list and its conformance test need no ADR (§3.1).
5. **Conversation compaction row** (writer change): a model-written, scribe-checked summary row that replaces what the rolling window now drops silently (§4.4: `conversation/window.ts` keeps about 100k tokens, oldest out first, with no summary) while the transcript keeps every row. Reference: "Compaction is the practice of taking a conversation nearing the context window limit" and "Compaction replaces the conversation with a structured summary" (Anthropic context engineering; Claude Code context-window docs).
6. **Standing grants** when built (authority change): owner/resource/parameter/time/budget scoped, revocable, rechecked before dispatch and resume (§6.2).

## 12. Bounded fixes this session proposes or has landed

| Fix | Scope | Status |
| --- | --- | --- |
| Gateway fetch aborts on the run's stop | `llm/gateway.ts`, tests | Landed in #1160 (`4a964b6f`) |
| Edge refuses non-catalogue tools on the effect rail; fixed arguments on every rail | `connector-proxy/index.ts`, `tools/live/mcp.ts`, tests | Follow-up PR (this session) |
| One wake arbiter with a due-key conformance test | `scheduler/alarm-slot.ts`, `owner-do.ts`, a guard test | Proposed (§3.1) |
| Fallback re-arm on an uncaught alarm throw | `owner-do.ts` `alarm()` | Proposed (§3.2) |
| `schedule_health` on the settings projection | contract first, then runtime | Proposed (§5.2) |
| `guard-app-v1-additive` and the app.v1 fixture set | `scripts/guards/`, `packages/contracts/fixtures/app-v1/`, app CI | Proposed (§7) |
| One `ageHealthRow` for route and prompt | `health/scores/` | Proposed (§8) |
| Nightly model-graded eval on staging | test-only entrypoint | Proposed to the owner (§9.2) |

## 12a. Backend items from the owner's two research documents

The Mac orchestrator's two documents of 13 Oct (`docs/research/WALDO_VS_INSTINCT_CAPABILITY_GAP_2026-10-13.md` and `docs/research/AGENT_UX_HCI_RESEARCH_2026-10-13.md`, on `docs/overnight-2026-10-12`) steer the backend backlog; their backend asks fold into Phase 2 and Phase 3 here rather than into a separate comparison. Where this document already carries the same finding, the row says so.

| Ask (source) | Where it lands | Relation to this document |
| --- | --- | --- |
| Deploy the merged queue; emit #1140's fields; serve open loops and carrying (#1138) (Instinct §5 items 1–2) | Phase 1 hand-off 2; Phase 2 after the app build carries the pin | Same ordering rule as §7 (contract, then app pin, then emit) |
| A turn **progress** part so a 10–40 s turn shows its steps (UX doc rows 2–4) | Phase 2, contract first: an additive `progress` part the owner turn emits at each tool round, with the hop name as the step word, never model text | New; the observability gap in §9 is the backend side of the same wait |
| Stop and steer; after Stop, say what ran and what did not (UX doc row 4) | Stop landed in #1160; "what ran" is the receipt part plus `effects_unconfirmed` | §10 |
| A push sender for Needs-you only, with no health in the payload and the quiet rule (Instinct §5 item 8; UX doc) | Phase 2 (the cloud builder's claim E), behind the delivery gate of §5.1 | §5.1's gate is the "nothing else needs you" rule |
| Photo and file input in the app (Instinct §4 "Multimodal input", §5 item 5) | Phase 2 after a bounded contract review of attachment storage (a new store) | Same class as the ADR proposals in §11 |
| Ask-versus-assume, up-front limits, "listen first" and "challenge without taking over" as model judgement, backed by the 20-task set as scenario evals, never rules (Instinct §4, §5 item 4) | Phase 3: the eval proposal in §9.2 takes the 20 tasks as its first outcome set; the prompt amendments go through the soul-file review | §9.2 |
| Watchers and sweep cards; a Patrol executor (Instinct §5 items 9 and 15) | Standing grants first (§6.2, an ADR); sweep cards are the Worker-side claim of the cloud builder behind contract #1153 | §6.2, §11 item 6 |
| Threads runtime (Instinct §5 item 10) | Phase 2, the backend builder's design accepted on #1103 (one slice per PR, isolation and forget tests blocking) | New |
| Spots actions and the profile route; the memory audit (Instinct §5 item 11) | Phase 2 shapes first; the audit scope is the owner's | §4.1's validity-window proposal is an input to the audit |
| People memory and birthdays (Instinct §5 item 12) | After the owner rules on a new connector scope | Not started |

## 13. What would change these conclusions

- A summarising step in the conversation load that this reading missed (the drop-oldest window of `conversation/window.ts` is not one) would remove ADR proposal 5.
- A multi-use grant beyond `authority_grants` (single-use) and `standing_orders` under another name would turn §6.2 from "not built" into a review of its recheck path.
- Reproducing an uncaught `alarm()` throw on staging and observing the platform re-arm after its retries would downgrade §3.2 to a note.
- A consumer-side parse of real Worker output somewhere in the app's CI would close §7(b).
