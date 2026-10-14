import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi, type MockInstance } from 'vitest';
import { calendarPushBook } from '../src/channels/calendar-push';
import { GOOGLE_FINISH_PATH } from '../src/channels/google-oauth';
import { startConsent, type ConsentFlow } from '../src/connectors/google-consent';

const MAIL = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.compose'];
const CALENDAR = 'https://www.googleapis.com/auth/calendar.events';
const EMAIL = 'owner@example.test';
const DAY = 86_400_000;
const edge = vi.hoisted(() => ({ ops: [] as Record<string, unknown>[], exchange: { id: '', scopes: [] as string[] } }));
vi.mock('../src/connectors/google-push', async load => {
  const original = await load<typeof import('../src/connectors/google-push')>();
  return { ...original, gmailPush: () => original.gmailPush('waldo-dev') };
});
// A locally held refresh token resolves to a bearer route without reaching Google.
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
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('rearm fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');

// The connector-proxy edge: the consent exchange answers with the grant the test names; watches and reads succeed.
const answer = (body: Record<string, unknown>): unknown => {
  edge.ops.push(body);
  if (body.op === 'exchange') return { id: edge.exchange.id, email: EMAIL, scopes: edge.exchange.scopes };
  if (body.op === 'gmail_watch') return { data: { historyId: '555', expiration: Date.now() + 7 * DAY } };
  if (body.op === 'calendar_watch') return { data: { channelId: body.channel_id, resourceId: 'res-1', expiration: Date.now() + 7 * DAY } };
  if (body.op === 'call') return { data: [] };
  return { error: { status: 404, message: 'unknown operation' } };
};

const lines = (logs: MockInstance, hop: string) => logs.mock.calls.flatMap(([raw]) => {
  if (typeof raw !== 'string' || !raw.startsWith('{')) return [];
  try { const json = JSON.parse(raw) as Record<string, unknown>; return json.hop === hop ? [{ raw, json }] : []; } catch { return []; }
});

type World = Readonly<{
  state: DurableObjectState; logs: MockInstance;
  sweep(): Promise<void>; reconnect(id: string, scopes: string[]): Promise<void>; push(connection: string, history: string): Promise<'wake' | 'ignore'>;
  watches(op: 'gmail_watch' | 'calendar_watch'): unknown[];
}>;

const world = async (name: string, accounts: unknown[], run: (world: World) => Promise<void>) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => String(input) === 'https://edge.test/functions/v1/connector-proxy'
      ? Response.json(answer(JSON.parse(String(init?.body)) as Record<string, unknown>)) : real(input, init));
    const logs = vi.spyOn(console, 'log');
    const config = { ...env, WALDO_OWNER_TELEGRAM_ID: '7', WALDO_OWNER_TIMEZONE: 'UTC', TELEGRAM_BOT_TOKEN: '7:synthetic-fixture', OPENAI_API_KEY: 'synthetic-fixture',
      GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret',
      WALDO_ROUTER_HMAC_SECRET: 'router-secret-fixture-0000000000', SUPABASE_PROJECT_URL: 'https://edge.test', SUPABASE_PUBLISHABLE_KEY: 'k' };
    const owner = new OwnerDO(state, config);
    state.storage.kv.put('do_name', name); state.storage.kv.put('telegram_subject', '7');
    await state.storage.put('origin', 'https://fixture.invalid');
    await state.storage.put('google:accounts', accounts);
    let seq = 900;
    // The update sweep's own closure, driven the way the harness command fires it.
    const sweep = async () => expect((await owner.fetch(new Request('https://owner.invalid/turn', { method: 'POST', body: JSON.stringify({ update_id: seq++, message: { message_id: seq, from: { id: 7, is_bot: false }, chat: { id: 7, type: 'private' }, text: '/fire briefs' } }) }))).status).toBe(200);
    // The owner connects Google again: one consent attempt, settled through the owner object's own finish route.
    const reconnect = async (id: string, scopes: string[]) => {
      edge.exchange = { id, scopes };
      const store = { read: async () => (await state.storage.get<Record<string, ConsentFlow>>('google:consents')) ?? {}, write: (flows: Record<string, ConsentFlow>) => state.storage.put('google:consents', flows) };
      const { nonce } = await startConsent({ store, now: () => Date.now() }, { clientId: 'synthetic-client', clientSecret: 'synthetic-secret', redirectUri: 'https://fixture.invalid/oauth/google/callback' }, 'state-secret-fixture', '7');
      const reply = await owner.fetch(new Request(`https://owner.invalid${GOOGLE_FINISH_PATH}`, { method: 'POST', body: JSON.stringify({ nonce, code: 'synthetic-code', error: null }) }));
      expect((await reply.json() as { outcome: { kind: string } }).outcome.kind).toBe('linked');
    };
    // Only an admitted push logs its sweep wake.
    const push = async (connection: string, history: string) => {
      const before = lines(logs, 'gmail_push').length;
      expect((await owner.fetch(new Request('https://owner.invalid/gmail-push', { method: 'POST', headers: { 'x-waldo-gmail-connection': connection, 'x-waldo-gmail-history': history } }))).status).toBe(200);
      return lines(logs, 'gmail_push').length > before ? 'wake' as const : 'ignore' as const;
    };
    const watches = (op: 'gmail_watch' | 'calendar_watch') => edge.ops.filter((body) => body.op === op && body.do_name === name).map((body) => body.connection);
    try { await run({ state, logs, sweep, reconnect, push, watches }); } finally { logs.mockRestore(); vi.unstubAllGlobals(); await state.storage.deleteAlarm(); }
  });
};

it('a reconnect re-arms a Gmail watch that a locally held grant skipped, says why it skipped, and clears a Calendar failure', async () => {
  await world('gmail-rearm-local-rail', [{ id: `local:${EMAIL}`, email: EMAIL, refresh_token: 'synthetic-offline-only', scopes: MAIL }], async ({ state, logs, sweep, reconnect, push, watches }) => {
    await sweep();
    expect(watches('gmail_watch')).toEqual([]);
    // The mail-only grant covers no calendar, so the Calendar watch stored a failure.
    expect(calendarPushBook(state.storage.kv).state()).toEqual({ failedAt: expect.any(Number) });
    await reconnect('conn-2', MAIL);
    expect.soft(calendarPushBook(state.storage.kv).state(), 'the keep clears a Calendar failure').toBeNull();
    await sweep();
    expect.soft(watches('gmail_watch'), 'the next sweep watches with the new connection').toEqual(['conn-2']);
    await sweep();
    expect.soft(watches('gmail_watch'), 'a fresh watch is left alone').toEqual(['conn-2']);
    const mail = lines(logs, 'gmail_watch');
    expect.soft(mail.map(({ json }) => json), 'a skip is logged once with its reason; a fresh sweep is silent').toEqual([
      expect.objectContaining({ ok: false, code: 'gmail_watch_skipped:local_rail' }),
      expect.objectContaining({ ok: true, code: 'gmail_watch_started' }),
    ]);
    for (const { raw } of mail) expect(raw).not.toMatch(/@|local:|conn-/);
    expect.soft(await push('conn-2', '556'), 'a push for the new connection wakes the sweep').toBe('wake');
  });
});

it('a reconnect that changes the connection moves the Gmail watch and its pushes to it, and leaves a live Calendar channel alone', async () => {
  await world('gmail-rearm-new-connection', [{ id: 'conn-1', email: EMAIL, scopes: [...MAIL, CALENDAR] }], async ({ state, sweep, reconnect, push, watches }) => {
    await sweep();
    expect(watches('gmail_watch')).toEqual(['conn-1']);
    const live = calendarPushBook(state.storage.kv).state();
    expect(live).toMatchObject({ resourceId: 'res-1' });
    await reconnect('conn-2', [...MAIL, CALENDAR]);
    expect(calendarPushBook(state.storage.kv).state(), 'a live Calendar channel survives the keep').toEqual(live);
    await sweep();
    expect.soft(watches('gmail_watch'), 'the next sweep watches with the new connection').toEqual(['conn-1', 'conn-2']);
    expect(watches('calendar_watch'), 'no second Calendar channel is started').toEqual(['conn-1']);
    expect.soft(await push('conn-1', '600'), 'a push for the old connection is ignored').toBe('ignore');
    expect.soft(await push('conn-2', '601'), 'a push for the new connection wakes the sweep').toBe('wake');
  });
});
