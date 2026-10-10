import { expect, it } from 'vitest';
import { appProtectedHealthPartV1Schema, appProtectedResponseQueryV1Schema, appProtectedResponseV1Schema } from './protected';
import { buildAppOpenApiV1 } from './agent';
it('protected message parts reject response text and expose the authenticated explicit-query route', () => {
  const part = { type: 'protected_health', response_ref: `hresp_${'a'.repeat(32)}`, readback_path: `/app/v1/chat/protected-responses/hresp_${'a'.repeat(32)}?conversation_ref=owner`, expires_at: 100, retention: 'volatile', state: 'available_until_expiry' };
  expect(appProtectedHealthPartV1Schema.safeParse(part).success).toBe(true);
  expect(appProtectedHealthPartV1Schema.safeParse({ ...part, text: 'Synthetic raw health' }).success).toBe(false);
  expect(appProtectedResponseQueryV1Schema.safeParse({ conversation_ref: 'owner', principal_ref: 'forged' }).success).toBe(false);
  const path = buildAppOpenApiV1().paths['/app/v1/chat/protected-responses/{response_ref}']!.get as { security: unknown[]; parameters: { name: string; required: boolean }[] };
  expect(path.security).toHaveLength(1); expect(path.parameters.some(row => row.name === 'conversation_ref' && row.required)).toBe(true);
  expect(appProtectedResponseV1Schema.safeParse({ version: 1, response_ref: part.response_ref, conversation_ref: 'owner', state: 'available', text: 'Synthetic raw health', expires_at: 100, retention: 'volatile' }).success).toBe(true);
});
