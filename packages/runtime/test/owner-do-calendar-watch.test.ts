import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { calendarPushBook } from '../src/channels/calendar-push';
import { verifyCalendarChannel } from '../src/connectors/google-push';
import { runOwnerJob } from './fixtures/owner-job';

const SECRET = 'router-secret-fixture-0000000000';
const watches = vi.hoisted(() => ({ bodies: [] as Record<string, string>[], status: 200 }));
vi.mock('../src/connectors/google', async load => {
  const original = await load<typeof import('../src/connectors/google')>();
  return { ...original,
    googleAccessToken: async () => 'ya29.fixture',
    googleClient: (_app: unknown, _tokens: unknown, _fetch: unknown, _health: unknown, account: unknown) => ({
      account, events: async () => [], calendarPage: async () => ({ events: [], next_page_token: null, fetched_count: 0, account, observed_at: new Date().toISOString() }),
      event: async () => null, changedEvents: async () => [], newMail: async () => [],
    }) };
});
vi.mock('../src/channels/telegram-api', async load => ({ ...await load<typeof import('../src/channels/telegram-api')>(), createTelegramCaller: () => async (method: string) => method === 'sendMessage' ? { message_id: 1, chat: { id: 7 } } : true }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('watch fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');

it('the update sweep starts a Calendar watch whose token routes back to this owner, and leaves a fresh one alone', async () => {
  const name = 'calendar-watch-owner';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input) === 'https://www.googleapis.com/calendar/v3/calendars/primary/events/watch') {
        const body = JSON.parse(String(init?.body)) as Record<string, string>;
        watches.bodies.push(body);
        return watches.status === 200 ? Response.json({ id: body.id, resourceId: 'res-1', expiration: String(Date.now() + 7 * 86_400_000) }) : new Response('{}', { status: watches.status });
      }
      return real(input, init);
    });
    const config = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture', GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret', WALDO_ROUTER_HMAC_SECRET: SECRET };
    const owner = new OwnerDO(state, config);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', [{ id: 'local:owner@example.test', email: 'owner@example.test', refresh_token: 'synthetic-offline-only', scopes: ['https://www.googleapis.com/auth/calendar.events'] }]);
    const fire = () => runOwnerJob(owner, 'briefs');
    try {
      await fire();
      expect(watches.bodies).toHaveLength(1);
      const [body] = watches.bodies;
      expect(body).toMatchObject({ type: 'web_hook', address: 'https://fixture.invalid/events/gcal' });
      expect(await verifyCalendarChannel(SECRET, body!.token!, body!.id!)).toBe(name);
      expect(calendarPushBook(state.storage.kv).state()).toMatchObject({ channelId: body!.id, resourceId: 'res-1' });
      await fire();
      expect(watches.bodies).toHaveLength(1);
    } finally { vi.unstubAllGlobals(); await state.storage.deleteAlarm(); }
  });
});
