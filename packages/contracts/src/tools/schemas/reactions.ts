import { z } from 'zod';
import { iMessageStandardReactionSchema } from '../../channels/imessage-v1';

// One emoji as a chat shows it: a pictograph with its variation selector, skin tone and joined parts, a flag (two regional
// indicators) or a keycap. Anything longer is not a reaction.
const ONE_EMOJI = /^(?:\p{Regional_Indicator}{2}|[#*0-9]\uFE0F?\u20E3|\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?(?:\u200D\p{Extended_Pictographic}\uFE0F?\p{Emoji_Modifier}?)*)$/u;
const reactionEmojiSchema = z.string().max(32).refine((value) => ONE_EMOJI.test(value), 'one emoji');

// react_to_message: a reaction on the owner's message the turn answers, offered only where the surface's host sends one.
// The host picks the message, so the model names only the reaction: a standard tapback (all iMessage sends) or, where the
// surface takes any emoji (WhatsApp), one emoji. queued is not sent: the reaction leaves with the turn's reply, and a
// reason says why it will not.
export const reactToMessageArgsSchema = z.strictObject({ reaction: z.union([iMessageStandardReactionSchema, reactionEmojiSchema]) });
export type ReactToMessageArgs = z.infer<typeof reactToMessageArgsSchema>;

export const reactToMessageResultSchema = z.union([
  z.strictObject({ queued: z.literal(true) }),
  // unavailable: this host does not send this reaction now. already_reacted: this turn queued a different one.
  z.strictObject({ queued: z.literal(false), reason: z.enum(['unavailable', 'not_owner_turn', 'already_reacted']) }),
]);
export type ReactToMessageResult = z.infer<typeof reactToMessageResultSchema>;
