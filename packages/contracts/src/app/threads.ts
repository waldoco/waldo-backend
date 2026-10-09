import { z } from 'zod';
import { APP_SEND_MAX_WIRE_BYTES, appHistoryResultV1Schema, appSendResultV1Schema } from './core';
import { appReplayQueryV1Schema, appReplayResultV1Schema } from './replay';

export const appThreadIdV1Schema = z.string().regex(/^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const revision = z.int().positive();
const operation = z.uuid();
export const appThreadV1Schema = z.strictObject({
  thread_id: appThreadIdV1Schema, title: z.string().max(200), revision,
  state: z.enum(['active', 'archived', 'deleted']), created_at: z.int().nonnegative(), updated_at: z.int().nonnegative(),
  conversation_ref: z.string().min(1).max(256),
});
export const appThreadCreateV1Schema = z.strictObject({ operation_id: operation, title: z.string().trim().min(1).max(200) });
export const appThreadArchiveV1Schema = z.strictObject({ operation_id: operation, expected_revision: revision, archived: z.boolean() });
export const appThreadDeleteV1Schema = z.strictObject({ operation_id: operation, expected_revision: revision });
export const appThreadOperationResultV1Schema = z.strictObject({
  operation_id: operation, state: z.literal('recorded'), thread_id: appThreadIdV1Schema,
  revision, thread_state: z.enum(['active', 'archived', 'deleted']), erased_messages: z.int().nonnegative().optional(),
});
export const appThreadMessageIdV1Schema = z.string().regex(/^[A-Za-z0-9_-]{8,64}$/);
export const appThreadMessageReceiptV1Schema = appSendResultV1Schema.extend({
  state: z.enum(['admitted', 'running', 'completed', 'interrupted', 'revoked']),
  closed_reason: z.enum(['interrupted', 'session_revoked', 'cancelled', 'archived', 'deleted', 'thread_changed']).optional(),
  effects_unconfirmed: z.boolean().optional(),
});
export const appThreadListQueryV1Schema = z.strictObject({ state: z.enum(['active', 'archived', 'all']).optional() });
export const appThreadListV1Schema = z.strictObject({ threads: z.array(appThreadV1Schema) });
export const appThreadReadQueryV1Schema = z.strictObject({ cursor: z.string().max(512).regex(/^(?:\d{1,9}|before:.{1,500})$/).optional(), limit: z.coerce.number().int().min(1).max(50).optional() });
// Lazy shared schemas avoid creating a second transcript DTO as agent.ts includes these routes.
export const appThreadReadV1Schema = z.strictObject({ thread: appThreadV1Schema, history: z.lazy(() => appHistoryResultV1Schema) });
export const appThreadContextRefV1Schema = z.union([
  z.strictObject({ kind: z.literal('thread'), thread_id: appThreadIdV1Schema, revision }),
  z.strictObject({ kind: z.literal('source'), source_ref: z.string().regex(/^[A-Za-z0-9:_-]{1,256}$/), revision: revision.optional() }),
]);
export const appThreadAttachmentRefV1Schema = z.strictObject({ file_id: z.uuid(), revision });
export const appThreadSendV1Schema = z.strictObject({
  client_message_id: appThreadMessageIdV1Schema, expected_revision: revision,
  text: z.string().trim().min(1).max(4000), context_refs: z.array(appThreadContextRefV1Schema).max(16).default([]),
  attachment_refs: z.array(appThreadAttachmentRefV1Schema).max(16).default([]),
});
export const appThreadRoutesV1 = [
  { method: 'GET', path: '/app/v1/threads', query: appThreadListQueryV1Schema, response: appThreadListV1Schema, authenticated: true },
  { method: 'POST', path: '/app/v1/threads', request: appThreadCreateV1Schema, response: appThreadOperationResultV1Schema, authenticated: true },
  { method: 'GET', path: '/app/v1/threads/operations/{operation_id}', response: appThreadOperationResultV1Schema, authenticated: true },
  { method: 'GET', path: '/app/v1/threads/{thread_id}', query: appThreadReadQueryV1Schema, response: appThreadReadV1Schema, authenticated: true },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/archive', request: appThreadArchiveV1Schema, response: appThreadOperationResultV1Schema, authenticated: true },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/delete', request: appThreadDeleteV1Schema, response: appThreadOperationResultV1Schema, authenticated: true },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/cancel', request: appThreadDeleteV1Schema, response: appThreadOperationResultV1Schema, authenticated: true },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/messages', request: appThreadSendV1Schema, response: z.lazy(() => appSendResultV1Schema), authenticated: true, success_status: 202, max_request_bytes: APP_SEND_MAX_WIRE_BYTES },
  { method: 'GET', path: '/app/v1/threads/{thread_id}/messages/{client_message_id}', response: appThreadMessageReceiptV1Schema, authenticated: true },
  { method: 'GET', path: '/app/v1/threads/{thread_id}/events', query: appReplayQueryV1Schema, response: appReplayResultV1Schema, authenticated: true },
] as const;
export type AppThreadV1 = z.infer<typeof appThreadV1Schema>;
export type AppThreadSendV1 = z.infer<typeof appThreadSendV1Schema>;
export type AppThreadOperationResultV1 = z.infer<typeof appThreadOperationResultV1Schema>;
export type AppThreadMessageReceiptV1 = z.infer<typeof appThreadMessageReceiptV1Schema>;
