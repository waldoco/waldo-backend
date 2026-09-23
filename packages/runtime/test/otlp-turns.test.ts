import { describe, expect, it } from 'vitest';
import { langfuseOtlpConfig, otlpTurnExporter } from '../src/observability/otlp-turns';

type Body = { resourceSpans: [{ scopeSpans: [{ spans: { traceId: string; spanId: string; parentSpanId?: string; name: string; startTimeUnixNano: string; endTimeUnixNano: string; status: { code: number; message?: string } }[] }] }] };

const capture = () => {
  const calls: { url: string; headers: Record<string, string>; body: Body }[] = [];
  const send = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(init.body as string) as Body });
    return new Response(null, { status: 200 });
  };
  return { calls, send };
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

describe('otlpTurnExporter', () => {
  it('sends one trace per turn with a child span per hop and no message text', async () => {
    const { calls, send } = capture();
    let clock = 10_000;
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: { authorization: 'Basic k' } }, send, () => clock);
    await log({ trace: 'tg-1', hop: 'pickup', ms: 100, ok: true });
    clock = 12_000;
    await log({ trace: 'tg-1', hop: 'respond', ms: 1900, ok: true });
    expect(calls).toHaveLength(0);
    await log({ trace: 'tg-1', hop: 'turn', ms: 2100, ok: true });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.authorization).toBe('Basic k');
    const spans = calls[0]!.body.resourceSpans[0].scopeSpans[0].spans;
    const [root, ...hops] = spans;
    expect(root!.name).toBe('telegram turn');
    expect(root!.parentSpanId).toBeUndefined();
    expect(root!.startTimeUnixNano).toBe('9900000000');
    expect(hops.map((span) => span.name)).toEqual(['pickup', 'respond']);
    expect(hops.every((span) => span.traceId === root!.traceId && span.parentSpanId === root!.spanId)).toBe(true);
    expect(root!.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('attaches hops that finish after the turn to the same trace and marks failures', async () => {
    const { calls, send } = capture();
    const log = otlpTurnExporter({ endpoint: 'https://x/v1/traces', headers: {} }, send, () => 5_000);
    await log({ trace: 'tg-2', hop: 'turn', ms: 10, ok: true });
    await log({ trace: 'tg-2', hop: 'memory', ms: 3, ok: false, error: 'bad json' });
    const root = calls[0]!.body.resourceSpans[0].scopeSpans[0].spans[0]!;
    const memory = calls[1]!.body.resourceSpans[0].scopeSpans[0].spans[0]!;
    expect(memory.traceId).toBe(root.traceId);
    expect(memory.parentSpanId).toBe(root.spanId);
    expect(memory.status).toEqual({ code: 2, message: 'bad json' });
  });
});
