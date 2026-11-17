// The app's chat upload route at the Worker (APP_CHAT_ATTACHMENTS): absent when off, authenticated, on its own per-owner
// budget, bounded at the attachment cap before it reads, and handing the owner object the bytes and their declared kind.
import { beforeEach, describe, expect, it } from 'vitest';
import { APP_CHAT_UPLOAD_MAX_BYTES, APP_CHAT_UPLOAD_PATH } from '../../contracts/src/app/core';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const seen = { keys: [] as string[], forwarded: [] as { url: string; headers: Record<string, string>; bytes: number }[], allow: true };
const env = (switches: Record<string, string> = { APP_CHAT_ATTACHMENTS: '1' }) => ({
  ...switches,
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async (request: Request) => {
    seen.forwarded.push({ url: request.url, headers: Object.fromEntries(request.headers), bytes: (await request.arrayBuffer()).byteLength });
    return Response.json({ upload_id: `up_${'C'.repeat(22)}`, kind: 'photo', bytes: 3, expires_at: 1 }, { status: 201 });
  } }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async ({ key }: { key: string }) => { seen.keys.push(key); return { success: seen.allow }; } },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
}) as never;
beforeEach(() => { seen.keys = []; seen.forwarded = []; seen.allow = true; });

const post = (body: BodyInit, headers: Record<string, string> = {}, switches?: Record<string, string>) => handleApp(new Request(`https://w.test${APP_CHAT_UPLOAD_PATH}`, {
  method: 'POST', body, headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'image/png', 'x-waldo-upload-kind': 'photo', 'x-waldo-upload-name': 'shot.png', ...headers },
}), env(switches), auth) as Promise<Response>;

describe('the chat upload route', () => {
  it('hands the owner object the bytes, kind, name and type of an authenticated upload, on its own budget', async () => {
    const response = await post(new Uint8Array([1, 2, 3]));
    expect(response.status).toBe(201);
    expect(seen.keys).toEqual(['app-upload:owner-1']);
    expect(seen.forwarded).toHaveLength(1);
    expect(seen.forwarded[0]).toMatchObject({ url: `https://telegram-owner${APP_CHAT_UPLOAD_PATH}`, bytes: 3,
      headers: expect.objectContaining({ 'x-waldo-do-name': 'owner-1', 'content-type': 'image/png', 'x-waldo-upload-kind': 'photo', 'x-waldo-upload-name': 'shot.png' }) });
    expect(seen.forwarded[0]!.headers['x-waldo-app-session-hash']).toMatch(/^[a-f0-9]{64}$/);
    expect(seen.forwarded[0]!.headers.authorization).toBeUndefined();
  });

  it('is not there with the switch off, and refuses without a credential, over the limit, or past the cap', async () => {
    expect((await post(new Uint8Array([1]), {}, { APP_CHAT_ATTACHMENTS: '0' })).status).toBe(404);
    expect((await post(new Uint8Array([1]), { authorization: 'Bearer nope-not-a-credential-at-all' })).status).toBe(401);
    seen.allow = false;
    expect((await post(new Uint8Array([1]))).status).toBe(429);
    seen.allow = true;
    expect((await post(new Uint8Array([1]), { 'content-length': String(APP_CHAT_UPLOAD_MAX_BYTES + 1) })).status).toBe(413);
    expect((await post(new Uint8Array(APP_CHAT_UPLOAD_MAX_BYTES + 1))).status).toBe(413);
    expect(seen.forwarded).toEqual([]);
  });
});
