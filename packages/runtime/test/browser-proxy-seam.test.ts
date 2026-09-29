import { describe, expect, it } from 'vitest';
import { browserStartParams, browsePageHandler, browseActHandler, executeBrowserSubmit } from '../src/tools/live/browser';

const ctx = {} as never;
const proxy = { server: 'https://egress.example.com', username: 'owner', password: 'secret' };
const expected = { modelName: expect.stringMatching(/^openai\//), verbose: 0, browserbaseSessionCreateParams: { proxies: [{ type: 'external', server: proxy.server, username: proxy.username, password: proxy.password }] } };

describe('browser proxy transport seam', () => {
  it('maps a complete HTTPS proxy onto Stagehand session start with one catch-all route', () => {
    expect(browserStartParams(proxy)).toEqual(expected);
    expect(browserStartParams()).toEqual({ modelName: expect.stringMatching(/^openai\//), verbose: 0 });
  });
  it.each([
    { server: 'http://egress.example.com', username: 'u', password: 'p' },
    { server: 'https://egress.example.com', username: 'u' },
    { server: 'https://egress.example.com', password: 'p' },
    { server: 'https://u:p@egress.example.com', username: 'u', password: 'p' },
    { server: 'https://egress.example.com/path', username: 'u', password: 'p' },
    { username: 'u', password: 'p' },
  ])('refuses incomplete or unsafe configured proxy before starting a session', async (bad) => {
    expect(browserStartParams(bad)).toBeNull();
    const fetcher = (() => { throw new Error('must not fetch'); }) as typeof fetch;
    const page = await browsePageHandler('key', 'project', undefined, fetcher, bad).handle({ url: 'https://example.com', instruction: 'read' }, ctx);
    const act = await browseActHandler('key', 'project', undefined, undefined, undefined, fetcher, bad).handle({ url: 'https://example.com', task: 'look', max_actions: 1 }, ctx);
    expect(page.ok).toBe(false);
    expect(act.ok).toBe(false);
  });
  it('uses the same external proxy for read and action starts, without leaking credentials in result', async () => {
    const starts: object[] = [];
    const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
      const path = String(url);
      if (path.endsWith('/start')) { starts.push(JSON.parse(String(init?.body))); return Response.json({ success: true, data: { sessionId: 'session' } }); }
      if (path.endsWith('/navigate')) return Response.json({ success: true });
      if (path.endsWith('/observe')) return Response.json({ success: true, data: { result: [] } });
      if (path.endsWith('/extract')) return Response.json({ success: true, data: { result: {} } });
      return Response.json({ success: true });
    }) as typeof fetch;
    const page = await browsePageHandler('key', 'project', undefined, fetcher, proxy).handle({ url: 'https://example.com', instruction: 'read' }, ctx);
    const act = await browseActHandler('key', 'project', undefined, undefined, undefined, fetcher, proxy).handle({ url: 'https://example.com', task: 'look', max_actions: 1 }, ctx);
    expect(starts).toEqual([expected, expected]);
    expect(JSON.stringify([page, act])).not.toContain('secret');
  });
});

describe('proxy failure handling', () => {
  it('does not expose a proxy password from a thrown network error', async () => {
    const fetcher = (() => { throw new Error('proxy secret denied'); }) as typeof fetch;
    const result = await browsePageHandler('key', 'project', undefined, fetcher, proxy).handle({ url: 'https://example.com', instruction: 'read' }, ctx);
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(result.ok).toBe(false);
  });
  it('refuses an incomplete route before an approved submit starts', async () => {
    const fetcher = (() => { throw new Error('must not fetch'); }) as typeof fetch;
    const message = await executeBrowserSubmit('key', 'project', undefined, {} as never, fetcher, { server: proxy.server });
    expect(message).toContain('not configured safely');
  });
});

// Browserbase returns errors at session creation when its external proxy cannot be reached.
// No fallback start is made by this handler.
