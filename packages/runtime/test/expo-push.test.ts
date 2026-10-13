import { describe, expect, it, vi } from 'vitest';
import { ownerPush, PUSH_DAILY_LIMIT, type OwnerPushDeps } from '../src/channels/expo-push';

const EXPO = 'ExponentPushToken[aaaaaaaaaaaaaaaaaaaaaa]';
const target = (provider: string, token: string, n = 1) => ({ installation_id: `4${n}000000-0000-4000-8000-000000000001`, provider, token });
const fixture = (over: Partial<OwnerPushDeps> & { targets?: () => Promise<unknown> } = {}) => {
  const store = new Map<string, unknown>(), logged: { code: string; sent: number }[] = [], posted: { url: string; body: unknown }[] = [];
  const send = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as unknown[];
    posted.push({ url: String(url), body });
    return Response.json({ data: body.map(() => ({ status: 'ok', id: 'ticket' })) });
  });
  const deps: OwnerPushDeps = { kv: { get: <T>(key: string) => store.get(key) as T | undefined, put: (key: string, value: unknown) => { store.set(key, value); } },
    targets: async () => [target('expo', EXPO)], send: send as unknown as typeof fetch, today: () => '2026-10-13', quiet: () => false,
    log: (code, sent) => { logged.push({ code, sent }); }, ...over };
  return { push: ownerPush(deps), logged, posted, send, store };
};

describe('pushing the owner\'s app', () => {
  it('sends the fixed Brief text to each Expo device, and logs only a code and a count', async () => {
    const { push, logged, posted } = fixture({ targets: async () => [target('expo', EXPO), target('expo', 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbb]', 2), target('apns', 'a'.repeat(64), 3)] });
    await push('brief');
    expect(posted).toEqual([{ url: 'https://exp.host/--/api/v2/push/send', body: [
      { to: EXPO, body: 'Your Brief is ready', sound: 'default' }, { to: 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbb]', body: 'Your Brief is ready', sound: 'default' }] }]);
    expect(logged).toEqual([{ code: 'sent', sent: 2 }]);
    expect(JSON.stringify(logged)).not.toContain('Token');
  });

  it(`sends at most ${PUSH_DAILY_LIMIT} a day, and again the next day`, async () => {
    let day = '2026-10-13';
    const { push, logged, send } = fixture({ today: () => day });
    for (let i = 0; i < PUSH_DAILY_LIMIT + 1; i++) await push('brief');
    expect(send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT);
    expect(logged.at(-1)).toEqual({ code: 'daily_limit', sent: 0 });
    day = '2026-10-14';
    await push('brief');
    expect(send).toHaveBeenCalledTimes(PUSH_DAILY_LIMIT + 1);
  });

  it('sends nothing in quiet hours, without devices, or when the targets cannot be read', async () => {
    for (const [over, code] of [
      [{ quiet: () => true }, 'quiet'],
      [{ targets: async () => [target('apns', 'a'.repeat(64))] }, 'no_devices'],
      [{ targets: async () => { throw new Error('directory unavailable'); } }, 'targets_unavailable'],
      [{ targets: async () => [{ installation_id: 'x', provider: 'expo', token: EXPO }] }, 'targets_unavailable'],
      [{ targets: async () => null }, 'targets_unavailable'],
    ] as const) {
      const { push, logged, send } = fixture(over as Partial<OwnerPushDeps>);
      await push('brief');
      expect(send).not.toHaveBeenCalled();
      expect(logged).toEqual([{ code, sent: 0 }]);
    }
  });

  it('a failed or refused send is logged and never thrown, and still counts against the day', async () => {
    const down = fixture({ send: (async () => { throw new Error('network'); }) as unknown as typeof fetch });
    await expect(down.push('brief')).resolves.toBeUndefined();
    expect(down.logged).toEqual([{ code: 'send_failed', sent: 0 }]);
    expect(down.store.get('app_push_budget_v1')).toEqual({ day: '2026-10-13', sent: 1 });
    const refused = fixture({ send: (async () => new Response('', { status: 429 })) as unknown as typeof fetch });
    await refused.push('brief');
    expect(refused.logged).toEqual([{ code: 'send_refused', sent: 0 }]);
    const partial = fixture({ targets: async () => [target('expo', EXPO), target('expo', 'ExpoPushToken[bbbbbbbbbbbbbbbbbbbb]', 2)],
      send: (async () => Response.json({ data: [{ status: 'ok', id: 't' }, { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } }] })) as unknown as typeof fetch });
    await partial.push('brief');
    expect(partial.logged).toEqual([{ code: 'partial', sent: 1 }]);
  });
});
