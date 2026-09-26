import { describe, expect, it, vi } from 'vitest';
import { handleProbeTurn, PROBE_TURN_DO_URL, type ProbeTurnEnv } from '../src/channels/probe-turn';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const namespace = () => {
  const fetch = vi.fn(async () => new Response(JSON.stringify({ trace: 'tg--1', outcome: 'answered' })));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const post = (token: string | null, body: unknown = { text: 'probe ping' }) => new Request('https://w.test/probe/turn', {
  method: 'POST', body: JSON.stringify(body), headers: token === null ? {} : { 'x-waldo-probe-token': token },
});
const staging = (ns: DurableObjectNamespace): ProbeTurnEnv => ({
  WALDO_ENVIRONMENT: 'staging', WALDO_PROBE_TOKEN: 'probe-secret',
  WALDO_OWNER_TELEGRAM_ID: '42', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata', TELEGRAM_OWNER_DO: ns,
});
const directory: OwnerDirectory = {
  byPresence: async () => ({ doName: 'do-a', subject: '42', timezone: 'Asia/Kolkata' }),
  redeem: async () => null,
};

describe('handleProbeTurn', () => {
  it('is hidden outside staging, without a token configured, and for non-POSTs', async () => {
    const { ns } = namespace();
    expect((await handleProbeTurn(post('probe-secret'), { ...staging(ns), WALDO_ENVIRONMENT: 'production' }, directory)).status).toBe(404);
    expect((await handleProbeTurn(post('probe-secret'), { ...staging(ns), WALDO_PROBE_TOKEN: undefined }, directory)).status).toBe(404);
    expect((await handleProbeTurn(new Request('https://w.test/probe/turn'), staging(ns), directory)).status).toBe(404);
  });

  it('rejects a wrong probe token and malformed bodies', async () => {
    const { fetch, ns } = namespace();
    expect((await handleProbeTurn(post('nope'), staging(ns), directory)).status).toBe(403);
    expect((await handleProbeTurn(post(null), staging(ns), directory)).status).toBe(403);
    expect((await handleProbeTurn(post('probe-secret', {}), staging(ns), directory)).status).toBe(400);
    expect((await handleProbeTurn(post('probe-secret', { text: '   ' }), staging(ns), directory)).status).toBe(400);
    expect((await handleProbeTurn(post('probe-secret', { text: 'x'.repeat(4_001) }), staging(ns), directory)).status).toBe(400);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards a verified probe to the owner Durable Object', async () => {
    const { fetch, idFromName, ns } = namespace();
    const response = await handleProbeTurn(post('probe-secret'), staging(ns), directory);
    expect(response.status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('do-a');
    expect(fetch).toHaveBeenCalledWith(PROBE_TURN_DO_URL, {
      method: 'POST', body: JSON.stringify({ text: 'probe ping' }),
      headers: {
        'content-type': 'application/json', 'x-waldo-origin': 'https://w.test',
        'x-waldo-telegram-subject': '42', 'x-waldo-timezone': 'Asia/Kolkata',
      },
    });
    expect(await response.json()).toEqual({ trace: 'tg--1', outcome: 'answered' });
  });

  it('falls back to the configured owner subject when the directory has no presence', async () => {
    const { fetch, idFromName, ns } = namespace();
    const empty: OwnerDirectory = { byPresence: async () => null, redeem: async () => null };
    expect((await handleProbeTurn(post('probe-secret'), staging(ns), empty)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('42');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
