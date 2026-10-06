import { browsePageArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema } from '@waldo/contracts';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { describe, expect, it } from 'vitest';
import { browserReadTraceCode } from '../src/observability/browser-read-trace';
import { gateTraceEntry } from '../src/observability/trace-privacy';
import { otlpTurnExporter } from '../src/observability/otlp-turns';
import { traceBook } from '../src/channels/harness';
import type { TurnLogEntry } from '../src/channels/owner-turn-types';

const PRIVATE = 'PRIVATE-browser-token-or-url';
const SAFE = 'browser_read:cloudflare_playwright:navigation:page_http:confirmed:503:none';

async function sinks(entry: TurnLogEntry) {
  const notes: unknown[] = [];
  const book = traceBook({ exec: (query: string, ...args: unknown[]) => {
    if (query.startsWith('INSERT INTO trace_log')) notes.push(args[5]);
    return { toArray: () => [] };
  } } as never);
  const gated = gateTraceEntry(entry, false);
  book.record(gated, 1);
  const exported: string[] = [];
  const exporter = otlpTurnExporter({ endpoint: 'https://otel.test', headers: {} }, {
    environment: 'test', release: 'test', channel: 'telegram', userId: 'test-owner', sessionId: 'test-session', captureText: false,
  }, async (_url, init) => { exported.push(String(init.body)); return new Response('{}'); });
  await exporter(entry);
  await exporter({ trace: entry.trace, hop: 'turn', ms: 1, ok: true });
  return { gated, notes, console: JSON.stringify({ ...gated, text: undefined }), otlp: exported.join('\n') };
}

describe('browser-read diagnostics at capture-off sinks', () => {
  it.each(['tool_browse_page', 'subagent_tool_browse_page'])('drops malformed browser code on %s before every sink', async hop => {
    const result = await sinks({ trace: 'test', hop, ms: 1, ok: false,
      code: `${SAFE}:${PRIVATE}`, detail: PRIVATE, error: PRIVATE, text: { input: PRIVATE } });
    expect(result.gated.code).toBeUndefined();
    expect(result.gated.detail).toBeUndefined();
    expect(JSON.stringify(result.notes)).not.toContain(PRIVATE);
    expect(result.console).not.toContain(PRIVATE);
    expect(result.otlp).not.toContain(PRIVATE);
  });
});

it.each(['tool_browse_page', 'subagent_tool_browse_page'])('preserves bounded browser fields on %s across all sinks', async hop => {
  const result = await sinks({ trace: 'safe', hop, ms: 1, ok: false, code: SAFE, detail: PRIVATE, error: PRIVATE });
  expect(result.gated.code).toBe(SAFE);
  expect(result.notes).toEqual([SAFE]);
  expect(result.console).toContain(SAFE);
  expect(result.otlp).toContain(SAFE);
  expect(result.console + result.otlp).not.toContain(PRIVATE);
});

it.each([
  SAFE + ':extra', SAFE.replace('503', '599.5'), SAFE.replace('503', '600'), SAFE.replace('503', '0503'),
  SAFE.replace('page_http', PRIVATE), SAFE.replace('confirmed', PRIVATE), SAFE.replace('none', 'cloudflare_playwright'),
  { toString: () => SAFE, private: PRIVATE },
])('rejects a malformed or coerced browser diagnostic code %#', async code => {
  const result = await sinks({ trace: 'invalid', hop: 'tool_browse_page', ms: 0, ok: false, code } as TurnLogEntry);
  expect(result.gated.code).toBeUndefined();
  expect(result.gated.detail).toBeUndefined();
  expect(result.console + result.otlp).not.toContain(PRIVATE);
});

it('validates the producer diagnostic strictly and keeps only bounded fields', () => {
  const diagnostic = { provider: 'browserbase_stagehand_http_v3', phase: 'complete', reason: 'completed', cleanup: 'confirmed', fallback_from: 'cloudflare_playwright' };
  expect(browserReadTraceCode(diagnostic)).toBe('browser_read:browserbase_stagehand_http_v3:complete:completed:confirmed:none:cloudflare_playwright');
  expect(browserReadTraceCode({ ...diagnostic, provider: PRIVATE })).toBeUndefined();
  expect(browserReadTraceCode({ ...diagnostic, url: PRIVATE })).toBeUndefined();
  expect(browserReadTraceCode({ ...diagnostic, http_status: 700 })).toBeUndefined();
});

it.each(['result_oversize', 'sanitise_denied', 'hook_halt'])('retains dispatcher %s alongside observed browser completion in capture-off traces', async reason => {
  const diagnostic = { provider: 'cloudflare_playwright', phase: 'complete', reason: 'completed', cleanup: 'confirmed' };
  const code = browserReadTraceCode(diagnostic, 'oversize', reason);
  expect(code).toBe(`browser_read:cloudflare_playwright:complete:completed:confirmed:none:none:oversize:${reason}`);
  for (const hop of ['tool_browse_page', 'subagent_tool_browse_page']) {
    const result = await sinks({ trace: 'failed-projection', hop, ms: 1, ok: false, code, error: PRIVATE });
    expect(result.notes).toEqual([code]);
    expect(result.console).toContain(reason);
    expect(result.otlp).toContain(reason);
    expect(result.console + result.otlp).not.toContain(PRIVATE);
  }
  expect(browserReadTraceCode(diagnostic, 'oversize', PRIVATE)).toBeUndefined();
  expect((await sinks({ trace: 'forged', hop: 'tool_browse_page', ms: 1, ok: false, code: `browser_read:cloudflare_playwright:complete:completed:confirmed:none:none:oversize:${PRIVATE}` })).gated.code).toBeUndefined();
});

it('preserves generic dispatcher diagnostics and unrelated legacy trace codes', () => {
  for (const hop of ['tool_browse_page', 'subagent_tool_browse_page', 'tool_query_calendar']) {
    expect(gateTraceEntry({ trace: 'legacy', hop, ms: 0, ok: false, code: 'forbidden:egress_denied' }, false).detail).toBe('forbidden:egress_denied');
  }
  expect(gateTraceEntry({ trace: 'legacy', hop: 'unrelated', ms: 0, ok: false, code: 'legacy-freeform-code' }, false).code).toBe('legacy-freeform-code');
});

it.each(['success', 'oversize', 'posthook', 'child'])('real owner responder preserves browser and dispatch trace evidence: %s', async mode => {
  const child = mode === 'child';
  const entries: TurnLogEntry[] = [];
  let parentRounds = 0;
  let childRounds = 0;
  const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
    const isChild = request.system?.startsWith('You are a subagent') ?? false;
    const browse = { call_id: 'browse', name: 'browse_page', arguments: JSON.stringify({ url: 'https://example.com/article', instruction: 'Read this page', provider: 'cloudflare_playwright' }) };
    const tool_calls = isChild ? childRounds++ === 0 ? [browse] : undefined
      : parentRounds++ === 0 ? child ? [{ call_id: 'delegate', name: 'delegate_task', arguments: '{"task":"Read the fictional public page"}' }] : [browse] : undefined;
    return { ok: true, data: { model: request.model, text: tool_calls ? '' : 'Done.', ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  const args: Parameters<typeof createOwnerResponder> = ['fixture'];
  args[3] = entry => entries.push(entry);
  args[5] = [{ name: 'browse_page', description: 'Read public page', schema: browsePageArgsSchema,
    trigger_allowlist: triggerTypeSchema.options.filter(trigger => TOOL_PERMISSIONS[trigger].includes('browse_page')),
    autonomy_gated: false, handle: async (_args, ctx) => ({ ok: true, data: { text: mode === 'oversize' ? 'Synthetic page. '.repeat(1500) : mode === 'posthook' ? ctx.session.canary_tokens[0] : 'Synthetic page.' }, source_taint: 'external', browser_read: {
      provider: 'cloudflare_playwright', phase: 'complete', reason: 'completed', cleanup: 'confirmed',
    } }),
  }];
  args[10] = gateway;
  args[16] = ['example.com'];
  const responder = createOwnerResponder(...args);
  await responder.respond({ traceId: 'browser-trace', conversationRef: 'fixture-owner', surface: 'telegram', text: 'Read this public page.', memoryWrites: false }, (_label, work) => work());
  const entry = entries.find(entry => entry.hop === `${child ? 'subagent_' : ''}tool_browse_page`);
  expect(entry?.ok).toBe(mode === 'success');
  const suffix = mode === 'oversize' ? ':oversize:result_oversize' : mode === 'posthook' ? ':forbidden:sanitise_denied' : '';
  expect(entry?.code).toBe(child ? 'not_found:handler_unavailable' : `browser_read:cloudflare_playwright:complete:completed:confirmed:none:none${suffix}`);
  expect((await sinks(entry!)).otlp).toContain(entry!.code);
});
