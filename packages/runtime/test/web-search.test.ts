import { describe, expect, it } from 'vitest';
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
