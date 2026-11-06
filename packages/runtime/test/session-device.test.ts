import { describe, expect, it } from 'vitest';
import { appSessionDevice, applySessionDeviceNote, browserSessionDevice, credentialSessionHash, noteBrowserSession, sessionDevices } from '../src/identity/session-device';
import { linkCodeHash } from '../src/identity/owner-directory';

const kvOf = () => {
  const map = new Map<string, unknown>();
  return { map, kv: { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); }, delete: (key: string) => map.delete(key),
    list: ({ prefix }: { prefix?: string } = {}) => [...map].filter(([key]) => key.startsWith(prefix ?? '')) } as never };
};
const A = 'a'.repeat(64), B = 'b'.repeat(64), C = 'c'.repeat(64);

describe('a web sign-in named by its User-Agent', () => {
  const agents: readonly (readonly [string, string, string])[] = [
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15', 'Safari on macOS', 'computer'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome on macOS', 'computer'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:144.0) Gecko/20100101 Firefox/144.0', 'Firefox on macOS', 'computer'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome on Windows', 'computer'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:144.0) Gecko/20100101 Firefox/144.0', 'Firefox on Windows', 'computer'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 Edg/141.0.0.0', 'Edge on Windows', 'computer'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1', 'Safari on iOS', 'phone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/141.0.0.0 Mobile/15E148 Safari/604.1', 'Chrome on iOS', 'phone'],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/144.0 Mobile/15E148 Safari/605.1.15', 'Firefox on iOS', 'phone'],
    ['Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1', 'Safari on iPadOS', 'tablet'],
    ['Mozilla/5.0 (Linux; Android 15; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36', 'Chrome on Android', 'phone'],
    ['Mozilla/5.0 (Android 15; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0', 'Firefox on Android', 'phone'],
    ['Mozilla/5.0 (Linux; Android 15; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Safari/537.36', 'Samsung Internet on Android', 'tablet'],
    ['Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36', 'Chrome on ChromeOS', 'computer'],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 OPR/120.0.0.0', 'Opera on Linux', 'computer'],
    ['SomeAgent/1.0 (X11; Linux x86_64)', 'Browser on Linux', 'computer'],
  ];
  it.each(agents)('%s reads %s', (agent, label, kind) => expect(browserSessionDevice(agent)).toEqual({ kind, label }));
  it('names nothing it cannot recognise, and keeps a known browser on an unknown system as unknown', () => {
    for (const agent of [null, '', 'curl/8.7.1', 'x'.repeat(10_000)]) expect(browserSessionDevice(agent)).toBeNull();
    expect(browserSessionDevice('Mozilla/5.0 Firefox/144.0')).toEqual({ kind: 'unknown', label: 'Firefox' });
  });
});

describe('the app naming its own session', () => {
  it('keeps the model and the major OS version', () => {
    expect(appSessionDevice({ platform: 'ios', model: 'iPhone 17 Pro', os_version: '26.0.1' })).toEqual({ kind: 'phone', label: 'iPhone 17 Pro · iOS 26' });
    expect(appSessionDevice({ platform: 'ios', model: 'iPad Air 11-inch (M3)', os_version: '26.1', kind: 'tablet' })).toEqual({ kind: 'tablet', label: 'iPad Air 11-inch (M3) · iPadOS 26' });
    expect(appSessionDevice({ platform: 'android', model: 'Pixel 9 Pro', os_version: '15' })).toEqual({ kind: 'phone', label: 'Pixel 9 Pro · Android 15' });
  });
  it('strips control, format and separator characters, and refuses a model left empty', () => {
    expect(appSessionDevice({ platform: 'ios', model: '‮iPhone\u0000\n  17​ Pro ', os_version: '26' })?.label).toBe('iPhone 17 Pro · iOS 26');
    expect(appSessionDevice({ platform: 'ios', model: '\u0007​‮ \t', os_version: '26' })).toBeNull();
  });
});

describe('the owner object\'s record of each session\'s device', () => {
  it('records, carries a description to the renewed session, and drops sessions no longer listed', () => {
    const { kv, map } = kvOf(), devices = sessionDevices(kv);
    devices.record(A, { kind: 'phone', label: 'iPhone 17 Pro · iOS 26' });
    devices.record('not-a-hash', { kind: 'phone', label: 'x' });
    devices.carry(A, B); devices.carry(C, A);
    expect(devices.read(B)).toEqual({ kind: 'phone', label: 'iPhone 17 Pro · iOS 26' });
    expect(devices.read(A)).toEqual(devices.read(B));
    devices.keepOnly(new Set([B]));
    expect([...map.keys()]).toEqual([`session_device:${B}`]);
  });
  it('applies only the notes the Worker sends', () => {
    const { kv } = kvOf();
    expect(applySessionDeviceNote(kv, { session: A, device: { kind: 'computer', label: 'Chrome on macOS' } })).toBe(true);
    expect(applySessionDeviceNote(kv, { session: B, from: A })).toBe(true);
    expect(sessionDevices(kv).read(B)).toEqual({ kind: 'computer', label: 'Chrome on macOS' });
    for (const bad of [null, 'x', { session: 'short', device: { kind: 'computer', label: 'x' } }, { session: C, device: { kind: 'watch', label: 'x' } }, { session: C, device: { kind: 'computer', label: '' } },
      { session: C, device: { kind: 'computer', label: 'x'.repeat(81) } }, { session: C }]) expect(applySessionDeviceNote(kv, bad)).toBe(false);
    expect(sessionDevices(kv).read(C)).toBeNull();
  });
  it('a web sign-in sends its owner object the session hash and the coarse label, never the User-Agent', async () => {
    const sent: { url: string; doName: string | null; body: unknown }[] = [];
    const owners = { idFromName: (name: string) => name, get: (name: string) => ({ fetch: async (request: Request) => { sent.push({ url: request.url, doName: request.headers.get('x-waldo-do-name'), body: await request.json() }); return new Response(null, { status: 204 }); } }) } as never;
    const agent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
    const cookie = `owner.with.dots.${'1'.repeat(32)}.signature`;
    await noteBrowserSession(owners, 'owner.with.dots', cookie, new Request('https://console.fixture.invalid/', { headers: { 'user-agent': agent } }));
    expect(sent).toEqual([{ url: 'https://telegram-owner/session-device', doName: 'owner.with.dots', body: { session: await linkCodeHash('1'.repeat(32)), device: { kind: 'computer', label: 'Chrome on macOS' } } }]);
    expect(await credentialSessionHash(cookie)).toBe(await linkCodeHash('1'.repeat(32)));
    await noteBrowserSession(owners, 'owner', cookie, new Request('https://console.fixture.invalid/', { headers: { 'user-agent': 'curl/8.7.1' } }));
    expect(sent).toHaveLength(1);
  });
});
