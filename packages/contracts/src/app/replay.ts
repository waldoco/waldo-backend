import { z } from 'zod';
import { appMessageV1Schema } from './core';

export const appReplayQueryV1Schema = z.strictObject({
  cursor: z.string().regex(/^\d{1,15}$/).optional(), limit: z.coerce.number().int().min(1).max(100).optional(),
});
export const appReplayEventV1Schema = z.strictObject({
  sequence: z.int().positive(), type: z.literal('message'), message: appMessageV1Schema,
  occurred_at: z.int().nonnegative(), approval_ids: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,80}$/)),
});
export const appReplayResultV1Schema = z.strictObject({
  version: z.literal(1), events: z.array(appReplayEventV1Schema), next_cursor: z.string().regex(/^\d{1,15}$/),
});
export const appReplayRoutesV1 = [
  { method: 'GET', path: '/app/v1/chat/main/events', query: appReplayQueryV1Schema, response: appReplayResultV1Schema, authenticated: true, success_status: 200 },
] as const;
export type AppReplayResultV1 = z.infer<typeof appReplayResultV1Schema>;
