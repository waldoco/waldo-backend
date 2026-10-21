import { z } from 'zod';

// send_progress_note: a short, non-blocking note to the owner on the chat the turn came from, while the turn keeps
// working. Whether to send one and what it says is the model's call; the host bounds only length, spacing and count,
// and a bound that stops a note comes back as a typed reason. The result never carries the note's text.
export const PROGRESS_NOTE_MAX_CHARS = 300;
export const PROGRESS_NOTE_MIN_GAP_MS = 45_000;
export const PROGRESS_NOTE_MAX_PER_TURN = 6;

export const sendProgressNoteArgsSchema = z.strictObject({
  text: z.string().min(1),
});
export type SendProgressNoteArgs = z.infer<typeof sendProgressNoteArgsSchema>;

export const sendProgressNoteResultSchema = z.union([
  z.strictObject({ sent: z.literal(true), notes_left: z.int().min(0) }),
  z.discriminatedUnion('reason', [
    z.strictObject({ sent: z.literal(false), reason: z.literal('too_long'), max_chars: z.int().positive() }),
    z.strictObject({ sent: z.literal(false), reason: z.literal('too_soon'), wait_seconds: z.int().positive() }),
    z.strictObject({ sent: z.literal(false), reason: z.literal('limit_reached'), max_per_turn: z.int().positive() }),
    // A job, reminder or other turn with no owner message waiting on it.
    z.strictObject({ sent: z.literal(false), reason: z.literal('not_owner_turn') }),
    // The surface refused, blocked or failed the send.
    z.strictObject({ sent: z.literal(false), reason: z.literal('send_failed') }),
  ]),
]);
export type SendProgressNoteResult = z.infer<typeof sendProgressNoteResultSchema>;
