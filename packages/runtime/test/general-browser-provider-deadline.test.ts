import { expect, it } from 'vitest';
import { cloudflareGeneralBrowser } from '../src/channels/cloudflare-general-browser';
import type { BrowserSession } from '@waldo/contracts';

const session = (expiresAt: number): BrowserSession => ({ id: 'host-session', ownerId: 'owner-a', provider: 'cloudflare_playwright', providerSessionId: 'provider-session', contextHandle: null, mode: 'public', state: 'active', generation: 1, expiresAt, updatedAt: 0 });
const never = () => new Promise<never>(() => {});
const driver = (sdk: unknown, binding: unknown, turnMs = 150) => {
  const deadline = Date.now() + turnMs;
  return cloudflareGeneralBrowser({ ownerId: 'owner-a', binding: binding as never, loadSdk: async () => sdk as never, now: Date.now, deadline: () => deadline, admit: async () => {}, authorizeRequest: async () => true, maxScreenshotBytes: 1024 });
};

it('a hung provider request is aborted at the turn deadline and reported as provider unavailable', async () => {
  const signals: (AbortSignal | undefined)[] = [];
  const binding = { fetch: (_input: unknown, init?: RequestInit) => { signals.push(init?.signal ?? undefined); return new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true })); } };
  const sdk = { acquire: async (provider: { fetch: typeof fetch }) => { await provider.fetch('https://browser.invalid/acquire', { method: 'POST' }); return { sessionId: 'never' }; }, sessions: async () => [] };
  const started = Date.now();
  await expect(driver(sdk, binding).start('public', 600000, async () => {}, async () => {})).rejects.toMatchObject({ code: 'provider_unavailable' });
  expect(signals[0]).toBeDefined(); expect(Date.now() - started).toBeLessThan(2000);
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
  await expect(driver(sdk, {}).observe(session(Date.now() + 600000))).rejects.toMatchObject({ code: 'provider_unavailable' });
  expect(Date.now() - started).toBeLessThan(2000);
});
