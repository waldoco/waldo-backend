import { describe, expect, it, vi } from 'vitest';
import { browseActHandler } from '../src/tools/live/browser';

const ctx = {} as never;
const args = { url: 'https://example.com', task: 'find the pricing section', max_actions: 3 };

type Op = 'start' | 'navigate' | 'observe' | 'act' | 'extract' | 'end';
const opOf = (url: string): Op =>
  url.includes('/start') ? 'start' : url.includes('/navigate') ? 'navigate' : url.includes('/observe') ? 'observe' : url.includes('/act') ? 'act' : url.includes('/extract') ? 'extract' : 'end';

type Action = { selector: string; description: string; method?: string; arguments?: string[] };
const stagehand = (opts: {
  actions?: (Action | null)[];
  failOp?: Op;
  status?: number;
} = {}) => {
  const calls: { op: Op; body: Record<string, unknown> }[] = [];
  let observeCount = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const op = opOf(String(input));
    calls.push({ op, body: JSON.parse(String(init?.body ?? '{}')) });
    if (opts.failOp === op) return new Response('err', { status: opts.status ?? 500 });
    switch (op) {
      case 'start':
        return new Response(JSON.stringify({ success: true, data: { sessionId: 'sess-1', available: true } }));
      case 'navigate':
        return new Response(JSON.stringify({ success: true, data: { result: null, actionId: 'a1' } }));
      case 'observe': {
        const action = (opts.actions ?? [{ selector: '#q', description: 'Click the search box', method: 'click', arguments: [] }, null])[observeCount] ?? null;
        observeCount += 1;
        return new Response(JSON.stringify({ success: true, data: { result: action ? [action] : [], actionId: `o${observeCount}` } }));
      }
      case 'act':
        return new Response(JSON.stringify({ success: true, data: { result: null, actionId: 'a2' } }));
      case 'extract':
        return new Response(JSON.stringify({ success: true, data: { result: { summary: 'Pricing shown' }, actionId: 'a3' } }));
      case 'end':
        return new Response(JSON.stringify({ success: true }));
    }
  }) as typeof fetch;
  return { calls, fetcher };
};

describe('browse_act', () => {
  it('observe-before-act: takes the observed action, records it, extracts the final state, ends the session', async () => {
    const record = vi.fn();
    const { calls, fetcher } = stagehand();
    const result = await browseActHandler('k', 'p', undefined, record, fetcher).handle(args, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source_taint).toBe('external');
    expect(result.data.actions_taken).toEqual(['Click the search box']);
    expect(result.data.stopped).toBe('task_done');
    expect(result.data.data).toEqual({ summary: 'Pricing shown' });
    const ops = calls.map((c) => c.op);
    expect(ops[0]).toBe('start');
    expect(ops[1]).toBe('navigate');
    expect(ops[ops.length - 1]).toBe('end');
    expect(ops.indexOf('observe')).toBeLessThan(ops.indexOf('act'));
    expect(record).toHaveBeenCalledWith('browser_action', 'Browse step 1: Click the search box', { url: args.url, selector: '#q', method: 'click' });
  });

  it('caps the loop at max_actions when observe always finds more to do', async () => {
    const { calls, fetcher } = stagehand({
      actions: Array(10).fill({ selector: '#more', description: 'Scroll for more', method: 'scroll' }),
    });
    const result = await browseActHandler('k', 'p', undefined, undefined, fetcher).handle({ ...args, max_actions: 2 }, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stopped).toBe('cap_reached');
    expect(result.data.actions_taken).toHaveLength(2);
    expect(calls.filter((c) => c.op === 'act')).toHaveLength(2);
  });

  it('DETERMINISTIC stop before irreversible-looking actions - it never acts on submit/pay/send/delete/login', async () => {
    for (const blocked of [
      { selector: '#b', description: 'Submit the payment form', method: 'click' },
      { selector: '#b', description: 'Pay now', method: 'click' },
      { selector: '#b', description: 'Send message', method: 'click' },
      { selector: '#b', description: 'Book the flight', method: 'click' },
      { selector: '#b', description: 'Delete account', method: 'click' },
      { selector: '#b', description: 'Log in', method: 'click' },
      { selector: '#b', description: 'Continue', method: 'submit' },
    ]) {
      const record = vi.fn();
      const { calls, fetcher } = stagehand({ actions: [blocked] });
      const result = await browseActHandler('k', 'p', undefined, record, fetcher).handle(args, ctx);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data.stopped).toBe('irreversible_blocked');
      expect(result.data.blocked_action).toBe(blocked.description);
      expect(result.data.actions_taken).toHaveLength(0);
      expect(calls.filter((c) => c.op === 'act')).toHaveLength(0);
      expect(record).not.toHaveBeenCalled();
    }
  });

  it('stops honestly when observe finds nothing on the first step', async () => {
    const { calls, fetcher } = stagehand({ actions: [null] });
    const result = await browseActHandler('k', 'p', undefined, undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stopped).toBe('no_action_found');
    expect(calls.some((c) => c.op === 'act')).toBe(false);
  });

  it('auth discipline: missing keys never start a session; 401 on start is auth_failed', async () => {
    const { calls, fetcher } = stagehand();
    const noKeys = await browseActHandler(undefined, undefined, undefined, undefined, fetcher).handle(args, ctx);
    expect(noKeys.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const rejected = await browseActHandler('bad', 'p', undefined, undefined, stagehand({ failOp: 'start', status: 403 }).fetcher).handle(args, ctx);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('auth_failed');
  });

  it('mid-loop failures (observe/act/extract 5xx or network throw) are transient and still end the session', async () => {
    for (const failOp of ['observe', 'act', 'extract'] as const) {
      const { calls, fetcher } = stagehand({ failOp });
      const result = await browseActHandler('k', 'p', undefined, undefined, fetcher).handle(args, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('transient');
      expect(calls[calls.length - 1]!.op).toBe('end');
    }
  });

  it('secrets never appear in the returned data or error text', async () => {
    const { fetcher } = stagehand();
    const result = await browseActHandler('bb-secret', 'proj-secret', 'model-secret', undefined, fetcher).handle(args, ctx);
    const rendered = JSON.stringify(result);
    for (const secret of ['bb-secret', 'proj-secret', 'model-secret', 'sess-1']) {
      expect(rendered).not.toContain(secret);
    }
  });
});
