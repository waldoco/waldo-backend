import { z } from 'zod';
import { iso8601Schema } from '../../core/error';
import { waldoCardSchema } from '../../ui/card';

// Threading tool args (ADR-0039 new-tools table) plus the ADR-0077 thread-graph shapes this
// surface touches: subthread refs, context-pin specs, and the reconnect/replay ref. None of
// the five tools are autonomy-gated — the user is explicitly curating their own data
// (ADR-0039) — and all five live in the user_message ACL only.

const topicTagSchema = z.string().min(1).max(50);

// A subthread is a child thread anchored to a message (ADR-0077): parent and anchor travel
// together, so a half-anchored deep-dive is unrepresentable. Depth accounting (both trees
// cap at 4) is the conversation graph's job, not the args'.
export const subthreadRefSchema = z.strictObject({
  parent_thread_id: z.string().min(1),
  anchor_message_id: z.string().min(1),
});
export type SubthreadRef = z.infer<typeof subthreadRefSchema>;

export const pinSourceTypeSchema = z.enum([
  'health_metric',
  'health_card',
  'gmail',
  'calendar',
  'document',
  'task',
  'waldo_card',
  'file',
]);
export type PinSourceType = z.infer<typeof pinSourceTypeSchema>;

export const pinIncludePolicySchema = z.enum(['next_turn', 'until_unpinned', 'ttl', 'local_only']);
export type PinIncludePolicy = z.infer<typeof pinIncludePolicySchema>;

export const pinInheritanceSchema = z.enum(['none', 'descendants']);
export type PinInheritance = z.infer<typeof pinInheritanceSchema>;

// Pins are references and policy, never copied source data (ADR-0077): source_ref is an
// opaque id into the owning store. Scope is the thread being created, and created_by is
// stamped by the code path — neither is model-suppliable here.
export const contextPinSpecSchema = z
  .strictObject({
    source_type: pinSourceTypeSchema,
    source_ref: z.string().min(1),
    include_policy: pinIncludePolicySchema,
    inheritance: pinInheritanceSchema,
    expires_at: iso8601Schema.nullable(),
  })
  .refine((pin) => (pin.include_policy === 'ttl') === (pin.expires_at !== null), {
    error: "expires_at travels exactly with the 'ttl' include policy",
    path: ['expires_at'],
  });
export type ContextPinSpec = z.infer<typeof contextPinSpecSchema>;

// The two card entry points always create NEW threads with the card context pre-loaded
// (ADR-0039 rule 5); a deep-dive names its parent+anchor and may add narrower pins without
// mutating the parent thread (ADR-0077).
export const createThreadArgsSchema = z.strictObject({
  topic_tags: z.array(topicTagSchema).max(5).optional(),
  entry_context: z.string().min(1).max(500).optional(),
  initial_card: waldoCardSchema.optional(),
  parent: subthreadRefSchema.optional(),
  context_pins: z.array(contextPinSpecSchema).optional(),
});
export type CreateThreadArgs = z.infer<typeof createThreadArgsSchema>;

// The ADR-0039 rule-3 soft-delete + recovery pair: both address one message within its
// thread. Children of a deleted message stay visible — curation, not cascade.
const messageRefShape = {
  message_id: z.string().min(1),
  thread_id: z.string().min(1),
};

export const deleteMessageArgsSchema = z.strictObject(messageRefShape);
export type DeleteMessageArgs = z.infer<typeof deleteMessageArgsSchema>;

export const restoreMessageArgsSchema = z.strictObject(messageRefShape);
export type RestoreMessageArgs = z.infer<typeof restoreMessageArgsSchema>;

export const archiveThreadArgsSchema = z.strictObject({
  thread_id: z.string().min(1),
});
export type ArchiveThreadArgs = z.infer<typeof archiveThreadArgsSchema>;

// Re-categorising replaces the tag set, so an empty set is a parse failure — a thread never
// loses its list grouping (topic_tags[0] is the section key, ADR-0039 rule 4).
export const updateThreadTopicsArgsSchema = z.strictObject({
  thread_id: z.string().min(1),
  topic_tags: z.array(topicTagSchema).min(1).max(5),
});
export type UpdateThreadTopicsArgs = z.infer<typeof updateThreadTopicsArgsSchema>;

// Reconnect/replay entry (ADR-0077): the app names the thread, optionally the run, and the
// last stream event sequence it saw; reconstruction resumes from the committed record — the
// run journal, never the socket, controls execution.
export const threadReplayRefSchema = z.strictObject({
  thread_id: z.string().min(1),
  run_id: z.string().min(1).nullable(),
  last_event_seq: z.int().nonnegative(),
});
export type ThreadReplayRef = z.infer<typeof threadReplayRefSchema>;
