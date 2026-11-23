# Production drift, 23 November 2026

What production (the top level of `packages/runtime/wrangler.jsonc`) runs differently from staging (`env.staging`) at
`c6e50555`, and a keep or align recommendation for each. Production has no Worker deployed and the app's bootstrap accepts
staging origins only, so nothing here changes what any owner sees today. It decides what production runs when the cohort
moves.

**Default:** production runs staging's behaviour, except the staging-only exceptions `CLAUDE.md` says never reach
production (Langfuse text capture, `WHATSAPP_DEBUG_LOG`), anything unsafe there (`WALDO_EGRESS_ALLOWLIST` `*`, medicines
without a code-level dosing check, HEY-297), and anything whose production prerequisite does not exist yet.

Counts: 117 of 145 switches differ (100 marked unconditional in [SWITCH_INVENTORY.md](SWITCH_INVENTORY.md), 15 kept, 2
knobs); 20 of 24 flat vars differ. Bindings that differ are in the
[production runbook](PRODUCTION_ALPHA_RUNBOOK_2026-10-22.md) §1.1 and are not repeated here, except the two below.

Prerequisites that are migrations are met by construction: production stands up from zero and applies every committed
migration (`node scripts/production-alpha-dryrun.mjs`, "migrations from zero").

## Owner rulings needed

| # | Item | Staging | Production | Recommendation |
|---|---|---|---|---|
| R1 | `WALDO_MODEL_PROVIDER` | `anthropic` | `openai` | Align, once production's `ANTHROPIC_API_KEY` passes a live owner turn and `BRAVE_SEARCH_API_KEY` is set (runbook §1.2). Until then the config value is moot: a provider without its key yields to the one that has it. |
| R2 | `CALENDAR_GROUNDED_PREP`, `DRIVE_READS`, `MAIL_SOURCE_FOLLOWUPS`, `MCP_READ_INTENTS` (runbook decision D6) | `1` | `0` | Align. They are marked unconditional, so the code batch that removes them also decides production. |
| R3 | `PREP_PUSH_NAMES`, `UPDATE_PUSH_NAMES` | `1` | `0` | Align once the privacy notice row that lets a push name an event is live in production. Marked unconditional; same note as R2. |
| R4 | `APP_AGREEMENTS` | `1` | `0` | Align once the owner has approved the version 1 terms and privacy notice for production. Marked unconditional; same note as R2. |
| R5 | `AUTONOMOUS_BY_DEFAULT`, `AUTONOMY_OWNER_TURNS`, `AUTONOMY_OWN_CALENDAR`, `APPROVE_IN_CHAT` | `1` | `0` | Align (staging behaviour), as kept switches until the authority ruling for the cohort. Acting without a card is the owner's call per environment. |
| R6 | `OPEN_SIGNUP` | `1` | `0` | Keep `0` until the cohort's admission is ruled; the caps and spend ceilings below apply once it is on. |
| R7 | `OPEN_SIGNUP_SPEND_CEILING_USD`, `OWNER_SPEND_CEILING_USD` | `50`, `50` | `5`, `25` | Keep production's lower values; staging raised them for testing on 9 November. Money is the owner's call. |
| R8 | `OWNER_LOOKUP`, `ONBOARDING_LOOKUP` | `1` | `0` | Keep `0` until the privacy notice that discloses the look-up is published. |
| R9 | `MEMORY_SEMANTIC_RECALL` (unconditional) and the `AI` binding | on, `AI` bound | off, no `AI` | Align the switch; it is inert without `AI`, which production does not bind. Whether production binds Workers AI (memory text to the embedder, same account) is a ruling. The runbook's "no source file reads them" is stale: `memory/semantic-recall.ts` reads `AI`. |
| R10 | `BROWSER_FORM_SUBMIT` | `1` | `0` | Keep `0`: production binds no browser by ruling, so the switch would be inert, and a form submit is third-party egress. |
| R11 | Kept switches' removal dates | | | Confirm or move the dates in `switch-inventory.json`. |

## Keep, no ruling needed

| Item | Staging | Production | Why |
|---|---|---|---|
| `LANGFUSE_CAPTURE_TEXT` | `true` | `false` | Staging-only owner exception; code forces it off in production. |
| `WHATSAPP_DEBUG_LOG` | `false` | `false` | No drift; staging-only exception, code-enforced. |
| `WALDO_EGRESS_ALLOWLIST` | `*` | `""` | Open web is unsafe in production; empty fails closed. A named production allowlist is runbook D6. |
| `MEDICATIONS` | `1` | `0` | No code-level dosing check yet (HEY-297). |
| `PHONE_SMS_VERIFY` | `1` | `0` | Twilio preconditions, runbook §1.2.1. |
| `IMESSAGE_CONNECTOR_ENABLED` and the iMessage vars, `PHOTON_PROJECT_ID` | set | off, empty | No production host Mac or Apple Account (runbook D5). |
| `AGENT_MAIL_INBOUND`, `AGENT_MAIL_SEND`, `AGENT_MAIL_DOMAIN`, `AGENT_MAIL_ZONE_ID` | on, set | off, empty | Production binds no sender; the privacy paragraph is not live. |
| WhatsApp number, templates, onboarding URL | set | empty | No production number yet (runbook D5). |
| `GMAIL_PUSH_PROJECT` | `waldo-dev-492217` | `""` | No production Cloud project topic yet (runbook S7). |
| `WALDO_MCP_SERVERS` | Google Workspace MCP | `[]` | Developer preview; runbook keeps `[]` for the alpha. |
| `WALDO_PUBLIC_ORIGIN`, `WALDO_OWNER_DO_NAMESPACE`, `WALDO_OWNER_TELEGRAM_ID`, `WALDO_ENVIRONMENT` | staging values | production values | Identity; set per environment at stand-up (runbook S5, S6). |

## Align

| Item | Staging | Production | Note |
|---|---|---|---|
| The 100 unconditional switches | on | off | Each code batch makes its switches unconditional in both environments, so production gets the behaviour with the code and the tests of that area. The config is not flipped ahead of the code: the test pool runs the production block, and hundreds of owner-object tests were written against every switch off. R2, R3 and R4 are among them. |
| `LANGFUSE_RETENTION_SWEEP`, `HISTORY_ARCHIVE` | `dry` | `0` | `dry` counts and changes nothing. |
| `WALDO_COST_LEDGER_SYNC` | `on` | `off` | Without it the spend ceilings are inert (runbook S9). Unconditional. |
| `WALDO_TOOL_LOADER` | `harness` | `off` | Unconditional. |
| Retention cron `17 3 * * *` | set | none | Without it raw health is never swept on schedule (runbook P3). |
| `limits.cpu_ms` 300000 | set | default | Long owner turns pass 30 s (runbook P3). |

The unconditional switches that differ, by batch:

| Batch | Count | Switches |
|---|---|---|
| delivery-proactive (after W4) | 18 | `CALENDAR_GROUNDED_PREP`, `EVENT_PUSH`, `GOOGLE_REALTIME_TRIAGE`, `HELD_RAISE`, `MAIL_SOURCE_FOLLOWUPS`, `OWNER_SURFACE_DEFAULT`, `PREP_PUSH_NAMES`, `PROACTIVE_BOTH_DEFAULT`, `PROACTIVE_GATE`, `PROACTIVE_OVER_TELEGRAM`, `REENGAGE_PROACTIVE`, `SEPARATE_TOGGLES`, `UPDATE_PUSH_NAMES`, `WALDO_DAY_STATE`, `WHATSAPP_LIST_CARDS`, `WHATSAPP_REPLY_BUTTONS`, `WHATSAPP_REPLY_MERGE`, `WHATSAPP_STOP` |
| device-google | 7 | `ARRIVAL_LOOK`, `CALENDAR_UNDO_CANCEL`, `DEVICE_CALENDAR`, `DEVICE_PLACE`, `DEVICE_WEATHER`, `DRIVE_READS`, `MCP_READ_INTENTS` |
| app-identity | 6 | `APP_AGREEMENTS`, `APP_CHAT_ATTACHMENTS`, `APP_ID_TOKEN_SIGNIN`, `CONSOLE_HARNESS`, `WALDO_COST_LEDGER_SYNC`, `WELCOME_V2` |
| memory | 11 | `MEMORY_CLAIM_CONTROLS`, `MEMORY_DAYTIME_CONSOLIDATOR`, `MEMORY_NIGHTLY_SOURCE_UPDATES`, `MEMORY_SELECTION`, `MEMORY_SEMANTIC_RECALL`, `MEMORY_USED_SHOWN`, `MEMORY_VALIDITY`, `OWNER_PROFILE`, `PEOPLE_MAP`, `WALDO_FORGET_BARRIER`, `WALDO_RECALL_CHAIN` |
| imessage | 3 | `IMESSAGE_MEDIA`, `IMESSAGE_STOP`, `IMESSAGE_VOICE` |
| tasks | 8 | `WALDO_ASYNC_TOOLS`, `WALDO_FILE_TOOLS`, `WALDO_JOB_OUTCOME_ROWS`, `WALDO_TASK_ASK`, `WALDO_TASK_NOTES`, `WALDO_TASK_PICKUP`, `WALDO_TASK_STEER`, `WALDO_WATCHDOG` |
| turn-day-cards (after W2) | 24 | `BLOCK_LIFECYCLE`, `BRIEF_BODY_REVISION`, `BRIEF_DAY_PLAN`, `CALENDAR_COVERAGE`, `CALENDAR_PLAN`, `CAPACITY_BUDGET`, `CAPACITY_PLAN`, `FREE_WINDOW_OFFERS`, `NEXT_DUE_ALARM`, `PLANNING_BRIEF`, `PROACTIVE_ACT_AHEAD`, `PROACTIVE_INTERVENTIONS`, `TOMORROW_TODAY`, `WAKE_BRIEF`, `WALDO_LEAN_SCHEDULED`, `WALDO_ONE_TIMELINE`, `WALDO_OWNER_FIRST`, `WALDO_PROMPT_V2`, `WALDO_SECOND_MESSAGE`, `WALDO_STREAM_REPLIES`, `WALDO_STRONG_ROLES`, `WALDO_THINKING_REPLAY`, `WALDO_TOOL_LOADER`, `WHY_TRAIL` |
| health-context (after W3) | 23 | `HEALTH_ACTIONS`, `HEALTH_CHARTS`, `HEALTH_COACHING`, `HEALTH_DAY_LOAD`, `HEALTH_EASE_WORKOUT`, `HEALTH_INVENTORY`, `HEALTH_PARTIAL_CONTEXT`, `HEALTH_PASSIVE_LOAD`, `HEALTH_PROVISIONAL_SCORES`, `HEALTH_SCORE_PARTS`, `HEALTH_SOLO_NOTICE`, `HEALTH_STRESS_CURVE`, `HEALTH_TRAINING_LOAD`, `HEALTH_USUAL`, `SCREEN_TIME`, `WALDO_CALL_CEILINGS`, `WALDO_COMPACTION`, `WALDO_COMPACTION_WAKE`, `WALDO_CONTEXT_CAPS`, `WALDO_STEPPED_WINDOW`, `WALDO_TIMEZONE_ASK`, `WHATS_NEW`, `WORKOUT_WAKE` |
