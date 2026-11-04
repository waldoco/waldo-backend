import { offerRepliesArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema, type OfferRepliesArgs, type OfferRepliesResult, type ToolHandler, type ToolResult } from '@waldo/contracts';
import type { ToolDispatcherContext } from '../dispatcher';

// The card's side of offered answers. open: a card that can carry answers is being written now, read fresh when the turn's
// tools are chosen. offer: keeps the answers for the card the turn with this id is writing; conflict when it already has
// some, closed when no such card is being written.
export type ReplyOfferPort = Readonly<{
  open(): boolean;
  offer(turnId: string, choices: readonly string[]): 'offered' | 'conflict' | 'closed';
}>;

// The answers offered for each card being written, by the trace of the turn writing it. A card opens its slot before its
// turn and takes it after, whatever the turn did, so a failed card never leaves the tool offered to later turns.
export const cardReplyBook = () => {
  const slots = new Map<string, readonly string[]>();
  const port: ReplyOfferPort = {
    open: () => slots.size > 0,
    offer: (turnId, choices) => {
      const offered = slots.get(turnId);
      if (offered === undefined) return 'closed';
      if (offered.length > 0) return 'conflict';
      slots.set(turnId, choices);
      return 'offered';
    },
  };
  return {
    port,
    open(trace: string): void { slots.set(trace, []); },
    take(trace: string): readonly string[] { const offered = slots.get(trace) ?? []; slots.delete(trace); return offered; },
  };
};

const DESCRIPTION = "Offer the owner up to three short answers they can tap for the one question your card asks (your best guesses, and one for something else). Ask the question in your card's words; each answer is at most 20 characters. A tap comes back as their own message. Once per card.";

const declined = (reason: Extract<OfferRepliesResult, { offered: false }>['reason']): ToolResult<OfferRepliesResult> => ({ ok: true, data: { offered: false, reason }, source_taint: null });

export const offerRepliesHandler = (port: ReplyOfferPort): ToolHandler<OfferRepliesArgs, OfferRepliesResult, ToolDispatcherContext> => ({
  name: 'offer_replies',
  description: DESCRIPTION,
  schema: offerRepliesArgsSchema,
  trigger_allowlist: triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('offer_replies')),
  autonomy_gated: false,
  mutates_state: true,
  turn_bound: true,
  eligible: () => port.open() ? { ok: true } : { ok: false, reason: 'not_configured' },
  async handle(args, ctx) {
    if (!ctx.turnId) return declined('not_card_turn');
    const outcome = port.offer(ctx.turnId, args.choices);
    return outcome === 'offered' ? { ok: true, data: { offered: true }, source_taint: null } : declined(outcome === 'conflict' ? 'already_offered' : 'not_card_turn');
  },
});
