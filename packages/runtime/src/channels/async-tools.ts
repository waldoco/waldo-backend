import { modelNameSchema, modelProviderSchema, OWNER_MODELS, PROVIDER_OF, type LLMTool, type ModelName } from '@waldo/contracts';
import { toolsWhere } from '../tools/records';

// The owner's chat turn as a router (docs/proposals/WALDO_ASYNC_TOOLS_DESIGN_2026-11-04.md). With WALDO_ASYNC_TOOLS=1 the
// owner's own turn holds no long tool: work that outlasts a model step goes to start_task, whose worker holds the tool, and
// the turn answers at once. Whether a piece of work becomes a task stays the model's call. Off unless "1".
export const asyncToolsEnabled = (env: Readonly<{ WALDO_ASYNC_TOOLS?: string }>): boolean => env.WALDO_ASYNC_TOOLS === '1';
export const OWNER_TURN_LONG_TOOLS: ReadonlySet<string> = toolsWhere((record) => record.long);

// With WALDO_LIGHT_CHAT=1 the first step of the owner's own reply runs on the light role, and every task worker on the chat
// model. The light step answers quick, simple chat itself; for anything else it calls LIGHT_ESCALATE and the strong role
// writes the turn's one reply. The light step is offered no other tool and reads no health, plan, memory or tool results
// (owner-turn.ts), so any answer drawn from those, and any action, is the strong role's. Off unless "1".
export const lightChatEnabled = (env: Readonly<{ WALDO_LIGHT_CHAT?: string }>): boolean => env.WALDO_LIGHT_CHAT === '1';

// The light chat roles, set per environment. WALDO_LIGHT_ROLE_MODEL takes the light step; WALDO_STRONG_ROLE_MODEL takes the
// turn when the light role hands over; WALDO_STRONG_ROLE_FALLBACK_MODEL answers when the strong role's provider fails;
// WALDO_LIGHT_ROLE_MAX_TOKENS caps the light step's output, thinking included. Unset, each is the deploy provider's own
// (OWNER_MODELS: its auxiliary model, its chat model, the other provider's chat model) and LIGHT_ROLE_MAX_TOKENS. A model that
// is not on an owner-path provider, a strong role set to any provider's auxiliary model, or a cap outside its range is logged
// once, by variable name, and the role keeps its default.
export type LightChatRoles = Readonly<{ light?: ModelName; strong?: ModelName; strongFallback?: ModelName; lightMaxTokens?: number }>;
// A quick chat answer and the light model's low-effort thinking fit well inside this; a step it cuts off hands over.
export const LIGHT_ROLE_MAX_TOKENS = 2_048;
type RoleEnv = Readonly<{ WALDO_LIGHT_ROLE_MODEL?: string; WALDO_STRONG_ROLE_MODEL?: string; WALDO_STRONG_ROLE_FALLBACK_MODEL?: string; WALDO_LIGHT_ROLE_MAX_TOKENS?: string }>;
const AUXILIARY: ReadonlySet<ModelName> = new Set(Object.values(OWNER_MODELS).map((models) => models.auxiliary));
const refusedRoles = new Set<string>();
const refuse = (name: keyof RoleEnv, value: string, why: string): undefined => {
  if (!refusedRoles.has(`${name}=${value}`)) {
    refusedRoles.add(`${name}=${value}`);
    console.warn(JSON.stringify({ hop: 'light_chat_role_refused', ok: false, detail: `${name} ${why}; the role keeps its default` }));
  }
  return undefined;
};
const roleModel = (name: keyof RoleEnv, value: string | undefined, strong: boolean): ModelName | undefined => {
  if (!value) return undefined;
  const parsed = modelNameSchema.safeParse(value);
  if (!parsed.success || !modelProviderSchema.safeParse(PROVIDER_OF[parsed.data]).success) return refuse(name, value, 'is not an owner-path roster model');
  return strong && AUXILIARY.has(parsed.data) ? refuse(name, value, 'is an auxiliary model, which a strong role never runs on') : parsed.data;
};
const maxTokens = (value: string | undefined): number | undefined => {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 256 && parsed <= 16_000 ? parsed : refuse('WALDO_LIGHT_ROLE_MAX_TOKENS', value, 'is not a whole number from 256 to 16000');
};
export const lightChatRoles = (env: RoleEnv): LightChatRoles => {
  const light = roleModel('WALDO_LIGHT_ROLE_MODEL', env.WALDO_LIGHT_ROLE_MODEL, false);
  const strong = roleModel('WALDO_STRONG_ROLE_MODEL', env.WALDO_STRONG_ROLE_MODEL, true);
  const strongFallback = roleModel('WALDO_STRONG_ROLE_FALLBACK_MODEL', env.WALDO_STRONG_ROLE_FALLBACK_MODEL, true);
  const lightMaxTokens = maxTokens(env.WALDO_LIGHT_ROLE_MAX_TOKENS);
  return { ...(light ? { light } : {}), ...(strong ? { strong } : {}), ...(strongFallback ? { strongFallback } : {}), ...(lightMaxTokens ? { lightMaxTokens } : {}) };
};

// Offered on the light step only, never dispatched: calling it is the hand-over. Which turns hand over is the model's call.
export const LIGHT_ESCALATE: LLMTool = {
  name: 'escalate',
  description: 'You are answering on the quick model. Answer directly only quick, simple chat: a greeting, thanks, small talk, '
    + 'or a short reply you can give from the conversation alone. You see no health, calendar, plan, memory or tool results. Call this tool instead, before writing anything, when '
    + 'the turn needs real reasoning or a careful judgment; any plan for the day, the week or a schedule; anything about the '
    + "owner's health, body, sleep, energy, training or readiness; words drafted for someone else; or any tool, lookup or "
    + 'action, or anything with consequences such as a card, an approval, a reminder or a message. When unsure, call it. The '
    + 'stronger model then writes the whole reply, and nothing you write in this step is shown.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};
