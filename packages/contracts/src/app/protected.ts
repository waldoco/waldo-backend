import { z } from 'zod';

export const appProtectedResponseRefV1Schema = z.string().regex(/^hresp_[a-f0-9]{32}$/);
export const appProtectedResponseQueryV1Schema = z.strictObject({
  conversation_ref: z.string().min(1).max(256).refine(value => !/[\u0000-\u001f]/.test(value)),
});
// This durable part contains no protected response body or physiological values.
export const appProtectedHealthPartV1Schema = z.strictObject({
  type: z.literal('protected_health'), response_ref: appProtectedResponseRefV1Schema,
  readback_path: z.string().regex(/^\/app\/v1\/chat\/protected-responses\/hresp_[a-f0-9]{32}\?conversation_ref=/),
  expires_at: z.int().nonnegative(), retention: z.literal('volatile'),
  state: z.literal('available_until_expiry'),
});
export const appProtectedResponseV1Schema = z.strictObject({
  version: z.literal(1), response_ref: appProtectedResponseRefV1Schema,
  conversation_ref: appProtectedResponseQueryV1Schema.shape.conversation_ref,
  state: z.literal('available'), text: z.string().min(1).max(32768),
  expires_at: z.int().nonnegative(), retention: z.literal('volatile'),
});
export type AppProtectedHealthPartV1 = z.infer<typeof appProtectedHealthPartV1Schema>;
export type AppProtectedResponseV1 = z.infer<typeof appProtectedResponseV1Schema>;
