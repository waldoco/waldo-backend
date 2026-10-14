import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { gmailPushBook } from '../src/channels/gmail-push';
import { runOwnerJob } from './fixtures/owner-job';

const proxied = vi.hoisted(() => ({ ops: [] as Record<string, unknown>[] }));
vi.mock('../src/connectors/google-push', async load => {
  const original = await load<typeof import('../src/connectors/google-push')>();
  return { ...original, gmailPush: () => original.gmailPush('waldo-dev') };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string) => method === 'sendMessage' ? { message_id: 1, chat: { id: 7 } } : true }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('watch fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');

it('the update sweep starts a Gmail watch into the push topic for a Vault-backed mailbox', async () => {
  const name = 'gmail-watch-owner';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://edge.test/functions/v1/connector-proxy') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        proxied.ops.push(body);
        return Response.json(body.op === 'gmail_watch' ? { data: { historyId: '555', expiration: Date.now() + 7 * 86_400_000 } } : { error: { status: 404, message: 'unknown operation' } });
      }
      return real(input, init);
    });
    const config = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
      WALDO_ROUTER_HMAC_SECRET: 'router-secret-fixture-0000000000', SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'k' };
    const owner = new OwnerDO(state, config);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'conn-1', email: 'owner@example.test', scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'] }]);
    const fire = () => runOwnerJob(owner, 'briefs');
    try {
      await fire();
      const watches = proxied.ops.filter((op) => op.op === 'gmail_watch');
      expect(watches).toEqual([{ do_name: name, op: 'gmail_watch', connection: 'conn-1', topic: 'projects/waldo-dev/topics/waldo-gmail-push' }]);
      expect(gmailPushBook(state.storage.kv).admit('conn-1', '556')).toBe('wake');
      await fire();
      expect(proxied.ops.filter((op) => op.op === 'gmail_watch')).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); await state.storage.deleteAlarm(); }
  });
});
