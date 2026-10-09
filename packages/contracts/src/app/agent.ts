import { z } from 'zod';

export const APP_AGENT_VERSION = 'app.v1' as const;
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
export const appMessagePartV1Schema = z.union([
  z.strictObject({ type: z.literal('text'), text: z.string() }),
  z.strictObject({ type: z.literal('operation'), operation_id: z.string(), state: z.enum(['admitted', 'running', 'completed', 'interrupted', 'revoked']), message: z.string() }),
  z.strictObject({ type: z.literal('artifact'), artifact_id: z.string(), revision: z.int().positive(), title: z.string(), download_path: z.string() }),
]);
export const appMessageV1Schema = z.strictObject({
  id: z.string(), role: z.enum(['user', 'assistant']), text: z.string(), parts: z.array(appMessagePartV1Schema),
  channel: z.string(), parent_id: z.string().nullable(),
});
export const appHistoryResultV1Schema = z.strictObject({ messages: z.array(appMessageV1Schema), next_cursor: z.string().nullable() });
export const appProblemV1Schema = z.strictObject({ error: z.string() });
export const appRoutesV1 = [
  { method: 'POST', path: '/app/v1/auth/code', request: appCodeRequestSchema, response: appCodeResultSchema, authenticated: false },
  { method: 'POST', path: '/app/v1/auth/verify', request: appVerifyRequestV1Schema, response: appVerifyResultV1Schema, authenticated: false },
  { method: 'GET', path: '/app/v1/session', response: appSessionV1Schema, authenticated: true },
  { method: 'POST', path: '/app/v1/auth/signout', response: appSignoutResultV1Schema, authenticated: true },
  { method: 'GET', path: '/app/v1/chat/main', response: appHistoryResultV1Schema, authenticated: true },
  { method: 'POST', path: '/app/v1/chat/main/messages', request: appSendRequestV1Schema, response: appSendResultV1Schema, authenticated: true },
] as const;
export const buildAppOpenApiV1 = () => ({
  openapi: '3.1.0', info: { title: 'Waldo owner app API', version: APP_AGENT_VERSION },
  components: { securitySchemes: { appBearer: { type: 'http', scheme: 'bearer' } } },
  paths: Object.fromEntries(appRoutesV1.map(route => [route.path, {
    [route.method.toLowerCase()]: {
      security: route.authenticated ? [{ appBearer: [] }] : [],
      ...('request' in route ? { requestBody: { required: true, content: { 'application/json': { schema: z.toJSONSchema(route.request) } } } } : {}),
      responses: { '200': { description: 'Current owner result', content: { 'application/json': { schema: z.toJSONSchema(route.response) } } },
        '202': { description: 'Durable admission; execution and delivery remain separate', content: { 'application/json': { schema: z.toJSONSchema(route.response) } } },
        '401': { description: 'Session expired or revoked' }, '409': { description: 'Revision or idempotency conflict' }, '503': { description: 'Unavailable or unconfirmed' } },
    },
  }])),
});
export type AppSessionV1 = z.infer<typeof appSessionV1Schema>;
export type AppSendV1 = z.infer<typeof appSendRequestV1Schema>;
