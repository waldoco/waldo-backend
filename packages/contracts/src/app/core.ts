import { z } from 'zod';
import {
  replyApprovalPartV1Schema, replyChartSeriesPartV1Schema, replyFilePartV1Schema, replyQuickRepliesPartV1Schema,
  replyVisibilityV1Schema, replyVoicePartV1Schema,
} from './parts';

export const APP_AGENT_VERSION = 'app.v1' as const;
export const APP_SEND_MAX_WIRE_BYTES = 32768;
export const appJsonWireBytes = (value: unknown): number => {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) return Infinity;
  let bytes = 0;
  for (const character of serialized) { const point = character.codePointAt(0)!; bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4; }
  return bytes;
};
export const appSendWireFits = (value: unknown): boolean => appJsonWireBytes(value) <= APP_SEND_MAX_WIRE_BYTES;
export const appCodeRequestSchema = z.strictObject({ email: z.email().max(254) });
export const appCodeResultSchema = z.strictObject({ ok: z.literal(true) });
export const appVerifyRequestV1Schema = z.strictObject({ email: z.email().max(254), code: z.string().regex(/^\d{4,10}$/) });
export const appSessionV1Schema = z.strictObject({
  state: z.literal('active'), session_ref: z.string().regex(/^sess_[a-f0-9]{64}$/),
  account_ref: z.string().regex(/^acct_[a-f0-9]{64}$/), surface: z.literal('app'),
  absolute_expires_at: z.int().nonnegative(),
});
export const appVerifyResultV1Schema = z.union([
  appSessionV1Schema.extend({ credential: z.string().min(20).max(512) }),
  z.strictObject({ state: z.literal('needs_invite') }),
]);
export const appSignoutResultV1Schema = z.strictObject({ result: z.enum(['revoked', 'already_gone']) });
export const appSendRequestV1Schema = z.strictObject({
  client_message_id: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/), text: z.string().trim().min(1).max(4000),
});
export const appSendResultV1Schema = z.strictObject({
  accepted: z.literal(true), message_id: z.string().min(1),
  state: z.enum(['admitted', 'running', 'completed', 'interrupted', 'revoked']).optional(),
});
export const appMessageReceiptV1Schema=appSendResultV1Schema.extend({state:z.enum(['admitted','running','completed','interrupted','revoked']),closed_reason:z.enum(['interrupted','session_revoked','cancelled','archived','deleted','thread_changed']).optional(),effects_unconfirmed:z.boolean().optional()});
export const appMessagePartV1Schema = z.union([
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('operation'), operation_id: z.string(), state: z.enum(['admitted', 'running', 'completed', 'interrupted', 'revoked']), message: z.string() }),
  z.strictObject({ type: z.literal('artifact'), artifact_id: z.string(), revision: z.int().positive(), title: z.string(), download_path: z.string() }),
  replyApprovalPartV1Schema, replyQuickRepliesPartV1Schema, replyChartSeriesPartV1Schema, replyFilePartV1Schema, replyVoicePartV1Schema,
]);
export const appMessageV1Schema = z.strictObject({
  id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), parts: z.array(appMessagePartV1Schema),
  channel: z.string(), parent_id: z.string().nullable(), visibility: replyVisibilityV1Schema.optional(),
});
export const appHistoryResultV1Schema = z.strictObject({ messages: z.array(appMessageV1Schema), next_cursor: z.string().nullable() });
// Codes name the non-generic failures a client can act on. The generic error stays code-free, so a
// pre-authentication answer cannot say whether an address is invited.
export const appErrorCodeV1Schema = z.enum(['client_message_id_reused', 'inbox_full', 'request_reused', 'stale_read', 'no_longer_eligible', 'receipt_capacity']);
export const appProblemV1Schema = z.strictObject({ error: z.string(), code: appErrorCodeV1Schema.optional(), message: z.string().max(1000).optional() })
  .refine(problem => problem.error !== 'unavailable' || problem.code === undefined, { error: 'the generic error carries no code', path: ['code'] });
export const appCoreRoutesV1 = [
  { method: 'POST', path: '/app/v1/auth/code', request: appCodeRequestSchema, response: appCodeResultSchema, authenticated: false, success_status: 200 },
  { method: 'POST', path: '/app/v1/auth/verify', request: appVerifyRequestV1Schema, response: appVerifyResultV1Schema, authenticated: false, success_status: 200 },
  { method: 'GET', path: '/app/v1/session', response: appSessionV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/auth/signout', response: appSignoutResultV1Schema, authenticated: true, success_status: 200 },
  { method:'GET', path:'/app/v1/chat/main/messages/{client_message_id}',response:appMessageReceiptV1Schema,authenticated:true,success_status:200 },
  { method: 'GET', path: '/app/v1/chat/main', response: appHistoryResultV1Schema, authenticated: true, success_status: 200 },
  { method: 'POST', path: '/app/v1/chat/main/messages', request: appSendRequestV1Schema, response: appSendResultV1Schema, authenticated: true, success_status: 202, max_request_bytes: APP_SEND_MAX_WIRE_BYTES },
] as const;

export type AppSessionV1 = z.infer<typeof appSessionV1Schema>;
export type AppSendV1 = z.infer<typeof appSendRequestV1Schema>;
export type AppMessageV1 = z.infer<typeof appMessageV1Schema>;
