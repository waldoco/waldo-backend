import type { TurnLogEntry } from '../channels/telegram-listener';
import { modelCost } from '../llm/pricing';

export type OtlpConfig = Readonly<{ endpoint: string; headers: Readonly<Record<string, string>> }>;
export type TraceContext = Readonly<{ environment: string; release: string; channel: string; userId: string; sessionId: string; captureText: boolean }>;
type Env = Readonly<{ LANGFUSE_PUBLIC_KEY?: string; LANGFUSE_SECRET_KEY?: string; LANGFUSE_BASE_URL?: string }>;
type Send = (url: string, init: RequestInit) => Promise<Response>;
type Span = Readonly<{ entry: TurnLogEntry; endMs: number }>;

// Bump when a name, tag or metadata key below changes meaning, so dashboards can filter by it.
export const TRACE_SCHEMA_VERSION = '1';

// Every hop has one feature area and a Langfuse observation type. New hops land in `other`
// as plain spans until they are added here; model calls (`llm_*`) are always generations.
type Hop = Readonly<{ feature: string; type: 'agent' | 'chain' | 'tool' | 'span' }>;
export const HOPS: Readonly<Record<string, Hop>> = {
  turn: { feature: 'turn', type: 'agent' },
  pickup: { feature: 'channel', type: 'span' },
  typing: { feature: 'channel', type: 'tool' }, progress: { feature: 'channel', type: 'tool' }, send: { feature: 'channel', type: 'tool' },
  receipt: { feature: 'reactions', type: 'tool' }, resolved: { feature: 'reactions', type: 'tool' }, choose_reaction: { feature: 'reactions', type: 'chain' },
  respond: { feature: 'reply', type: 'chain' }, joined_path: { feature: 'reply', type: 'chain' },
  memory: { feature: 'memory', type: 'chain' },
  llm_reply: { feature: 'reply', type: 'span' }, llm_reaction: { feature: 'reactions', type: 'span' }, llm_memory: { feature: 'memory', type: 'span' },
};
export const hopFeature = (hop: string) => HOPS[hop]?.feature ?? 'other';

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
const list = (key: string, values: readonly string[]) => ({ key, value: { arrayValue: { values: values.map((stringValue) => ({ stringValue })) } } });
const tagsFor = (context: TraceContext, spans: readonly Span[]) => [
  `channel:${context.channel}`,
  ...[...new Set(spans.map(({ entry }) => hopFeature(entry.hop)))].filter((feature) => feature !== 'turn').sort().map((feature) => `feature:${feature}`),
];

// Exports each owner turn as one Langfuse trace: a root span for the turn, a child per hop,
// and a generation per model call with tokens and USD cost. Message text only when captureText is on.
export const otlpTurnExporter = (config: OtlpConfig, context: TraceContext, send: Send = fetch, now: () => number = Date.now) => {
  const pending = new Map<string, Span[]>();
  const exported = new Map<string, Readonly<{ traceId: string; rootId: string }>>();

  const generation = ({ hop, usage }: TurnLogEntry) => {
    if (!usage) return [attr('langfuse.observation.type', HOPS[hop]?.type ?? 'span')];
    const cost = modelCost(usage);
    return [
      attr('langfuse.observation.type', 'generation'),
      attr('langfuse.observation.model.name', usage.model),
      attr('langfuse.observation.usage_details', JSON.stringify({ input: usage.input - usage.cached, input_cached_tokens: usage.cached, output: usage.output })),
      ...(cost ? [attr('langfuse.observation.cost_details', JSON.stringify(cost))] : []),
    ];
  };

  const io = ({ text }: TurnLogEntry) => {
    if (!context.captureText || !text) return [];
    return [
      attr('langfuse.observation.input', text.input),
      ...(text.output === undefined ? [] : [attr('langfuse.observation.output', text.reasoning ? JSON.stringify({ reasoning: text.reasoning, text: text.output }) : text.output)]),
    ];
  };

  const totals = (spans: readonly Span[]) => {
    const usages = spans.flatMap(({ entry }) => (entry.usage ? [entry.usage] : []));
    const cost = usages.reduce((sum, usage) => sum + (modelCost(usage)?.total ?? 0), 0);
    return [
      attr('langfuse.trace.metadata.model_calls', String(usages.length)),
      attr('langfuse.trace.metadata.tokens_input', String(usages.reduce((sum, usage) => sum + usage.input, 0))),
      attr('langfuse.trace.metadata.tokens_output', String(usages.reduce((sum, usage) => sum + usage.output, 0))),
      attr('langfuse.trace.metadata.cost_usd', cost.toFixed(8)),
    ];
  };

  const span = (traceId: string, spanId: string, parentSpanId: string | undefined, { entry, endMs }: Span, extra: readonly object[] = []) => ({
    traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}),
    name: parentSpanId ? entry.hop : `${context.channel}.turn`, kind: 1,
    startTimeUnixNano: nanos(endMs - entry.ms), endTimeUnixNano: nanos(endMs),
    attributes: [
      attr('langfuse.environment', context.environment),
      attr('langfuse.observation.metadata.hop', entry.hop),
      attr('langfuse.observation.metadata.feature', hopFeature(entry.hop)),
      attr('langfuse.observation.metadata.trace_key', entry.trace),
      ...(entry.detail ? [attr('langfuse.observation.metadata.detail', entry.detail)] : []),
      ...generation(entry),
      ...io(entry),
      ...extra,
    ],
    status: entry.ok ? { code: 1 } : { code: 2, message: entry.error ?? 'failed' },
  });

  const post = (spans: readonly object[]) => send(config.endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...config.headers },
    body: JSON.stringify({
      resourceSpans: [{
        resource: { attributes: [attr('service.name', 'waldo-runtime'), attr('service.version', context.release), attr('deployment.environment.name', context.environment)] },
        scopeSpans: [{ scope: { name: 'waldo.turns', version: TRACE_SCHEMA_VERSION }, spans }],
      }],
    }),
  }).then((response) => { if (!response.ok) throw new Error(`otlp export failed: ${response.status}`); });

  return (entry: TurnLogEntry): Promise<void> => {
    const item = { entry, endMs: now() };
    const done = exported.get(entry.trace);
    if (done) return post([span(done.traceId, hex(8), done.rootId, item, [list('langfuse.trace.tags', tagsFor(context, [item]))])]);
    if (entry.hop !== 'turn') {
      pending.set(entry.trace, [...(pending.get(entry.trace) ?? []), item]);
      if (pending.size > 50) pending.delete(pending.keys().next().value!);
      return Promise.resolve();
    }
    const ids = { traceId: hex(16), rootId: hex(8) };
    const hops = pending.get(entry.trace) ?? [];
    pending.delete(entry.trace);
    exported.set(entry.trace, ids);
    if (exported.size > 50) exported.delete(exported.keys().next().value!);
    const root = span(ids.traceId, ids.rootId, undefined, item, [
      attr('langfuse.trace.name', `${context.channel}.turn`),
      attr('langfuse.user.id', context.userId),
      attr('langfuse.session.id', context.sessionId),
      attr('langfuse.release', context.release),
      attr('langfuse.version', context.release),
      list('langfuse.trace.tags', tagsFor(context, hops)),
      attr('langfuse.trace.metadata.schema_version', TRACE_SCHEMA_VERSION),
      attr('langfuse.trace.metadata.channel', context.channel),
      attr('langfuse.trace.metadata.trace_key', entry.trace),
      attr('langfuse.trace.metadata.outcome', entry.ok ? 'answered' : 'failed'),
      ...totals(hops),
    ]);
    return post([root, ...hops.map((hop) => span(ids.traceId, hex(8), ids.rootId, hop))]);
  };
};
