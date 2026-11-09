import { expect, it, vi } from 'vitest';
import { cloudflareGeneralBrowser } from '../src/channels/cloudflare-general-browser';
import type { BrowserSession } from '@waldo/contracts';

const session = (expiresAt: number): BrowserSession => ({ id: 'host-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId: 'provider-session', contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt, updatedAt: 0 });
const never = () => new Promise<never>(() => {});
const driver = (sdk: unknown, binding: unknown, turnMs = 150) => {
  const deadline = Date.now() + turnMs;
  return cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: binding as never, loadSdk: async () => sdk as never, now: Date.now, deadline: () => deadline, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
};

const hung = (signals: (AbortSignal | undefined)[] = []) => ({ fetch: (_input: unknown, init?: RequestInit) => { signals.push(init?.signal ?? undefined); return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })); } });

it('a hung allocation request is aborted at the turn deadline and reported as a turn deadline', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const sdk = { acquire: async (provider: { fetch: typeof fetch }) => { await provider.fetch('https://browser.invalid/acquire', { method: 'POST' }); return { sessionId: 'never' }; }, sessions: async () => [] };
  const started = Date.now();
  await expect(driver(sdk, hung(signals)).start('public', 600000, async () => {}, async () => {})).rejects.toMatchObject({ code: 'turn_deadline' });
  expect(signals[0]).toBeDefined(); expect(Date.now() - started).toBeLessThan(2000);
});

it('an allocation that answers after ten seconds but inside the turn is recorded and returned, not aborted', async () => {
  vi.useFakeTimers();
  try {
    let aborted = false;
    const binding = { fetch: (_input: unknown, init?: RequestInit) => new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => { aborted = true; reject(init.signal!.reason); }, { once: true });
      setTimeout(() => resolve(new Response('{}', { status: 200 })), 12_000);
    }) };
    const sdk = { acquire: async (provider: { fetch: typeof fetch }) => { await provider.fetch('https://browser.invalid/acquire', { method: 'POST' }); return { sessionId: 'late-session' }; }, sessions: async () => [] };
    const recorded: string[] = [];
    const started = driver(sdk, binding, 60_000).start('public', 600000, async () => {}, async id => { recorded.push(id); });
    const settled = started.then(id => ({ id }), error => ({ error }));
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await settled).toEqual({ id: 'late-session' });
    expect(recorded).toEqual(['late-session']); expect(aborted).toBe(false);
  } finally { vi.useRealTimers(); }
});

it('no allocation request is sent once the turn has no time left', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const sdk = { acquire: async (provider: { fetch: typeof fetch }) => { await provider.fetch('https://browser.invalid/acquire', { method: 'POST' }); return { sessionId: 'never' }; }, sessions: async () => [] };
  await expect(driver(sdk, hung(signals), -1).start('public', 600000, async () => {}, async () => {})).rejects.toMatchObject({ code: 'turn_deadline' });
  expect(signals).toEqual([]);
});

it('a hung provider control request is still capped at ten seconds when the turn has longer', async () => {
  vi.useFakeTimers();
  try {
    const sdk = { connect: async (provider: { fetch: typeof fetch }) => { await provider.fetch('https://browser.invalid/v1/sessions'); return never(); }, sessions: async () => [{ sessionId: 'provider-session' }] };
    const observed = driver(sdk, hung(), 60_000).observe(session(Date.now() + 600000)).then(() => undefined, error => error);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await observed).toMatchObject({ code: 'provider_unavailable' });
  } finally { vi.useRealTimers(); }
});

it('a provider upgrade request carries no turn signal, so the retained connection outlives one request', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const binding = { fetch: async (_input: unknown, init?: RequestInit) => { signals.push(init?.signal ?? undefined); return new Response(null, { status: 200 }); } };
  const sdk = { acquire: async (provider: { fetch: typeof fetch }) => { await provider.fetch('https://browser.invalid/v1/connectDevtools', { headers: { Upgrade: 'websocket' } }); return { sessionId: 'socket-session' }; }, sessions: async () => [] };
  await driver(sdk, binding, 60000).start('public', 600000, async () => {}, async () => {});
  expect(signals).toEqual([undefined]);
});

it('a hung attach to the retained session fails at the turn deadline instead of holding the turn', async () => {
  const sdk = { connect: never, sessions: async () => [] };
  const started = Date.now();
  await expect(driver(sdk, {}).observe(session(Date.now() + 600000))).rejects.toMatchObject({ code: 'turn_deadline' });
  expect(Date.now() - started).toBeLessThan(2000);
});

// Timers and the injected clock can disagree by a few milliseconds, so the clock may still show turn time left when the
// turn-bounded timer fires. A clock that never advances makes that disagreement total.
it('a turn-bounded attach that fires is a turn deadline even when the clock still shows time left', async () => {
  const at = Date.now(), sdk = { connect: never, sessions: async () => [{ sessionId: 'provider-session' }] };
  const frozen = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: {} as never, loadSdk: async () => sdk as never, now: () => at, deadline: () => at + 50, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  await expect(frozen.observe(session(at + 600000))).rejects.toMatchObject({ code: 'turn_deadline' });
});

it('a turn-bounded provider request that fires is a turn deadline even when the clock still shows time left', async () => {
  const at = Date.now(), sdk = { connect: async (provider: { fetch: typeof fetch }) => { await provider.fetch('https://browser.invalid/v1/sessions'); return never(); }, sessions: async () => [{ sessionId: 'provider-session' }] };
  const frozen = cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: hung() as never, loadSdk: async () => sdk as never, now: () => at, deadline: () => at + 50, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
  await expect(frozen.observe(session(at + 600000))).rejects.toMatchObject({ code: 'turn_deadline' });
});

it('a connection that arrives after the turn gave up on it is closed, not leaked', async () => {
  let closed = 0;
  const sdk = { connect: () => new Promise(resolve => setTimeout(() => resolve({ close: async () => { closed++; } }), 300)), sessions: async () => [] };
  await expect(driver(sdk, {}).observe(session(Date.now() + 600000))).rejects.toMatchObject({ code: 'turn_deadline' });
  await new Promise(resolve => setTimeout(resolve, 400));
  expect(closed).toBe(1);
});

it('an attach that fails after the turn gave up on it leaves no unhandled rejection', async () => {
  const unhandled: unknown[] = [], listener = (reason: unknown) => { unhandled.push(reason); };
  process.on('unhandledRejection', listener);
  try {
    const sdk = { connect: () => new Promise((_, reject) => setTimeout(() => reject(Error('socket closed')), 300)), sessions: async () => [] };
    await expect(driver(sdk, {}).observe(session(Date.now() + 600000))).rejects.toMatchObject({ code: 'turn_deadline' });
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(unhandled).toEqual([]);
  } finally { process.off('unhandledRejection', listener); }
});

it('a failed attach is a lost session only when the provider no longer lists it', async () => {
  const refused = async () => { throw Error('websocket upgrade refused'); };
  const attach = (sessions: () => Promise<unknown>) => driver({ connect: refused, sessions }, {}, 60_000).observe(session(Date.now() + 600000));
  await expect(attach(async () => [])).rejects.toMatchObject({ code: 'session_lost' });
  await expect(attach(async () => [{ sessionId: 'provider-session' }])).rejects.toMatchObject({ code: 'provider_unavailable' });
  await expect(attach(async () => { throw Error('listing unavailable'); })).rejects.toMatchObject({ code: 'provider_unavailable' });
});
