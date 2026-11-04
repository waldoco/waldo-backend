import { z } from 'zod';

// attach_file: the model names one of the owner's workspace files (current revision) to go out with this turn's reply,
// on a surface that carries files. Whether to attach is the model's call. The host only queues it: the file leaves after
// the reply, under its own effect intent, so a queued file is not yet a sent file. The arguments carry no destination.
export const ATTACH_FILE_MAX_PER_TURN = 10;

export const attachFileArgsSchema = z.strictObject({
  file_id: z.string().min(1).max(100),
  revision: z.int().positive(),
});
export type AttachFileArgs = z.infer<typeof attachFileArgsSchema>;

export const attachFileResultSchema = z.union([
  z.strictObject({ queued: z.literal(true), filename: z.string().min(1), attachments_left: z.int().min(0) }),
  z.discriminatedUnion('reason', [
    // A job, reminder or other turn with no owner reply to attach to.
    z.strictObject({ queued: z.literal(false), reason: z.literal('not_owner_turn') }),
    z.strictObject({ queued: z.literal(false), reason: z.literal('not_found') }),
    // The file has moved on since the receipt the model holds; attach the current revision if that is what the owner wants.
    z.strictObject({ queued: z.literal(false), reason: z.literal('revision_changed'), current_revision: z.int().positive() }),
    z.strictObject({ queued: z.literal(false), reason: z.literal('limit_reached'), max_per_turn: z.int().positive() }),
    // The workspace could not be opened for this turn.
    z.strictObject({ queued: z.literal(false), reason: z.literal('unavailable') }),
  ]),
]);
export type AttachFileResult = z.infer<typeof attachFileResultSchema>;
