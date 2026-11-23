// Feature switches and tuning knobs travel as one JSON var, WALDO_SWITCHES, because Cloudflare caps a Worker's text bindings
// (vars and secrets together) at 128 and every switch was one more. Each entry seam (the Worker's fetch, email and scheduled
// handlers and each Durable Object's constructor) passes its env through withSwitches, so code below a seam reads
// env.<NAME> as it did when every switch was its own var. A name set on env itself wins, so a test's override or a deploy's
// --var still applies. guard-switches-binding.mjs checks that every seam does this.
//
// Each call builds a fresh flattened copy (a deployed env never changes; a changed config arrives as a new Worker version
// and new objects). A WALDO_SWITCHES that is not a JSON object of strings throws at the seam: every request and object fails
// loudly rather than running with every switch read as off. One that is absent (the PR preview) leaves env as it is.

const switchesOf = (raw: unknown): Record<string, string> | undefined => {
  if (raw === undefined) return undefined;
  let value: unknown = raw;
  if (typeof raw === 'string') {
    try { value = JSON.parse(raw); } catch { throw new Error('WALDO_SWITCHES is not valid JSON'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some((switchValue) => typeof switchValue !== 'string')) {
    throw new Error('WALDO_SWITCHES must be a JSON object of string values');
  }
  return value as Record<string, string>;
};

export const withSwitches = <E extends object>(env: E): E => {
  const switches = switchesOf((env as { WALDO_SWITCHES?: unknown }).WALDO_SWITCHES);
  return (switches ? { ...switches, ...env } : env) as E;
};

// Switches whose on behaviour is now the only behaviour. A signed announcement keeps naming its capability by the switch
// it shipped behind, so once WALDO_SWITCHES stops declaring one of these names, declaredSwitch reads it as on.
// guard-switches-binding.mjs checks that every switch the inventory marks unconditional is listed here before it goes.
export const SHIPPED_SWITCHES: ReadonlySet<string> = new Set([
  'APP_AGREEMENTS', 'APP_CHAT_ATTACHMENTS', 'APP_ID_TOKEN_SIGNIN', 'ARRIVAL_LOOK', 'BLOCK_LIFECYCLE',
  'BRIEF_BODY_REVISION', 'BRIEF_DAY_PLAN', 'CALENDAR_COVERAGE', 'CALENDAR_GROUNDED_PREP', 'CALENDAR_PLAN',
  'CALENDAR_UNDO_CANCEL', 'CAPACITY_BUDGET', 'CAPACITY_PLAN', 'CONSOLE_HARNESS', 'DEVICE_CALENDAR', 'DEVICE_PLACE',
  'DEVICE_WEATHER', 'DRIVE_READS', 'EVENT_PUSH', 'FREE_WINDOW_OFFERS', 'GOOGLE_REALTIME_TRIAGE', 'HEALTH_ACTIONS',
  'HEALTH_CHARTS', 'HEALTH_COACHING', 'HEALTH_DAY_LOAD', 'HEALTH_EASE_WORKOUT', 'HEALTH_INVENTORY',
  'HEALTH_PARTIAL_CONTEXT', 'HEALTH_PASSIVE_LOAD', 'HEALTH_PROVISIONAL_SCORES', 'HEALTH_SCORE_PARTS',
  'HEALTH_SOLO_NOTICE', 'HEALTH_STRESS_CURVE', 'HEALTH_TRAINING_LOAD', 'HEALTH_USUAL', 'HELD_RAISE', 'IMESSAGE_MEDIA',
  'IMESSAGE_STOP', 'IMESSAGE_VOICE', 'MAIL_SOURCE_FOLLOWUPS', 'MCP_READ_INTENTS', 'MEMORY_CLAIM_CONTROLS',
  'MEMORY_DAYTIME_CONSOLIDATOR', 'MEMORY_NIGHTLY_SOURCE_UPDATES', 'MEMORY_SELECTION', 'MEMORY_SEMANTIC_RECALL',
  'MEMORY_USED_SHOWN', 'MEMORY_VALIDITY', 'NEXT_DUE_ALARM', 'OWNER_PROFILE', 'OWNER_SURFACE_DEFAULT', 'PEOPLE_MAP',
  'PLANNING_BRIEF', 'PREP_PUSH_NAMES', 'PROACTIVE_ACT_AHEAD', 'PROACTIVE_BOTH_DEFAULT', 'PROACTIVE_GATE',
  'PROACTIVE_INTERVENTIONS', 'PROACTIVE_OVER_TELEGRAM', 'REENGAGE_PROACTIVE', 'SCREEN_TIME', 'SEPARATE_TOGGLES',
  'TOMORROW_TODAY', 'UPDATE_PUSH_NAMES', 'WAKE_BRIEF', 'WALDO_ASYNC_TOOLS', 'WALDO_CALL_CEILINGS', 'WALDO_COMPACTION',
  'WALDO_COMPACTION_WAKE', 'WALDO_CONTEXT_CAPS', 'WALDO_COST_LEDGER_SYNC', 'WALDO_DAY_STATE', 'WALDO_FILE_TOOLS',
  'WALDO_FORGET_BARRIER', 'WALDO_JOB_OUTCOME_ROWS', 'WALDO_LEAN_SCHEDULED', 'WALDO_ONE_TIMELINE', 'WALDO_OWNER_FIRST',
  'WALDO_PROMPT_V2', 'WALDO_RECALL_CHAIN', 'WALDO_SECOND_MESSAGE', 'WALDO_STEPPED_WINDOW', 'WALDO_STREAM_REPLIES',
  'WALDO_STRONG_ROLES', 'WALDO_TASK_ASK', 'WALDO_TASK_NOTES', 'WALDO_TASK_PICKUP', 'WALDO_TASK_STEER',
  'WALDO_THINKING_REPLAY', 'WALDO_TIMEZONE_ASK', 'WALDO_TOOL_LOADER', 'WALDO_WATCHDOG', 'WELCOME_V2',
  'WHATSAPP_LIST_CARDS', 'WHATSAPP_REPLY_BUTTONS', 'WHATSAPP_REPLY_MERGE', 'WHATSAPP_STOP', 'WHATS_NEW', 'WHY_TRAIL',
  'WORKOUT_WAKE'
]);

// A switch named by data (an announcement's capability) is read only when WALDO_SWITCHES declares it, so such a name never
// reads a secret or any other var. A value set on env itself still wins, as above.
export const declaredSwitch = (env: object, name: string): string | undefined => {
  const switches = switchesOf((env as { WALDO_SWITCHES?: unknown }).WALDO_SWITCHES);
  if (!switches || !Object.hasOwn(switches, name)) return SHIPPED_SWITCHES.has(name) ? '1' : undefined;
  const value = (env as Readonly<Record<string, unknown>>)[name];
  return typeof value === 'string' ? value : switches[name];
};
