import { describe, expect, it } from 'vitest';
import { buildSessionState, type LLMTool, type LLMToolCall } from '@waldo/contracts';
import { BROWSING_UNAVAILABLE, runToolLoop, type ToolLoopEvent } from '../src/conversation/tool-loop';
import { OPEN_PUBLIC } from '../src/hooks/egress-policy';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import { getContextHandler } from '../src/tools/live/get-context';
import { browseActHandler, browsePageHandler } from '../src/tools/live/browser';
import { webSearchHandler } from '../src/tools/live/web-search';

const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const adapters = resolveRunLoopAdapters({ WALDO_ENV: 'local' });
const ctx = {
  authenticatedUserId: 'owner-1', trigger: 'user_message' as const, canaryTokens: CANARIES,
  sourceTaint: null, toolArgSourceTaint: null, egressAllowlist: [OPEN_PUBLIC],
  sanitise: adapters.safety.sanitise,
  session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
};
const clock = getContextHandler({ timezone: 'Asia/Kolkata', now: () => new Date('2026-09-23T08:20:00Z') });

// S5's browser: the Cloudflare reader is wired, so browse_page is offered, but this Waldo has no browser binding.
const unboundBrowser = (failure: Readonly<{ code: 'auth_failed' | 'rejected'; error: string }> = { code: 'auth_failed', error: 'The selected Cloudflare browser provider is unavailable.' }) => {
  const reads: string[] = [];
  const handler = browsePageHandler(undefined, undefined, undefined, fetch, {
    allowBrowserbase: false,
    cloudflare: async ({ url }) => { reads.push(url); return { ok: false, ...failure, source_taint: 'external' }; },
  });
  return { handler, reads };
};
const keyRejected = (async () => new Response('', { status: 401 })) as typeof fetch;
const browseAct = browseActHandler('browser-key', 'browser-project', undefined, undefined, undefined, keyRejected);

const browse = (n: number, url = `https://example.com/page-${n}`): LLMToolCall => ({ call_id: `b${n}`, name: 'browse_page', arguments: JSON.stringify({ url, instruction: 'Find the opening hours' }) });
const names = (tools: readonly LLMTool[] | undefined) => tools?.map((tool) => tool.name);

// S5's model: while a browser is offered it reads the next page, up to three, then answers from what it has.
const s5Model = (offered: Array<readonly string[] | undefined>) => {
  let reads = 0;
  return async (tools: readonly LLMTool[] | undefined) => {
    offered.push(names(tools));
    if (tools?.some((tool) => tool.name === 'browse_page') && reads < 3) {
      reads += 1;
      return { text: '', tool_calls: [browse(reads)] };
    }
    return { text: 'I could not read those pages.' };
  };
};

describe('a browse auth_failed ends browsing for the rest of the turn', () => {
  it('S5: one failed read instead of three, two model rounds sooner', async () => {
    const { handler, reads } = unboundBrowser();
    const offered: Array<readonly string[] | undefined> = [];
    const events: ToolLoopEvent[] = [];
    const text = await runToolLoop({ handlers: [clock, handler, browseAct], ctx, maxSteps: 25, onTool: (event) => events.push(event), step: s5Model(offered) });
    expect(text).toBe('I could not read those pages.');
    expect(reads).toEqual(['https://example.com/page-1']);
    // Both browse tools go; nothing else does.
    expect(offered).toEqual([['get_context', 'browse_page', 'browse_act'], ['get_context']]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ ok: false, code: 'auth_failed' });
    expect(events[0]!.output.endsWith(`\n[${BROWSING_UNAVAILABLE}]`)).toBe(true);
  });

  it('withholds browse_page after browse_act fails auth_failed', async () => {
    const { handler, reads } = unboundBrowser();
    const offered: Array<readonly string[] | undefined> = [];
    await runToolLoop({
      handlers: [clock, handler, browseAct], ctx, maxSteps: 25,
      step: async (tools) => {
        offered.push(names(tools));
        return offered.length === 1
          ? { text: '', tool_calls: [{ call_id: 'a1', name: 'browse_act', arguments: JSON.stringify({ url: 'https://example.com', task: 'Find the opening hours' }) }] }
          : { text: 'Browsing is not working here.' };
      },
    });
    expect(offered).toEqual([['get_context', 'browse_page', 'browse_act'], ['get_context']]);
    expect(reads).toEqual([]);
  });

  it('answers a second browse call in the same response without running it', async () => {
    const { handler, reads } = unboundBrowser();
    const events: ToolLoopEvent[] = [];
    await runToolLoop({
      handlers: [clock, handler], ctx, maxSteps: 25, onTool: (event) => events.push(event),
      step: async (tools) => (tools?.some((tool) => tool.name === 'browse_page') && events.length === 0
        ? { text: '', tool_calls: [browse(1), browse(2)] }
        : { text: 'Neither page could be read.' }),
    });
    expect(reads).toEqual(['https://example.com/page-1']);
    expect(events.map((event) => [event.code, event.reason])).toEqual([['auth_failed', 'tool_result_error'], ['auth_failed', 'withheld_this_turn']]);
    expect(JSON.parse(events[1]!.output)).toMatchObject({ ok: false, error: BROWSING_UNAVAILABLE });
  });

  it('keys on the typed code, not the words: another browse failure leaves browsing offered', async () => {
    const { handler, reads } = unboundBrowser({ code: 'rejected', error: 'The selected Cloudflare browser provider is unavailable.' });
    const offered: Array<readonly string[] | undefined> = [];
    await runToolLoop({ handlers: [clock, handler], ctx, maxSteps: 25, step: s5Model(offered) });
    expect(reads).toHaveLength(3);
    expect(offered.slice(0, 4).every((tools) => tools?.includes('browse_page'))).toBe(true);
  });

  it("withholds nothing after another tool's auth_failed", async () => {
    const search = webSearchHandler('search-key');
    const rejectedSearch: typeof search = { ...search, handle: async () => ({ ok: false, code: 'auth_failed', error: 'The search key was rejected.' }) };
    const { handler } = unboundBrowser();
    const offered: Array<readonly string[] | undefined> = [];
    await runToolLoop({
      handlers: [rejectedSearch, handler], ctx, maxSteps: 25,
      step: async (tools) => {
        offered.push(names(tools));
        return offered.length === 1
          ? { text: '', tool_calls: [{ call_id: 's1', name: 'web_search', arguments: JSON.stringify({ query: 'opening hours' }) }] }
          : { text: 'Search is not working.' };
      },
    });
    expect(offered).toEqual([['web_search', 'browse_page'], ['web_search', 'browse_page']]);
  });

  it('offers browsing again on the next turn, where eligibility decides', async () => {
    const { handler } = unboundBrowser();
    await runToolLoop({ handlers: [clock, handler], ctx, maxSteps: 25, step: s5Model([]) });
    const offered: Array<readonly string[] | undefined> = [];
    await runToolLoop({ handlers: [clock, handler], ctx, maxSteps: 25, step: s5Model(offered) });
    expect(offered[0]).toEqual(['get_context', 'browse_page']);
  });
});
