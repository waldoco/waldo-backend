import { describe, expect, it } from 'vitest';
import { buildSessionState } from '@waldo/contracts';
import { dispatchTool, type ToolDispatcherContext } from '../src/tools/dispatcher';
import { sanitise } from '../src/scribe/sanitiser';
import { webSearchHandler } from '../src/tools/live/web-search';

const ctx = {} as never;

const braveOk = (results: unknown[]) => async () =>
  new Response(JSON.stringify({ web: { results } }), { status: 200 });

describe('web_search', () => {
  it('returns mapped hits capped at the requested limit, tainted external', async () => {
    const results = Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, url: `https://example.com/${i}`, description: `d${i}` }));
    const handler = webSearchHandler('key', braveOk(results) as typeof fetch);
    const result = await handler.handle({ query: 'waldo', limit: 5 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source_taint).toBe('external');
    expect(result.data.hits).toHaveLength(5);
    expect(result.data.hits[0]).toEqual({ title: 't0', url: 'https://example.com/0', snippet: 'd0' });
  });

  it('no key configured: honest auth_failed, never a fabricated answer', async () => {
    const handler = webSearchHandler(undefined, braveOk([]) as typeof fetch);
    const result = await handler.handle({ query: 'waldo', limit: 5 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('auth_failed');
    expect(result.error).toContain('not set up');
  });

  it('rejected key (401/403) surfaces as auth_failed for key replacement', async () => {
    const handler = webSearchHandler('bad-key', (async () => new Response('nope', { status: 401 })) as typeof fetch);
    const result = await handler.handle({ query: 'waldo', limit: 5 }, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('auth_failed');
  });

  it('provider 5xx and network throw both map to transient', async () => {
    const failing = webSearchHandler('key', (async () => new Response('err', { status: 502 })) as typeof fetch);
    const throwing = webSearchHandler('key', (async () => { throw new Error('socket reset'); }) as typeof fetch);
    for (const handler of [failing, throwing]) {
      const result = await handler.handle({ query: 'waldo', limit: 5 }, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('transient');
    }
  });

  it('drops results without a URL and tolerates missing fields', async () => {
    const handler = webSearchHandler('key', braveOk([{ title: 'no url' }, { url: 'https://example.com/ok' }]) as typeof fetch);
    const result = await handler.handle({ query: 'waldo', limit: 5 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.hits).toEqual([{ title: '', url: 'https://example.com/ok', snippet: '' }]);
  });
});

const dispatchContext = (): ToolDispatcherContext => ({
  authenticatedUserId: 'user-1',
  trigger: 'user_message',
  session: buildSessionState({
    trigger: 'user_message',
    canary_tokens: ['1111111111111111', '2222222222222222', '3333333333333333'],
    started_at: 1_700_000_000_000,
  }),
  hasApproval: () => true,
  sourceTaint: null,
  toolArgSourceTaint: null,
  sanitise,
});

const dispatchSearch = (handler: ReturnType<typeof webSearchHandler>) => dispatchTool(
  { id: 'search-receipt', name: 'web_search', args: { query: 'waldo', limit: 5 } },
  dispatchContext(),
  { handlers: [handler] },
);

describe('web_search dispatcher receipts', () => {
  it('preserves a provider timeout diagnostic and its external provenance', async () => {
    const handler = webSearchHandler('synthetic-key', (async () => {
      throw new Error('synthetic provider timeout');
    }) as typeof fetch);
    expect(await dispatchSearch(handler)).toEqual({
      ok: false, call_id: 'search-receipt', tool: 'web_search',
      code: 'transient', error: 'synthetic provider timeout',
      reason: 'tool_result_error', source_taint: 'external',
    });
  });
  it('preserves HTTP 503 as an external transient provider failure', async () => {
    const handler = webSearchHandler('synthetic-key', (async () => new Response('unavailable', { status: 503 })) as typeof fetch);
    expect(await dispatchSearch(handler)).toEqual({
      ok: false, call_id: 'search-receipt', tool: 'web_search',
      code: 'transient', error: 'Brave search returned HTTP 503',
      reason: 'tool_result_error', source_taint: 'external',
    });
  });
  it.each([undefined, ''])('preserves missing setup with key %s without provider I/O', async (key) => {
    let requests = 0;
    const handler = webSearchHandler(key, (async () => { requests += 1; throw new Error('must not fetch'); }) as typeof fetch);
    expect(await dispatchSearch(handler)).toEqual({
      ok: false, call_id: 'search-receipt', tool: 'web_search',
      code: 'auth_failed', error: 'Web search is not set up on this Waldo yet.',
      reason: 'tool_result_error', source_taint: 'external',
    });
    expect(requests).toBe(0);
  });
  it.each([401, 403])('preserves rejected key HTTP %s as an external auth failure', async (status) => {
    const handler = webSearchHandler('synthetic-key', (async () => new Response('rejected', { status })) as typeof fetch);
    expect(await dispatchSearch(handler)).toEqual({
      ok: false, call_id: 'search-receipt', tool: 'web_search',
      code: 'auth_failed', error: `The web search key was rejected (HTTP ${status}) - it needs replacing.`,
      reason: 'tool_result_error', source_taint: 'external',
    });
  });
  it('preserves mapped successful results through dispatcher hooks', async () => {
    const handler = webSearchHandler('synthetic-key', braveOk([
      { title: 'no URL' },
      { title: 'Waldo', url: 'https://example.com/waldo', description: 'Synthetic result' },
    ]) as typeof fetch);
    expect(await dispatchSearch(handler)).toEqual({
      ok: true, call_id: 'search-receipt', tool: 'web_search',
      data: { query: 'waldo', hits: [{ title: 'Waldo', url: 'https://example.com/waldo', snippet: 'Synthetic result' }] },
      source_taint: 'external',
    });
  });

  it('preserves non-Error provider rejections as external diagnostics', async () => {
    const handler = webSearchHandler('synthetic-key', (async () => { throw 'synthetic network rejection'; }) as typeof fetch);
    expect(await dispatchSearch(handler)).toMatchObject({
      ok: false, code: 'transient', error: 'synthetic network rejection',
      reason: 'tool_result_error', source_taint: 'external',
    });
  });

  it.each([
    { ok: false, code: 'transient', error: 'unstamped provider error' },
    { ok: false, code: 'transient', error: 'null-stamped provider error', source_taint: null },
    { ok: false, code: 'unknown', error: 'invalid error code', source_taint: 'external' },
    { ok: false, code: 'transient', error: 'extra result field', source_taint: 'external', extra: true },
  ])('still rejects malformed external failure receipts: %j', async (receipt) => {
    const handler = webSearchHandler('synthetic-key', braveOk([]) as typeof fetch);
    const malformedHandler = {
      ...handler,
      handle: async () => receipt as unknown as Awaited<ReturnType<typeof handler.handle>>,
    };
    expect(await dispatchSearch(malformedHandler)).toEqual({
      ok: false, call_id: 'search-receipt', tool: 'web_search',
      code: 'transient', error: 'tool handler returned invalid result', reason: 'invalid_handler_result',
    });
  });
});
