# Switch inventory

Every key in `WALDO_SWITCHES` (`packages/runtime/wrangler.jsonc`) has a row in
[`switch-inventory.json`](switch-inventory.json). `scripts/guards/guard-switches-binding.mjs` fails when a switch has no
row or a row names a switch no longer in the config, so a switch and its row leave together. The JSON is authoritative;
the table below is a snapshot at `c6e50555` with values and read sites, for review.

## The rule

By owner ruling (19 November 2026), behaviour that is merged ships turned on. A switch stays only for risky authority or
egress, or for unfinished work, and each kept switch carries a reason and a removal date. A removal date already past is
printed by the guard, never failed, so the guard does not depend on the clock.

| Disposition | Meaning | Count |
|---|---|---|
| `unconditional` (a) | On in staging and shipped: the code drops the switch and its off path, the config drops the key | 100 |
| `kept` (b) | Risky authority or egress, or unfinished; carries `reason` and `removeBy` | 20 |
| `delete` (c) | Dead: off everywhere and superseded | 1 |
| `knob` | A tuning value (cap, ceiling, size, minutes), not a behaviour switch; stays config | 24 |

"Shipped" here means on in the staging block of `wrangler.jsonc`. That the deployed staging Worker carries the same value
is not checked by this inventory: the staging gate's `worker-version` read is where to confirm it.

The removal dates are proposals for the owner to confirm: `2026-12-31` for unfinished work and the medicines check,
`2027-01-31` for authority and egress, which the production cohort ruling decides.

## Batches

Each (a) batch is one PR that removes its switches from both config blocks, the env type, the read sites, the off paths
and the tests of the off paths, and deletes the batch's rows here.

| Batch | Switches | When |
|---|---|---|
| memory | 11 | now |
| tasks | 8 | now |
| app-identity | 6 | now |
| imessage | 3 | now |
| device-google | 7 | now |
| turn-day-cards | 24 | draft; rebases after W2 (dispatcher, time budget, OpenAI provider, day cards, episodes) merges |
| health-context | 23 | draft; rebases after W3 (context composer, health context, sanitiser, health tools) merges |
| delivery-proactive | 18 | draft; rebases after W4 (outbox, Expo push, WhatsApp delivery) merges |

`WALDO_TOOL_SEARCH` (c) is deleted in the turn-day-cards batch, with `WALDO_TOOL_LOADER`.

Some (a) switches need a production prerequisite before the production block runs them; those are listed in
[PRODUCTION_DRIFT_2026-11-23.md](PRODUCTION_DRIFT_2026-11-23.md). In staging they are already met.

## Snapshot at c6e50555

| Switch | Staging | Production | Read in (`packages/runtime/src`, besides the env type) | Disposition | Batch, or reason and removal date |
|---|---|---|---|---|---|
| `APP_AGREEMENTS` | `1` | `0` | `identity/open-signup.ts`, `onboarding/consent-ledger.ts` | (a) unconditional | app-identity |
| `APP_CHAT_ATTACHMENTS` | `1` | `0` | `channels/app-api.ts`, `channels/console-chat.ts`, `channels/owner-do.ts` | (a) unconditional | app-identity |
| `APP_ID_TOKEN_SIGNIN` | `1` | `0` | `channels/app-api.ts` | (a) unconditional | app-identity |
| `CONSOLE_HARNESS` | `1` | `0` | `channels/dashboard-harness.ts`, `channels/owner-do.ts` | (a) unconditional | app-identity |
| `WALDO_COST_LEDGER_SYNC` | `on` | `off` | `identity/open-signup.ts`, `observability/cost-rollup.ts`, `llm/cost-ledger.ts`, `channels/console-admin.ts` | (a) unconditional | app-identity |
| `WELCOME_V2` | `1` | `0` | `channels/owner-do.ts`, `onboarding/findings.ts`, `onboarding/welcome-sources.ts` | (a) unconditional | app-identity |
| `CALENDAR_GROUNDED_PREP` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `EVENT_PUSH` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `GOOGLE_REALTIME_TRIAGE` | `1` | `0` | `channels/watch-upkeep.ts`, `channels/calendar-watches.ts`, `channels/calendar-push.ts`, `channels/gmail-watches.ts`, `channels/update-sweep.ts`, `channels/owner-do.ts`, `channels/calendar-set.ts`, `prompt/update-cards.ts` | (a) unconditional | delivery-proactive (after W4) |
| `HELD_RAISE` | `1` | `0` | `channels/update-sweep.ts`, `channels/owner-do.ts`, `channels/update-cards.ts` | (a) unconditional | delivery-proactive (after W4) |
| `MAIL_SOURCE_FOLLOWUPS` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `OWNER_SURFACE_DEFAULT` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `PREP_PUSH_NAMES` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `PROACTIVE_BOTH_DEFAULT` | `1` | `0` | `channels/app-onboarding.ts`, `channels/proactive-surface.ts`, `channels/app-controls.ts` | (a) unconditional | delivery-proactive (after W4) |
| `PROACTIVE_GATE` | `1` | `0` | `channels/expo-push.ts`, `channels/heartbeat.ts`, `channels/update-sweep.ts`, `channels/owner-do.ts`, `channels/loops.ts` | (a) unconditional | delivery-proactive (after W4) |
| `PROACTIVE_OVER_TELEGRAM` | `1` | `0` | `channels/proactive-surface.ts`, `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `REENGAGE_PROACTIVE` | `1` | `0` | `channels/whatsapp-window.ts`, `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `SEPARATE_TOGGLES` | `1` | `0` | `channels/schedule-preferences.ts`, `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `UPDATE_PUSH_NAMES` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `WALDO_DAY_STATE` | `1` | `0` | `channels/owner-do.ts`, `channels/calendar-set.ts` | (a) unconditional | delivery-proactive (after W4) |
| `WHATSAPP_LIST_CARDS` | `1` | `0` | `channels/whatsapp-api.ts`, `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `WHATSAPP_REPLY_BUTTONS` | `1` | `0` | `channels/whatsapp-api.ts`, `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `WHATSAPP_REPLY_MERGE` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `WHATSAPP_STOP` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | delivery-proactive (after W4) |
| `ARRIVAL_LOOK` | `1` | `0` | `channels/app-api.ts`, `channels/app-device-context.ts`, `channels/owner-do.ts` | (a) unconditional | device-google |
| `CALENDAR_UNDO_CANCEL` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | device-google |
| `DEVICE_CALENDAR` | `1` | `0` | `channels/device-calendar.ts`, `channels/app-api.ts`, `channels/update-sweep.ts`, `channels/owner-do.ts`, `tools/live/phone-calendar.ts`, `contracts:app/device-context.ts`, `contracts:tools/schemas/reads.ts`, `contracts:tools/permissions.ts` | (a) unconditional | device-google |
| `DEVICE_PLACE` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts`, `tools/live/weather.ts`, `contracts:app/device-context.ts`, `contracts:tools/permissions.ts` | (a) unconditional | device-google |
| `DEVICE_WEATHER` | `1` | `0` | `tools/live/weather.ts`, `contracts:tools/permissions.ts` | (a) unconditional | device-google |
| `DRIVE_READS` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | device-google |
| `MCP_READ_INTENTS` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | device-google |
| `HEALTH_ACTIONS` | `1` | `0` | `skills/curated-owner.ts`, `channels/owner-do.ts`, `health/trigger.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_CHARTS` | `1` | `0` | `channels/owner-do.ts`, `contracts:tools/permissions.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_COACHING` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_DAY_LOAD` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_EASE_WORKOUT` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_INVENTORY` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_PARTIAL_CONTEXT` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_PASSIVE_LOAD` | `apple,health_connect` | `0` | `channels/app-api.ts`, `channels/app-health.ts`, `channels/owner-do.ts`, `health/producer.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_PROVISIONAL_SCORES` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts`, `health/scores/index.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_SCORE_PARTS` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_SOLO_NOTICE` | `1` | `0` | `channels/owner-do.ts`, `health/trigger.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_STRESS_CURVE` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_TRAINING_LOAD` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `HEALTH_USUAL` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `SCREEN_TIME` | `1` | `0` | `channels/app-api.ts`, `channels/owner-do.ts`, `contracts:tools/permissions.ts` | (a) unconditional | health-context (after W3) |
| `WALDO_CALL_CEILINGS` | `1` | `0` | `llm/owner-routes.ts`, `channels/owner-do.ts`, `conversation/context-budget.ts`, `conversation/compaction.ts` | (a) unconditional | health-context (after W3) |
| `WALDO_COMPACTION` | `on` | `off` | `channels/owner-do.ts`, `conversation/compaction.ts` | (a) unconditional | health-context (after W3) |
| `WALDO_COMPACTION_WAKE` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `WALDO_CONTEXT_CAPS` | `1` | `0` | `llm/owner-routes.ts`, `channels/owner-do.ts`, `conversation/context-budget.ts` | (a) unconditional | health-context (after W3) |
| `WALDO_STEPPED_WINDOW` | `1` | `0` | `conversation/context-budget.ts`, `conversation/compaction.ts` | (a) unconditional | health-context (after W3) |
| `WALDO_TIMEZONE_ASK` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | health-context (after W3) |
| `WHATS_NEW` | `1` | `0` | `channels/owner-do.ts`, `conversation/context-budget.ts` | (a) unconditional | health-context (after W3) |
| `WORKOUT_WAKE` | `1` | `0` | `channels/app-api.ts`, `channels/app-health.ts`, `channels/owner-do.ts`, `health/providers/whoop-owner.ts`, `health/wake-notice.ts`, `health/wakes.ts`, `health/zone-change-route.ts` | (a) unconditional | health-context (after W3) |
| `IMESSAGE_MEDIA` | `1` | `0` | `channels/imessage/bridge-do.ts`, `channels/imessage/console.ts`, `channels/imessage/owner-runtime.ts`, `contracts:runtime/surface-capabilities.ts` | (a) unconditional | imessage |
| `IMESSAGE_STOP` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | imessage |
| `IMESSAGE_VOICE` | `1` | `0` | `channels/imessage/bridge-do.ts`, `channels/imessage/photon-media.ts`, `channels/imessage/console.ts`, `channels/imessage/owner-runtime.ts`, `contracts:runtime/surface-capabilities.ts` | (a) unconditional | imessage |
| `MEMORY_CLAIM_CONTROLS` | `1` | `0` | `channels/app-controls.ts`, `channels/owner-do.ts` | (a) unconditional | memory |
| `MEMORY_DAYTIME_CONSOLIDATOR` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | memory |
| `MEMORY_NIGHTLY_SOURCE_UPDATES` | `1` | `0` | `channels/owner-do.ts`, `channels/nightly-sources.ts` | (a) unconditional | memory |
| `MEMORY_SELECTION` | `1` | `0` | `channels/owner-do.ts`, `memory/select-memory.ts` | (a) unconditional | memory |
| `MEMORY_SEMANTIC_RECALL` | `1` | `0` | `channels/owner-do.ts`, `memory/semantic-recall.ts` | (a) unconditional | memory |
| `MEMORY_USED_SHOWN` | `1` | `0` | `channels/owner-turn.ts`, `channels/owner-do.ts` | (a) unconditional | memory |
| `MEMORY_VALIDITY` | `1` | `0` | `channels/owner-do.ts`, `tools/live/memory.ts`, `memory/turn-recall.ts`, `memory/claims.ts` | (a) unconditional | memory |
| `OWNER_PROFILE` | `1` | `0` | `channels/owner-do.ts`, `memory/owner-profile.ts` | (a) unconditional | memory |
| `PEOPLE_MAP` | `1` | `0` | `channels/app-controls.ts`, `channels/owner-do.ts`, `channels/nightly-sources.ts`, `tools/live/memory.ts` | (a) unconditional | memory |
| `WALDO_FORGET_BARRIER` | `on` | `off` | `channels/owner-do.ts` | (a) unconditional | memory |
| `WALDO_RECALL_CHAIN` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | memory |
| `WALDO_ASYNC_TOOLS` | `1` | `0` | `channels/owner-browser-runtime.ts`, `channels/async-tools.ts`, `channels/owner-do.ts`, `prompt/messaging-behavior.ts`, `tools/records.ts` | (a) unconditional | tasks |
| `WALDO_FILE_TOOLS` | `1` | `0` | `channels/agent-mail/turn.ts`, `channels/imessage/bridge-do.ts`, `channels/imessage/photon-media.ts`, `channels/imessage/owner-runtime.ts`, `channels/upload-keeper.ts`, `channels/owner-do.ts`, `channels/telegram-media.ts`, `tools/live/workspace.ts`, `contracts:tools/permissions.ts` | (a) unconditional | tasks |
| `WALDO_JOB_OUTCOME_ROWS` | `1` | `0` | `conversation/job-outcome.ts` | (a) unconditional | tasks |
| `WALDO_TASK_ASK` | `1` | `0` | `tasks/asks.ts`, `tasks/brain.ts`, `tasks/lane.ts`, `channels/owner-do.ts` | (a) unconditional | tasks |
| `WALDO_TASK_NOTES` | `1` | `0` | `tasks/machine.ts`, `tasks/lane.ts`, `channels/owner-do.ts` | (a) unconditional | tasks |
| `WALDO_TASK_PICKUP` | `1` | `0` | `tasks/lane.ts`, `channels/owner-turn.ts`, `channels/owner-do.ts` | (a) unconditional | tasks |
| `WALDO_TASK_STEER` | `1` | `0` | `tasks/tools.ts`, `channels/owner-do.ts`, `contracts:tools/permissions.ts` | (a) unconditional | tasks |
| `WALDO_WATCHDOG` | `1` | `0` | `tasks/brain.ts`, `tasks/watchdog.ts`, `channels/owner-do.ts` | (a) unconditional | tasks |
| `BLOCK_LIFECYCLE` | `1` | `0` | `channels/capacity.ts`, `channels/update-sweep.ts`, `channels/waldo-blocks.ts`, `channels/owner-do.ts`, `prompt/capacity.ts`, `prompt/day-shaping.ts` | (a) unconditional | turn-day-cards (after W2) |
| `BRIEF_BODY_REVISION` | `1` | `0` | `channels/brief-revision.ts`, `channels/owner-do.ts` | (a) unconditional | turn-day-cards (after W2) |
| `BRIEF_DAY_PLAN` | `1` | `0` | `channels/owner-do.ts`, `prompt/day-cards.ts` | (a) unconditional | turn-day-cards (after W2) |
| `CALENDAR_COVERAGE` | `1` | `0` | `skills/curated-owner.ts`, `channels/coverage.ts`, `channels/owner-do.ts`, `prompt/day-shaping.ts`, `prompt/update-cards.ts` | (a) unconditional | turn-day-cards (after W2) |
| `CALENDAR_PLAN` | `1` | `0` | `channels/owner-do.ts`, `prompt/day-cards.ts`, `tools/live/google.ts`, `contracts:tools/permissions.ts` | (a) unconditional | turn-day-cards (after W2) |
| `CAPACITY_BUDGET` | `1` | `0` | `channels/capacity.ts`, `channels/owner-do.ts`, `prompt/capacity.ts` | (a) unconditional | turn-day-cards (after W2) |
| `CAPACITY_PLAN` | `1` | `0` | `channels/capacity.ts`, `channels/owner-turn-envelope.ts`, `channels/owner-do.ts`, `prompt/day-cards.ts`, `prompt/capacity.ts`, `prompt/day-shaping.ts` | (a) unconditional | turn-day-cards (after W2) |
| `FREE_WINDOW_OFFERS` | `1` | `0` | `skills/curated-owner.ts`, `channels/approvals.ts`, `channels/owner-do.ts`, `prompt/day-shaping.ts`, `prompt/update-cards.ts` | (a) unconditional | turn-day-cards (after W2) |
| `NEXT_DUE_ALARM` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | turn-day-cards (after W2) |
| `PLANNING_BRIEF` | `1` | `0` | `channels/owner-do.ts`, `prompt/day-cards.ts` | (a) unconditional | turn-day-cards (after W2) |
| `PROACTIVE_ACT_AHEAD` | `1` | `0` | `channels/update-sweep.ts`, `channels/owner-do.ts`, `prompt/day-cards.ts`, `prompt/machine-jobs.ts`, `prompt/update-cards.ts` | (a) unconditional | turn-day-cards (after W2) |
| `PROACTIVE_INTERVENTIONS` | `1` | `0` | `tasks/jobs.ts`, `channels/interventions.ts`, `channels/owner-do.ts`, `prompt/machine-jobs.ts` | (a) unconditional | turn-day-cards (after W2) |
| `TOMORROW_TODAY` | `1` | `0` | `channels/owner-do.ts`, `prompt/day-cards.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WAKE_BRIEF` | `1` | `0` | `channels/app-api.ts`, `channels/day-cards.ts`, `channels/app-health.ts`, `channels/owner-do.ts`, `channels/console.ts`, `prompt/day-cards.ts`, `health/providers/whoop-owner.ts`, `health/wake-notice.ts`, `health/zone-change-route.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_LEAN_SCHEDULED` | `1` | `0` | `channels/owner-turn.ts`, `channels/owner-turn-envelope.ts`, `channels/owner-do.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_ONE_TIMELINE` | `1` | `0` | `conversation/one-timeline.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_OWNER_FIRST` | `1` | `0` | `channels/owner-first.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_PROMPT_V2` | `1` | `0` | `llm/owner-routes.ts`, `channels/owner-do.ts`, `prompt/messaging-behavior.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_SECOND_MESSAGE` | `1` | `0` | `channels/second-message.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_STREAM_REPLIES` | `on` | `off` | `channels/owner-do.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_STRONG_ROLES` | `1` | `0` | `tasks/worker-do.ts`, `tasks/worker-loop.ts`, `llm/owner-routes.ts`, `channels/owner-turn.ts`, `channels/owner-turn-envelope.ts`, `channels/owner-do.ts`, `contracts:model/roster.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_THINKING_REPLAY` | `1` | `0` | `tasks/worker-do.ts`, `llm/owner-routes.ts`, `llm/anthropic.ts`, `channels/owner-do.ts`, `conversation/tool-loop.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WALDO_TOOL_LOADER` | `harness` | `off` | `channels/owner-do.ts` | (a) unconditional | turn-day-cards (after W2) |
| `WHY_TRAIL` | `1` | `0` | `channels/owner-do.ts` | (a) unconditional | turn-day-cards (after W2) |
| `AGENT_MAIL_INBOUND` | `1` | `0` | `index.ts`, `channels/agent-mail/controls.ts`, `channels/agent-mail/ingress.ts`, `channels/agent-mail/send.ts`, `channels/agent-mail/rules.ts` | (b) kept | egress: Waldo's own mail address; production binds no sender and has no AGENT_MAIL_DOMAIN yet Remove by 2027-01-31. |
| `AGENT_MAIL_SEND` | `1` | `0` | `index.ts`, `channels/agent-mail/send.ts` | (b) kept | egress: Waldo's own mail address; production binds no sender and has no AGENT_MAIL_DOMAIN yet Remove by 2027-01-31. |
| `APPROVE_IN_CHAT` | `1` | `0` | `channels/approvals.ts`, `channels/owner-do.ts` | (b) kept | authority: acts without a card; stays a per-environment decision until production autonomy is ruled (ADR-0018 amendment) Remove by 2027-01-31. |
| `AUTONOMOUS_BY_DEFAULT` | `1` | `0` | `channels/approvals.ts`, `channels/owner-do.ts`, `channels/approval-step-up.ts`, `channels/act-without-asking.ts` | (b) kept | authority: acts without a card; stays a per-environment decision until production autonomy is ruled (ADR-0018 amendment) Remove by 2027-01-31. |
| `AUTONOMY_OWNER_TURNS` | `1` | `0` | `channels/approvals.ts`, `channels/owner-do.ts` | (b) kept | authority: acts without a card; stays a per-environment decision until production autonomy is ruled (ADR-0018 amendment) Remove by 2027-01-31. |
| `AUTONOMY_OWN_CALENDAR` | `1` | `0` | `channels/owner-do.ts` | (b) kept | authority: acts without a card; stays a per-environment decision until production autonomy is ruled (ADR-0018 amendment) Remove by 2027-01-31. |
| `BROWSER_FORM_SUBMIT` | `1` | `0` | `channels/owner-browser-runtime.ts`, `channels/owner-do.ts` | (b) kept | egress and authority: submits a form to a third-party site from the owner's browser Remove by 2027-01-31. |
| `CONSOLE_GOOGLE_SIGNIN` | `0` | `0` | `channels/console-signin.ts` | (b) kept | unfinished: off everywhere; needs the callback on Supabase's redirect allow list Remove by 2026-12-31. |
| `HEALTH_FORM_CURVE` | `0` | `0` | `channels/app-api.ts`, `channels/owner-do.ts` | (b) kept | unfinished: off everywhere; Form curve not yet accepted Remove by 2026-12-31. |
| `HISTORY_ARCHIVE` | `dry` | `0` | `history/archive.ts`, `channels/owner-do.ts` | (b) kept | unfinished: "dry" only counts; moving history needs a reviewed live run Remove by 2026-12-31. |
| `IMESSAGE_CONNECTOR_ENABLED` | `1` | `0` | `index.ts`, `channels/imessage/bridge-do.ts` | (b) kept | egress: iMessage relay; production has no Photon project or connector policy yet Remove by 2027-01-31. |
| `LANGFUSE_RETENTION_SWEEP` | `dry` | `0` | `index.ts`, `observability/langfuse-retention.ts` | (b) kept | unfinished: "dry" only counts; deletes in Langfuse need a reviewed live run Remove by 2026-12-31. |
| `MEDICATIONS` | `1` | `0` | `channels/owner-do.ts`, `contracts:tools/permissions.ts` | (b) kept | safety: medicine reminders stay off where no code-level dosing check exists (HEY-297) Remove by 2026-12-31. |
| `MEMORY_OUTSIDE_NOTES` | `0` | `0` | `channels/owner-do.ts`, `memory/semantic-recall.ts` | (b) kept | unfinished: off everywhere until the owner rules how widely a recalled outside note marks a turn Remove by 2026-12-31. |
| `ONBOARDING_LOOKUP` | `1` | `0` | `channels/owner-do.ts` | (b) kept | egress and privacy: looks the owner up on the web; production waits for the published privacy notice that discloses it Remove by 2027-01-31. |
| `OPEN_SIGNUP` | `1` | `0` | `identity/open-signup.ts`, `identity/open-owner-hold.ts`, `channels/console-signin.ts` | (b) kept | authority and spend: lets strangers create owners; on only where the cohort and spend caps are ruled Remove by 2027-01-31. |
| `OWNER_LOOKUP` | `1` | `0` | `onboarding/consent-ledger.ts` | (b) kept | egress and privacy: looks the owner up on the web; production waits for the published privacy notice that discloses it Remove by 2027-01-31. |
| `PHONE_SMS_VERIFY` | `1` | `0` | `identity/phone-sms.ts` | (b) kept | egress and spend: texts real phones through Twilio; production Twilio setup is a runbook step Remove by 2027-01-31. |
| `WALDO_IMESSAGE_PROGRESS` | `0` | `0` | `channels/owner-do.ts` | (b) kept | unfinished: progress notes are off everywhere ("0"); ship or delete Remove by 2026-12-31. |
| `WALDO_LIGHT_CHAT` | `0` | `0` | `tasks/worker-loop.ts`, `llm/owner-routes.ts`, `channels/owner-turn.ts`, `channels/async-tools.ts` | (b) kept | unfinished: off everywhere; the light chat step has no accepted eval Remove by 2026-12-31. |
| `WALDO_TOOL_SEARCH` | `off` | `off` | `channels/owner-do.ts` | (c) delete | off everywhere and superseded by WALDO_TOOL_LOADER "harness"; delete with the loader batch |
| `EVENT_PUSH_PER_DAY` | `3` | `3` | `channels/expo-push.ts`, `channels/owner-do.ts` | knob | tuning value, not a behaviour switch |
| `OPEN_SIGNUP_DAILY_CAP` | `10` | `10` | `identity/open-signup.ts` | knob | tuning value, not a behaviour switch |
| `OPEN_SIGNUP_SPEND_CEILING_USD` | `50` | `5` | `identity/open-signup.ts` | knob | tuning value, not a behaviour switch |
| `OPEN_SIGNUP_TOTAL_CAP` | `80` | `80` | `identity/open-signup.ts` | knob | tuning value, not a behaviour switch |
| `OWNER_SPEND_CEILING_USD` | `50` | `25` | `llm/cost-ledger.ts` | knob | tuning value, not a behaviour switch |
| `PHONE_SMS_COUNTRIES` | `+91` | `+91` | `identity/phone-sms.ts` | knob | tuning value, not a behaviour switch |
| `PHONE_SMS_DAILY_LIMIT` | `20` | `20` | `identity/phone-sms.ts` | knob | tuning value, not a behaviour switch |
| `PROACTIVE_GAP_MIN` | `60` | `60` | `channels/interruptions.ts` | knob | tuning value, not a behaviour switch |
| `PROACTIVE_INTERRUPTS_PER_DAY` | `2` | `2` | `channels/interruptions.ts` | knob | tuning value, not a behaviour switch |
| `PROACTIVE_REVIEW_EVERY_MIN` | `90` | `90` | `channels/owner-do.ts` | knob | tuning value, not a behaviour switch |
| `PROACTIVE_URGENT_PER_DAY` | `1` | `1` | `channels/interruptions.ts` | knob | tuning value, not a behaviour switch |
| `WAKE_BRIEF_FRESH_MIN` | `180` | `180` | `channels/app-api.ts`, `channels/owner-do.ts` | knob | tuning value, not a behaviour switch |
| `WAKE_BRIEF_TURNS_PER_DAY` | `3` | `3` | `channels/owner-do.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_CHAT_CEILING_TOKENS` | `57143` | `57143` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_HARD_CEILING_TOKENS` | `114286` | `114286` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_HISTORY_BUDGET_TOKENS` | `31429` | `31429` | `conversation/context-budget.ts`, `conversation/compaction.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_JOB_CEILING_TOKENS` | `35714` | `35714` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_QUESTS_CHARS` | `3000` | `3000` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_STANDING_ORDERS_CHARS` | `3000` | `3000` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_STEPPED_WINDOW_TARGET` | `0.5` | `0.5` | `conversation/context-budget.ts`, `conversation/compaction.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_TOOL_RESULTS_CLEAR_AT_CHARS` | `120000` | `120000` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_TOOL_RESULTS_KEEP_LATEST` | `3` | `3` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WALDO_WHATS_NEW_CHARS` | `1200` | `1200` | `conversation/context-budget.ts` | knob | tuning value, not a behaviour switch |
| `WHATSAPP_QUIET_MS` | `3000` | `3000` | `channels/owner-do.ts` | knob | tuning value, not a behaviour switch |
