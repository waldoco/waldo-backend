import { modelNameSchema, modelProviderSchema, PROVIDER_OF, type LLMTool, type ModelName } from '@waldo/contracts';
import { toolsWhere } from '../tools/records';

// The owner's chat turn as a router (docs/proposals/WALDO_ASYNC_TOOLS_DESIGN_2026-11-04.md). With WALDO_ASYNC_TOOLS=1 the
// owner's own turn holds no long tool: work that outlasts a model step goes to start_task, whose worker holds the tool, and
// the turn answers at once. Whether a piece of work becomes a task stays the model's call. Off unless "1".
export const asyncToolsEnabled = (env: Readonly<{ WALDO_ASYNC_TOOLS?: string }>): boolean => env.WALDO_ASYNC_TOOLS === '1';
export const OWNER_TURN_LONG_TOOLS: ReadonlySet<string> = toolsWhere((record) => record.long);

// With WALDO_LIGHT_CHAT=1 the first step of the owner's own reply runs on the light role, and every task worker on the chat
// model. The light step answers quick, simple chat itself; for anything else it calls LIGHT_ESCALATE and the strong role
// writes the turn's one reply. Any other tool call hands over the same way, so the light role never takes an action. Off
// unless "1".
export const lightChatEnabled = (env: Readonly<{ WALDO_LIGHT_CHAT?: string }>): boolean => env.WALDO_LIGHT_CHAT === '1';

// The light chat roles, set per environment. WALDO_LIGHT_ROLE_MODEL takes the light step; WALDO_STRONG_ROLE_MODEL takes the
// turn when the light role hands over; WALDO_STRONG_ROLE_FALLBACK_MODEL answers when the strong role's provider fails. Unset,
// each is the deploy provider's own (OWNER_MODELS): its auxiliary model, its chat model, the other provider's chat model.
// A value that is not a roster model on an owner-path provider is logged once, by variable name, and left at its default.
export type LightChatRoles = Readonly<{ light?: ModelName; strong?: ModelName; strongFallback?: ModelName }>;
type RoleEnv = Readonly<{ WALDO_LIGHT_ROLE_MODEL?: string; WALDO_STRONG_ROLE_MODEL?: string; WALDO_STRONG_ROLE_FALLBACK_MODEL?: string }>;
const refusedRoles = new Set<string>();
const roleModel = (name: keyof RoleEnv, value: string | undefined): ModelName | undefined => {
  if (!value) return undefined;
  const parsed = modelNameSchema.safeParse(value);
  if (parsed.success && modelProviderSchema.safeParse(PROVIDER_OF[parsed.data]).success) return parsed.data;
  if (!refusedRoles.has(`${name}=${value}`)) {
    refusedRoles.add(`${name}=${value}`);
    console.warn(JSON.stringify({ hop: 'light_chat_role_refused', ok: false, detail: `${name} is not an owner-path roster model; the role keeps its default` }));
  }
  return undefined;
};
export const lightChatRoles = (env: RoleEnv): LightChatRoles => {
  const light = roleModel('WALDO_LIGHT_ROLE_MODEL', env.WALDO_LIGHT_ROLE_MODEL);
  const strong = roleModel('WALDO_STRONG_ROLE_MODEL', env.WALDO_STRONG_ROLE_MODEL);
  const strongFallback = roleModel('WALDO_STRONG_ROLE_FALLBACK_MODEL', env.WALDO_STRONG_ROLE_FALLBACK_MODEL);
  return { ...(light ? { light } : {}), ...(strong ? { strong } : {}), ...(strongFallback ? { strongFallback } : {}) };
};

// Offered on the light step only, never dispatched: calling it is the hand-over. Which turns hand over is the model's call.
export const LIGHT_ESCALATE: LLMTool = {
  name: 'escalate',
  description: 'You are answering on the quick model. Answer directly only quick, simple chat: a greeting, thanks, small talk, '
    + 'or a short reply you can give from what is already in front of you. Call this tool instead, before writing anything, when '
    + 'the turn needs real reasoning or a careful judgment; any plan for the day, the week or a schedule; anything about the '
    + "owner's health, body, sleep, energy, training or readiness; words drafted for someone else; or any tool, lookup or "
    + 'action, or anything with consequences such as a card, an approval, a reminder or a message. When unsure, call it. The '
    + 'stronger model then writes the whole reply, and nothing you write in this step is shown.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
};
