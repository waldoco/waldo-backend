import { reactToMessageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type IMessageStandardReaction, type ReactToMessageArgs, type ReactToMessageResult, type ToolHandler, type ToolResult } from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../../channels/run-effect-scope';
import type { ToolDispatcherContext } from '../dispatcher';

// The surface's side of a tapback. ready: its host sends tapbacks now (sent, verified, exact target), read fresh on every
// call. freeze: the tapback's intent, committed under the turn's scope before any send; conflict when this turn already
// froze a different one.
export type TapbackPort = Readonly<{
  ready(): Promise<boolean>;
  freeze(reaction: IMessageStandardReaction, scope: RunEffectScope): 'queued' | 'conflict';
}>;

const DESCRIPTION = "Tapback the owner's message you are answering. It goes out with your reply; queued:false means none will.";

const unqueued = (reason: Extract<ReactToMessageResult, { queued: false }>['reason']): ToolResult<ReactToMessageResult> => ({ ok: true, data: { queued: false, reason }, source_taint: null });

// Offered and run only while the port says the host sends tapbacks: checked when the turn's tools are chosen and again
// when the call runs, so a capability withdrawn in between refuses the call instead of freezing a tapback.
export const reactToMessageHandler = (port: TapbackPort): ToolHandler<ReactToMessageArgs, ReactToMessageResult, ToolDispatcherContext> => ({
  name: 'react_to_message',
  description: DESCRIPTION,
  schema: reactToMessageArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('react_to_message')),
  autonomy_gated: false,
  mutates_state: true,
  turn_bound: true,
  async eligible() {
    try { return await port.ready() ? { ok: true } : { ok: false, reason: 'not_configured' }; } catch { return { ok: false, reason: 'not_configured' }; }
  },
  async handle(args, ctx) {
    if (ctx.trigger !== 'user_message' || ctx.ownerInitiated !== true || !ctx.runScope) return unqueued('not_owner_turn');
    let ready: boolean;
    try { ready = await port.ready(); } catch (error) { if (error instanceof ClosedRunError) throw error; ready = false; }
    if (!ready) return unqueued('unavailable');
    ctx.runScope.admit();
    return port.freeze(args.reaction, ctx.runScope) === 'queued' ? { ok: true, data: { queued: true }, source_taint: null } : unqueued('already_reacted');
  },
});
