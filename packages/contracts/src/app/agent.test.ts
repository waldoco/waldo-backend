import { describe, expect, it, vi } from 'vitest';
import { appSendRequestV1Schema, appSessionV1Schema, buildAppOpenApiV1 } from './agent';
import { createAppClientV1 } from './client';

describe('served app contracts', () => {
  it('rejects client routing fields and binds stable session/account refs', () => {
    expect(appSendRequestV1Schema.safeParse({ client_message_id: 'client-0001', text: 'hello', owner: 'other' }).success).toBe(false);
    expect(appSessionV1Schema.safeParse({ state: 'active', session_ref: null, surface: 'app' }).success).toBe(false);
    expect(Object.keys(buildAppOpenApiV1().paths)).toHaveLength(6);
  });
  it('validates replies and requires authenticated transport', async () => {
    const transport = vi.fn(async (request: { authenticated: boolean }) => {
      expect(request.authenticated).toBe(true);
      return { status: 200, body: { state: 'active', session_ref: null } };
    });
    const client = createAppClientV1(transport);
    await expect(client.request('/app/v1/session')).rejects.toThrow();
    expect(transport).toHaveBeenCalledOnce();
  });
});
