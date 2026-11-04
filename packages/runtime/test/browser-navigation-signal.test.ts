import { describe, expect, it } from 'vitest';
import { browseActHandler, browsePageHandler } from '../src/tools/live/browser';

const open = { egressAllowlist: ['*'] } as never;
const pageArgs = { url: 'https://example.com', instruction: 'what is on this page' };
const actArgs = { url: 'https://example.com', task: 'open pricing', max_actions: 2 };
const action = { selector: '#p', description: 'Click the pricing link', method: 'click', arguments: [] };
const json = (body: unknown, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });

type Script = { navigate?: Response; debug?: Response };
const stagehand = (script: Script = {}) => {
  const ops: string[] = [];
  const debugHeaders: Record<string, string>[] = [];
  let observed = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const op = url.includes('/debug') ? 'debug' : (url.split('/').pop() ?? '');
    ops.push(op);
    if (op === 'debug') {
      expect(new URL(url).origin).toBe('https://api.browserbase.com');
      expect(init?.method).toBe('GET');
      debugHeaders.push({ ...(init?.headers as Record<string, string>) });
      return script.debug ?? json({ pages: [{ id: 'p', url: 'https://example.com/pricing', title: 't' }] });
    }
    switch (op) {
      case 'start': return json({ success: true, data: { sessionId: 'sess-1' } });
      case 'navigate': return script.navigate ?? json({ success: true, data: { result: null } });
      case 'observe': observed += 1; return json({ success: true, data: { result: observed === 1 ? [action] : [] } });
      case 'act': return json({ success: true, data: { result: null } });
      case 'extract': return json({ success: true, data: { result: { title: 'Example' } } });
      default: return json({ success: true });
    }
  }) as typeof fetch;
  return { ops, fetcher, debugHeaders };
};

describe('browse_page navigation failure signal', () => {
  it('HTTP 200 with success:false from navigate is a failed load, not a page to extract', async () => {
    const { ops, fetcher } = stagehand({ navigate: json({ success: false, data: { result: null } }) });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(pageArgs, open);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('transient');
    expect(ops).toEqual(['start', 'navigate', 'end']);
  });

  it('an unreadable navigate body is not evidence of a loaded page', async () => {
    const { ops, fetcher } = stagehand({ navigate: json('<html>gateway</html>') });
    const result = await browsePageHandler('k', 'p', undefined, fetcher).handle(pageArgs, open);
    expect(result.ok).toBe(false);
    expect(ops).toEqual(['start', 'navigate', 'end']);
  });
});

describe('browse_act navigation and post-step page recheck', () => {
  it('navigate success:false stops before any observe', async () => {
    const { ops, fetcher } = stagehand({ navigate: json({ success: false, data: { result: null } }) });
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(actArgs, open);
    expect(result.ok).toBe(false);
    expect(ops).toEqual(['start', 'navigate', 'end']);
  });

  it('rechecks pages[].url after each act step and reads on when the page stays allowed', async () => {
    const { ops, fetcher } = stagehand();
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(actArgs, open);
    expect(result.ok).toBe(true);
    expect(ops).toEqual(['start', 'navigate', 'observe', 'act', 'debug', 'observe', 'extract', 'end']);
  });

  it('a step that redirected to a private address is rejected and nothing is extracted', async () => {
    const { ops, fetcher } = stagehand({ debug: json({ pages: [{ id: 'p', url: 'http://169.254.169.254/latest/meta-data', title: 't' }] }) });
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(actArgs, open);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('rejected');
    expect(JSON.stringify(result)).not.toContain('169.254');
    expect(ops).toEqual(['start', 'navigate', 'observe', 'act', 'debug', 'end']);
  });

  it('any open page counts: a popup on a blocked host is rejected (no active-tab flag exists)', async () => {
    const { ops, fetcher } = stagehand({ debug: json({ pages: [
      { id: 'a', url: 'https://example.com/', title: 't' }, { id: 'b', url: 'http://127.0.0.1:8787/admin', title: 't' }] }) });
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(actArgs, open);
    expect(result.ok).toBe(false);
    expect(ops).not.toContain('extract');
  });

  it('honours a restrictive allowlist: a redirect off the listed hosts is rejected', async () => {
    const { ops, fetcher } = stagehand({ debug: json({ pages: [{ id: 'p', url: 'https://other.example.org/', title: 't' }] }) });
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(actArgs, { egressAllowlist: ['example.com'] } as never);
    expect(result.ok).toBe(false);
    expect(ops).not.toContain('extract');
  });

  it('fails closed when the page list cannot be read, never assuming the page is fine', async () => {
    for (const debug of [json('no', 500), json({ nope: 1 }), json('not json')]) {
      const { ops, fetcher } = stagehand({ debug });
      const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(actArgs, open);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('transient');
      expect(ops).not.toContain('extract');
      expect(ops.at(-1)).toBe('end');
    }
  });

  it('the acted step stays recorded when the recheck rejects', async () => {
    const recorded: string[] = [];
    const { fetcher } = stagehand({ debug: json({ pages: [{ id: 'p', url: 'http://10.0.0.1/', title: 't' }] }) });
    await browseActHandler('k', 'p', undefined, (kind) => recorded.push(kind), undefined, fetcher).handle(actArgs, open);
    expect(recorded).toEqual(['browser_action']);
  });
  it('the Browserbase debug call carries only the Browserbase key, never the model key or project id', async () => {
    const { fetcher, debugHeaders } = stagehand();
    await browseActHandler('bb-key', 'proj', 'model-key', undefined, undefined, fetcher).handle(actArgs, open);
    expect(debugHeaders.length).toBeGreaterThan(0);
    for (const headers of debugHeaders) expect(headers).toEqual({ 'x-bb-api-key': 'bb-key' });
  });

  it.each([
    ['an entry without a url', [{ id: 'x' }]],
    ['a null entry', [null]],
    ['an empty page list', []],
    ['a blank page', [{ id: 'p', url: 'about:blank' }]],
    ['a non-string url', [{ id: 'p', url: 42 }]],
  ])('%s is unverified, never read', async (_name, pages) => {
    const { ops, fetcher } = stagehand({ debug: json({ pages }) });
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(actArgs, open);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('transient');
    expect(result.error).toContain('could not be verified');
    expect(ops).not.toContain('extract');
  });
});
