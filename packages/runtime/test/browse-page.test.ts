import { describe, expect, it } from 'vitest';
import { browsePageHandler } from '../src/tools/live/browser';

const ctx = {} as never;
const args = { url: 'https://example.com', instruction: 'what is on this page' };

type Op = 'start' | 'navigate' | 'extract' | 'end';
const opOf = (url: string): Op =>
  url.includes('/start') ? 'start' : url.includes('/navigate') ? 'navigate' : url.includes('/extract') ? 'extract' : 'end';

const stagehand = (overrides: Partial<Record<Op, Response | Error>> = {}) => {
  const calls: { op: Op; path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
  const ok: Record<Op, () => Response> = {
    start: () => new Response(JSON.stringify({ success: true, data: { sessionId: 'sess-1', available: true } })),
    navigate: () => new Response(JSON.stringify({ success: true, data: { result: null, actionId: 'a1' } })),
    extract: () => new Response(JSON.stringify({ success: true, data: { result: { title: 'Example' }, actionId: 'a2' } })),
    end: () => new Response(JSON.stringify({ success: true })),
  };
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const op = opOf(String(input));
    calls.push({ op, path: new URL(String(input)).pathname, headers: (init?.headers ?? {}) as Record<string, string>, body: JSON.parse(String(init?.body ?? '{}')) });
    const override = overrides[op];
    if (override instanceof Error) throw override;
    return override ?? ok[op]();
  }) as typeof fetch;
  return { calls, fetcher };
};

describe('browse_page', () => {
  it('runs start -> navigate -> extract -> end in order and returns the extraction, tainted external', async () => {
    const { calls, fetcher } = stagehand();
    const handler = browsePageHandler('bb-key', 'bb-proj', 'model-key', fetcher);
    const result = await handler.handle(args, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source_taint).toBe('external');
    expect(result.data).toEqual({ url: 'https://example.com', provider: 'browserbase_stagehand_http_v3', data: { title: 'Example' } });
    expect(result.browser_read).toEqual({ provider: 'browserbase_stagehand_http_v3', phase: 'complete', reason: 'completed', cleanup: 'confirmed' });
    expect(calls.map((c) => c.op)).toEqual(['start', 'navigate', 'extract', 'end']);
    expect(calls[0]!.path).toBe('/v1/sessions/start');
    expect(calls[2]!.path).toBe('/v1/sessions/sess-1/extract');
  });

  it('sends the model key as the x-model-api-key header on the session start (Stagehand spec), not only in the extract body', async () => {
    const { calls, fetcher } = stagehand();
    const handler = browsePageHandler('bb-key', 'bb-proj', 'model-secret', fetcher);
    await handler.handle(args, ctx);
    expect(calls[0]!.op).toBe('start');
    expect(calls[0]!.headers['x-model-api-key']).toBe('model-secret');
    expect(calls[2]!.headers['x-model-api-key']).toBe('model-secret');
  });

  it('sends no x-model-api-key header when no model key is configured', async () => {
    const { calls, fetcher } = stagehand();
    const handler = browsePageHandler('bb-key', 'bb-proj', undefined, fetcher);
    await handler.handle(args, ctx);
    expect(calls.every((c) => c.headers['x-model-api-key'] === undefined)).toBe(true);
  });

  it('sends keys only in request headers - never in the returned data or errors', async () => {
    const { calls, fetcher } = stagehand();
    const handler = browsePageHandler('bb-secret', 'bb-proj', 'model-secret', fetcher);
    const result = await handler.handle(args, ctx);
    expect(calls[0]!.headers['x-bb-api-key']).toBe('bb-secret');
    expect(calls[0]!.headers['x-bb-project-id']).toBe('bb-proj');
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('bb-secret');
    expect(rendered).not.toContain('model-secret');
    expect(rendered).not.toContain('sess-1');
  });

  it('no keys configured: honest auth_failed, no session started', async () => {
    const { calls, fetcher } = stagehand();
    const result = await browsePageHandler(undefined, undefined, undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('auth_failed');
    expect(result.error).toContain('not set up');
    expect(calls).toHaveLength(0);
  });

  it('rejected key on start (401) surfaces as auth_failed and still attempts no navigate', async () => {
    const { calls, fetcher } = stagehand({ start: new Response('no', { status: 401 }) });
    const result = await browsePageHandler('bad', 'proj', undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('auth_failed');
    expect(calls.map((c) => c.op)).toEqual(['start']);
  });

  it('start returns no usable session identity: rejected with unknown allocation, without guessing an end target', async () => {
    const { calls, fetcher } = stagehand({ start: new Response(JSON.stringify({ success: false, data: {} })) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('rejected');
    expect(result.browser_read).toEqual({ provider: 'browserbase_stagehand_http_v3', phase: 'allocation', reason: 'invalid_session', cleanup: 'unknown_allocation' });
    expect(calls.map((c) => c.op)).toEqual(['start']);
  });

  it.each([[undefined], [null], [123], [{}], [''], ['../foreign'], ['x'.repeat(129)]])('a successful start with malformed session identity %j never navigates or guesses a cleanup target', async sessionId => {
    const { calls, fetcher } = stagehand({ start: Response.json({ success: true, data: { sessionId } }) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result).toEqual({ ok: false, code: 'rejected', error: 'Browser session start returned no valid session identity. The Browserbase cleanup is unconfirmed. No browser read is reported as complete.', source_taint: 'external', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'allocation', reason: 'invalid_session', cleanup: 'unknown_allocation' } });
    expect(calls.map((c) => c.op)).toEqual(['start']);
  });

  it('retains a valid session identity for cleanup when start is not acknowledged', async () => {
    const { calls, fetcher } = stagehand({ start: Response.json({ success: false, data: { sessionId: 'sess-1' } }) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result).toEqual({ ok: false, code: 'transient', error: 'Browser session start was not acknowledged.', source_taint: 'external', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'allocation', reason: 'provider_failure', cleanup: 'confirmed' } });
    expect(calls.map((c) => c.op)).toEqual(['start', 'end']);
    expect(calls[1]!.path).toBe('/v1/sessions/sess-1/end');
  });

  it('navigate or extract failure maps to transient and the session is still ended', async () => {
    for (const override of [
      { navigate: new Response('err', { status: 502 }) },
      { extract: new Response('err', { status: 500 }) },
    ]) {
      const { calls, fetcher } = stagehand(override);
      const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('transient');
      expect(calls[calls.length - 1]!.op).toBe('end');
    }
  });

  it('a network throw maps to transient and still ends an open session', async () => {
    const { calls, fetcher } = stagehand();
    const throwing: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes('/extract')) throw new Error('socket reset');
      return fetcher(input, init);
    }) as typeof fetch;
    const result = await browsePageHandler('k', 'p', undefined, throwing).handle(args, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('transient');
    expect(calls[calls.length - 1]!.op).toBe('end');
  });

  it('a failing end call cannot certify a completed read and suppresses extracted content', async () => {
    const { calls, fetcher } = stagehand({ end: new Response('err', { status: 500 }) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result).toEqual({ ok: false, code: 'rejected', error: 'The Browserbase cleanup is unconfirmed. No browser read is reported as complete.', source_taint: 'external', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'cleanup', reason: 'cleanup_unconfirmed', cleanup: 'unconfirmed' } });
    expect(calls.map((c) => c.op)).toEqual(['start', 'navigate', 'extract', 'end']);
  });

  it.each(['http', 'false', 'missing', 'malformed', 'throw'] as const)('unconfirmed %s cleanup preserves the observed read failure and never retries', async mode => {
    const end = mode === 'throw' ? Error('cleanup-body-secret')
      : mode === 'http' ? new Response('cleanup-body-secret', { status: 500 })
      : mode === 'malformed' ? new Response('cleanup-body-secret')
      : Response.json({ ...(mode === 'false' ? { success: false } : {}), message: 'cleanup-body-secret' });
    const { calls, fetcher } = stagehand({ navigate: new Response('navigation-body-secret', { status: 502 }), end });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result).toEqual({ ok: false, code: 'rejected', error: 'The page did not load (HTTP 502) The Browserbase cleanup is unconfirmed. No browser read is reported as complete.', source_taint: 'external', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'navigation', reason: 'provider_http', http_status: 502, cleanup: 'unconfirmed' } });
    expect(calls.map((c) => c.op)).toEqual(['start', 'navigate', 'end']);
    expect(JSON.stringify(result)).not.toContain('body-secret');
  });

  it('the model passed to extract comes from the roster, never a literal', async () => {
    const { calls, fetcher } = stagehand();
    await browsePageHandler('k', 'p', 'model-key', fetcher).handle(args, ctx);
    const extract = calls.find((c) => c.op === 'extract');
    const start = calls.find((c) => c.op === 'start');
    expect(String(start?.body.modelName)).toMatch(/^openai\//);
    const model = (extract?.body.options as { model: { modelName: string; apiKey: string } }).model;
    expect(model.modelName).toBe(start?.body.modelName);
    expect(model.apiKey).toBe('model-key');
  });
  it('a JSON failure body stays private while HTTP status is surfaced', async () => {
    const { fetcher } = stagehand({ navigate: new Response(JSON.stringify({ success: false, message: 'url must be absolute' }), { status: 400 }) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('HTTP 400');
    expect(result.error).not.toContain('url must be absolute');
  });

  it('failure bodies never leak keys, project ids or session ids', async () => {
    const { fetcher } = stagehand({ navigate: new Response(JSON.stringify({ success: false, message: 'bad key bb-secret proj bb-proj sess 123e4567-e89b-12d3-a456-426614174000' }), { status: 400 }) });
    const result = await browsePageHandler('bb-secret', 'bb-proj', undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const rendered = JSON.stringify(result);
    expect(rendered).not.toContain('bb-secret');
    expect(rendered).not.toContain('bb-proj');
    expect(rendered).not.toContain('123e4567-e89b-12d3-a456-426614174000');
    expect(result.error).toContain('HTTP 400');
    expect(result.error).not.toContain('bad key');
  });

  it.each([[null], [''], [{}], [{ price: null, title: '  ' }], [[]]])('an empty extraction (%j) is a not_found failure, not ok:true', async (result) => {
    const { fetcher } = stagehand({ extract: new Response(JSON.stringify({ success: true, data: { result, actionId: 'a2' } })) });
    const out = await browsePageHandler('bb-key', 'bb-proj', 'model-key', fetcher).handle(args, ctx);
    expect(out.ok).toBe(false);
    expect(out).toEqual({ ok: false, code: 'not_found', error: 'The page returned no readable content.', source_taint: 'external', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'extraction', reason: 'empty_content', cleanup: 'confirmed' } });
  });

  it.each([[0], [false], ['none'], [{ found: false }]])('a real but falsy answer (%j) stays ok', async (result) => {
    const { fetcher } = stagehand({ extract: new Response(JSON.stringify({ success: true, data: { result, actionId: 'a2' } })) });
    const out = await browsePageHandler('bb-key', 'bb-proj', 'model-key', fetcher).handle(args, ctx);
    expect(out).toEqual({ ok: true, data: { url: args.url, provider: 'browserbase_stagehand_http_v3', data: result }, source_taint: 'external', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'complete', reason: 'completed', cleanup: 'confirmed' } });
  });

  it('a partly filled extraction is still ok', async () => {
    const { fetcher } = stagehand({ extract: new Response(JSON.stringify({ success: true, data: { result: { price: null, title: 'Bose QC' }, actionId: 'a2' } })) });
    const out = await browsePageHandler('bb-key', 'bb-proj', 'model-key', fetcher).handle(args, ctx);
    expect(out).toEqual({ ok: true, data: { url: args.url, provider: 'browserbase_stagehand_http_v3', data: { price: null, title: 'Bose QC' } }, source_taint: 'external', browser_read: { provider: 'browserbase_stagehand_http_v3', phase: 'complete', reason: 'completed', cleanup: 'confirmed' } });
  });
});
