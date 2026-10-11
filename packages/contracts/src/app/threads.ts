import { z } from 'zod';
import {
  APP_SEND_MAX_WIRE_BYTES, appHistoryResultV1Schema, appMessageReceiptV1Schema,
  appRatingRequestV1Schema, appRatingResultV1Schema, appSendRequestV1Schema, appSendResultV1Schema,
} from './core';

// A thread is a chat beside main: its own transcript, sharing the owner's memory and approvals. Messaging
// surfaces and proactive messages use main only. Deleting a thread erases its transcript and recall index;
// what Waldo learned in it stays in memory, where the owner can correct it.
export const APP_THREAD_MAX_V1 = 256;
export const appThreadIdV1Schema = z.string().regex(/^thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
const revision = z.int().positive();
const at = z.int().nonnegative();
const operation = z.uuid();
const title = z.string().trim().min(1).max(200);
export const appThreadStateV1Schema = z.enum(['active', 'archived', 'deleted']);
// `revision` fences the running turn: archive, unarchive and delete change it and stop that turn. Renaming
// changes only `title_revision`, so it never stops a reply. A null title is untitled; the model may name an
// untitled thread once, which changes title_revision, so a rename racing it gets 409 and rereads. Titles are
// model or owner text and render as plain text. Times are epoch ms; last_activity_at moves only forward.
export const appThreadV1Schema = z.strictObject({
  thread_id: appThreadIdV1Schema, title: z.string().min(1).max(200).nullable(), revision, title_revision: revision,
  state: appThreadStateV1Schema, created_at: at, last_activity_at: at,
});
export const appThreadCreateV1Schema = z.strictObject({ operation_id: operation, title: title.optional() });
export const appThreadRenameV1Schema = z.strictObject({ operation_id: operation, expected_title_revision: revision, title });
export const appThreadArchiveV1Schema = z.strictObject({ operation_id: operation, expected_revision: revision, archived: z.boolean() });
export const appThreadDeleteV1Schema = z.strictObject({ operation_id: operation, expected_revision: revision });
// Repeating an operation_id with the same request returns its first result; with a different request, 409.
export const appThreadOperationResultV1Schema = z.strictObject({
  operation_id: operation, state: z.literal('recorded'), thread_id: appThreadIdV1Schema, revision, title_revision: revision,
  thread_state: appThreadStateV1Schema, erased_messages: z.int().nonnegative().optional(),
});
// Every live thread in one page, newest last_activity_at first, then thread_id. Deleted threads are not listed.
export const appThreadListQueryV1Schema = z.strictObject({ state: z.enum(['active', 'archived', 'all']).optional() });
export const appThreadListV1Schema = z.strictObject({ threads: z.array(appThreadV1Schema).max(APP_THREAD_MAX_V1) });
export const appThreadReadQueryV1Schema = z.strictObject({
  cursor: z.string().max(512).regex(/^(?:\d{1,9}|before:.{1,500})$/).optional(), limit: z.coerce.number().int().min(1).max(50).optional(),
});
export const appThreadReadV1Schema = z.strictObject({ thread: appThreadV1Schema, history: appHistoryResultV1Schema });
export const appThreadSendV1Schema = appSendRequestV1Schema.extend({ expected_revision: revision });
// Failures carry `error`: thread_not_found and message_not_found (404), thread_deleted (410), thread_revision_conflict,
// title_revision_conflict, thread_archived and operation_conflict (409), thread_capacity (429).
export const appThreadRoutesV1 = [
  { method: 'GET', path: '/app/v1/threads', query: appThreadListQueryV1Schema, response: appThreadListV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/threads', request: appThreadCreateV1Schema, response: appThreadOperationResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'GET', path: '/app/v1/threads/operations/{operation_id}', response: appThreadOperationResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'GET', path: '/app/v1/threads/{thread_id}', query: appThreadReadQueryV1Schema, response: appThreadReadV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/rename', request: appThreadRenameV1Schema, response: appThreadOperationResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/archive', request: appThreadArchiveV1Schema, response: appThreadOperationResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/delete', request: appThreadDeleteV1Schema, response: appThreadOperationResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/messages', request: appThreadSendV1Schema, response: appSendResultV1Schema, authenticated: true, success_status: 202, max_request_bytes: APP_SEND_MAX_WIRE_BYTES },
  { method: 'GET', path: '/app/v1/threads/{thread_id}/messages/{client_message_id}', response: appMessageReceiptV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/threads/{thread_id}/messages/{client_message_id}/cancel', response: appMessageReceiptV1Schema, authenticated: true, success_status: 200 },
  { method: 'PUT', path: '/app/v1/threads/{thread_id}/messages/{message_id}/rating', request: appRatingRequestV1Schema, response: appRatingResultV1Schema, authenticated: true, success_status: 200 },
] as const;

export type AppThreadV1 = z.infer<typeof appThreadV1Schema>;
export type AppThreadSendV1 = z.infer<typeof appThreadSendV1Schema>;
export type AppThreadOperationResultV1 = z.infer<typeof appThreadOperationResultV1Schema>;
