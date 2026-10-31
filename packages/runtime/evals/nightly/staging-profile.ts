// WALDO_EVAL_PROFILE=staging: the eval runs the way the staging Worker's owner object builds a turn. The profile is a pure
// function of the `env.staging.vars` block of wrangler.jsonc, so a staging change reaches the eval with no second list to
// keep. Every variable in that block is classified here; a test goes red on one that is not, so a new flag that shapes
// turns cannot reach staging without the eval's owner deciding what to do about it.
import { readFileSync } from 'node:fs';
import { WALDO_CHAT_MODEL, type ModelName } from '@waldo/contracts';
import { parseJsonc } from '../../../../scripts/jsonc.mjs';
import { compactionSettings, type CompactionSettings } from '../../src/conversation/compaction';
import type { ForgetBarrierMode } from '../../src/context-composer/forget-barrier';

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
  WALDO_TOOL_LOADER: mapped("'harness' loads core tools up front and the rest through find_tools and use_tool"),
  WALDO_TOOL_SEARCH: mapped('provider tool search; the harness loader wins when both are set'),
  WALDO_COMPACTION: mapped('the trial\'s chat runs on the canonical store with these compaction settings'),
  WALDO_FORGET_BARRIER: mapped("'on' is the 'items' barrier, any other value the earlier 'reads' rule"),
  MEMORY_SEMANTIC_RECALL: mapped('the eval has no semantic leg, so the profile refuses a staging that turns it on'),

  WALDO_STREAM_REPLIES: gap('the trial calls respond directly and shows no streamed draft; streaming changes delivery, not the words [inference]'),
  CALENDAR_GROUNDED_PREP: gap('proactive prep jobs are not run; the eval runs the day cards as scenario steps'),
  MAIL_SOURCE_FOLLOWUPS: gap('the mail follow-up sweep is not run in a trial'),
  DRIVE_READS: gap(SYNTHETIC_TOOLS),
  OWNER_LOOKUP: gap('the look-up consent gate is not modelled; the world offers the look-up tool directly'),
  OWNER_PROFILE: gap('the profile view is not rendered in a trial; staging has it off'),
  MCP_READ_INTENTS: gap(SYNTHETIC_TOOLS),
  WALDO_MCP_SERVERS: gap('the world seeds its own connected tool server'),
  WALDO_EGRESS_ALLOWLIST: gap('the world has no network, so the egress boundary is held by its own tests, not by a trial'),
  HEALTH_PROVISIONAL_SCORES: gap('the world serves synthetic health, not the provisional score computation'),
  HEALTH_SOLO_NOTICE: gap('the solo-owner health notice is not run in a trial; staging has it off'),
  MEMORY_NIGHTLY_SOURCE_UPDATES: gap('the nightly memory pass is not run in a trial; staging has it off'),
  WALDO_IMESSAGE_PROGRESS: gap('iMessage progress notes; the trial runs the app surface; staging has them off'),
  IMESSAGE_MEDIA: gap('iMessage media; the trial runs the app surface'),

  WALDO_ENVIRONMENT: inert('names the deployment'),
  PREP_PUSH_NAMES: inert('the app push text raised after a prep note is delivered; the model never sees it'),
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
}>;

// The owner object's own precedence: the harness loader wins over provider tool search.
export const stagingProfile = (vars: StagingVars): StagingProfile => {
  if (vars.MEMORY_SEMANTIC_RECALL === '1') throw new Error('staging turns semantic recall on and the eval has no semantic leg');
  const harness = vars.WALDO_TOOL_LOADER === 'harness';
  return {
    label: 'staging', model: WALDO_CHAT_MODEL,
    ...(harness ? { toolLoader: 'harness' as const } : vars.WALDO_TOOL_SEARCH === 'on' ? { toolSearch: true as const } : {}),
    compaction: compactionSettings({ WALDO_COMPACTION: vars.WALDO_COMPACTION }),
    forgetBarrier: vars.WALDO_FORGET_BARRIER === 'on' ? 'items' : 'reads',
  };
};
