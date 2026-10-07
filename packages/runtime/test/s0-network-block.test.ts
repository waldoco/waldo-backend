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
