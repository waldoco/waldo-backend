import type { TurnLogEntry } from '../channels/telegram-listener';

export type OtlpConfig = Readonly<{ endpoint: string; headers: Readonly<Record<string, string>> }>;
type Env = Readonly<{ LANGFUSE_PUBLIC_KEY?: string; LANGFUSE_SECRET_KEY?: string; LANGFUSE_BASE_URL?: string }>;
type Send = (url: string, init: RequestInit) => Promise<Response>;
type Span = Readonly<{ entry: TurnLogEntry; endMs: number }>;

export const langfuseOtlpConfig = (env: Env): OtlpConfig | null => {
  const { LANGFUSE_PUBLIC_KEY: pk, LANGFUSE_SECRET_KEY: sk, LANGFUSE_BASE_URL: base } = env;
  if (!pk || !sk || !base) return null;
  return {
    endpoint: `${base.replace(/\/+$/, '')}/api/public/otel/v1/traces`,
    headers: { authorization: `Basic ${btoa(`${pk}:${sk}`)}`, 'x-langfuse-ingestion-version': '4' },
  };
};

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const nanos = (ms: number) => `${Math.round(ms)}000000`;
const attr = (key: string, value: string) => ({ key, value: { stringValue: value } });

// Exports each owner turn as one trace: a root span for the turn and a child per hop.
// Spans carry hop names, timings and outcomes only, never message text.
export const otlpTurnExporter = (config: OtlpConfig, send: Send = fetch, now: () => number = Date.now) => {
  const pending = new Map<string, Span[]>();
  const exported = new Map<string, Readonly<{ traceId: string; rootId: string }>>();

  const span = (traceId: string, spanId: string, parentSpanId: string | undefined, { entry, endMs }: Span) => ({
    traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}),
    name: parentSpanId ? entry.hop : 'telegram turn', kind: 1,
    startTimeUnixNano: nanos(endMs - entry.ms), endTimeUnixNano: nanos(endMs),
    attributes: [attr('waldo.trace', entry.trace), attr('waldo.hop', entry.hop)],
    status: entry.ok ? { code: 1 } : { code: 2, message: entry.error ?? 'failed' },
  });

  const post = (spans: readonly object[]) => send(config.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...config.headers },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [attr('service.name', 'waldo-runtime')] },
        scopeSpans: [{ scope: { name: 'waldo.telegram' }, spans }],
      }],
    }),
  }).then((response) => { if (!response.ok) throw new Error(`otlp export failed: ${response.status}`); });

  return (entry: TurnLogEntry): Promise<void> => {
    const item = { entry, endMs: now() };
    const done = exported.get(entry.trace);
    if (done) return post([span(done.traceId, hex(8), done.rootId, item)]);
    if (entry.hop !== 'turn') {
      pending.set(entry.trace, [...(pending.get(entry.trace) ?? []), item]);
      return Promise.resolve();
    }
    const ids = { traceId: hex(16), rootId: hex(8) };
    const hops = pending.get(entry.trace) ?? [];
    pending.delete(entry.trace);
    exported.set(entry.trace, ids);
    if (exported.size > 50) exported.delete(exported.keys().next().value!);
    return post([span(ids.traceId, ids.rootId, undefined, item), ...hops.map((hop) => span(ids.traceId, hex(8), ids.rootId, hop))]);
  };
};
