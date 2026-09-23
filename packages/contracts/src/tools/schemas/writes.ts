import { z } from 'zod';
import { channelNameSchema } from '../../adapters/channel';
import { docProviderSchema } from '../../adapters/doc';
import { iso8601Schema } from '../../core/error';
import { hallTypeSchema } from '../../memory/hall';
import { MEMORY_BLOCK_CONTENT_MAX } from '../../memory/sanitise';
import { idempotencyKeySchema } from '../../runtime/outbox';

// Mutating tool arg surface (ADR-0021; execute_code per ADR-0023). These schemas are the
// PreToolUse validation seam for the write tools: strictObject makes an unknown arg a parse
// failure, and every external mutation is autonomy-gated (ADR-0018) before any adapter call.

// The facts hall is not agent-writable. Derived from the hall vocabulary's single owner, so
// a new hall surfaces here (admitted or deliberately excluded) at review time, not by drift.
export const memoryWriteHallSchema = hallTypeSchema.exclude(['facts']);
export type MemoryWriteHall = z.infer<typeof memoryWriteHallSchema>;

// update_memory stages through the Scribe inbox (ADR-0006), never memory_blocks direct.
export const updateMemoryArgsSchema = z.strictObject({
  hall: memoryWriteHallSchema,
  content: z.string().min(1).max(MEMORY_BLOCK_CONTENT_MAX),
  tags: z.array(z.string().min(1)).max(10).optional(),
});
export type UpdateMemoryArgs = z.infer<typeof updateMemoryArgsSchema>;

export const proposeActionArgsSchema = z.strictObject({
  action_type: z.string().min(1).max(100),
  description: z.string().min(1).max(1_000),
  reasoning: z.string().min(1).max(500),
  urgency: z.enum(['low', 'medium', 'high']).default('medium'),
});
export type ProposeActionArgs = z.infer<typeof proposeActionArgsSchema>;

// Delivery is an exactly-once outbox side effect (ADR-0054): the repo-canonical 64-hex key
// collapses a retry onto the prior send instead of double-delivering.
export const sendMessageArgsSchema = z.strictObject({
  channel: channelNameSchema,
  content: z.string().min(1).max(4_096),
  idempotency_key: idempotencyKeySchema,
});
export type SendMessageArgs = z.infer<typeof sendMessageArgsSchema>;

export const taskPrioritySchema = z.enum(['low', 'medium', 'high']);
export type TaskPriority = z.infer<typeof taskPrioritySchema>;

// `title` only — task descriptions never cross the privacy wall (ADR-0021). `reasoning` is
// the mandatory audit surface every task mutation carries.
export const writeTaskArgsSchema = z.strictObject({
  title: z.string().min(1).max(200),
  due: iso8601Schema.optional(),
  priority: taskPrioritySchema.optional(),
  tags: z.array(z.string().min(1)).max(10).optional(),
  parent_task_id: z.string().min(1).optional(),
  reasoning: z.string().min(1).max(500),
});
export type WriteTaskArgs = z.infer<typeof writeTaskArgsSchema>;

export const taskStatusSchema = z.enum(['todo', 'in_progress', 'done', 'cancelled']);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

// status 'done' is connector_write under ADR-0018 — third-party-observable, so even L3
// confirms; the autonomy gate reads the transition from these args.
export const updateTaskArgsSchema = z.strictObject({
  task_id: z.string().min(1),
  changes: z.strictObject({
    title: z.string().min(1).max(200).optional(),
    due: iso8601Schema.optional(),
    priority: taskPrioritySchema.optional(),
    status: taskStatusSchema.optional(),
    tags_add: z.array(z.string().min(1)).optional(),
    tags_remove: z.array(z.string().min(1)).optional(),
  }),
  reasoning: z.string().min(1).max(500),
});
export type UpdateTaskArgs = z.infer<typeof updateTaskArgsSchema>;

// destination reuses the DocProvider vocabulary (ADR-0025): 'r2_scratch' is the one
// representation of the R2 scratch space, so a bare 'scratch' is a parse failure.
export const draftDocumentArgsSchema = z.strictObject({
  title: z.string().min(1).max(200),
  body_markdown: z.string().min(1).max(50_000),
  destination: docProviderSchema,
  parent_folder_id: z.string().min(1).optional(),
  shareable: z.boolean().default(false),
});
export type DraftDocumentArgs = z.infer<typeof draftDocumentArgsSchema>;

// Drafts only — Waldo never sends (ADR-0027); send_draft is a separate user-tap-only
// execute_action invocation. Tool args carry bare addresses: display-name forms are the
// adapter's inbound draft shape, never the model's outbound one.
export const draftEmailArgsSchema = z.strictObject({
  to: z.array(z.email()).min(1).max(50),
  cc: z.array(z.email()).max(50).optional(),
  bcc: z.array(z.email()).max(50).optional(),
  subject: z.string().min(1).max(200),
  body_markdown: z.string().min(1).max(10_000),
  reply_to_thread_id: z.string().min(1).optional(),
  in_reply_to_msg_id: z.string().min(1).optional(),
});
export type DraftEmailArgs = z.infer<typeof draftEmailArgsSchema>;

// 'energized'/'steady' mirror the form-zone vocabulary (health/crs); 'avoid_trough' is a
// scheduling-only preference. 'peak' is deliberately absent — it names a load zone, not a
// form zone.
export const formZonePreferenceSchema = z.enum(['energized', 'steady', 'avoid_trough']);
export type FormZonePreference = z.infer<typeof formZonePreferenceSchema>;

// Sending invites is connector_write (ADR-0018) — proposals always confirm, even at L3.
export const proposeScheduleArgsSchema = z.strictObject({
  attendees: z.array(z.email()).min(1).max(50),
  duration_min: z.int().min(15).max(480),
  title: z.string().min(1).max(200),
  description_markdown: z.string().max(2_000).optional(),
  earliest: iso8601Schema.optional(),
  latest: iso8601Schema.optional(),
  prefer_user_form_zone: formZonePreferenceSchema.optional(),
});
export type ProposeScheduleArgs = z.infer<typeof proposeScheduleArgsSchema>;

export const sheetWriteModeSchema = z.enum(['overwrite', 'append']);
export type SheetWriteMode = z.infer<typeof sheetWriteModeSchema>;

export const writeSheetCellArgsSchema = z.strictObject({
  sheet_id: z.string().min(1),
  // A1 notation, e.g. "Sheet1!A5"; single-cell-ness is provider-checked (ADR-0026).
  range: z.string().min(1).max(100),
  value: z.union([z.string(), z.number()]),
  mode: sheetWriteModeSchema.default('overwrite'),
});
export type WriteSheetCellArgs = z.infer<typeof writeSheetCellArgsSchema>;

// Typed even though 'execute_code' sits in zero current ACLs (ADR-0050):
// re-enabling is an ACL change, not a breaking type change. The 30_000 ms hard cap and the
// empty-by-default egress allowlist are ADR-0023 law.
export const executeCodeArgsSchema = z.strictObject({
  language: z.enum(['python', 'js']),
  code: z.string().min(1).max(50_000),
  stdin: z.string().max(10_000).optional(),
  allow_hosts: z.array(z.string().min(1)).max(20).default([]),
  timeout_ms: z.int().min(1_000).max(30_000).default(30_000),
  memory_mb: z.int().min(64).max(512).default(256),
});
export type ExecuteCodeArgs = z.infer<typeof executeCodeArgsSchema>;
