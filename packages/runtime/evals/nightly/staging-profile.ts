// WALDO_EVAL_PROFILE=staging: the eval runs the way the staging Worker's owner object builds a turn. The profile is a pure
// function of the `env.staging.vars` block of wrangler.jsonc, so a staging change reaches the eval with no second list to
// keep. Every variable in that block is classified here; a test goes red on one that is not, so a new flag that shapes
// turns cannot reach staging without the eval's owner deciding what to do about it.
import { readFileSync } from 'node:fs';
import { OWNER_MODELS, type ModelName } from '@waldo/contracts';
import { parseJsonc } from '../../../../scripts/jsonc.mjs';
import { flatVars } from '../../../../scripts/wrangler-vars.mjs';
import { compactionSettings, type CompactionSettings } from '../../src/conversation/compaction';
import type { ForgetBarrierMode } from '../../src/context-composer/forget-barrier';
import { modelProviderSetting } from '../../src/llm/owner-routes';

export type StagingVars = Readonly<Record<string, string>>;

// mapped: the profile reads the variable and sets the matching trial dependency.
// not_turn_shaping: the variable cannot change what the model is sent or what a turn does.
// known_gap: it can change a turn, and the eval does not model it. The reason says what the eval does instead.
export type VarClass = Readonly<{ kind: 'mapped' | 'not_turn_shaping' | 'known_gap'; why: string }>;

const mapped = (why: string): VarClass => ({ kind: 'mapped', why });
const inert = (why: string): VarClass => ({ kind: 'not_turn_shaping', why });
const gap = (why: string): VarClass => ({ kind: 'known_gap', why });

const IDENTITY = 'names or addresses this deployment';
const IMESSAGE = 'iMessage connector setup; the trial runs the app surface';
const WHATSAPP = 'WhatsApp surface setup; the trial runs the app surface';
const SYNTHETIC_TOOLS = 'the trial\'s tools are the synthetic handlers of world.ts, not the live registry';

export const STAGING_VAR_CLASSES: Readonly<Record<string, VarClass>> = {
  WALDO_MODEL_PROVIDER: mapped("the profile's chat model is that provider's; a live run refuses a Claude staging, since its judge is Claude"),
  WALDO_TOOL_LOADER: mapped("'harness' loads core tools up front and the rest through find_tools and use_tool"),
  WALDO_TOOL_SEARCH: mapped('provider tool search; the harness loader wins when both are set'),
  WALDO_TASK_ASK: gap('a background worker\'s held step raises its card and waits; the trial runs no background workers'),
  WALDO_TASK_STEER: gap('the owner\'s turn is offered steer_task to change a running background task; the trial runs no background workers'),
  WALDO_TASK_PICKUP: gap('a running owner turn is told when a background task finishes, and a report waits behind a card the owner can approve in words; the trial runs no background workers'),
  WALDO_TASK_NOTES: inert('background jobs that stop say so outside any turn, and a parked task retries once; the trial runs no background jobs'),
  WALDO_OWNER_FIRST: gap('owner messages take the chain before queued machine turns; the trial runs one owner turn at a time with no machine work queued'),
  WALDO_SECOND_MESSAGE: gap('a running owner turn is offered newer owner messages; the trial sends each step after the last one answered'),
  WALDO_ASYNC_TOOLS: gap('the owner turn holds no long tool and hands that work to start_task; the trial runs no task worker or report turn, so it keeps the long tools inline'),
  WALDO_ONE_TIMELINE: gap('the owner\'s WhatsApp turns share the app chat\'s chain; the trial runs the app surface only, so it never sees a WhatsApp turn in its history'),
  WALDO_JOB_OUTCOME_ROWS: gap('a background job stores a keyed stub in place of its prompt, so a later job turn on the same chain (the Close after the Brief) no longer reads the earlier job\'s prompt; app owner turns already did not, and the trial runs no job turn after another'),
  WALDO_LIGHT_CHAT: gap("the owner's reply takes a light step on the auxiliary model that answers quick chat or hands the turn to the chat model, and task workers run on the chat model; the profile's trials stay on the chat model, and the lc- scenarios run with it on"),
  WALDO_COMPACTION: mapped('the trial\'s chat runs on the canonical store with these compaction settings'),
  WALDO_STEPPED_WINDOW: mapped('the trial\'s chat history is windowed in steps under the same compaction settings'),
  WALDO_CONTEXT_CAPS: gap('caps the standing orders and quests a turn reads and clears tool results down to the latest few past a size (the context budget\'s settings); no trial holds that many orders or quests or runs that long a tool loop, so the trials read as they would with it on'),
  WALDO_COMPACTION_WAKE: inert('moves a compaction to its own alarm pass; what it summarises and what the next turn reads are the same'),
  WALDO_CALL_CEILINGS: mapped('the trial\'s chat history is held to the same budget; the hard ceiling on a turn\'s tool results is not modelled, and no trial\'s results come near it'),
  WALDO_HISTORY_BUDGET_TOKENS: mapped('the trial\'s chat history budget under WALDO_CALL_CEILINGS'),
  WALDO_STEPPED_WINDOW_TARGET: mapped('the share of the budget the trial\'s stepped window keeps at a cut'),
  WALDO_CHAT_CEILING_TOKENS: inert('only labels a reply call\'s trace against its class\'s ceiling'),
  WALDO_JOB_CEILING_TOKENS: inert('only labels a job call\'s trace against its class\'s ceiling'),
  WALDO_HARD_CEILING_TOKENS: gap('where a turn\'s earlier tool results clear under WALDO_CALL_CEILINGS; no trial\'s results come near it'),
  WALDO_TOOL_RESULTS_CLEAR_AT_CHARS: gap('where WALDO_CONTEXT_CAPS clears a turn\'s tool results; no trial runs that long a tool loop'),
  WALDO_TOOL_RESULTS_KEEP_LATEST: gap('how many results WALDO_CONTEXT_CAPS keeps when it clears; no trial runs that long a tool loop'),
  WALDO_STANDING_ORDERS_CHARS: gap('the WALDO_CONTEXT_CAPS cap on standing orders; no trial holds that many'),
  WALDO_QUESTS_CHARS: gap('the WALDO_CONTEXT_CAPS cap on quests; no trial holds that many'),
  WALDO_WHATS_NEW_CHARS: gap('the cap on an owner turn\'s what\'s new section; no trial holds announcements'),
  WALDO_TIMEZONE_ASK: gap('adds a line to a turn whose time zone the owner has not confirmed; every trial runs on a fixed zone, so no trial sees it'),
  WALDO_FORGET_BARRIER: mapped("'on' is the 'items' barrier, any other value the earlier 'reads' rule"),
  MEMORY_SELECTION: mapped("'1' shows the trials option B's memory: the pins, what is new since the nightly review, recall stubs"),
  MEMORY_SEMANTIC_RECALL: mapped("'1' runs the trials with semantic recall on, over the run's embedder"),

  WALDO_STREAM_REPLIES: gap('the trial calls respond directly and shows no streamed draft; streaming changes delivery, not the words [inference]'),
  CALENDAR_GROUNDED_PREP: gap('proactive prep jobs are not run; the eval runs the day cards as scenario steps'),
  WALDO_DAY_STATE: gap('the update sweep and its apply turn are not run in a trial'),
  GOOGLE_REALTIME_TRIAGE: gap('the sweep, its delta reads and watches are not run in a trial; the triage prompt runs as its own scenario step'),
  PROACTIVE_GATE: gap('the owner\'s interruption limits act on the update sweep and health trigger, which a trial does not run'),
  PROACTIVE_INTERRUPTS_PER_DAY: gap('the default daily budget for unasked messages; no trial runs an unasked message'),
  PROACTIVE_URGENT_PER_DAY: gap('the default urgent allowance past that budget; no trial runs an unasked message'),
  PROACTIVE_GAP_MIN: gap('the default gap between two unasked messages; no trial runs an unasked message'),
  PROACTIVE_OVER_TELEGRAM: gap('where unasked messages go for an owner still linked on Telegram; no trial runs an unasked message or a Telegram owner'),
  PROACTIVE_BOTH_DEFAULT: gap('where unasked messages go for an owner with WhatsApp bound; no trial runs an unasked message'),
  EVENT_PUSH: inert('the app push raised after an event notice reaches the app chat; no model turn runs for it'),
  EVENT_PUSH_PER_DAY: inert('the most event pushes in an owner\'s day; no model turn runs for them'),
  PROACTIVE_ACT_AHEAD: gap('the sweep worker and triage are not run in a trial, and the day-card cases run the Check-in and Close as before'),
  PROACTIVE_INTERVENTIONS: gap('Waldo\'s own look runs on the scheduler and the job lane, which a trial does not run; no case judges the look yet'),
  WHATS_NEW: gap('the what\'s new pass runs on the release wake and folds into day cards, neither of which a trial runs; with no announcement decided, an owner turn carries no what\'s new section'),
  PROACTIVE_REVIEW_EVERY_MIN: inert('how often the look is scheduled; a trial turn is not an alarm pass'),
  WAKE_BRIEF: gap('no trial uploads a night or runs the wake turn; the Brief cases run at their planned time; staging has it on'),
  WAKE_BRIEF_FRESH_MIN: inert('how fresh a night\'s end must be to count as a wake; no trial uploads a night'),
  WAKE_BRIEF_TURNS_PER_DAY: inert('caps the wake turns a day; no trial runs one'),
  WORKOUT_WAKE: gap('no trial uploads a finished workout; the health-trigger cases wake on their own reasons; staging has it on'),
  CALENDAR_PLAN: gap('no trial offers propose_calendar_plan or approves a day plan; staging has it on'),
  BRIEF_DAY_PLAN: gap('the Brief cases run without the time-blocked plan; no case judges it yet; staging has it on'),
  MAIL_SOURCE_FOLLOWUPS: gap('the mail follow-up sweep is not run in a trial'),
  DRIVE_READS: gap(SYNTHETIC_TOOLS),
  OWNER_LOOKUP: gap('the look-up consent gate is not modelled; the world offers the look-up tool directly'),
  OWNER_PROFILE: gap('the profile view is not rendered in a trial'),
  MCP_READ_INTENTS: gap(SYNTHETIC_TOOLS),
  WALDO_MCP_SERVERS: gap('the world seeds its own connected tool server'),
  WALDO_EGRESS_ALLOWLIST: gap('the world has no network, so the egress boundary is held by its own tests, not by a trial'),
  HEALTH_PROVISIONAL_SCORES: gap('the world serves synthetic health, not the provisional score computation'),
  HEALTH_SOLO_NOTICE: gap('the solo-owner health notice is not run in a trial'),
  CALENDAR_UNDO_CANCEL: gap('no trial undoes a cancel; staging has it on'),
  NEXT_DUE_ALARM: inert('decides only whether an owner alarm with nothing due runs its pass; a trial turn is not an alarm pass'),
  WHY_TRAIL: gap('no trial reads the steps behind a card; staging has it on'),
  AUTONOMY_OWN_CALENDAR: gap('no trial holds a standing grant, and this build creates none; staging has it on'),
  APPROVE_IN_CHAT: gap('no trial has the owner approve a shown card in words; staging has it on'),
  AUTONOMOUS_BY_DEFAULT: gap('the trial\'s tools are synthetic and raise no desk card, so an owner-asked run with no card is not modelled; staging has it on'),
  HEALTH_EASE_WORKOUT: gap('the world serves no workouts on the calendar; staging has it on'),
  HISTORY_ARCHIVE: gap('retention runs only past a hot table\'s cap, which a trial never reaches'),
  WALDO_PROMPT_V2: mapped("'1' sends the trials the behavior prompt's version 2"),
  WALDO_WATCHDOG: inert('the progress watchdog checks running background jobs; the trial runs no background jobs'),
  PLANNING_BRIEF: gap('the Brief cases run the recap Brief; no case judges a planning Brief yet; staging has it on'),
  OWNER_SURFACE_DEFAULT: inert('where a notice outside any turn goes and which surface the console and harness commands open on; each trial turn names its own surface'),
  APP_CHAT_ATTACHMENTS: gap('an app message may carry one voice note, photo or file through the shared media reader; the trial sends words only'),
  CONSOLE_HARNESS: inert('diagnostics, and for admins /fire and /langfuse, in the owner\'s console; the trial runs no console'),
  WHATSAPP_STOP: inert('a typed /stop on WhatsApp ends the running turn; the trial runs the app surface and sends no stop'),
  CAPACITY_PLAN: gap('the nightly capacity pass is not run in a trial; the cap- case runs the Close with a seeded capacity note'),
  TOMORROW_TODAY: gap('the Close cases run with the switch in their steps; a trial runs no approval of the cards it raises'),
  CAPACITY_BUDGET: gap('a trial turn does not read the staging vars for the Brief; the d6 case runs the planning Brief with a seeded capacity note and the week ahead'),
  WALDO_RECALL_CHAIN: gap('the trial\'s search_episodes runs without the recall chain, and its world keeps no runs, tasks or cards to link; test/recall-chain.test.ts measures it; staging has it on'),
  WALDO_FILE_TOOLS: gap('a trial turn carries no upload; the zip and meeting cases in the files nightly scenarios measure the tools, and test/upload-keeper.test.ts the keeping; staging has it on'),
  MEDICATIONS: gap('no trial tracks a medicine; staging has it off until the gate turns it on with migration 20261101040000'),
  BROWSER_FORM_SUBMIT: gap('no trial drives the owner browser to a form; staging has it on for the owner\'s Google Forms run'),
  HEALTH_CHARTS: gap('a trial turn has no app chat read to draw a chart in; test/show-health-chart.test.ts measures the tool and the live read; staging has it on'),
  PEOPLE_MAP: gap('the trial memory holds no people; test/people-map.test.ts measures the store, the reads and forgetting a person; staging has it on'),
  SCREEN_TIME: gap('the world serves no screen time and the trial offers no get_screen_time; staging has it on'),
  DEVICE_PLACE: gap('the world serves no device place and the trial offers no get_device_context; staging has it on'),
  DEVICE_CALENDAR: gap('the world serves no phone calendar and the trial offers no query_phone_calendar; staging has it on'),
  CALENDAR_COVERAGE: gap('the coverage facts read Google calendars over two weeks and the phone calendar, which a trial world does not serve; no case judges the coverage question yet'),
  FREE_WINDOW_OFFERS: gap('offers come from the update triage and the intervention look, which a trial does not run; no case judges a free-window offer yet'),
  BLOCK_LIFECYCLE: gap('Waldo\'s blocks come from the approval ledger and the update sweep, which a trial does not run; no case judges the block lifecycle yet'),
  DEVICE_WEATHER: gap('the world serves no weather and the trial offers no get_weather; staging has it on once the WeatherKit secrets are set'),
  ARRIVAL_LOOK: gap('the world serves no device place, so no phone arrives anywhere; staging has it on'),
  ONBOARDING_LOOKUP: gap('no trial runs onboarding or the background owner look-up; staging has it on'),
  WELCOME_V2: gap('one trial asks a single second-build stage (w1); the build\'s order, admission and caps are held by their own tests; staging has it on'),
  HEALTH_ACTIONS: gap('the health trigger\'s decision is not run in a trial; the trial\'s skill book always offers health-protocols, as staging does'),
  HEALTH_COACHING: gap('the trial offers no set_sleep_need, and the world serves synthetic health with no stated sleep need'),
  HEALTH_TRAINING_LOAD: gap('the world serves synthetic health, not the candidate training load the producer writes'),
  HEALTH_FORM_CURVE: inert('the measured Form curve is read only by the app\'s calendar day; no turn is sent it'),
  MEMORY_NIGHTLY_SOURCE_UPDATES: gap('the nightly memory pass is not run in a trial'),
  MEMORY_CLAIM_CONTROLS: inert('the app\'s claim controls (confirm, forget, dismiss, bring up less) are an app read; the trial runs no app controls'),
  MEMORY_VALIDITY: gap('the trial turns on recall of replaced facts and read_memory include_replaced, as staging has them; the nightly pass that retires a contradicted claim is not run in a trial'),
  MEMORY_USED_SHOWN: inert('the app shows which notes a reply looked at; the trial reads no app history'),
  MEMORY_DAYTIME_CONSOLIDATOR: gap('the daytime memory pass is not run in a trial'),
  WALDO_IMESSAGE_PROGRESS: gap('iMessage progress notes; the trial runs the app surface; staging has them off'),
  IMESSAGE_MEDIA: gap('iMessage media; the trial runs the app surface'),
  IMESSAGE_STOP: inert('a typed /stop on iMessage ends the running turn; the trial runs the app surface and sends no stop'),
  IMESSAGE_VOICE: gap('iMessage voice notes; the trial runs the app surface'),

  WALDO_ENVIRONMENT: inert('names the deployment'),
  PREP_PUSH_NAMES: inert('the app push text raised after a prep note is delivered; the model never sees it'),
  UPDATE_PUSH_NAMES: inert('the app push text raised after an update is delivered; the model never sees it'),
  REENGAGE_PROACTIVE: inert('which WhatsApp template knocks outside the window, and the app push for a copy it keeps; no model turn runs for it'),
  WALDO_PUBLIC_ORIGIN: inert(IDENTITY),
  WALDO_OWNER_DO_NAMESPACE: inert(IDENTITY),
  WALDO_RELEASE: inert('release stamp'),
  WALDO_OWNER_TELEGRAM_ID: inert(IDENTITY),
  APP_AGREEMENTS: inert('onboarding consent screens'),
  PHONE_SMS_VERIFY: inert('sign-up phone verification'),
  PHONE_SMS_COUNTRIES: inert('sign-up phone verification'),
  PHONE_SMS_DAILY_LIMIT: inert('sign-up phone verification'),
  CONSOLE_GOOGLE_SIGNIN: inert('console sign-in'),
  APP_ID_TOKEN_SIGNIN: inert('app sign-in'),
  OPEN_SIGNUP: inert('app sign-up without an invite'),
  OPEN_SIGNUP_DAILY_CAP: inert('app sign-up without an invite'),
  OPEN_SIGNUP_TOTAL_CAP: inert('app sign-up without an invite'),
  OPEN_SIGNUP_SPEND_CEILING_USD: inert('applies only to an owner who joined without an invite; the trial owner is invited'),
  OWNER_SPEND_CEILING_USD: inert('the trial keeps no month of spend, so no ceiling is reached'),
  GMAIL_PUSH_PROJECT: inert('mail push subscription'),
  LANGFUSE_CAPTURE_TEXT: inert('trace capture after a turn'),
  LANGFUSE_RETENTION_SWEEP: inert('the daily cron\'s trace retention sweep; no turn reads it'),
  IMESSAGE_CONNECTOR_ENABLED: inert(IMESSAGE),
  IMESSAGE_CONNECTOR_POLICY: inert(IMESSAGE),
  IMESSAGE_ONBOARDING_URL: inert(IMESSAGE),
  IMESSAGE_WALDO_ADDRESS: inert(IMESSAGE),
  PHOTON_PROJECT_ID: inert(IMESSAGE),
  WHATSAPP_REENGAGE_TEMPLATE: inert(WHATSAPP),
  WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: inert(WHATSAPP),
  WHATSAPP_REPLY_BUTTONS: inert(WHATSAPP),
  WHATSAPP_LIST_CARDS: inert(WHATSAPP),
  WHATSAPP_PROACTIVE_TEMPLATE: inert(WHATSAPP),
  WHATSAPP_PROACTIVE_TEMPLATE_LANGUAGE: inert(WHATSAPP),
  WHATSAPP_ONBOARDING_URL: inert(WHATSAPP),
  WHATSAPP_WALDO_NUMBER: inert(WHATSAPP),
  WHATSAPP_DEBUG_LOG: inert(WHATSAPP),
  WHATSAPP_REPLY_MERGE: inert(WHATSAPP),
  WHATSAPP_QUIET_MS: inert(WHATSAPP),
  WALDO_COST_LEDGER_SYNC: inert('cost ledger sync after a turn'),
  AGENT_MAIL_INBOUND: inert('inbound agent mail ingress'),
  AGENT_MAIL_DOMAIN: inert('inbound agent mail ingress'),
  AGENT_MAIL_ZONE_ID: inert('agent mail routing rules'),
  AGENT_MAIL_SEND: inert('agent mail sending'),
};

export const unclassifiedVars = (vars: StagingVars): readonly string[] => Object.keys(vars).filter((name) => !(name in STAGING_VAR_CLASSES)).sort();
export const staleClasses = (vars: StagingVars): readonly string[] => Object.keys(STAGING_VAR_CLASSES).filter((name) => !(name in vars)).sort();

export const readStagingVars = (path: URL = new URL('../../wrangler.jsonc', import.meta.url)): StagingVars => {
  const block = (parseJsonc(readFileSync(path, 'utf8')) as { env?: { staging?: { vars?: Record<string, unknown> } } }).env?.staging?.vars;
  if (!block) throw new Error('wrangler.jsonc has no env.staging.vars');
  const vars = flatVars(block);
  for (const [name, value] of Object.entries(vars)) if (typeof value !== 'string') throw new Error(`env.staging.vars.${name} is not a string`);
  return vars as StagingVars;
};

export type StagingProfile = Readonly<{
  // Named on the scorecard's candidate so a staging-profile card is never read as a default one.
  label: 'staging';
  model: ModelName;
  toolLoader?: 'harness';
  toolSearch?: true;
  promptV2: boolean;
  compaction: CompactionSettings;
  forgetBarrier: ForgetBarrierMode;
  memorySelection: boolean;
  semantic: boolean;
}>;

// The owner object's own precedence: the harness loader wins over provider tool search. The model is the chat model of the
// provider staging runs.
export const stagingProfile = (vars: StagingVars): StagingProfile => {
  const harness = vars.WALDO_TOOL_LOADER === 'harness';
  return {
    label: 'staging', model: OWNER_MODELS[modelProviderSetting(vars.WALDO_MODEL_PROVIDER)].chat,
    ...(harness ? { toolLoader: 'harness' as const } : vars.WALDO_TOOL_SEARCH === 'on' ? { toolSearch: true as const } : {}),
    promptV2: vars.WALDO_PROMPT_V2 === '1',
    compaction: compactionSettings({ WALDO_COMPACTION: vars.WALDO_COMPACTION, WALDO_STEPPED_WINDOW: vars.WALDO_STEPPED_WINDOW, WALDO_CALL_CEILINGS: vars.WALDO_CALL_CEILINGS, WALDO_HISTORY_BUDGET_TOKENS: vars.WALDO_HISTORY_BUDGET_TOKENS, WALDO_STEPPED_WINDOW_TARGET: vars.WALDO_STEPPED_WINDOW_TARGET }),
    forgetBarrier: vars.WALDO_FORGET_BARRIER === 'on' ? 'items' : 'reads',
    memorySelection: vars.MEMORY_SELECTION === '1',
    semantic: vars.MEMORY_SEMANTIC_RECALL === '1',
  };
};
