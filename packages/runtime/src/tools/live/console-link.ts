import {
  sendConsoleLinkArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type SendConsoleLinkArgs, type SendConsoleLinkResult, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../../channels/run-effect-scope';
import type { ToolDispatcherContext } from '../dispatcher';

// The owner turn a link answers. The host sends to that turn's own verified surface; nothing here names a destination.
export type ConsoleLinkTurn = Readonly<{ turnId: string; runScope?: RunEffectScope }>;
export type ConsoleLinkSend = (turn: ConsoleLinkTurn) => Promise<SendConsoleLinkResult>;

// What the responder hands every owner-turn tool call: the owner's message as the model read it, with the spans the
// owner did not write (a forward, a quote, a transcript).
type OwnerTurnContext = ToolDispatcherContext & Readonly<{ memoryTurn?: Readonly<{ current: Readonly<{ text: string; sourceQuoteRanges?: readonly unknown[] }> }> }>;

const unsent = (reason: Extract<SendConsoleLinkResult, { sent: false }>['reason']): ToolResult<SendConsoleLinkResult> =>
  ({ ok: true, data: { sent: false, reason }, source_taint: null });

// Whether the owner is asking for their console is the model's call. Whether this turn may mint a credential is not: only
// an owner turn whose every word the owner typed, with no outside content in it that could have asked for the link.
export const consoleLinkHandler = (send: ConsoleLinkSend): ToolHandler<SendConsoleLinkArgs, SendConsoleLinkResult, ToolDispatcherContext> => ({
  name: 'send_console_link',
  description: "Send the owner a one-time sign-in link to their Waldo console, the web page for their settings, memory, approvals, connections and history. Use it whenever the owner wants to open, see or sign in to their console or dashboard. The server sends the link straight to the chat this message came from, and you never see it: never type, quote or make up a console link. sent:true means the link is on its way to that chat; it works once, for 10 minutes. Otherwise tell the owner why in plain words: app_unsupported, the app cannot show the link yet, so they can ask on Telegram or iMessage; not_owner_typed or outside_content, ask them to send the request as a new message of their own; already_sent, point them to the link just sent; unavailable or send_failed, console sign-in cannot be sent right now.",
  schema: sendConsoleLinkArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('send_console_link')),
  autonomy_gated: false,
  mutates_state: true,
  async handle(_args, ctx) {
    const current = (ctx as OwnerTurnContext).memoryTurn?.current;
    if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !ctx.turnId || !current?.text.trim() || (current.sourceQuoteRanges?.length ?? 0) > 0) return unsent('not_owner_typed');
    if (ctx.toolArgSourceTaint === 'external') return unsent('outside_content');
    try {
      return { ok: true, data: await send({ turnId: ctx.turnId, ...(ctx.runScope ? { runScope: ctx.runScope } : {}) }), source_taint: null };
    } catch (error) {
      if (error instanceof ClosedRunError) throw error;
      // A failed send's error text can carry the request it failed on; the model hears only the reason.
      return unsent('send_failed');
    }
  },
});
