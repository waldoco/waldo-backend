import { describe, expect, it } from 'vitest';
import {
  browsePageArgsSchema, buildSessionState, TOOL_PERMISSIONS, triggerTypeSchema,
  type BrowserReadDiagnostic, type BrowsePageArgs, type LLMToolCall, type ToolHandler, type ToolResult,
} from '@waldo/contracts';
import { runToolLoop, type ToolLoopEvent } from '../src/conversation/tool-loop';
import { getContextHandler } from '../src/tools/live/get-context';
import { resolveRunLoopAdapters } from '../src/run-loop/adapters';
import type { ToolDispatcherContext } from '../src/tools/dispatcher';

const CF = 'cloudflare_playwright';
const BB = 'browserbase_stagehand_http_v3';
const URL = 'https://example.com/article?x=1';
const CANARIES = ['0123456789abcdef', 'fedcba9876543210', '0011223344556677'];
const diagnostic = (overrides: Partial<BrowserReadDiagnostic> = {}): BrowserReadDiagnostic => ({
  provider: CF, phase: 'navigation', reason: 'page_http', cleanup: 'confirmed', http_status: 503,
  configured_alternatives: [BB], ...overrides,
});
const failure = (browser_read = diagnostic()): ToolResult<unknown> => ({
  ok: false, error: 'Browser read failed.', code: 'transient', source_taint: 'external', browser_read,
});
const success = (provider: BrowserReadDiagnostic['provider'] = BB): ToolResult<unknown> => ({
  ok: true, data: { text: 'Synthetic public content.' }, source_taint: 'external',
  browser_read: { provider, phase: 'complete', reason: 'completed', cleanup: 'confirmed' },
});
const call = (provider: string | null = CF, url = URL, extra: Record<string, unknown> = {}): LLMToolCall => ({
  call_id: `call-${provider}-${url}`, name: 'browse_page', arguments: JSON.stringify({ url, instruction: 'Read this page', ...(provider ? { provider } : {}), ...extra }),
});
function context(): ToolDispatcherContext {
  return { authenticatedUserId: 'synthetic-owner', trigger: 'user_message', canaryTokens: CANARIES,
    sourceTaint: null, toolArgSourceTaint: null, egressAllowlist: ['example.com'],
    sanitise: resolveRunLoopAdapters({ WALDO_ENV: 'local' }).safety.sanitise,
    session: buildSessionState({ trigger: 'user_message', canary_tokens: CANARIES, started_at: 0 }),
  };
}
async function run(rounds: readonly (readonly LLMToolCall[])[], reply: (args: BrowsePageArgs) => ToolResult<unknown>, ctx = context()) {
  const dispatched: BrowsePageArgs[] = [];
  const events: ToolLoopEvent[] = [];
  const handler: ToolHandler<BrowsePageArgs, unknown, ToolDispatcherContext> = {
    name: 'browse_page', description: 'Read a public page', schema: browsePageArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('browse_page')),
    autonomy_gated: false, handle: async args => { dispatched.push(args); return reply(args); },
  };
  let next = 0;
  const text = await runToolLoop({ ctx, handlers: [handler, getContextHandler({ timezone: 'UTC', now: () => new Date('2026-10-06T12:00:00Z') })], maxSteps: 5, onTool: event => events.push(event),
    step: async () => next < rounds.length ? { text: '', tool_calls: rounds[next++]! } : { text: 'Done.' },
  });
  return { events, dispatched, text, outputs: events.map(event => { try { return JSON.parse(event.output.split('\n')[0]!); } catch { return undefined; } }) };
}

describe('browser diagnostic model boundary', () => {
  it('preserves validated success and failure diagnostics into model JSON and onTool', async () => {
    const result = await run([[call(CF)], [call(BB, 'https://example.com/other')]], args => args.provider === CF ? failure() : success());
    expect(result.dispatched).toHaveLength(2);
    expect(result.outputs[0].browser_read).toEqual(diagnostic());
    expect(result.outputs[1].browser_read).toEqual(success().browser_read);
    expect(result.events[0]).toMatchObject({ browser_read: diagnostic() });
    expect(result.events[1]).toMatchObject({ browser_read: success().browser_read });
  });
});


describe('host-owned same-turn browser fallback provenance', () => {
  it('marks a fresh explicit Browserbase dispatch after eligible Cloudflare failure in an earlier model round', async () => {
    const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF ? failure() : success());
    expect(result.dispatched.map(args => args.provider)).toEqual([CF, BB]);
    expect(result.outputs[1].browser_read).toMatchObject({ provider: BB, fallback_from: CF });
    expect(result.events[1]).toMatchObject({ browser_read: { provider: BB, fallback_from: CF } });
  });
});


it.each(['unconfirmed', 'unknown_allocation'] as const)('fences new browser starts after %s cleanup but continues ordinary tools', async cleanup => {
  const result = await run([[call(CF), call(BB)], [{ call_id: 'clock', name: 'get_context', arguments: '{}' }, call(CF, 'https://example.com/new')]], () => failure(diagnostic({ cleanup })));
  expect(result.dispatched).toHaveLength(1);
  expect(result.outputs[1]).toMatchObject({ ok: false, code: 'forbidden', reason: 'browser_cleanup_unconfirmed' });
  expect(result.outputs[2]).toMatchObject({ ok: true, data: { timezone: 'UTC' } });
  expect(result.outputs[3]).toMatchObject({ ok: false, code: 'forbidden', reason: 'browser_cleanup_unconfirmed' });
  expect(result.events.every(event => !event.browser_read?.fallback_from)).toBe(true);
});

it.each(['unsafe_redirect', 'source_rejected', 'run_closed', 'deadline_elapsed'] as const)('revokes earlier fallback evidence after a newer %s result', async reason => {
  let calls = 0;
  const result = await run([[call(CF)], [call(CF, URL, { instruction: 'Try a narrower read' })], [call(BB)]], args =>
    args.provider === CF ? ++calls === 1 ? failure() : failure(diagnostic({ reason, configured_alternatives: [] })) : success());
  expect(result.dispatched).toHaveLength(3);
  expect(result.outputs[2].browser_read.fallback_from).toBeUndefined();
});

it.each(['unsafe_redirect', 'source_rejected', 'run_closed', 'deadline_elapsed'] as const)('does not annotate a Browserbase %s result', async reason => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF ? failure()
    : failure(diagnostic({ provider: BB, reason, configured_alternatives: [] })));
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});


it.each(['confirmed', 'not_started', 'allocation_refused'] as const)('allows observed mechanical recovery after %s cleanup', async cleanup => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF ? failure(diagnostic({ cleanup })) : success());
  expect(result.outputs[1].browser_read.fallback_from).toBe(CF);
});

it.each(['provider_http', 'provider_failure', 'navigation_failed', 'page_http', 'empty_content', 'provider_unconfigured'] as const)('allows configured alternate evidence for mechanical %s', async reason => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF ? failure(diagnostic({ reason })) : success());
  expect(result.outputs[1].browser_read.fallback_from).toBe(CF);
});

it.each(['provider_disabled', 'invalid_session', 'cleanup_unconfirmed', 'completed'] as const)('does not create alternate evidence from %s', async reason => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF ? failure(diagnostic({ reason })) : success());
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});

it.each([
  'https://example.com/other', 'https://EXAMPLE.com/article?x=1',
  'https://example.com:443/article?x=1', 'https://example.com/article?x=1#section',
])('requires exact raw requested URL rather than matching %s', async url => {
  const result = await run([[call(CF)], [call(BB, url)]], args => args.provider === CF ? failure() : success());
  expect(result.dispatched).toHaveLength(2);
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});

it('does not mark prebatched provider calls that preceded model observation', async () => {
  const result = await run([[call(CF), call(BB)]], args => args.provider === CF ? failure() : success());
  expect(result.dispatched).toHaveLength(2);
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});

it('requires an explicit alternate provider selection', async () => {
  const result = await run([[call(CF)], [call(null)]], args => args.provider === CF ? failure() : success());
  expect(result.outputs[1].browser_read.provider).toBe(BB);
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});

it('requires the selected provider to be confirmed by the returned diagnostic', async () => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF ? failure() : success(CF));
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});

it('requires a configured alternate and does not invent fallback after successful Cloudflare reads', async () => {
  for (const cfResult of [failure(diagnostic({ configured_alternatives: [] })), success(CF)]) {
    const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF ? cfResult : success());
    expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
  }
});

it('revokes stale failure evidence after a successful Cloudflare reread', async () => {
  let cf = 0;
  const result = await run([[call(CF)], [call(CF, URL, { instruction: 'Narrow read' })], [call(BB)]], args => args.provider === CF ? ++cf === 1 ? failure() : success(CF) : success());
  expect(result.outputs[2].browser_read.fallback_from).toBeUndefined();
});

it('does not copy fallback provenance onto cached failure replays', async () => {
  const result = await run([[call(CF)], [call(BB)], [call(BB)]], args => args.provider === CF ? failure()
    : { ...failure(diagnostic({ provider: BB, configured_alternatives: [] })), code: 'forbidden' } as ToolResult<unknown>);
  expect(result.dispatched).toHaveLength(2);
  expect(result.outputs[1].browser_read.fallback_from).toBe(CF);
  expect(result.outputs[2].browser_read.fallback_from).toBeUndefined();
  expect(result.events[2]!.output).toContain('cached failure');
});

it('does not share provenance or allocation fences across invocations or owners', async () => {
  const ctx = context();
  await run([[call(CF)]], () => failure(), ctx);
  const next = await run([[call(BB)]], () => success(), ctx);
  expect(next.outputs[0].browser_read.fallback_from).toBeUndefined();
  await run([[call(CF)]], () => failure(diagnostic({ cleanup: 'unknown_allocation' })), ctx);
  for (const nextContext of [ctx, { ...context(), authenticatedUserId: 'other-owner' }]) {
    const fresh = await run([[call(BB)]], () => success(), nextContext);
    expect(fresh.dispatched).toHaveLength(1);
    expect(fresh.outputs[0].browser_read.fallback_from).toBeUndefined();
  }
});

it('never dispatches an alternate automatically', async () => {
  const result = await run([[call(CF)]], () => failure());
  expect(result.dispatched.map(args => args.provider)).toEqual([CF]);
  expect(result.text).toBe('Done.');
});

it('rejects forged model provenance and handler provenance through the full dispatcher', async () => {
  const model = await run([[call(CF)], [call(BB, URL, { fallback_from: CF })]], () => failure());
  expect(model.dispatched).toHaveLength(1);
  expect(model.outputs[1]).toMatchObject({ ok: false, reason: 'invalid_args' });
  const handler = await run([[call(BB)]], () => ({ ...success(), browser_read: { ...success().browser_read!, fallback_from: CF } }));
  expect(handler.outputs[0]).toMatchObject({ ok: false, reason: 'invalid_handler_result' });
  expect(handler.outputs[0].browser_read).toBeUndefined();
});

it('does not use dispatcher size failures as provider-failure evidence', async () => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF
    ? { ...failure(), error: 'x'.repeat(600) } as ToolResult<unknown> : success());
  expect(result.outputs[0]).toMatchObject({ ok: false, error: 'tool returned oversized error' });
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});

it('rechecks dispatcher egress before a model-selected alternate', async () => {
  const ctx = context();
  const result = await run([[call(CF)], [call(BB)]], () => {
    ctx.egressAllowlist = [];
    return failure();
  }, ctx);
  expect(result.dispatched).toHaveLength(1);
  expect(result.outputs[1]).toMatchObject({ ok: false, reason: 'egress_denied' });
  expect(result.outputs[1].browser_read).toBeUndefined();
});


it('retains bounded diagnostic metadata in the model-visible head when successful content is capped', async () => {
  const result = await run([[call(BB)]], () => ({ ...success(), data: { text: 'x'.repeat(15_980) } }));
  expect(result.events[0]!.ok).toBe(true);
  expect(result.events[0]!.output).toContain('[cut:');
  expect(result.events[0]!.output).toContain('"browser_read":{"provider":"browserbase_stagehand_http_v3","phase":"complete","reason":"completed","cleanup":"confirmed"}');
});

it.each(['unconfirmed', 'unknown_allocation'] as const)('keeps the browser-start fence when sanitising a provider error with %s cleanup', async cleanup => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF
    ? { ...failure(diagnostic({ cleanup })), error: `Provider failure ${CANARIES[0]}` } as ToolResult<unknown>
    : success());
  expect(result.outputs[0]).toMatchObject({ ok: false, reason: 'sanitise_denied', browser_read: { cleanup } });
  expect(result.events[0]!.output).not.toContain(CANARIES[0]);
  expect(result.dispatched.map(args => args.provider)).toEqual([CF]);
  expect(result.outputs[1]).toMatchObject({ ok: false, reason: 'browser_cleanup_unconfirmed' });
  expect(result.events.every(event => !event.browser_read?.fallback_from)).toBe(true);
});

it('never treats a sanitiser-denied mechanical failure as alternate-provider eligibility', async () => {
  const result = await run([[call(CF)], [call(BB)]], args => args.provider === CF
    ? { ...failure(), error: `Provider failure ${CANARIES[0]}` } as ToolResult<unknown>
    : success());
  expect(result.outputs[0]).toMatchObject({ ok: false, reason: 'sanitise_denied' });
  expect(result.events[0]!.output).not.toContain(CANARIES[0]);
  expect(result.outputs[1].browser_read.fallback_from).toBeUndefined();
});
