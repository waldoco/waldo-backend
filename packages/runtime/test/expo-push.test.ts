import { describe, expect, it, vi } from 'vitest';
import { pushNotificationSchema } from '../../contracts/src/ui/notification';
import { ownerPush, PUSH_DAILY_LIMIT, PUSHES, type OwnerPushDeps, type PushTarget } from '../src/channels/expo-push';

const EXPO = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]', OTHER = 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbb]';
const ACCESS = 'synthetic-expo-access';
const BRIEF = { trigger: 'brief', variant: 'morning', card_ref: 'card:brief' };
const target = (token: string, n = 1, epoch = 1) => ({ installation_id: `4${n}000000-0000-4000-8000-000000000001`, device_epoch: epoch, token });
const fixture = (over: Partial<OwnerPushDeps> = {}) => {
  const store = new Map<string, unknown>(), logged: { code: string; count: number }[] = [], posted: { url: string; headers: Headers; body: unknown }[] = [];
  const retired: PushTarget[] = [];
  const send = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    posted.push({ url: String(url), headers: new Headers(init?.headers), body });
    return Response.json({ data: body.map(() => ({ status: 'ok', id: 'ticket' })) });
  });
  const deps: OwnerPushDeps = { accessToken: ACCESS, kv: { get: <T>(key: string) => store.get(key) as T | undefined, put: (key: string, value: unknown) => { store.set(key, value); } },
    targets: async () => [target(EXPO)], retire: async device => { retired.push(device); return true; }, send: send as unknown as typeof fetch,
    today: () => '2026-10-13', quiet: () => false, log: (code, count) => { logged.push({ code, count }); }, ...over };
  return { push: ownerPush(deps), logged, posted, send, store, retired };
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
    expect(posted[0]!.body).toEqual([EXPO, OTHER].map(to => ({ to, body: 'Your Brief is ready', data: BRIEF, sound: 'default' })));
    expect(logged).toEqual([{ code: 'sent', count: 2 }]);
    expect(JSON.stringify(logged)).not.toContain('Token');
  });

  it('every push carries only the ids the app\'s notification contract allows', () => {
    for (const { data } of Object.values(PUSHES)) expect(pushNotificationSchema.parse(data)).toEqual(data);
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
