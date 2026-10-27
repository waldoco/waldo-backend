import { z } from 'zod';
import { iMessageStandardReactionSchema } from '../../channels/imessage-v1';

// react_to_message: a standard tapback on the owner's message the turn answers, offered only where the surface's host
// verified tapbacks. The host picks the message, so the model names only the reaction. queued is not sent: the tapback
// leaves with the turn's reply, and a reason says why it will not.
export const reactToMessageArgsSchema = z.strictObject({ reaction: iMessageStandardReactionSchema });
export type ReactToMessageArgs = z.infer<typeof reactToMessageArgsSchema>;

export const reactToMessageResultSchema = z.union([
  z.strictObject({ queued: z.literal(true) }),
  // unavailable: this host does not send tapbacks now. already_reacted: this turn queued a different one.
  z.strictObject({ queued: z.literal(false), reason: z.enum(['unavailable', 'not_owner_turn', 'already_reacted']) }),
]);
export type ReactToMessageResult = z.infer<typeof reactToMessageResultSchema>;
