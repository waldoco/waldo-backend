import { describe, expect, it } from 'vitest';
import { OPENAI_GPT_5_NANO_MODEL, OPENAI_PROVIDER } from '@waldo/contracts';
import { browsePageHandler } from '../src/tools/live/browser';

const ctx = {} as never;
const args = { url: 'https://example.com', instruction: 'what is on this page' };

type Op = 'start' | 'navigate' | 'extract' | 'end';
const opOf = (url: string): Op =>
  url.includes('/start') ? 'start' : url.includes('/navigate') ? 'navigate' : url.includes('/extract') ? 'extract' : 'end';

const stagehand = (overrides: Partial<Record<Op, Response>> = {}) => {
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
    return overrides[op] ?? ok[op]();
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
    expect(result.data).toEqual({ url: 'https://example.com', data: { title: 'Example' } });
    expect(calls.map((c) => c.op)).toEqual(['start', 'navigate', 'extract', 'end']);
    expect(calls[0]!.path).toBe('/v1/sessions/start');
    expect(calls[2]!.path).toBe('/v1/sessions/sess-1/extract');
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

  it('start succeeds but returns no session: transient, and end is not called without a session', async () => {
    const { calls, fetcher } = stagehand({ start: new Response(JSON.stringify({ success: false, data: {} })) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('transient');
    expect(calls.map((c) => c.op)).toEqual(['start']);
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

  it('a failing end call never masks a successful extraction', async () => {
    const { fetcher } = stagehand({ end: new Response('err', { status: 500 }) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(true);
  });

  it('the model passed to extract comes from the roster, never a literal', async () => {
    const { calls, fetcher } = stagehand();
    await browsePageHandler('k', 'p', 'model-key', fetcher).handle(args, ctx);
    const extract = calls.find((c) => c.op === 'extract');
    const start = calls.find((c) => c.op === 'start');
    expect(start?.body.modelName).toBe(`${OPENAI_PROVIDER}/${OPENAI_GPT_5_NANO_MODEL}`);
    const model = (extract?.body.options as { model: { modelName: string; apiKey: string } }).model;
    expect(model.modelName).toBe(start?.body.modelName);
    expect(model.apiKey).toBe('model-key');
  });
});
