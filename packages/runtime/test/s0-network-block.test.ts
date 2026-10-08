import { expect, it } from 'vitest';
import { evaluateS0, handleS0, S0_BLOCKED_PROBES } from '../src/channels/s0-network-block';

const blocked = S0_BLOCKED_PROBES.map(url => ({ url, reached: false, detail: 'blocked' }));
it('passes only when the allowed host loads, every probe is blocked and the session ended', () => {
  expect(evaluateS0(true, blocked, true, 5).passed).toBe(true);
  expect(evaluateS0(false, blocked, true, 5).passed).toBe(false);
  expect(evaluateS0(true, blocked, false, 5).passed).toBe(false);
  expect(evaluateS0(true, blocked.slice(1), true, 5).passed).toBe(false);
  expect(evaluateS0(true, [{ ...blocked[0]!, reached: true }, ...blocked.slice(1)], true, 5).passed).toBe(false);
});
it('is invisible without staging, a token, a binding and the exact bearer', async () => {
  const sdk = (async () => { throw Error('must not load'); }) as never;
  const req = (auth?: string, method = 'POST') => new Request('https://x/s0', { method, headers: auth ? { authorization: auth } : {} });
  const env = { WALDO_ENVIRONMENT: 'staging', S0_TOKEN: 't0ken', BROWSER: {} as never };
  for (const [r, e] of [[req('Bearer t0ken'), { ...env, WALDO_ENVIRONMENT: 'production' }], [req('Bearer t0ken'), { ...env, S0_TOKEN: undefined }], [req('Bearer t0ken'), { ...env, BROWSER: undefined }], [req(), env], [req('Bearer wrong'), env], [req('Bearer t0ken', 'GET'), env]] as const)
    expect((await handleS0(r, e, sdk)).status).toBe(404);
});

it('a probe that merely timed out is not accepted as a network block, and the deadline sums under 60s', async () => {
  const mod = await import('../src/channels/s0-network-block');
  const timedOut = mod.S0_BLOCKED_PROBES.map(url => ({ url, reached: false, detail: 'blocked:TimeoutError: signal timed out' }));
  expect(mod.evaluateS0(true, timedOut, true, 5).passed).toBe(false);
  expect(mod.S0_TOTAL_DEADLINE_MS).toBe(60_000);
});

it('stage budgets are measured from the start and cannot exceed the 60s ceiling', async () => {
  const mod = await import('../src/channels/s0-network-block');
  expect(mod.S0_TOTAL_DEADLINE_MS).toBe(60_000);
});

it('a late-resolving acquire is closed by its exact id and the run fails', async () => {
  const mod = await import('../src/channels/s0-network-block');
  const calls: string[] = [];
  const sdk = {
    acquire: () => new Promise(resolve => setTimeout(() => resolve({ sessionId: 'late-1' }), 60)),
    connect: async (_b: unknown, o: { sessionId: string }) => { calls.push(`connect:${o.sessionId}`); return { newBrowserCDPSession: async () => ({ send: async () => { calls.push('close'); } }) }; },
    sessions: async () => { calls.push('list'); return []; },
  };
  await expect(mod.runS0({} as never, (async () => sdk) as never, { load: 50, acquire: 10, work: 40, cleanup: 40 })).rejects.toThrow();
  await new Promise(r => setTimeout(r, 150));
  expect(calls).toEqual(['connect:late-1', 'close', 'list']);
});
