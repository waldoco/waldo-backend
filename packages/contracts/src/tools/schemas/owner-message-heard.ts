import { z } from 'zod';

// owner_message_heard: while the owner's turn runs, the owner may write again on the same chat. The host shows the running
// turn each newer message at its next round, and the model says what it is: fold (it changes or adds to this task, so this
// answer covers it and it gets no turn of its own), queue (separate: it keeps its own turn after this one) or stop_current
// (it replaces this task: it closes like a fold, and this turn drops what it was doing and answers it). A message the model never
// answers stays queued. Which choice is right is the model's judgment; the host only checks the message is still waiting.
export const OWNER_MESSAGE_CHOICES = ['fold', 'queue', 'stop_current'] as const;

export const ownerMessageHeardArgsSchema = z.strictObject({
  message_id: z.string().min(1).max(64),
  choice: z.enum(OWNER_MESSAGE_CHOICES),
});
export type OwnerMessageHeardArgs = z.infer<typeof ownerMessageHeardArgsSchema>;

export const ownerMessageHeardResultSchema = z.union([
  z.strictObject({ heard: z.literal(true), choice: z.enum(OWNER_MESSAGE_CHOICES) }),
  // not_waiting: no such message is waiting on this chat (already answered, stopped or never offered); not_owner_turn: a job,
  // reminder or other turn that no owner message waits on.
  z.strictObject({ heard: z.literal(false), reason: z.enum(['not_waiting', 'not_owner_turn']) }),
]);
export type OwnerMessageHeardResult = z.infer<typeof ownerMessageHeardResultSchema>;
