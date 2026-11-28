import { describe, expect, it, vi } from 'vitest';
import { APPROVAL_PUSH_CATEGORY, pushNotificationSchema } from '../../contracts/src/ui/notification';
import { EVENT_PUSH_DAILY_LIMIT, ownerPush, PUSH_DAILY_LIMIT, PUSHES, pushReceipts, RECEIPT_AFTER_MS, REPLY_PUSH_DAILY_LIMIT, type OwnerPushDeps, type PushTarget } from '../src/channels/expo-push';

const EXPO = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', OTHER = 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbb]';
const ACCESS = 'synthetic-expo-access';
const BRIEF = { trigger: 'brief', variant: 'morning', card_ref: 'card:brief' };
const target = (token: string, n = 1, epoch = 1) => ({ installation_id: `4${n}000000-0000-4000-8000-000000000001`, device_epoch: epoch, token });
const fixture = (over: Partial<OwnerPushDeps> = {}) => {
  const clock = { now: Date.parse('2026-10-13T09:00:00Z') };
  const store = new Map<string, unknown>(), logged: { code: string; count: number }[] = [], posted: { url: string; headers: Headers; body: unknown }[] = [];
  const retired: Pick<PushTarget, 'installation_id' | 'device_epoch'>[] = [];
  const send = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    posted.push({ url: String(url), headers: new Headers(init?.headers), body });
    return Response.json({ data: body.map(() => ({ status: 'ok', id: 'ticket' })) });
  });
  const deps: OwnerPushDeps = { accessToken: ACCESS, kv: { get: <T>(key: string) => store.get(key) as T | undefined, put: (key: string, value: unknown) => { store.set(key, value); } },
    targets: async () => [target(EXPO)], retire: async device => { retired.push(device); return true; }, send: send as unknown as typeof fetch,
    today: () => '2026-10-13', quiet: () => false, now: () => clock.now, log: (code, count) => { logged.push({ code, count }); }, ...over };
  return { push: ownerPush(deps), receipts: pushReceipts(deps), logged, posted, send, store, retired, clock };
};
const answering = (tickets: unknown[]) => (async () => Response.json({ data: tickets })) as unknown as typeof fetch;
const gone = { status: 'error', message: 'not registered', details: { error: 'DeviceNotRegistered' } };

describe('pushing the owner\'s app', () => {
  it('sends the fixed Brief text and the Brief\'s ids to each Expo device under the project\'s access token, and logs only a code and a count', async () => {
    const { push, logged, posted } = fixture({ targets: async () => [target(EXPO), target(OTHER, 2)] });
    await push('brief');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.url).toBe('https://exp.host/--/api/v2/push/send');
    expect(posted[0]!.headers.get('authorization')).toBe(`Bearer ${ACCESS}`);
    expect(posted[0]!.body).toEqual([EXPO, OTHER].map(to => ({ to, body: 'Your Daily Brief is ready', data: BRIEF, sound: 'default' })));
    expect(logged).toEqual([{ code: 'sent', count: 2 }]);
    expect(JSON.stringify(logged)).not.toContain('Token');
  });

  it('every push carries only the ids the app\'s notification contract allows', () => {
    for (const [kind, { data }] of Object.entries(PUSHES)) {
      const composed = kind === 'approval' ? { ...data, approval_id: 'p0001' } : data;
      expect(pushNotificationSchema.parse(composed)).toEqual(composed);
    }
  });

  it('an approval push is fixed generic text with the id of the approval and nothing else: no reason, zone, number or title', async () => {
    const { push, logged, posted } = fixture({ targets: async () => [target(EXPO), target(OTHER, 2)] });
    await push('approval', 'p0001');
    expect(posted).toHaveLength(1);
    expect(posted[0]!.body).toEqual([EXPO, OTHER].map(to => ({ to, body: 'Waldo has a suggestion for your day', data: { trigger: 'approval', approval_id: 'p0001' }, sound: 'default', categoryId: APPROVAL_PUSH_CATEGORY })));
    expect(logged).toEqual([{ code: 'sent', count: 2 }]);
    expect(Object.keys((posted[0]!.body as { data: object }[])[0]!.data).sort()).toEqual(['approval_id', 'trigger']);
  });

  it('an approval push without its id is never sent and is not counted against the day', async () => {
    const { push, logged, send, store, posted } = fixture();
    await push('approval');
    await push('approval', 'not an id');
    expect([send.mock.calls.length, posted, store.size]).toEqual([0, [], 0]);
    expect(logged).toEqual([{ code: 'invalid_payload', count: 0 }, { code: 'invalid_payload', count: 0 }]);
  });

  it('an approval push is held in quiet hours, and shares the day\'s limit with the Brief', async () => {
    const held = fixture({ quiet: () => true });
    await held.push('approval', 'p0001');
    expect([held.send.mock.calls.length, held.logged]).toEqual([0, [{ code: 'quiet', count: 0 }]]);
    const { push, send, logged } = fixture();
    for (let i = 0; i < PUSH_DAILY_LIMIT; i++) await (i % 2 ? push('brief') : push('approval', `p000${i}`));
    await push('approval', 'p0009');
    expect(send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT);
    expect(logged.at(-1)).toEqual({ code: 'daily_limit', count: 0 });
  });

  it('keeps the Brief\'s slot: approval pushes stop one short of the day\'s limit until the Brief has been pushed, and use the last slot after it', async () => {
    const early = fixture();
    for (let i = 0; i < PUSH_DAILY_LIMIT; i++) await early.push('approval', `p000${i}`);
    expect(early.send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT - 1);
    expect(early.logged.at(-1)).toEqual({ code: 'daily_limit', count: 0 });
    await early.push('brief');
    expect(early.send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT);
    expect(early.posted.at(-1)!.body).toEqual([expect.objectContaining({ body: 'Your Daily Brief is ready' })]);

    const briefFirst = fixture();
    await briefFirst.push('brief');
    for (let i = 0; i < PUSH_DAILY_LIMIT; i++) await briefFirst.push('approval', `p000${i}`);
    expect(briefFirst.send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT);
    expect(briefFirst.logged.at(-1)).toEqual({ code: 'daily_limit', count: 0 });
  });

  it('the reserved slot is per owner-day: the next day starts with the Brief\'s slot held again', async () => {
    let day = '2026-10-13';
    const { push, send } = fixture({ today: () => day });
    await push('brief');
    day = '2026-10-14';
    for (let i = 0; i < PUSH_DAILY_LIMIT; i++) await push('approval', `p000${i}`);
    expect(send).toHaveBeenCalledTimes(1 + PUSH_DAILY_LIMIT - 1);
  });

  it('gives up on a send that never answers, and on a receipt that never arrives, instead of holding the caller', async () => {
    vi.useFakeTimers();
    try {
      const silent = fixture({ send: ((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch });
      const pending = silent.push('approval', 'p0001');
      await vi.advanceTimersByTimeAsync(10_000);
      await pending;
      expect(silent.logged).toEqual([{ code: 'send_failed', count: 0 }]);
      const unreadable = fixture({ send: (async () => ({ ok: true, json: () => new Promise(() => undefined) })) as unknown as typeof fetch });
      const reading = unreadable.push('approval', 'p0001');
      await vi.advanceTimersByTimeAsync(10_000);
      await reading;
      expect(unreadable.logged).toEqual([{ code: 'receipt_unreadable', count: 0 }]);
    } finally { vi.useRealTimers(); }
  });

  it('without the access token push is not configured: it reads no devices and sends nothing', async () => {
    const targets = vi.fn(async () => [target(EXPO)]);
    const { push, logged, send, store } = fixture({ accessToken: undefined, targets });
    await push('brief');
    expect([targets.mock.calls.length, send.mock.calls.length, store.size]).toEqual([0, 0, 0]);
    expect(logged).toEqual([{ code: 'not_configured', count: 0 }]);
  });

  it(`sends at most ${PUSH_DAILY_LIMIT} a day, and again the next day`, async () => {
    let day = '2026-10-13';
    const { push, logged, send } = fixture({ today: () => day });
    for (let i = 0; i < PUSH_DAILY_LIMIT + 1; i++) await push('brief');
    expect(send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT);
    expect(logged.at(-1)).toEqual({ code: 'daily_limit', count: 0 });
    day = '2026-10-14';
    await push('brief');
    expect(send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT + 1);
  });

  it('sends nothing in quiet hours, without devices, or when the targets cannot be read', async () => {
    for (const [over, code] of [
      [{ quiet: () => true }, 'quiet'],
      [{ targets: async () => [] }, 'no_devices'],
      [{ targets: async () => { throw new Error('directory unavailable'); } }, 'targets_unavailable'],
      [{ targets: async () => [{ installation_id: 'x', device_epoch: 1, token: EXPO }] }, 'targets_unavailable'],
      [{ targets: async () => [{ ...target(EXPO), device_epoch: 0 }] }, 'targets_unavailable'],
      [{ targets: async () => null }, 'targets_unavailable'],
    ] as const) {
      const { push, logged, send } = fixture(over as Partial<OwnerPushDeps>);
      await push('brief');
      expect(send).not.toHaveBeenCalled();
      expect(logged).toEqual([{ code, count: 0 }]);
    }
  });

  it('a failed or refused send is logged and never thrown, and still counts against the day', async () => {
    const down = fixture({ send: (async () => { throw new Error('network'); }) as unknown as typeof fetch });
    await expect(down.push('brief')).resolves.toBeUndefined();
    expect(down.logged).toEqual([{ code: 'send_failed', count: 0 }]);
    expect(down.store.get('app_push_budget_v1')).toEqual({ day: '2026-10-13', sent: 1 });
    const refused = fixture({ send: (async () => new Response('', { status: 429 })) as unknown as typeof fetch });
    await refused.push('brief');
    expect(refused.logged).toEqual([{ code: 'send_refused', count: 0 }]);
    const short = fixture({ targets: async () => [target(EXPO), target(OTHER, 2)], send: answering([gone]) });
    await short.push('brief');
    expect([short.logged, short.retired]).toEqual([[{ code: 'receipt_unreadable', count: 0 }], []]);
  });

  it('retires exactly the devices Expo says no longer hold their token, on the epoch it read', async () => {
    const third = 'ExponentPushToken[cccccccccccccccccccccc]';
    const { push, logged, retired } = fixture({ targets: async () => [target(EXPO, 1, 3), target(OTHER, 2, 5), target(third, 3, 2)],
      send: answering([{ status: 'ok', id: 't' }, gone, { status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } }]) });
    await push('brief');
    expect(retired).toEqual([target(OTHER, 2, 5)]);
    expect(logged).toEqual([{ code: 'partial', count: 1 }, { code: 'retired', count: 1 }]);
  });

  it('a retire that fails is logged and never thrown; the next push meets the same answer and retires again', async () => {
    const { push, logged } = fixture({ send: answering([gone]), retire: async () => { throw new Error('directory unavailable'); } });
    await expect(push('brief')).resolves.toBeUndefined();
    expect(logged).toEqual([{ code: 'partial', count: 0 }, { code: 'retire_failed', count: 1 }]);
  });
});

describe('an update push', () => {
  it('carries the line it was given and the card it opens, on the proactive ceiling', async () => {
    const { push, posted, store } = fixture();
    await push('update', undefined, 'Your 15:00 with Krati moved to 17:00', 'card:brief');
    expect(posted[0]!.body).toEqual([{ to: EXPO, body: 'Your 15:00 with Krati moved to 17:00', data: { trigger: 'update', card_ref: 'card:brief' }, sound: 'default' }]);
    expect(store.get('app_push_proactive_budget_v1')).toEqual({ day: '2026-10-13', sent: 1 });
    expect(store.get('app_push_budget_v1')).toBeUndefined();
  });

  it('without a line or a card, is the fixed line that opens Main chat', async () => {
    const { push, posted } = fixture();
    await push('update');
    expect(posted[0]!.body).toEqual([{ to: EXPO, body: PUSHES.update.body, data: { trigger: 'update' }, sound: 'default' }]);
  });

  it('a card ref goes only on an update push', async () => {
    const { push, posted } = fixture();
    await push('brief', undefined, undefined, 'card:close');
    expect((posted[0]!.body as { data: object }[])[0]!.data).toEqual(BRIEF);
  });
});

describe('an event push', () => {
  it('is its fixed line whatever body it is handed, and counts on its own ceiling, never the one prep and update pushes share', async () => {
    const { push, posted, store, logged } = fixture();
    for (let n = 0; n <= EVENT_PUSH_DAILY_LIMIT; n += 1) await push('event', undefined, 'Deploy finished: see https://ci.example');
    expect(posted).toHaveLength(EVENT_PUSH_DAILY_LIMIT);
    expect(posted[0]!.body).toEqual([{ to: EXPO, body: PUSHES.event.body, data: { trigger: 'event' }, sound: 'default' }]);
    expect(logged.at(-1)).toEqual({ code: 'daily_limit', count: 0 });
    expect(store.get('app_push_proactive_budget_v1')).toBeUndefined();
    await push('update', undefined, 'Your 15:00 moved to 17:00');
    expect(posted).toHaveLength(EVENT_PUSH_DAILY_LIMIT + 1);
  });
});

describe('a message or a reply in the app chat', () => {
  it('a message pushes the fixed line that opens Main chat, on the proactive ceiling, and holds in quiet hours', async () => {
    const { push, posted, logged } = fixture();
    await push('message');
    expect(posted[0]!.body).toEqual([{ to: EXPO, body: 'Waldo has a new message for you', data: { trigger: 'event' }, sound: 'default' }]);
    const quiet = fixture({ quiet: () => true });
    await quiet.push('message');
    expect([quiet.posted.length, quiet.logged]).toEqual([0, [{ code: 'quiet', count: 0 }]]);
    expect(logged).toEqual([{ code: 'sent', count: 1 }]);
  });

  it('a reply goes in quiet hours, since the owner just wrote, on its own backstop that the proactive pushes never use up', async () => {
    const { push, posted, logged } = fixture({ quiet: () => true });
    await push('reply');
    expect(posted[0]!.body).toEqual([{ to: EXPO, body: 'Waldo replied', data: { trigger: 'event' }, sound: 'default' }]);
    const busy = fixture();
    for (let n = 0; n < 30; n += 1) await busy.push('message');
    await busy.push('reply');
    expect(busy.logged.at(-1)).toEqual({ code: 'sent', count: 1 });
    for (let n = 1; n < REPLY_PUSH_DAILY_LIMIT; n += 1) await busy.push('reply');
    await busy.push('reply');
    expect(busy.logged.at(-1)).toEqual({ code: 'daily_limit', count: 0 });
    expect(logged).toEqual([{ code: 'sent', count: 1 }]);
  });

  it('only an approval push carries a category', async () => {
    for (const kind of ['brief', 'prep', 'update', 'event', 'copy', 'message', 'reply'] as const) {
      const { push, posted } = fixture();
      await push(kind);
      expect(JSON.stringify(posted[0]!.body)).not.toContain('categoryId');
    }
  });
});

describe('Expo\'s push receipts', () => {
  const receiptsAnswer = (data: unknown, posted: { url: string; body: unknown }[]) => vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown;
    posted.push({ url: String(url), body });
    if (String(url).endsWith('/getReceipts')) return Response.json({ data });
    return Response.json({ data: (body as unknown[]).map((_, index) => ({ status: 'ok', id: `ticket-${index}` })) });
  }) as unknown as typeof fetch;

  it('are read once old enough; a dead token retires its registration and every failure is logged by its reason', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const h = fixture({ targets: async () => [target(EXPO), target(OTHER, 2, 3)],
      send: receiptsAnswer({ 'ticket-0': { status: 'error', details: { error: 'DeviceNotRegistered' } }, 'ticket-1': { status: 'error', details: { error: 'MessageTooBig' } } }, posted) });
    await h.push('brief');
    await h.receipts();
    expect(posted.filter(call => call.url.endsWith('/getReceipts'))).toEqual([]);
    h.clock.now += RECEIPT_AFTER_MS;
    await h.receipts();
    expect(posted.at(-1)).toEqual({ url: 'https://exp.host/--/api/v2/push/getReceipts', body: { ids: ['ticket-0', 'ticket-1'] } });
    expect(h.logged.slice(1)).toEqual([{ code: 'receipt_device_not_registered', count: 1 }, { code: 'receipt_too_big', count: 1 }, { code: 'retired', count: 1 }]);
    expect(h.retired).toEqual([{ installation_id: target(EXPO).installation_id, device_epoch: 1 }]);
    await h.receipts();
    expect(posted.filter(call => call.url.endsWith('/getReceipts'))).toHaveLength(1);
  });

  it('a receipt not ready is asked for again; one Expo no longer keeps is dropped as missing', async () => {
    const posted: { url: string; body: unknown }[] = [];
    const h = fixture({ send: receiptsAnswer({}, posted) });
    await h.push('brief');
    h.clock.now += RECEIPT_AFTER_MS;
    await h.receipts();
    await h.receipts();
    expect(posted.filter(call => call.url.endsWith('/getReceipts'))).toHaveLength(2);
    h.clock.now += 24 * 60 * 60_000;
    await h.receipts();
    expect(h.logged.at(-1)).toEqual({ code: 'receipt_missing', count: 1 });
    expect(posted.filter(call => call.url.endsWith('/getReceipts'))).toHaveLength(2);
  });

  it('a receipt read that fails (Expo 5xx, no answer) keeps the tickets for the next read and never throws', async () => {
    let fail = true;
    const posted: { url: string; body: unknown }[] = [];
    const ok = receiptsAnswer({ 'ticket-0': { status: 'ok' } }, posted);
    const h = fixture({ send: (async (url: RequestInfo | URL, init?: RequestInit) => String(url).endsWith('/getReceipts') && fail ? new Response('down', { status: 503 }) : ok(url, init)) as typeof fetch });
    await h.push('brief');
    h.clock.now += RECEIPT_AFTER_MS;
    await h.receipts();
    expect(h.logged.at(-1)).toEqual({ code: 'receipts_refused', count: 0 });
    fail = false;
    await h.receipts();
    expect(h.logged.at(-1)).toEqual({ code: 'receipt_ok', count: 1 });
    const thrown = fixture({ send: (async (url: RequestInfo | URL, init?: RequestInit) => { if (String(url).endsWith('/getReceipts')) throw new Error('reset'); return ok(url, init); }) as typeof fetch });
    await thrown.push('brief');
    thrown.clock.now += RECEIPT_AFTER_MS;
    await expect(thrown.receipts()).resolves.toBeUndefined();
    expect(thrown.logged.at(-1)).toEqual({ code: 'receipts_unavailable', count: 0 });
  });

  it('keeps no ticket for a push Expo refused, and logs no token', async () => {
    const h = fixture({ send: answering([gone]) });
    await h.push('brief');
    h.clock.now += RECEIPT_AFTER_MS;
    await h.receipts();
    expect(h.store.get('app_push_tickets_v1')).toBeUndefined();
    const kept = fixture();
    await kept.push('brief');
    expect(JSON.stringify(kept.store.get('app_push_tickets_v1'))).not.toContain('Token');
  });
});
