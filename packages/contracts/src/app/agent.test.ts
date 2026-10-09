import { describe, expect, it, vi } from 'vitest';
import { APP_SEND_MAX_WIRE_BYTES, appJsonWireBytes, appSendWireFits, appCoreRoutesV1, appSendRequestV1Schema, appSessionV1Schema, buildAppOpenApiV1 } from './agent';
import { createAppClientV1 } from './client';

describe('served app contracts', () => {
  it('rejects client routing fields and binds stable session/account refs', () => {
    expect(appSendRequestV1Schema.safeParse({ client_message_id: 'client-0001', text: 'hello', owner: 'other' }).success).toBe(false);
    expect(appSessionV1Schema.safeParse({ state: 'active', session_ref: null, surface: 'app' }).success).toBe(false);
    expect(appCoreRoutesV1).toHaveLength(6);
    expect(buildAppOpenApiV1().paths['/app/v1/files']).toHaveProperty('get');
    expect(buildAppOpenApiV1().paths['/app/v1/files']).toHaveProperty('post');
    const files = buildAppOpenApiV1().paths['/app/v1/files']! as { get: { parameters: { name: string; required: boolean }[] }; post: { requestBody: { content: { 'multipart/form-data': { schema: { required: string[] } } } } } };
    expect(files.post.requestBody.content['multipart/form-data'].schema.required).toContain('file');
    expect(files.get.parameters.find(parameter => parameter.name === 'limit')?.required).toBe(false);
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
  it('accepts a full unicode envelope and distinguishes send admission status', async () => {
    const payload = { client_message_id: 'client-0001', text: '漢'.repeat(4000) };
    expect(appSendRequestV1Schema.safeParse(payload).success).toBe(true);
    expect(appJsonWireBytes(payload)).toBeGreaterThan(8192);
    expect(appSendWireFits(payload)).toBe(true);
    expect(appJsonWireBytes(payload)).toBeLessThan(APP_SEND_MAX_WIRE_BYTES);
    const client = createAppClientV1(async () => ({ status: 200, body: { accepted: true, message_id: 'op' } }));
    await expect(client.request('/app/v1/chat/main/messages', payload)).rejects.toThrow('200');
  });
});
