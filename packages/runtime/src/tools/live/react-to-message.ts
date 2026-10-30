import { iMessageStandardReactionSchema, reactToMessageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type IMessageStandardReaction, type ReactToMessageArgs, type ReactToMessageResult, type ToolHandler, type ToolResult } from '@waldo/contracts';
import { ClosedRunError, type RunEffectScope } from '../../channels/run-effect-scope';
import { STANDARD_REACTION_EMOJI } from '../../channels/reactions';
import type { ToolDispatcherContext } from '../dispatcher';

// The surface's side of a reaction. ready: its host sends one now, read fresh on every call. freeze: the reaction's intent,
// committed under the turn's scope before any send; conflict when this turn already froze a different one. A surface that
// takes any emoji (WhatsApp) is given the emoji; one that sends only the standard tapbacks (iMessage) is given the tapback.
export type TapbackPort = Readonly<{ ready(): Promise<boolean> } & (
  | { anyEmoji?: false; freeze(reaction: IMessageStandardReaction, scope: RunEffectScope): 'queued' | 'conflict' }
  | { anyEmoji: true; freeze(emoji: string, scope: RunEffectScope): 'queued' | 'conflict' })>;

const DESCRIPTION = "Tapback the owner's message you are answering. It goes out with your reply; queued:false means none will.";
const EMOJI_DESCRIPTION = "React to the owner's message you are answering with one emoji (or a tapback name). It goes out after your reply; queued:false means none will.";

const unqueued = (reason: Extract<ReactToMessageResult, { queued: false }>['reason']): ToolResult<ReactToMessageResult> => ({ ok: true, data: { queued: false, reason }, source_taint: null });
const plain = (emoji: string) => emoji.replace(/\uFE0F/g, '');
const tapbackFor = (emoji: string): IMessageStandardReaction | null =>
  (Object.entries(STANDARD_REACTION_EMOJI) as [IMessageStandardReaction, string][]).find(([, shown]) => plain(shown) === plain(emoji))?.[0] ?? null;

export const reactToMessageHandler = (port: TapbackPort): ToolHandler<ReactToMessageArgs, ReactToMessageResult, ToolDispatcherContext> => ({
  name: 'react_to_message',
  description: port.anyEmoji ? EMOJI_DESCRIPTION : DESCRIPTION,
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
    const tapback = iMessageStandardReactionSchema.safeParse(args.reaction);
    if (port.anyEmoji) {
      ctx.runScope.admit();
      return port.freeze(tapback.success ? STANDARD_REACTION_EMOJI[tapback.data] : args.reaction, ctx.runScope) === 'queued' ? { ok: true, data: { queued: true }, source_taint: null } : unqueued('already_reacted');
    }
    // An emoji this surface has a tapback for goes as that tapback; any other emoji it cannot send.
    const reaction = tapback.success ? tapback.data : tapbackFor(args.reaction);
    if (!reaction) return unqueued('unavailable');
    ctx.runScope.admit();
    return port.freeze(reaction, ctx.runScope) === 'queued' ? { ok: true, data: { queued: true }, source_taint: null } : unqueued('already_reacted');
  },
});
