# Waldo harness map

**Pinned to:** `waldoco/beta-mvp` at `38ff097bf`, read on 4–5 Nov 2026.

**Scope:** every layer an event or message crosses, from admission to delivery.

**Labels:**
- [verified]: seen in source or a test at the cited line.
- [inference]: concluded from source, not run or traced.

Plans and PR descriptions are not used as evidence here.

**Paths:**
- `rt/` = `packages/runtime/src/`
- `ct/` = `packages/contracts/src/`
- `OD` = `rt/channels/owner-do.ts`
- `OT` = `rt/channels/owner-turn.ts`

**Switch columns** show staging / production, from `packages/runtime/wrangler.jsonc`. There is no `env.production` block: the top-level `vars` are what production runs [verified].

**Models** are named by role [verified, `ct/model/roster.ts:38-50`, `rt/llm/owner-routes.ts:46-72`]:

| Role | Staging (`WALDO_MODEL_PROVIDER=anthropic`) | Production (`=openai`) |
|---|---|---|
| chat | `claude-sonnet-5-5` | `gpt-6.1-terra` |
| aux | `claude-haiku-5-5` | `gpt-6-luna` |

The other provider is every route's fallback when its key is deployed. A `template` floor follows it.

**Prompt caching** differs by provider [verified, `owner-routes.ts:68-72`, `anthropic.ts:216-240`, `openai.ts:89`]:
- **Anthropic:** only owner chat-model calls carry `cache_control`. There is one breakpoint on the system head and rolling breakpoints on the last 3 messages, with the default 5-minute TTL. Every aux call on Claude sends no cache marks.
- **OpenAI:** routing is automatic. `prompt_cache_key = waldo:<owner>` is accounting only.

## 0. The path of one app chat message [verified]

1. **The app sends the message.** `POST /app/v1/chat/main/messages` goes to `handleApp` (`rt/index.ts:156`), which checks auth and the rate limit, then calls `OWNER_DO.fetch` (`rt/channels/app-api.ts:335`).
2. **The inbox admits it.** `OD:2089 appSend` calls `AppInbox.admit`. Dedupe is by `client_message_id` plus a text digest: the same digest is a duplicate, a different one is a 409. 256 open rows return 503. Admission sets a wake at +250 ms and returns 202.
3. **The turn starts.** `serial(drainApp)` runs the authority check, then `claim` with a 15-minute deadline, then builds the thread-fenced scope. It calls `turn(…,'app')`, which calls `setup('app')`, which reaches `TelegramOwnerListener.handle` (`rt/channels/telegram-listener.ts:93`, racing a `TurnTimeout`).
4. **The responder builds context and runs the loop.** `createOwnerResponder` (`OT:136`) composes context (§3), recalls memory (§4), and runs `runToolLoop` on the chat model (§2). Each round it rebuilds the prompt (§3), checks steer/stop (`consumeRound`), and folds newer owner messages (`WALDO_SECOND_MESSAGE` 0/0).
5. **The reply is saved and read.** `converse` (`OT:841`) persists the input, gates the reply, runs `assertFresh`, and saves the reply plus its receipt line to the conversation store. The app reads the row (drafts stream while `WALDO_STREAM_REPLIES` is on/off).
6. **Upkeep runs after the queue drains:**
   - thread title (aux);
   - `compactApp` (`WALDO_COMPACTION` on/off, aux);
   - `rearmWithSchedule`.

## 1. Admission, inboxes, triggers and wakes

| Piece | File | Contract | Switch (stg/prod) | Model | Notes |
|---|---|---|---|---|---|
| Worker entry | `rt/entry.ts:5`, `rt/lazy-entry.ts:35-46`, `rt/index.ts:147-239` | `fetch` / `email` / `scheduled` | main `staging-entry.ts` / `entry.ts` | – | `scheduled` does upkeep only (Photon keepalive, retention, mail rules, Langfuse); it starts no owner turn [verified] |
| App inbox | `rt/channels/app-inbox.ts:80-99` | `AppInbox.admit` → admitted / duplicate / conflict / capacity | `APP_ID_TOKEN_SIGNIN` 1/0 | – | No mid-turn steer on the app: a new row waits behind `serial()` [verified] |
| Telegram (test channel) | `rt/channels/telegram-webhook.ts:245`, `OD:820-905` | `TelegramOwnerInbox.admit` with control steer/stop | inbox secret | – | The only surface with true mid-turn steer (`OD:872-905`) [verified] |
| WhatsApp | `rt/channels/whatsapp-webhook.ts:183`, `OD:2313-2316` | `WhatsAppOwnerInbox` | `WHATSAPP_REPLY_MERGE` 1/0, `WHATSAPP_QUIET_MS` 3000/3000 | – | Dedupe by wamid; quiet-window merge; `overtaken(runId)` ends a stale turn [verified] |
| iMessage | `rt/channels/imessage/bridge-do.ts:40,84`, `imessage/owner-inbox.ts:54` | `admitIMessageTurn`, `IMessageOwnerInbox.admit` | `IMESSAGE_CONNECTOR_ENABLED` 1/0 | – | Dedupe by event id plus digest [verified] |
| Inbound email | `rt/channels/agent-mail/ingress.ts:43-67`, `inbox.ts:11,48`, `turn.ts:22,79` | `receiveAgentMail` → `admitAgentMail` | `AGENT_MAIL_INBOUND` 1/0 | aux (machine turn) [inference] | 50 turns per day cap. Runs as a tainted job whose answer goes to the owner's chat; changes go to cards [verified] |
| Alarm lanes | `OD:2992-3023, 383, 3502` | `alarm` → `alarmWork`: whatsapp → mail → app → imessage → mac/mail/jobs/transport → round robin inbox/transport/schedule/browser | `NEXT_DUE_ALARM` 1/0 | – | One turn at a time per owner (`serial`) [verified] |
| Scheduler | `rt/scheduler/multiplexer.ts:67-70, 217, 672`; executors `OD:3160` | `Scheduler.schedule / dispatchDue / rearm` | schedule prefs (`OD:3190`) | – | Executors: reminder, heartbeat, dreaming, pre-activity spot, brief cards, standing orders, health trigger (patrol). One shared DO alarm [verified] |
| Reminders | `rt/channels/reminders.ts:24`, `OD:4825-4864` | `responder.remind` | – | aux [inference] | Model-written check-back with `reminderFloorText` fallback; medication text never goes through a model [verified] |
| Open-loop heartbeat | `rt/channels/heartbeat.ts:42-144`, `OD:4999-5017` | `heartbeatTick` → `enqueueMachine(heartbeatJobSpec)` | `NEXT_DUE_ALARM` grid | worker `taskModel`; apply turn | The tick makes no model call [verified] |
| Health trigger | `rt/health/trigger.ts:326, 370, 605`; `OD:5151-5220` | `runHealthTrigger`, `healthTriggerPrompt`, `healthNoticePrompt` | `HEALTH_SOLO_NOTICE` 1/0, `HEALTH_COACHING` 1/0, `HEALTH_EASE_WORKOUT` 0/0 | `responder.prompt` | Zone words only; JSON propose / no_op; one change at most [verified] |
| Day cards (Brief / Check-in / Close) | `rt/channels/day-cards.ts:262-475`, `rt/prompt/day-cards.ts`, `OD:5540-5625` | `armDayCards`, `composeDayCard` → `dayCardPrompt` | `WALDO_DAY_STATE` 1/0, `PLANNING_BRIEF` 0/0, `WHY_TRAIL` 0/0 | aux (sized for `WALDO_AUXILIARY_MODEL`, `day-cards.ts:470`) | `DAY_PLAN_INSTRUCTION` plans the times (aux, JSON) [verified] |
| Update cards / sweep | `rt/channels/update-cards.ts`, `update-sweep.ts:163, 241`, `rt/prompt/update-cards.ts` | `updateCardPrompt`, `updateEffectsPrompt` (JSON revise / say / push) | `UPDATE_PUSH_NAMES` 1/0, `MAIL_SOURCE_FOLLOWUPS` 1/0 | machine job, then apply turn | [verified] |
| Meeting prep | `OD:5370-5400`, `rt/prompt/machine-jobs.ts:44` | `enqueueMachine(meetingPrepSpec)` | `CALENDAR_GROUNDED_PREP` 1/0, `PREP_PUSH_NAMES` 1/0 | machine job | [verified] |
| Nightly / daytime memory | `OD:5141-5145`, `OT:1084-1127` | `ask('nightly_memory' / 'memory_nightly_sources' / 'constellation')` | `MEMORY_DAYTIME_CONSOLIDATOR` 1/0, `MEMORY_NIGHTLY_SOURCE_UPDATES` 1/0 | aux | [verified] |

## 2. The owner turn, the tool loader and the loop

| Piece | File | Contract | Switch (stg/prod) | Model | Notes |
|---|---|---|---|---|---|
| Responder | `OT:136-224` | `createOwnerResponder(…)`; `ownerModelAccess` (`rt/llm/owner-routes.ts:38-42`) | `WALDO_MODEL_PROVIDER` anthropic/openai | chat for owner turns; aux for machine replies (`OT:719`) | Spend cap clamps to aux (`OT:850`) [verified] |
| Step (per round) | `OT:591-736` | `step(tools, turns)`: steer, compose, recall, forget barrier, `assembleTurnPrompt`, `complete('reply')` | – | as above | The turn suffix is frozen and resent until steering, forget, health or held topics change (`OT:574, 622`) [verified] |
| Harness loader | `rt/tools/loader.ts:50-108`, `rt/tools/records.ts:8-21` | `harnessToolLoader` → `{offered, route, definition}`; `find_tools`, `use_tool`, `toolCatalogue` | `WALDO_TOOL_LOADER` harness/off | – | 12 deferred groups; core tools plus 2 meta tools offered; the catalogue is in the system prompt, sorted for byte stability [verified] |
| Provider tool search | `rt/llm/anthropic.ts:357-365`, `rt/llm/openai.ts:256` | `tool_search` | `WALDO_TOOL_SEARCH` off/off | – | Inactive in both environments [verified] |
| Loop | `rt/conversation/tool-loop.ts:128-300` | `runToolLoop({handlers, maxSteps, budget, offload, stableMenu, loader, step})` | – | – | Exits: completed / budget_exhausted / time_exhausted / withdrawn [verified] |
| Rounds and budget | `rt/llm/time-budget.ts:38-80`, `tool-loop.ts:50, 428-450` | `toolRoundsFor(ms)` = max(25, ms × 25 / 120 s), capped at 150; budget notes in the last 3 rounds | – | – | `unchangedNote` counts identical repeat results [verified] |
| Result size and spill | `tool-loop.ts:15-28, 83-88, 209-230`; `rt/conversation/tool-output-store.ts:27-31` | `capToolOutput` (16k, keeps 4k head); `read_tool_output` reads the rest; clearing past 160k characters; cold cache keeps 3 rounds (Anthropic only) | – | – | [verified] |
| Cross-turn results | `rt/conversation/tool-output-ledger.ts:11-170` | 6 summaries of up to 500 characters, with taint | – | – | Rendered as fenced "earlier tool results" only if the sanitiser admits them unchanged (`OT:640-660`) [verified] |
| Subagent | `rt/conversation/subagent.ts:18-110` | `delegate_task`: read-only child loop, at most 5 per turn, 0.6 round share | – | parent's [inference] | [verified] |
| Compaction | `rt/conversation/compaction.ts:8-108`, `OT:923-976` | trigger at 0.7 of the window, tail 0.5, 2k output | `WALDO_COMPACTION` on/off | aux | After delivery [verified] |
| Window | `rt/conversation/window.ts:15-44` | `conversationInputBudgetTokens(model)` | – | – | About 100k tokens [verified] |
| Task workers | `rt/tasks/worker-do.ts:16-41`, `worker-loop.ts:73, 225-245`, `lane.ts:99`, `jobs.ts:15-26` | `TaskWorkerDO.start`; tools run in OwnerDO through `taskTool` RPC; `MachineJob` = heartbeat / update_sweep / meeting_prep / owner_lookup | `WALDO_TASK_NOTES` 0/0, `WALDO_TASK_ASK` 0/0 | `taskModel`: chat if effort is deep, else aux; `TASK_MAX_ROUNDS` 200 | Workers hold no memory, send or approve tools; results come back as a machine turn on the owner's chain (`lane.ts:75`, `machine-jobs.ts:44`) [verified] |

## 3. Context composer and prompt builder

What one owner reply call sends, in provider order:

```
tools (function list; harness: core tools + find_tools + use_tool)
system  = behavior (messagingSystemPrompt)            ┐ stable per owner,
          + skill catalog + standing orders          │ surface and tool set:
          + REASONS instructions (identity, approach, │ the cached head
            tools line, voice, safety)               ┘
          [+ loaded skill procedure + safeguards]     ← after the head
messages = history … + last owner message
          + fenced recall / earlier results / receipts
          + turn context (clock, today, profile, memory, REASONS operations,
            health, loops, connections, task context)
```

| Piece | File | Contract | Switch | Notes |
|---|---|---|---|---|
| Behavior prompt | `rt/prompt/messaging-behavior.ts:122-165` | `messagingSystemPrompt(tools, presentation?, toolSearch, direct)` | – | Sections: IDENTITY, VOICE (`VOICE_VERSION` 4), vocabulary, TASKS, EXAMPLES, DOING (+ DIRECT_DOING on a surface-less turn), HEALTH, REMEMBERING, surface presentation, tool line [verified] |
| Turn assembly | `rt/prompt/turn-prompt.ts:62-75` | `assembleTurnPrompt({instructions, facts, memory, loops, room})` → `{system, turnContext, sections, contextSections}` | – | Memory and loops get the room the sanitiser's system cap leaves [verified] |
| REASONS composer | `rt/context-composer/composer.ts`, `prompt.ts:121-168`, `owner-turn.ts:60-132` | `assembleReasonsPrompt` → `{instructions, operations}`; serializer `context-reasons-v4` | – | Fixed owner fragments, about 600 bytes (`context-composer/owner-turn.ts:87-94`); operations carry recall, health, workspace and recent tool results [verified] |
| Health in context | `rt/context-composer/prompt.ts:185-210` | `renderHealth`: zone, trend, freshness, confidence, baseline, sleep debt in words, energy windows as clock ranges | ADR-0081 | Zone words only [verified] |
| Day-card and job prompts | `rt/prompt/day-cards.ts`, `update-cards.ts`, `machine-jobs.ts`, `rt/health/trigger.ts:326-380` | job text rides the message; system = behavior prompt | `PLANNING_BRIEF` | `fitPromptToBudget` (`rt/prompt/fit-prompt.ts`) cuts the middle of oversize job prompts [verified] |
| Fixed owner lines | `rt/prompt/fixed-lines.ts` | floor reply, park notices, interrupted notices | – | Words no model wrote, used only when no model can be reached [verified] |
| Size telemetry | `OT:329-340`; `ct/telemetry/turn-event.ts:37,60`; `rt/observability/otlp-turns.ts:100-110` | `shape{system_bytes, request_bytes, voice_version, context{tools_bytes, tools_tokens_est, history_bytes, current_bytes, system_sections, context_sections}}` | – | Only `reply` calls carry the section breakdown [verified] |

## 4. Memory and recall

| Piece | File | Contract | Switch (stg/prod) | Notes |
|---|---|---|---|---|
| Claims store | `rt/memory/claims.ts` | `ClaimStore.claims / recall` | – | Owner facts and preferences; health claims per the health-plane amendment [verified] |
| Turn memory | `OT:404, 621-660, 668` | `recallFor(…)` → fenced "memory recalled for this message"; pinned profile within `systemRoom` | `MEMORY_SEMANTIC_RECALL` 1/0, `MEMORY_SELECTION` 1/0 | Recall rides the owner message, not the system prompt [verified] |
| Forget barrier | `rt/context-composer/forget-barrier.ts` | `applyForgetBarrier(parts, held, mode)` | `WALDO_FORGET_BARRIER` | Everything the call shows crosses it once per build [verified] |

## 5. Approvals and the effect ledger

| Piece | File | Contract | Switch (stg/prod) | Notes |
|---|---|---|---|---|
| Card desk | `rt/channels/approvals.ts:64-88, 161, 308-315` | `DeskAction` a / s / e / u / d | `APPROVE_IN_CHAT` 0/0, `CALENDAR_UNDO_CANCEL` 0/0 | **Card kinds.** Modifiable: calendar, Google task, email, message and agent-mail sends. Not modifiable: browser submit, MCP call, tainted action. **Windows:** `UNDO_WINDOW_MS` 10 min; proposals live 12 h [verified] |
| Effect ledger | `rt/channels/owner-effect-ledger.ts:7-49` | `EffectIntent` / `EffectRecord`: reserved → attempting → done / rejected / unknown | – | DO KV under `owner:effect:`; authority is rechecked in the reserve transaction [verified] |
| Standing grants | `rt/channels/standing-grants.ts:19-41` | `standingGrants(storage)` | `AUTONOMY_OWN_CALENDAR` 0/0 | No code path creates a grant yet, so autonomy is inert [verified] |
| Hooks | `rt/hooks/registry.ts:481-674` | PreToolUse autonomy gate, egress allowlist, taint, canary, sanitiser | `WALDO_EGRESS_ALLOWLIST` | [verified] |

## 6. Delivery

| Surface | File | Contract | Switch (stg/prod) | Retry |
|---|---|---|---|---|
| Shared final outbox (every surface except the app reply) | `rt/channels/telegram-final-outbox.ts:21, 128-311`; routes `OD:3212-3245` | `enqueue / drain`, `OutboxRoute{addressed, allowed, defer, send}` | – | 3 attempts; the backoff respects `retryAfter`; otherwise quarantined. Quiet hours defer [verified] |
| App reply | `rt/channels/surfaces/app.ts:42`, `OT:~882` | conversation row; receipt GET | `WALDO_STREAM_REPLIES` on/off | The reply is the saved row [inference] |
| App proactive | `OD:1411`, `rt/channels/expo-push.ts:34-79` | `scheduledAppDelivery`, `ownerPush` | – | Push limits 3 per day and 6 proactive [verified] |
| WhatsApp | `OD:3240, 3806` | `whatsappWindowRoute` (24 h window, template knock outside it) | `WHATSAPP_REENGAGE_TEMPLATE` | outbox [verified] |
| iMessage | `rt/channels/imessage/final-outbox.ts`, `OD:4786` | `IMessageBridgeDO.enqueueReply` | `WALDO_IMESSAGE_PROGRESS` 0/0 | The bridge owns retry [inference] |
| Email (Waldo's address) | `rt/channels/agent-mail/send.ts` | approval card first | `AGENT_MAIL_SEND` 1/0 | not read |

## 7. Observability

- **Turn log** [verified]: `llm_<purpose>` and `llm_<purpose>_attempt` hops carry usage (input, output, cached, cache_write), provider, `fallback_fired` and `ttft_ms` (`OT:356-369`). There is one `tool_<name>` hop per call.
- **Langfuse OTLP** [verified]: per call it records `usage_details`, `cached_share`, cost, and per-section bytes as `context_system_<k>_bytes` and `context_turn_<k>_bytes` (`otlp-turns.ts:84-110`).
  - `LANGFUSE_CAPTURE_TEXT`: true / false.
- **Cost ledger** [verified]: `rt/observability/cost-rollup.ts`.
  - `WALDO_COST_LEDGER_SYNC`: on / off.
- **Not wired** [verified]: no Sentry, no Analytics Engine, no alerts. CF `traces.enabled` is false (`wrangler.jsonc:12`).

## 8. Token cost per round

These numbers come from the eval world, a 31-tool owner on the app surface, at `38ff097bf`. They are UTF-8 bytes; token estimates are bytes ÷ 4 (`BYTES_PER_TOKEN_EST`), not provider counts. The per-turn-type measurement with the V2 comparison is in `docs/proposals/PROMPT_CONTEXT_AUDIT_2026-11-05.md`.

| Part | Production menu (all tools) | Staging menu (harness) |
|---|---|---|
| Tool definitions | 32,236 B (~8.1k tok), 31 tools | 15,822 B (~4.0k tok), 16 offered |
| Behavior system prompt | 19,793 B (~4.9k tok) | 21,922 B (~5.5k tok, includes the catalogue) |
| Machine turn behavior (no tools) | 19,467 B | 19,467 B |

A real owner with every connector carries up to 99 records plus MCP tools on the production menu [inference, from `rt/tools/records.ts`]. The staging harness keeps that to about 23 offered.

## 9. Where the prefix can break

These points matter for both Anthropic and OpenAI caching [verified unless marked]:
1. **The last no-tools round** (`tool-loop.ts:284`) drops the tool list, which leads the Anthropic prefix.
2. **Subagent and other loops** filter their menu mid-turn. Only the owner turn sets `stableMenu` (`OT:584`).
3. **A provider fallback or spend clamp mid-turn** moves the turn to another model or cache.
4. **Loading a skill procedure** appends to the system prompt. On Anthropic the head breakpoint survives. On OpenAI the instructions text changes.
5. **Changes between turns** move the cached head: the tool set (harness catalogue text), standing orders, the skill catalog, REASONS identity (which carries the owner profile), and a voice bump.
6. **A rebuilt turn suffix** (steer, forget, health refresh, held topics) invalidates everything after the last owner message.
7. **History windowing, compaction, result clearing past 160k characters, and cold-cache clearing** each shift what follows.

## 10. Where the Super-agent ideas land

| Idea | Lands in | Owner lane | State at this SHA |
|---|---|---|---|
| Two-level router and workers | The owner turn is the router (`OT`). Workers are `TaskWorkerDO` and machine jobs (§2) | built | Workers exist; the owner turn holds long tools inline [verified] |
| Full duplex (hand long tools to workers, answer now) | `OT:591-736` step, `rt/tasks/*`, the `tasks()` block in `messaging-behavior.ts` | `harness-full-duplex`, PR #1868 (`WALDO_ASYNC_TOOLS`, plus `WALDO_LIGHT_CHAT`) | In review. It changes `tasks()` in `messaging-behavior.ts`, `owner-routes.ts`, `owner-do.ts`, `wrangler.jsonc` and `staging-profile.ts` |
| Chain of Recall (Inline & Spill on recalled rows) | `rt/memory/turn-recall.ts`, `rt/history/recall-chain.ts`, the fenced recall block in the turn suffix (`OT:631`) | `chain-of-recall`, PR #1876 (`WALDO_RECALL_CHAIN`) | In review |
| Progress watchdog | `rt/tasks/watchdog.ts` (new), `jobs.ts`, `brain.ts`, `worker-loop.ts`, `fixed-lines.ts`; today's pieces are `progress-pacer.ts` and `tool-loop.ts:445` | `progress-watchdog`, PR #1875 (`WALDO_WATCHDOG`) | In review. It adds a `do-schema.ts` change |
| Tools (descriptions, results, core set, budget) | `rt/tools/records.ts`, `loader.ts`, tool descriptions, `capToolOutput` | `tool-engineering`, #1843 and #1869–#1873 | Merged at this SHA |
| Event triggers | Scheduler executors, health wakes, update sweep (§1); Google real-time capture | #1840 (`GOOGLE_REALTIME_TRIAGE`) | In review |
| Thread routing and the health action layer | `threadFenced` (`OD:2121`), `APP_THREAD` (`delivery-routes.ts:46`), `health/trigger.ts` | after #1840 | Not started |
| Prompt and context engineering | §3, `messaging-behavior.ts` | this lane (`WALDO_PROMPT_V2`) | See the audit doc |

**Seams that collide with the open PRs:**
- `messaging-behavior.ts` `tasks()`: #1868.
- `OT` step: #1868 and #1876.
- `owner-do.ts`: every open PR.
- `wrangler.jsonc` vars and `evals/nightly/staging-profile.ts` `STAGING_VAR_CLASSES`: every open PR adds a key.

This lane changes no `tasks()` text, and touches `OT` only to thread the switch.
