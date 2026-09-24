import { describe, expect, it, vi } from 'vitest';
import { browseActHandler, executeBrowserSubmit } from '../src/tools/live/browser';

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
    const result = await browseActHandler('k', 'p', undefined, record, undefined, fetcher).handle(args, ctx);
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
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle({ ...args, max_actions: 2 }, ctx);
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
      const result = await browseActHandler('k', 'p', undefined, record, undefined, fetcher).handle(args, ctx);
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
    const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(args, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stopped).toBe('no_action_found');
    expect(calls.some((c) => c.op === 'act')).toBe(false);
  });

  it('auth discipline: missing keys never start a session; 401 on start is auth_failed', async () => {
    const { calls, fetcher } = stagehand();
    const noKeys = await browseActHandler(undefined, undefined, undefined, undefined, undefined, fetcher).handle(args, ctx);
    expect(noKeys.ok).toBe(false);
    expect(calls).toHaveLength(0);
    const rejected = await browseActHandler('bad', 'p', undefined, undefined, undefined, stagehand({ failOp: 'start', status: 403 }).fetcher).handle(args, ctx);
    expect(rejected.ok).toBe(false);
    if (rejected.ok) return;
    expect(rejected.code).toBe('auth_failed');
  });

  it('mid-loop failures (observe/act/extract 5xx or network throw) are transient and still end the session', async () => {
    for (const failOp of ['observe', 'act', 'extract'] as const) {
      const { calls, fetcher } = stagehand({ failOp });
      const result = await browseActHandler('k', 'p', undefined, undefined, undefined, fetcher).handle(args, ctx);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('transient');
      expect(calls[calls.length - 1]!.op).toBe('end');
    }
  });

  it('secrets never appear in the returned data or error text', async () => {
    const { fetcher } = stagehand();
    const result = await browseActHandler('bb-secret', 'proj-secret', 'model-secret', undefined, undefined, fetcher).handle(args, ctx);
    const rendered = JSON.stringify(result);
    for (const secret of ['bb-secret', 'proj-secret', 'model-secret', 'sess-1']) {
      expect(rendered).not.toContain(secret);
    }
  });
});

describe('browse_act approval path (B-tool-3)', () => {
  it('an irreversible action becomes an approval proposal with the page binding - nothing is acted on', async () => {
    const { calls, fetcher } = stagehand({ actions: [{ selector: '#pay', description: 'Place the order', method: 'click' }] });
    const proposals: unknown[] = [];
    const result = await browseActHandler('k', 'p', undefined, undefined, async (payload) => { proposals.push(payload); return 'p123'; }, fetcher).handle(args, ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.stopped).toBe('approval_pending');
    expect(result.data.proposal_id).toBe('p123');
    expect(proposals).toHaveLength(1);
    const payload = proposals[0] as { url: string; action: { description: string }; binding: unknown; steps: string[] };
    expect(payload.url).toBe(args.url);
    expect(payload.action.description).toBe('Place the order');
    expect(calls.filter((c) => c.op === 'act')).toHaveLength(0);
    expect(calls[calls.length - 1]!.op).toBe('end');
  });
});

describe('executeBrowserSubmit', () => {
  const proposal = {
    url: 'https://shop.example/checkout',
    action: { selector: '#pay', description: 'Place the order', method: 'click' },
    binding: { total: 'Rs 499' },
    steps: ['Add to cart'],
  } as const;

  const executorFake = (opts: { binding?: unknown; observeAction?: object | null; failOp?: Op } = {}) => {
    const calls: Op[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const op = opOf(String(input));
      calls.push(op);
      if (opts.failOp === op) return new Response('err', { status: 500 });
      switch (op) {
        case 'start': return new Response(JSON.stringify({ success: true, data: { sessionId: 's9', available: true } }));
        case 'navigate': return new Response(JSON.stringify({ success: true, data: { result: null, actionId: 'n1' } }));
        case 'observe': return new Response(JSON.stringify({ success: true, data: { result: opts.observeAction === null ? [] : [opts.observeAction ?? proposal.action], actionId: 'o1' } }));
        case 'extract': return new Response(JSON.stringify({ success: true, data: { result: opts.binding ?? { total: 'Rs 499' }, actionId: 'e1' } }));
        case 'act': return new Response(JSON.stringify({ success: true, data: { result: null, actionId: 'a1' } }));
        case 'end': return new Response(JSON.stringify({ success: true }));
      }
    }) as typeof fetch;
    return { calls, fetcher };
  };

  it('acts only when the re-read binding matches the approved one, then ends the session', async () => {
    const { calls, fetcher } = executorFake();
    const message = await executeBrowserSubmit('k', 'p', undefined, proposal, fetcher);
    expect(message).toContain('Done: Place the order');
    expect(calls).toContain('act');
    expect(calls[calls.length - 1]).toBe('end');
  });

  it('aborts when the price drifted - no act, honest drift report', async () => {
    const { calls, fetcher } = executorFake({ binding: { total: 'Rs 899' } });
    const message = await executeBrowserSubmit('k', 'p', undefined, proposal, fetcher);
    expect(message).toContain('did NOT do it');
    expect(message).toContain('Rs 499');
    expect(message).toContain('Rs 899');
    expect(calls).not.toContain('act');
    expect(calls[calls.length - 1]).toBe('end');
  });

  it('aborts when the action is no longer on the page', async () => {
    const { calls, fetcher } = executorFake({ observeAction: null });
    const message = await executeBrowserSubmit('k', 'p', undefined, proposal, fetcher);
    expect(message).toContain('no longer on the page');
    expect(calls).not.toContain('act');
  });

  it('tolerates cosmetic binding differences (case/whitespace) but not real ones', async () => {
    const { calls, fetcher } = executorFake({ binding: { total: '  rs 499 ' } });
    const message = await executeBrowserSubmit('k', 'p', undefined, proposal, fetcher);
    expect(message).toContain('Done');
    expect(calls).toContain('act');
  });

  it('missing keys or a failed start: nothing happens, no act', async () => {
    expect(await executeBrowserSubmit(undefined, undefined, undefined, proposal)).toContain('not set up');
    const { calls, fetcher } = executorFake({ failOp: 'start' });
    const message = await executeBrowserSubmit('k', 'p', undefined, proposal, fetcher);
    expect(message).toContain('could not start');
    expect(calls).toEqual(['start']);
  });
});
