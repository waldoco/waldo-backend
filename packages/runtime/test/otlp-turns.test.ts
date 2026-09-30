import { describe, expect, it } from 'vitest';
import { OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { modelCost } from '../src/llm/pricing';
import { hopFeature, langfuseOtlpConfig, otlpTurnExporter } from '../src/observability/otlp-turns';

type Attr = { key: string; value: { stringValue?: string; arrayValue?: { values: { stringValue: string }[] } } };
type OtlpSpan = { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; attributes: Attr[]; status: { code: number; message?: string } };
type Body = { resourceSpans: [{ scopeSpans: [{ spans: OtlpSpan[] }] }] };

const context = { environment: 'staging', release: 'abc1234', channel: 'telegram', userId: 'telegram:1', sessionId: 'telegram-dm:1', captureText: false };
const attrs = (span: OtlpSpan) => Object.fromEntries(span.attributes.map((a) => [a.key, a.value.stringValue ?? a.value.arrayValue!.values.map((v) => v.stringValue)]));

const capture = () => {
  const calls: { url: string; headers: Record<string, string>; body: Body }[] = [];
  const send = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Body });
    return new Response(null, { status: 200 });
  };
  const spans = (call: number) => calls[call]!.body.resourceSpans[0].scopeSpans[0].spans;
  return { calls, send, spans };
};

describe('langfuse OTLP config', () => {
  it('is off until all three settings exist', () => {
    expect(langfuseOtlpConfig({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk' })).toBeNull();
  });

  it('targets the traces endpoint with basic auth and v4 ingestion', () => {
    expect(langfuseOtlpConfig({ LANGFUSE_PUBLIC_KEY: 'pk', LANGFUSE_SECRET_KEY: 'sk', LANGFUSE_BASE_URL: 'https://cloud.langfuse.com/' })).toEqual({
      endpoint: 'https://cloud.langfuse.com/api/public/otel/v1/traces',
      headers: { authorization: `Basic ${btoa('pk:sk')}`, 'x-langfuse-ingestion-version': '4' },
    });
  });
});

describe('model cost', () => {
  it('prices cached input separately and returns null for unknown models', () => {
    expect(modelCost({ model: OPENAI_GPT_6_LUNA_MODEL, input: 2_000_000, cached: 1_000_000, output: 1_000_000 })).toEqual({ input: 0.11, output: 0.5, total: 0.61 });
    expect(modelCost({ model: 'mystery', input: 1, cached: 0, output: 1 })).toBeNull();
  });
});

describe('otlpTurnExporter', () => {
  it('labels mixed price coverage as a partial estimate instead of a complete zero-priced total', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send);
    await log({ trace: 'tg-cost', hop: 'llm_reply', ms: 1, ok: true, usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 100, cached: 10, output: 20 } });
    await log({ trace: 'tg-cost', hop: 'llm_memory', ms: 1, ok: true, usage: { model: 'unpriced-model', input: 200, cached: 30, output: 40 } });
    await log({ trace: 'tg-cost', hop: 'turn', ms: 2, ok: true });
    const [root, known, unknown] = spans(0);
    expect(attrs(root!)).toMatchObject({
      'langfuse.trace.metadata.cost_kind': 'estimate', 'langfuse.trace.metadata.priced_model_calls': '1',
      'langfuse.trace.metadata.unpriced_model_calls': '1', 'langfuse.trace.metadata.cost_coverage': 'partial',
      'langfuse.trace.metadata.tokens_cached': '40',
    });
    expect(attrs(root!)['langfuse.trace.metadata.cost_usd']).toBeUndefined();
    expect(attrs(root!)['langfuse.trace.metadata.estimated_cost_usd']).toBeDefined();
    expect(attrs(known!)['langfuse.observation.metadata.cost_kind']).toBe('estimate');
    expect(attrs(known!)['langfuse.observation.metadata.price_source']).toBeDefined();
    expect(attrs(unknown!)['langfuse.observation.cost_details']).toBeUndefined();
  });
  it('enforces the existing production privacy policy at serialization even if captureText is mis-set', async () => {
    const { calls, send } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, { ...context, environment: 'production', captureText: true }, send);
    await log({ trace: 'tg-private', hop: 'llm_reply', ms: 10, ok: false, error: 'PRIVATE_CANARY', detail: 'PRIVATE_CANARY', code: 'send_failed', text: { input: 'PRIVATE_CANARY', output: 'PRIVATE_CANARY' } });
    await log({ trace: 'tg-private', hop: 'turn', ms: 20, ok: true, text: { input: 'PRIVATE_CANARY' } });
    expect(JSON.stringify(calls)).not.toContain('PRIVATE_CANARY');
    expect(JSON.stringify(calls)).toContain('send_failed');
  });
  it('keeps observation filtering on every child and late span, with explicit owner attribution limits', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'tg-context', hop: 'llm_reply', ms: 10, ok: true });
    await log({ trace: 'tg-context', hop: 'turn', ms: 20, ok: true });
    await log({ trace: 'tg-context', hop: 'memory', ms: 5, ok: true });
    for (const span of [...spans(0), ...spans(1)]) {
      expect(attrs(span)).toMatchObject({
        'langfuse.user.id': context.userId, 'langfuse.session.id': context.sessionId,
        'langfuse.release': context.release, 'langfuse.version': context.release,
        'langfuse.trace.name': 'telegram.turn',
        'langfuse.trace.metadata.owner_attribution': 'canonical_owner_not_supplied',
      });
    }
  });
  it('sends one trace per turn with a child span per hop and no message text', async () => {
    const { calls, send, spans } = capture();
    let clock = 10_000;
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: { authorization: 'Basic k' } }, context, send, () => clock);
    await log({ trace: 'tg-1', hop: 'pickup', ms: 100, ok: true });
    clock = 12_000;
    await log({ trace: 'tg-1', hop: 'respond', ms: 1900, ok: true });
    expect(calls).toHaveLength(0);
    await log({ trace: 'tg-1', hop: 'turn', ms: 2100, ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe('Basic k');
    const [root, ...hops] = spans(0);
    expect(root!.name).toBe('telegram.turn');
    expect(root!.parentSpanId).toBeUndefined();
    expect(root!.startTimeUnixNano).toBe('9900000000');
    expect(hops.map((span) => span.name)).toEqual(['pickup', 'respond']);
    expect(hops.every((span) => span.traceId === root!.traceId && span.parentSpanId === root!.spanId)).toBe(true);
    expect(root!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('flushes machine traces on a machine_turn root: reminders, ticks and nightly stop being invisible', async () => {
    const { calls, send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'rem:1:2:0', hop: 'send', ms: 300, ok: true });
    await log({ trace: 'rem:1:2:0', hop: 'reminder', ms: 900, ok: true });
    expect(calls).toHaveLength(0);
    await log({ trace: 'rem:1:2:0', hop: 'machine_turn', ms: 950, ok: true, detail: 'reminder' });

    expect(calls).toHaveLength(1);
    const [root, ...hops] = spans(0);
    expect(root!.name).toBe('telegram.machine');
    expect(root!.parentSpanId).toBeUndefined();
    expect(attrs(root!)).toMatchObject({
      'langfuse.trace.name': 'telegram.machine',
      'langfuse.trace.metadata.outcome': 'completed',
      'langfuse.trace.metadata.trace_key': 'rem:1:2:0',
    });
    expect(hops.map((span) => span.name)).toEqual(['send', 'reminder']);
    expect(hops.every((span) => span.traceId === root!.traceId && span.parentSpanId === root!.spanId)).toBe(true);
  });

  it('marks a failed machine turn at the trace level', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'rem:9:1:0', hop: 'reminder', ms: 0, ok: false, error: 'note row missing at fire time', code: 'note_missing' });
    await log({ trace: 'rem:9:1:0', hop: 'machine_turn', ms: 0, ok: false, detail: 'reminder' });
    const [root, reminder] = spans(0);
    expect(root!.name).toBe('telegram.machine');
    expect(root!.status.code).toBe(2);
    expect(attrs(root!)['langfuse.trace.metadata.outcome']).toBe('failed');
    expect(attrs(reminder!)['langfuse.observation.metadata.detail']).toBe('note_missing');
    expect(reminder!.status.code).toBe(2);
  });

  it('pins the typed halt identity onto failed tool hop spans, so a hook halt is diagnosable with capture off', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'tg-9', hop: 'tool_draft_email', ms: 40, ok: false, error: 'hook halted', code: 'transient:approval_denied' });
    await log({ trace: 'tg-9', hop: 'tool_web_search', ms: 300, ok: true });
    await log({ trace: 'tg-9', hop: 'turn', ms: 900, ok: true });

    const [, halted, okHop] = spans(0);
    expect(halted!.name).toBe('tool_draft_email');
    expect(halted!.status.code).toBe(2);
    expect(attrs(halted!)['langfuse.observation.metadata.code']).toBe('transient:approval_denied');
    // Content-free status preserves the typed halt identity, never the raw provider message.
    expect(halted!.status.message).toBe('transient:approval_denied');
    // No code attribute on a clean hop, and no argument/result content with capture off.
    expect(attrs(okHop!)['langfuse.observation.metadata.code']).toBeUndefined();
    expect(attrs(halted!)['langfuse.observation.input']).toBeUndefined();
    expect(attrs(halted!)['langfuse.observation.output']).toBeUndefined();
  });

  it('carries the emitting owner on every hop span, so an alarm or card is attributable in Langfuse', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'card:close:1', hop: 'day_card', ms: 800, ok: true, owner: 'do-old' });
    await log({ trace: 'card:close:1', hop: 'turn', ms: 900, ok: true, owner: 'do-old' });
    for (const span of spans(0)) {
      expect(attrs(span)['langfuse.observation.metadata.owner']).toBe('do-old');
    }
  });

  it('labels the trace for filtering: user, session, environment, release, tags, schema', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'tg-4', hop: 'receipt', ms: 5, ok: true });
    await log({ trace: 'tg-4', hop: 'joined_path', ms: 900, ok: true });
    await log({ trace: 'tg-4', hop: 'turn', ms: 1000, ok: true });
    const [root, receipt] = spans(0);
    expect(attrs(root!)).toMatchObject({
      'langfuse.trace.name': 'telegram.turn', 'langfuse.user.id': 'telegram:1', 'langfuse.session.id': 'telegram-dm:1',
      'langfuse.environment': 'staging', 'langfuse.release': 'abc1234',
      'langfuse.trace.tags': ['channel:telegram', 'feature:reactions', 'feature:reply'],
      'langfuse.trace.metadata.schema_version': '4', 'langfuse.trace.metadata.trace_key': 'tg-4', 'langfuse.trace.metadata.outcome': 'answered',
    });
    expect(attrs(receipt!)).toMatchObject({ 'langfuse.observation.metadata.hop': 'receipt', 'langfuse.observation.metadata.feature': 'reactions', 'langfuse.observation.type': 'tool' });
    expect(hopFeature('brand_new_hop')).toBe('other');
  });

  it('marks model hops as generations with tokens and cost, and totals them on the trace', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'tg-3', hop: 'llm_reply', ms: 900, ok: true, usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 1200, output: 80, cached: 1024 } });
    await log({ trace: 'tg-3', hop: 'turn', ms: 1000, ok: true });
    const [root, reply] = spans(0);
    const gen = attrs(reply!);
    expect(gen['langfuse.observation.type']).toBe('generation');
    expect(gen['langfuse.observation.model.name']).toBe(OPENAI_GPT_6_LUNA_MODEL);
    expect(JSON.parse(gen['langfuse.observation.usage_details'] as string)).toEqual({ input: 176, input_cached_tokens: 1024, output: 80 });
    expect(JSON.parse(gen['langfuse.observation.cost_details'] as string).total).toBeCloseTo((176 * 0.1 + 1024 * 0.01 + 80 * 0.5) / 1e6, 12);
    expect(attrs(root!)).toMatchObject({ 'langfuse.trace.metadata.model_calls': '1', 'langfuse.trace.metadata.tokens_input': '1200', 'langfuse.trace.metadata.tokens_output': '80' });
    expect(attrs(root!)['langfuse.observation.type']).toBe('agent');
  });

  it('carries input, output and reasoning only when text capture is on', async () => {
    const text = { input: '[{"role":"user","content":"hi"}]', output: 'hello', reasoning: 'greet back' };
    const off = capture();
    await otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, off.send, () => 5_000)({ trace: 'tg-5', hop: 'turn', ms: 10, ok: true, text });
    expect(attrs(off.spans(0)[0]!)['langfuse.observation.input']).toBeUndefined();
    const on = capture();
    await otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, { ...context, captureText: true }, on.send, () => 5_000)({ trace: 'tg-5', hop: 'turn', ms: 10, ok: true, text });
    expect(attrs(on.spans(0)[0]!)).toMatchObject({ 'langfuse.observation.input': text.input, 'langfuse.observation.output': JSON.stringify({ reasoning: 'greet back', text: 'hello' }) });
    expect(attrs(on.spans(0)[0]!)).toMatchObject({ 'langfuse.trace.input': text.input, 'langfuse.trace.output': JSON.stringify({ reasoning: 'greet back', text: 'hello' }) });
    expect(attrs(off.spans(0)[0]!)['langfuse.trace.input']).toBeUndefined();
  });

  it('reports overflow, retains new work and bounds abandoned traces', async () => {
    const { calls, send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    for (let i = 0; i < 50; i++) await log({ trace: `tg-${i}`, hop: 'memory', ms: 3, ok: true });
    await expect(log({ trace: 'tg-50', hop: 'memory', ms: 3, ok: true })).rejects.toThrow('otlp_buffer_evicted');
    await log({ trace: 'tg-0', hop: 'turn', ms: 10, ok: true });
    expect(spans(calls.length - 1)).toHaveLength(1);
    // tg-50 was retained even though its admission reported the eviction.

    await log({ trace: 'tg-50', hop: 'turn', ms: 10, ok: true });
    expect(spans(calls.length - 1)).toHaveLength(2);
  });

  it('attaches hops that finish after the turn to the same trace and marks failures', async () => {
    const { send, spans } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, context, send, () => 5_000);
    await log({ trace: 'tg-2', hop: 'turn', ms: 10, ok: true });
    await log({ trace: 'tg-2', hop: 'memory', ms: 3, ok: false, error: 'bad json' });
    const root = spans(0)[0]!;
    const memory = spans(1)[0]!;
    expect(memory.traceId).toBe(root.traceId);
    expect(memory.parentSpanId).toBe(root.spanId);
    expect(memory.status).toEqual({ code: 2, message: 'failed' });
    expect(attrs(memory)['langfuse.trace.tags']).toEqual(['channel:telegram', 'feature:memory']);
  });
});
