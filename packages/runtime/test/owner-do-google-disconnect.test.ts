import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureSchema } from '../src/tracer/schema';

// A disconnect asks Google to revoke the grant, then deletes the secret whatever Google said, and records Google's answer
// as one word. Only a failed delete fails the disconnect, and then the account stays so the owner can try again.
const EMAIL = 'owner@example.test';
const TOKEN = '1//synthetic-local-refresh';
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const CONFIG = { TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: '7',
  GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: 'router-secret-fixture-0000000000',
  SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable' };

vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, payload: { chat_id?: number }) => method === 'sendMessage' ? { message_id: 1, chat: { id: payload.chat_id ?? 7 } } : true }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('disconnect fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');

const world = vi.hoisted(() => ({ calls: [] as string[], bodies: [] as string[], edge: (() => Response.json({ data: { provider: 'revoked' } })) as () => Response, rpc: (() => Response.json(true)) as () => Response, google: (() => new Response('{}', { status: 200 })) as () => Response, holders: [] as string[] }));
beforeEach(() => {
  world.calls = []; world.bodies = [];
  world.edge = () => Response.json({ data: { provider: 'revoked' } });
  world.rpc = () => Response.json(true);
  world.google = () => new Response('{}', { status: 200 });
  world.holders = ['conn-1'];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const raw = init?.body ? String(init.body) : '';
    world.bodies.push(raw);
    if (url === 'https://edge.test/functions/v1/connector-proxy') { world.calls.push(`edge:${String((JSON.parse(raw) as { op?: unknown }).op)}`); return world.edge(); }
    if (url === 'https://edge.test/rest/v1/rpc/connection_revoke') { world.calls.push('rpc:connection_revoke'); return world.rpc(); }
    if (url === 'https://edge.test/rest/v1/rpc/gmail_push_route') { world.calls.push('rpc:gmail_push_route'); return Response.json(world.holders.map((connection, n) => ({ do_name: `owner-${n}`, connection }))); }
    if (url === 'https://oauth2.googleapis.com/revoke') { world.calls.push('google:revoke'); return world.google(); }
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = Readonly<{ setup(channel?: string): Readonly<{ act(action: { action: string; id?: string }): Promise<boolean | string> }> }>;
const disconnecting = async (name: string, account: Record<string, unknown>, run: (owner: Owner, state: DurableObjectState) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    ensureSchema(state.storage);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [account]);
    try { await run(new OwnerDO(state, { ...env, ...CONFIG }) as unknown as Owner, state); } finally { await state.storage.deleteAlarm(); }
  });
};
// The revocation traffic only: a runtime build also reads Google in the background.
const revoking = () => world.calls.filter(call => call !== 'edge:call');
const hops = (state: DurableObjectState) => state.storage.sql.exec<{ hop: string; ok: number; note: string | null }>("SELECT hop, ok, note FROM trace_log WHERE hop = 'google_disconnect'").toArray();
const traces = (state: DurableObjectState) => JSON.stringify(state.storage.sql.exec('SELECT * FROM trace_log').toArray());

describe('disconnecting Google', () => {
  it.each([
    ['revoked', true],
    ['already_invalid', true],
    ['failed', false],
    ['not_held', false],
  ] as const)('a Vault-held grant is revoked at Google before its secret is deleted, and the outcome %s is recorded', async (outcome, ok) => {
    world.edge = () => Response.json({ data: { provider: outcome } });
    await disconnecting(`disconnect-vault-${outcome}`, { id: 'conn-1', email: EMAIL, scopes: [CALENDAR] }, async (owner, state) => {
      expect(await owner.setup('telegram').act({ action: 'google.disconnect', id: 'conn-1' })).toBe(true);
      expect(revoking()).toEqual(['rpc:gmail_push_route', 'edge:revoke', 'rpc:connection_revoke']);
      expect(await state.storage.get('google:accounts')).toEqual([]);
      expect(hops(state)).toEqual([{ hop: 'google_disconnect', ok: ok ? 1 : 0, note: outcome }]);
      expect(traces(state)).not.toContain(EMAIL);
    });
  });

  it('an edge that predates the revoke operation still deletes the secret, and says Google was not asked', async () => {
    world.edge = () => Response.json({ error: { status: 404, message: 'unknown operation' } });
    await disconnecting('disconnect-old-edge', { id: 'conn-1', email: EMAIL, scopes: [CALENDAR] }, async (owner, state) => {
      expect(await owner.setup('telegram').act({ action: 'google.disconnect', id: 'conn-1' })).toBe(true);
      expect(revoking()).toEqual(['rpc:gmail_push_route', 'edge:revoke', 'rpc:connection_revoke']);
      expect(await state.storage.get('google:accounts')).toEqual([]);
      expect(hops(state)).toEqual([{ hop: 'google_disconnect', ok: 0, note: 'unavailable' }]);
    });
  });

  it('a mailbox another owner also connected is not revoked at Google, so their grant keeps working; the secret is still deleted', async () => {
    world.holders = ['conn-1', 'conn-other'];
    await disconnecting('disconnect-shared', { id: 'conn-1', email: EMAIL, scopes: [CALENDAR] }, async (owner, state) => {
      expect(await owner.setup('telegram').act({ action: 'google.disconnect', id: 'conn-1' })).toBe(true);
      expect(revoking()).toEqual(['rpc:gmail_push_route', 'rpc:connection_revoke']);
      expect(await state.storage.get('google:accounts')).toEqual([]);
      expect(hops(state)).toEqual([{ hop: 'google_disconnect', ok: 0, note: 'shared' }]);
    });
  });

  it('a delete the database refuses fails the disconnect and keeps the account for another try', async () => {
    world.rpc = () => new Response('down', { status: 503 });
    await disconnecting('disconnect-delete-refused', { id: 'conn-1', email: EMAIL, scopes: [CALENDAR] }, async (owner, state) => {
      await expect(owner.setup('telegram').act({ action: 'google.disconnect', id: 'conn-1' })).rejects.toThrow();
      expect(revoking()).toEqual(['rpc:gmail_push_route', 'edge:revoke', 'rpc:connection_revoke']);
      expect(await state.storage.get('google:accounts')).toEqual([expect.objectContaining({ id: 'conn-1' })]);
    });
  });

  it('a grant this object holds itself is revoked at Google directly, and forgotten whatever Google says', async () => {
    for (const [outcome, google] of [['revoked', () => new Response('{}', { status: 200 })], ['failed', () => new Response('upstream', { status: 503 })]] as const) {
      world.calls = []; world.bodies = []; world.google = google;
      await disconnecting(`disconnect-local-${outcome}`, { id: `local:${EMAIL}`, email: EMAIL, scopes: [CALENDAR], refresh_token: TOKEN }, async (owner, state) => {
        expect(await owner.setup('telegram').act({ action: 'google.disconnect', id: `local:${EMAIL}` })).toBe(true);
        expect(revoking()).toEqual(['google:revoke']);
        expect(new URLSearchParams(world.bodies.find(body => body.includes('token=')) ?? '').get('token')).toBe(TOKEN);
        expect(await state.storage.get('google:accounts')).toEqual([]);
        expect(hops(state)).toEqual([{ hop: 'google_disconnect', ok: outcome === 'revoked' ? 1 : 0, note: outcome }]);
        expect(traces(state)).not.toContain(TOKEN);
      });
    }
  });
});
