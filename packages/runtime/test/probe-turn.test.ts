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
      method: 'POST', body: JSON.stringify({ text: 'probe ping', live: false }),
      headers: {
        'content-type': 'application/json', 'x-waldo-origin': 'https://w.test',
        'x-waldo-telegram-subject': '42', 'x-waldo-timezone': 'Asia/Kolkata',
      },
    });
    expect(await response.json()).toEqual({ trace: 'tg--1', outcome: 'answered' });
  });

  it('passes live:true through and rejects a non-boolean live flag', async () => {
    const { fetch, ns } = namespace();
    expect((await handleProbeTurn(post('probe-secret', { text: 'receipt check', live: true }), staging(ns), directory)).status).toBe(200);
    expect(fetch).toHaveBeenCalledWith(PROBE_TURN_DO_URL, expect.objectContaining({ body: JSON.stringify({ text: 'receipt check', live: true }) }));
    expect((await handleProbeTurn(post('probe-secret', { text: 'x', live: 'yes' }), staging(ns), directory)).status).toBe(400);
  });

  it('falls back to the configured owner subject when the directory has no presence', async () => {
    const { fetch, idFromName, ns } = namespace();
    const empty: OwnerDirectory = { byPresence: async () => null, redeem: async () => null };
    expect((await handleProbeTurn(post('probe-secret'), staging(ns), empty)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('42');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('newProbeCapture', () => {
  it('collects calls in order and answers with a Bot-API-shaped success', async () => {
    const { newProbeCapture } = await import('../src/channels/probe-turn');
    const capture = newProbeCapture();
    const first = await capture.record('sendChatAction', { chat_id: 42, action: 'typing' });
    const second = await capture.record('sendMessage', { chat_id: 42, text: 'reply' });
    expect(capture.calls.map((c) => c.method)).toEqual(['sendChatAction', 'sendMessage']);
    expect(capture.calls[1]?.request).toEqual({ chat_id: 42, text: 'reply' });
    expect(first).toEqual({ ok: true, result: { message_id: 0 } });
    expect(second).toEqual({ ok: true, result: { message_id: 0 } });
  });
});

describe('probe capture confinement (Codex #230/#231 holds)', () => {
  it('PROBE_STRIPPED_TOOLS covers every live provider handler (drift guard)', async () => {
    const { PROBE_STRIPPED_TOOLS } = await import('../src/channels/probe-turn');
    const { googleHandlers } = await import('../src/tools/live/google');
    const { browsePageHandler, browseActHandler } = await import('../src/tools/live/browser');
    const { callMcpToolHandler } = await import('../src/tools/live/mcp');
    const google = googleHandlers(
      { client: async () => { throw new Error('no client in test'); }, connectUrl: async () => null } as never,
      { propose: async () => 'p', proposeSendEmail: async () => 'p', record: () => undefined } as never,
      { timezone: 'UTC', now: () => new Date(0) },
    );
    const liveNames = [
      ...google.map((h) => h.name),
      browsePageHandler('k', 'p', 'm').name,
      browseActHandler('k', 'p', 'm', () => undefined, async () => 'p').name,
      callMcpToolHandler(undefined).name,
      'connect_service',
    ];
    for (const name of liveNames) {
      expect(PROBE_STRIPPED_TOOLS, `live handler ${name} must be stripped from capture-mode probes`).toContain(name);
    }
  });

  it('the strip set never includes read-only owner-context tools (probes stay useful)', async () => {
    const { PROBE_STRIPPED_TOOLS } = await import('../src/channels/probe-turn');
    for (const keep of ['get_context', 'web_search', 'read_memory', 'search_episodes']) {
      expect(PROBE_STRIPPED_TOOLS).not.toContain(keep);
    }
  });
});
