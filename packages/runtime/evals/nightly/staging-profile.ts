// WALDO_EVAL_PROFILE=staging: the eval runs the way the staging Worker's owner object builds a turn. The profile is a pure
// function of the `env.staging.vars` block of wrangler.jsonc, so a staging change reaches the eval with no second list to
// keep. Every variable in that block is classified here; a test goes red on one that is not, so a new flag that shapes
// turns cannot reach staging without the eval's owner deciding what to do about it.
import { readFileSync } from 'node:fs';
import { OWNER_MODELS, type ModelName } from '@waldo/contracts';
import { parseJsonc } from '../../../../scripts/jsonc.mjs';
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
  WALDO_COMPACTION: mapped('the trial\'s chat runs on the canonical store with these compaction settings'),
  WALDO_FORGET_BARRIER: mapped("'on' is the 'items' barrier, any other value the earlier 'reads' rule"),
  MEMORY_SELECTION: mapped("'1' shows the trials option B's memory: the pins, what is new since the nightly review, recall stubs"),
  MEMORY_SEMANTIC_RECALL: mapped("'1' runs the trials with semantic recall on, over the run's embedder"),

  WALDO_STREAM_REPLIES: gap('the trial calls respond directly and shows no streamed draft; streaming changes delivery, not the words [inference]'),
  CALENDAR_GROUNDED_PREP: gap('proactive prep jobs are not run; the eval runs the day cards as scenario steps'),
  WALDO_DAY_STATE: gap('the update sweep and its apply turn are not run in a trial'),
  MAIL_SOURCE_FOLLOWUPS: gap('the mail follow-up sweep is not run in a trial'),
  DRIVE_READS: gap(SYNTHETIC_TOOLS),
  OWNER_LOOKUP: gap('the look-up consent gate is not modelled; the world offers the look-up tool directly'),
  OWNER_PROFILE: gap('the profile view is not rendered in a trial'),
  MCP_READ_INTENTS: gap(SYNTHETIC_TOOLS),
  WALDO_MCP_SERVERS: gap('the world seeds its own connected tool server'),
  WALDO_EGRESS_ALLOWLIST: gap('the world has no network, so the egress boundary is held by its own tests, not by a trial'),
  HEALTH_PROVISIONAL_SCORES: gap('the world serves synthetic health, not the provisional score computation'),
  HEALTH_SOLO_NOTICE: gap('the solo-owner health notice is not run in a trial'),
  CALENDAR_UNDO_CANCEL: gap('no trial undoes a cancel; staging has it off'),
  HEALTH_EASE_WORKOUT: gap('the world serves no workouts on the calendar; staging has it off'),
  MEDICATIONS: gap('no trial tracks a medicine; staging has it off until the gate turns it on with migration 20261101040000'),
  ONBOARDING_LOOKUP: gap('no trial runs onboarding or the background owner look-up; staging has it off'),
  WELCOME_V2: gap('the welcome build runs once at setup, never in a turn trial; staging has it off'),
  HEALTH_COACHING: gap('the trial offers no set_sleep_need, and the world serves synthetic health with no stated sleep need'),
  HEALTH_TRAINING_LOAD: gap('the world serves synthetic health, not the candidate training load the producer writes'),
  MEMORY_NIGHTLY_SOURCE_UPDATES: gap('the nightly memory pass is not run in a trial'),
  MEMORY_DAYTIME_CONSOLIDATOR: gap('the daytime memory pass is not run in a trial'),
  WALDO_IMESSAGE_PROGRESS: gap('iMessage progress notes; the trial runs the app surface; staging has them off'),
  IMESSAGE_MEDIA: gap('iMessage media; the trial runs the app surface'),

  WALDO_ENVIRONMENT: inert('names the deployment'),
  PREP_PUSH_NAMES: inert('the app push text raised after a prep note is delivered; the model never sees it'),
  UPDATE_PUSH_NAMES: inert('the app push text raised after an update is delivered; the model never sees it'),
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
  GMAIL_PUSH_PROJECT: inert('mail push subscription'),
  LANGFUSE_CAPTURE_TEXT: inert('trace capture after a turn'),
  IMESSAGE_CONNECTOR_ENABLED: inert(IMESSAGE),
  IMESSAGE_CONNECTOR_POLICY: inert(IMESSAGE),
  IMESSAGE_ONBOARDING_URL: inert(IMESSAGE),
  IMESSAGE_WALDO_ADDRESS: inert(IMESSAGE),
  PHOTON_PROJECT_ID: inert(IMESSAGE),
  WHATSAPP_REENGAGE_TEMPLATE: inert(WHATSAPP),
  WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: inert(WHATSAPP),
  WHATSAPP_ONBOARDING_URL: inert(WHATSAPP),
  WHATSAPP_WALDO_NUMBER: inert(WHATSAPP),
  WHATSAPP_DEBUG_LOG: inert(WHATSAPP),
  WALDO_COST_LEDGER_SYNC: inert('cost ledger sync after a turn'),
  AGENT_MAIL_INBOUND: inert('inbound agent mail ingress'),
  AGENT_MAIL_DOMAIN: inert('inbound agent mail ingress'),
  AGENT_MAIL_ZONE_ID: inert('agent mail routing rules'),
};

export const unclassifiedVars = (vars: StagingVars): readonly string[] => Object.keys(vars).filter((name) => !(name in STAGING_VAR_CLASSES)).sort();
export const staleClasses = (vars: StagingVars): readonly string[] => Object.keys(STAGING_VAR_CLASSES).filter((name) => !(name in vars)).sort();

export const readStagingVars = (path: URL = new URL('../../wrangler.jsonc', import.meta.url)): StagingVars => {
  const vars = (parseJsonc(readFileSync(path, 'utf8')) as { env?: { staging?: { vars?: Record<string, unknown> } } }).env?.staging?.vars;
  if (!vars) throw new Error('wrangler.jsonc has no env.staging.vars');
  for (const [name, value] of Object.entries(vars)) if (typeof value !== 'string') throw new Error(`env.staging.vars.${name} is not a string`);
  return vars as StagingVars;
};

export type StagingProfile = Readonly<{
  // Named on the scorecard's candidate so a staging-profile card is never read as a default one.
  label: 'staging';
  model: ModelName;
  toolLoader?: 'harness';
  toolSearch?: true;
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
    compaction: compactionSettings({ WALDO_COMPACTION: vars.WALDO_COMPACTION }),
    forgetBarrier: vars.WALDO_FORGET_BARRIER === 'on' ? 'items' : 'reads',
    memorySelection: vars.MEMORY_SELECTION === '1',
    semantic: vars.MEMORY_SEMANTIC_RECALL === '1',
  };
};
