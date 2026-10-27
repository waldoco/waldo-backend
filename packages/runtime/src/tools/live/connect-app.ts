import {
  connectAppArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type ConnectAppArgs, type ConnectAppResult, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../../channels/run-effect-scope';
import { MCP_CATALOGUE, type McpCatalogueEntry } from '../../connectors/mcp-catalogue';
import type { ToolDispatcherContext } from '../dispatcher';

// The owner turn a connect answers: the host sends to that turn's own verified surface, and its confirmation later goes back
// to the conversation the turn ran in. Nothing here names a destination.
export type ConnectAppTurn = Readonly<{ turnId: string; runScope?: RunEffectScope }>;
export type ConnectAppSend = (turn: ConnectAppTurn, entry: McpCatalogueEntry, method: 'link' | 'code') => Promise<ConnectAppResult>;

type OwnerTurnContext = ToolDispatcherContext & Readonly<{ memoryTurn?: Readonly<{ current: Readonly<{ text: string; sourceQuoteRanges?: readonly unknown[] }> }> }>;

const unsent = (reason: Extract<ConnectAppResult, { status: 'not_sent' }>['reason']): ToolResult<ConnectAppResult> =>
  ({ ok: true, data: { status: 'not_sent', reason }, source_taint: null });

// Whether the owner wants an app connected is the model's call. Whether this turn may send a connect link is not: only an
// owner turn whose every word the owner typed, with nothing from outside in it that could have asked for the link, and only
// for an app in Waldo's catalogue. Sending a link grants nothing: what runs without asking once the app is connected is
// decided where the owner signs in, exactly as from the console.
export const connectAppHandler = (send: ConnectAppSend): ToolHandler<ConnectAppArgs, ConnectAppResult, ToolDispatcherContext> => ({
  name: 'connect_app',
  description: `Connect one of the owner's apps to Waldo (${MCP_CATALOGUE.map((entry) => entry.id).join(', ')}): the server sends a one-time sign-in link, or with method code a device code where the app offers one, to this chat, and says there when the app is connected; you never see either. Use it when the owner asks to connect, link or set up one of these. Never type a link. not_owner_typed or outside_content: ask them to ask again in their own message.`,
  schema: connectAppArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('connect_app')),
  autonomy_gated: false,
  mutates_state: true,
  async handle(args, ctx) {
    const current = (ctx as OwnerTurnContext).memoryTurn?.current;
    if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !ctx.turnId || !current?.text.trim() || (current.sourceQuoteRanges?.length ?? 0) > 0) return unsent('not_owner_typed');
    if (ctx.toolArgSourceTaint === 'external') return unsent('outside_content');
    const entry = MCP_CATALOGUE.find((candidate) => candidate.id === args.connector_id);
    if (!entry) return unsent('unknown_app');
    try {
      return { ok: true, data: await send({ turnId: ctx.turnId, ...(ctx.runScope ? { runScope: ctx.runScope } : {}) }, entry, args.method ?? 'link'), source_taint: null };
    } catch (error) {
      if (error instanceof ClosedRunError) throw error;
      // A failed send's error text can carry the link it failed on; the model hears only the reason.
      return unsent('send_failed');
    }
  },
});
