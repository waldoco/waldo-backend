import { z } from 'zod';
import { QUICK_REPLY_LABEL_MAX_CHARS } from '../../app/parts';

// offer_replies: short answers the owner can tap for the one question a planning card asks. The question itself is in the
// card's words; the host turns these labels into the card's quick_replies part, and a tap comes back as an ordinary owner
// message carrying the label. Three fits every surface that shows buttons (WhatsApp's limit). What to ask and which answers
// to offer is the model's call; the host bounds only count, length and one offer per card.
export const OFFER_REPLIES_MAX_CHOICES = 3;

export const offerRepliesArgsSchema = z.strictObject({
  choices: z.array(z.string().trim().min(1).max(QUICK_REPLY_LABEL_MAX_CHARS)).min(1).max(OFFER_REPLIES_MAX_CHOICES)
    .refine(choices => new Set(choices.map(choice => choice.toLowerCase())).size === choices.length, 'choices repeat'),
});
export type OfferRepliesArgs = z.infer<typeof offerRepliesArgsSchema>;

export const offerRepliesResultSchema = z.union([
  // offered is not shown: the answers go out with the card once it is delivered.
  z.strictObject({ offered: z.literal(true) }),
  // not_card_turn: this turn is not a card that can carry answers. already_offered: this card already has its answers.
  z.strictObject({ offered: z.literal(false), reason: z.enum(['not_card_turn', 'already_offered']) }),
]);
export type OfferRepliesResult = z.infer<typeof offerRepliesResultSchema>;
