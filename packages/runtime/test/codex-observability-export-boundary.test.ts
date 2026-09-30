import { afterEach, describe, expect, it, vi } from 'vitest';
import { OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { consoleLog, consoleTrace, withConsoleTrace } from '../src/observability/console-correlation';
import { otlpTurnExporter } from '../src/observability/otlp-turns';

const config = { endpoint: 'https://langfuse.invalid/v1/traces', headers: {} };
const context = { environment: 'staging', release: 'fixture-a', channel: 'telegram', userId: 'channel-a', sessionId: 'session-a', captureText: false };
const root = (trace: string) => ({ trace, hop: 'turn', ms: 1, ok: true });

afterEach(() => vi.useRealTimers());

describe('real exporter transport boundary', () => {
  it('settles a hung vendor request at the OTLP deadline, aborts it and frees capacity without retry', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const send = vi.fn(async (_url: string, init: RequestInit) => {
      signals.push(init.signal!);
      return signals.length === 1 ? new Promise<Response>(() => undefined) : new Response(null);
    });
    const log = otlpTurnExporter(config, context, send);
    const result = expect(log(root('hung'))).rejects.toThrow('otlp_export_timeout');
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect(signals[0]!.aborted).toBe(true);
    await log(root('next'));
    expect(send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds a single unfinished trace by the existing 50-item budget and recovers on flush', async () => {
    const bodies: string[] = [];
    const log = otlpTurnExporter(config, context, async (_url, init) => { bodies.push(String(init.body)); return new Response(null); });
    for (let i = 0; i < 50; i++) await log({ ...root('full'), hop: 'pickup' });
    await expect(log({ ...root('full'), hop: 'pickup' })).rejects.toThrow('otlp_buffer_evicted');
    await log(root('full'));
    expect(JSON.parse(bodies[0]!).resourceSpans[0].scopeSpans[0].spans).toHaveLength(51);
    await log({ ...root('next'), hop: 'pickup' });
    await log(root('next'));
    expect(JSON.parse(bodies[1]!).resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it('rejects missing context without retaining hops or contacting the sink', async () => {
    const send = vi.fn(async () => new Response(null));
    for (const field of ['environment', 'release', 'channel', 'userId', 'sessionId']) {
      const log = otlpTurnExporter(config, { ...context, [field]: '' }, send);
      await expect(log({ ...root('invalid'), hop: 'pickup' })).rejects.toThrow('otlp_context_invalid');
      await expect(log(root('invalid'))).rejects.toThrow('otlp_context_invalid');
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('does not export a late child of a rejected root as if its parent was delivered', async () => {
    let rejectRoot!: (reason: Error) => void;
    const send = vi.fn(() => new Promise<Response>((_resolve, reject) => { rejectRoot = reject; }));
    const log = otlpTurnExporter(config, context, send);
    const parent = expect(log(root('failed'))).rejects.toThrow('otlp_export_transport');
    const child = expect(log({ ...root('failed'), hop: 'memory' })).rejects.toThrow('otlp_export_transport');
    await Promise.resolve();
    rejectRoot(new Error('PRIVATE_VENDOR_CANARY'));
    await parent;
    await child;
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('bounds outstanding sends, surfaces overload and frees slots after HTTP rejection', async () => {
    vi.useFakeTimers();
    const releases: ((response: Response) => void)[] = [];
    const send = vi.fn(() => new Promise<Response>((resolve) => releases.push(resolve)));
    const log = otlpTurnExporter(config, context, send);
    const requests = Array.from({ length: 50 }, (_, index) => expect(log(root(`parallel-${index}`))).rejects.toThrow('otlp_export_http_503'));
    await expect(log(root('overload'))).rejects.toThrow('otlp_export_capacity');
    await Promise.resolve();
    releases.forEach((release) => release(new Response('PRIVATE_VENDOR_BODY', { status: 503 })));
    await Promise.all(requests);
    expect(send).toHaveBeenCalledTimes(50);
    expect(vi.getTimerCount()).toBe(0);
    const next = log(root('recovered'));
    await Promise.resolve();
    releases[50]!(new Response(null));
    await next;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('scrubs thrown vendor errors and synchronous transport failures without retry', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => { throw new Error('PRIVATE_VENDOR_URL_HEADER'); });
    const log = otlpTurnExporter(config, context, send);
    await expect(log(root('thrown'))).rejects.toThrow(/^otlp_export_transport$/);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps supplied contexts and buffers independent even when trace keys collide and callers mutate input', async () => {
    const bodies: unknown[] = [];
    const send = async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return new Response(null); };
    const first = { ...context };
    const a = otlpTurnExporter(config, first, send);
    const b = otlpTurnExporter(config, { ...context, userId: 'channel-b', sessionId: 'session-b', environment: 'production', release: 'fixture-b', captureText: true }, send);
    const hop = { ...root('collision'), hop: 'llm_reply', usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 10, cached: 2, output: 4 }, text: { input: 'PRIVATE_A' } };
    await a(hop);
    first.userId = 'MUTATED_ID'; first.release = 'MUTATED_RELEASE';
    hop.usage.input = 999; hop.text.input = 'MUTATED_TEXT';
    await b({ ...root('collision'), hop: 'typing', text: { input: 'PRIVATE_B' } });
    await a(root('collision'));
    await b(root('collision'));
    const parsed = bodies as { resourceSpans: { scopeSpans: { spans: { traceId: string; name: string; attributes: { key: string; value: { stringValue?: string } }[] }[] }[] }[] }[];
    const spans = parsed.map((body) => body.resourceSpans[0]!.scopeSpans[0]!.spans);
    const values = spans.map((group) => group.map((span) => Object.fromEntries(span.attributes.map((attr) => [attr.key, attr.value.stringValue]))));
    expect(spans[0]![1]!.name).toBe('llm_reply');
    expect(spans[1]![1]!.name).toBe('typing');
    expect(spans[0]![0]!.traceId).not.toBe(spans[1]![0]!.traceId);
    for (const value of values[0]!) expect(value).toMatchObject({ 'langfuse.user.id': 'channel-a', 'langfuse.session.id': 'session-a', 'langfuse.release': 'fixture-a', 'langfuse.environment': 'staging' });
    for (const value of values[1]!) expect(value).toMatchObject({ 'langfuse.user.id': 'channel-b', 'langfuse.session.id': 'session-b', 'langfuse.release': 'fixture-b', 'langfuse.environment': 'production' });
    expect(values[0]![0]!['langfuse.trace.metadata.tokens_input']).toBe('10');
    expect(JSON.stringify(bodies)).not.toMatch(/PRIVATE_A|PRIVATE_B|MUTATED_/);
  });

  it('keeps machine late generations correlated and declares pre-root cost scope without invented billing', async () => {
    const bodies: string[] = [];
    const log = otlpTurnExporter(config, context, async (_url, init) => { bodies.push(String(init.body)); return new Response(null); });
    await log({ ...root('scheduled'), hop: 'llm_reply', usage: { model: 'unknown-model', input: 10, cached: 2, output: 4 } });
    await log({ ...root('scheduled'), hop: 'machine_turn' });
    await log({ ...root('scheduled'), hop: 'llm_memory', usage: { model: OPENAI_GPT_6_LUNA_MODEL, input: 10, cached: 2, output: 4 } });
    const [parent, late] = bodies.map((body) => JSON.parse(body).resourceSpans[0].scopeSpans[0].spans);
    const attrs = (span: { attributes: { key: string; value: { stringValue?: string } }[] }) => Object.fromEntries(span.attributes.map((attr) => [attr.key, attr.value.stringValue]));
    expect(late[0].traceId).toBe(parent[0].traceId);
    expect(late[0].parentSpanId).toBe(parent[0].spanId);
    expect(attrs(late[0])['langfuse.trace.name']).toBe('telegram.machine');
    expect(attrs(parent[0])).toMatchObject({ 'langfuse.trace.metadata.cost_coverage': 'unpriced', 'langfuse.trace.metadata.cost_scope': 'pre_root_hops' });
    expect(attrs(parent[0])['langfuse.trace.metadata.estimated_cost_usd']).toBeUndefined();
    expect(attrs(late[0])['langfuse.observation.metadata.cost_kind']).toBe('estimate');
    expect(JSON.parse(String(attrs(late[0])['langfuse.observation.metadata.price_source']))).toEqual({ source: 'runtime:modelCost:standard-flat', usd_per_million: { input: 0.1, cached: 0.01, output: 0.5 } });
    expect(bodies.join('')).not.toContain('billed');
  });

  it('keeps console correlation content-free and preserves response status/body/headers', async () => {
    const trace = consoleTrace();
    expect(trace).toMatch(/^console-[0-9a-f-]{36}$/);
    const sink = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      consoleLog(trace, 'signin', false, 'denied');
      expect(JSON.parse(String(sink.mock.calls[0]![0]))).toEqual({ trace, hop: 'signin', ok: false, code: 'denied' });
    } finally { sink.mockRestore(); }
    const response = withConsoleTrace(new Response('fixture-response', { status: 202, headers: { 'x-fixture': 'kept' } }), trace);
    expect(response.status).toBe(202);
    expect(response.headers.get('x-waldo-trace')).toBe(trace);
    expect(response.headers.get('x-fixture')).toBe('kept');
    expect(await response.text()).toBe('fixture-response');
  });

  it('rejects children that arrive after their root has already failed', async () => {
    const send = vi.fn(async () => new Response(null, { status: 503 }));
    const log = otlpTurnExporter(config, context, send);
    await expect(log(root('already-failed'))).rejects.toThrow('otlp_export_http_503');
    await expect(log({ ...root('already-failed'), hop: 'memory' })).rejects.toThrow('otlp_export_transport');
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('recovers from abandoned traces by reporting eviction and retaining the new hop', async () => {
    const bodies: string[] = [];
    const log = otlpTurnExporter(config, context, async (_url, init) => { bodies.push(String(init.body)); return new Response(null); });
    for (let i = 0; i < 50; i++) await log({ ...root(`abandoned-${i}`), hop: 'pickup' });
    await expect(log({ ...root('fresh'), hop: 'typing' })).rejects.toThrow('otlp_buffer_evicted');
    await log(root('fresh'));
    const [parent, child] = JSON.parse(bodies[0]!).resourceSpans[0].scopeSpans[0].spans;
    expect(child.name).toBe('typing');
    expect(parent.attributes).toContainEqual({ key: 'langfuse.trace.metadata.buffer_evicted_hops', value: { stringValue: '1' } });
    await log({ ...root('next-fresh'), hop: 'typing' });
    await log(root('next-fresh'));
  });

  it('sends late children only after root acceptance and cancels unused response bodies', async () => {
    let acceptRoot!: (response: Response) => void;
    const cancelled = vi.fn();
    const send = vi.fn(async () => send.mock.calls.length === 1
      ? new Promise<Response>((resolve) => { acceptRoot = resolve; })
      : new Response(new ReadableStream({ cancel: cancelled })));
    const log = otlpTurnExporter(config, context, send);
    const parent = log(root('ordered'));
    const child = log({ ...root('ordered'), hop: 'memory' });
    await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    acceptRoot(new Response(new ReadableStream({ cancel: cancelled })));
    await Promise.all([parent, child]);
    expect(send).toHaveBeenCalledTimes(2);
    expect(cancelled).toHaveBeenCalledTimes(2);
  });

  it('settles children waiting for a hung parent without another network call', async () => {
    vi.useFakeTimers();
    const send = vi.fn(() => new Promise<Response>(() => undefined));
    const log = otlpTurnExporter(config, context, send);
    const parent = expect(log(root('hung-parent'))).rejects.toThrow('otlp_export_timeout');
    const child = expect(log({ ...root('hung-parent'), hop: 'memory' })).rejects.toThrow('otlp_export_transport');
    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([parent, child]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('snapshots synthetic staging text when authorized capture is enabled', async () => {
    const bodies: string[] = [];
    const supplied = { ...context, captureText: true };
    const log = otlpTurnExporter(config, supplied, async (_url, init) => { bodies.push(String(init.body)); return new Response(null); });
    const text = { input: 'SYNTHETIC_BEFORE_INPUT', output: 'SYNTHETIC_BEFORE_OUTPUT', reasoning: 'SYNTHETIC_BEFORE_REASONING' };
    await log({ ...root('capture-snapshot'), hop: 'llm_reply', text });
    text.input = 'MUTATED_INPUT'; text.output = 'MUTATED_OUTPUT'; text.reasoning = 'MUTATED_REASONING'; supplied.captureText = false;
    await log(root('capture-snapshot'));
    expect(bodies[0]).toContain('SYNTHETIC_BEFORE_INPUT');
    expect(bodies[0]).toContain('SYNTHETIC_BEFORE_OUTPUT');
    expect(bodies[0]).toContain('SYNTHETIC_BEFORE_REASONING');
    expect(bodies[0]).not.toContain('MUTATED_');
  });

  it('evicts globally oldest hops across interleaved traces rather than trace insertion order', async () => {
    const bodies: string[] = [];
    const log = otlpTurnExporter(config, context, async (_url, init) => { bodies.push(String(init.body)); return new Response(null); });
    await log({ ...root('a'), hop: 'tool_a_old' });
    await log({ ...root('b'), hop: 'tool_b_old' });
    await log({ ...root('a'), hop: 'tool_a_new' });
    for (let i = 0; i < 47; i++) await log({ ...root(`filler-${i}`), hop: 'tool_filler' });
    for (let i = 0; i < 2; i++) await expect(log({ ...root(`overflow-${i}`), hop: 'tool_overflow' })).rejects.toThrow('otlp_buffer_evicted');
    await log(root('a'));
    await log(root('b'));
    const spans = bodies.map((body) => JSON.parse(body).resourceSpans[0].scopeSpans[0].spans);
    expect(spans[0].map((span: { name: string }) => span.name)).toEqual(['telegram.turn', 'tool_a_new']);
    expect(spans[1].map((span: { name: string }) => span.name)).toEqual(['telegram.turn']);
    expect(spans[0][0].attributes).toContainEqual({ key: 'langfuse.trace.metadata.buffer_evicted_hops', value: { stringValue: '2' } });
  });

});
