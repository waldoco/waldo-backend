import type { TurnLogEntry } from '../channels/telegram-listener';
import { modelCost } from '../llm/pricing';
import { gateTraceEntry, resolveCaptureText } from './trace-privacy';
import { ownerTraceFields, ownerTraceIdentity } from './owner-trace-identity';

export type OtlpConfig = Readonly<{ endpoint: string; headers: Readonly<Record<string, string>> }>;
export type TraceContext = Readonly<{ environment: string; release: string; channel: string; userId: string; sessionId: string; captureText: boolean }>;
type Env = Readonly<{ LANGFUSE_PUBLIC_KEY?: string; LANGFUSE_SECRET_KEY?: string; LANGFUSE_BASE_URL?: string }>;
type Send = (url: string, init: RequestInit) => Promise<Response>;
type Span = Readonly<{ entry: TurnLogEntry; endMs: number; arrival: number }>;

// Bump when a name, tag or metadata key below changes meaning, so dashboards can filter by it.
export const TRACE_SCHEMA_VERSION = '6';

// Every hop has one feature area and a Langfuse observation type. New hops land in `other`
// as plain spans until they are added here; model calls (`llm_*`) are always generations.
type Hop = Readonly<{ feature: string; type: 'agent' | 'chain' | 'tool' | 'span' }>;
export const HOPS: Readonly<Record<string, Hop>> = {
  turn: { feature: 'turn', type: 'agent' },
  machine_turn: { feature: 'schedule', type: 'agent' },
  pickup: { feature: 'channel', type: 'span' },
  typing: { feature: 'channel', type: 'tool' }, progress: { feature: 'channel', type: 'tool' }, send: { feature: 'channel', type: 'tool' },
  receipt: { feature: 'reactions', type: 'tool' }, resolved: { feature: 'reactions', type: 'tool' }, choose_reaction: { feature: 'reactions', type: 'chain' },
  respond: { feature: 'reply', type: 'chain' }, joined_path: { feature: 'reply', type: 'chain' },
  memory: { feature: 'memory', type: 'chain' }, constellation_evidence: { feature: 'memory', type: 'span' }, health_context: { feature: 'health', type: 'span' },
  llm_reply: { feature: 'reply', type: 'span' }, llm_reaction: { feature: 'reactions', type: 'span' }, llm_memory: { feature: 'memory', type: 'span' },
};
export const hopFeature = (hop: string) => HOPS[hop]?.feature ?? 'other';

// Machine turns (reminder fires, heartbeat ticks, nightly, standing orders) close their trace
// with a machine_turn root instead of turn; without a root the spans never leave `pending`.
const ROOT_NAMES: Readonly<Record<string, string>> = { turn: 'turn', machine_turn: 'machine' };

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
// Outstanding exports keep the 50-item budget. Buffered hops get their own, larger one so a long tool turn keeps every span.
const MAX_RETAINED = 50;
const MAX_BUFFERED_HOPS = 1000;
// OpenTelemetry's standard OTLP exporter timeout.
const EXPORT_TIMEOUT_MS = 10_000;
const tagsFor = (context: TraceContext, spans: readonly Span[]) => [
  `channel:${context.channel}`,
  ...[...new Set(spans.map(({ entry }) => hopFeature(entry.hop)))].filter((feature) => feature !== 'turn').sort().map((feature) => `feature:${feature}`),
];

// Exports each owner turn as one Langfuse trace: a root span for the turn, a child per hop,
// and a generation per model call with tokens and explicit USD estimates. Message text only when captureText is on.
export const otlpTurnExporter = (config: OtlpConfig, suppliedContext: TraceContext, send: Send = fetch, now: () => number = Date.now) => {
  const context = { ...suppliedContext, captureText: resolveCaptureText({ WALDO_ENVIRONMENT: suppliedContext.environment, LANGFUSE_CAPTURE_TEXT: suppliedContext.captureText ? 'true' : 'false' }) };
  const validContext = [context.environment, context.release, context.channel, context.userId, context.sessionId].every((value) => typeof value === 'string' && value.trim().length > 0) && typeof suppliedContext.captureText === 'boolean';
  const pending = new Map<string, Span[]>();
  let nextArrival = 0;
  let bufferedHops = 0;
  let evictedHops = 0;
  const exported = new Map<string, Readonly<{ traceId: string; rootId: string; rootHop: string; delivery: Promise<void> }>>();

  const rootName = (hop: string) => `${context.channel}.${ROOT_NAMES[hop] ?? 'turn'}`;

  const observationType = (hop: string) => HOPS[hop]?.type ?? (hop.startsWith('tool_') ? 'tool' : 'span');
  const generation = ({ hop, usage }: TurnLogEntry) => {
    if (!usage) return [attr('langfuse.observation.type', observationType(hop))];
    const cost = modelCost(usage);
    return [
      attr('langfuse.observation.type', 'generation'),
      attr('langfuse.observation.model.name', usage.model),
      attr('langfuse.observation.usage_details', JSON.stringify({ input: usage.input - usage.cached, input_cached_tokens: usage.cached, output: usage.output })),
      attr('langfuse.observation.metadata.cost_kind', cost ? 'estimate' : 'unpriced'),
      ...(cost ? [attr('langfuse.observation.metadata.price_source', JSON.stringify({
        source: 'runtime:modelCost:standard-flat',
        usd_per_million: {
          input: modelCost({ model: usage.model, input: 1_000_000, cached: 0, output: 0 })!.input,
          cached: modelCost({ model: usage.model, input: 1_000_000, cached: 1_000_000, output: 0 })!.input,
          output: modelCost({ model: usage.model, input: 0, cached: 0, output: 1_000_000 })!.output,
        },
      }))] : []),
      ...(cost ? [attr('langfuse.observation.cost_details', JSON.stringify(cost))] : []),
    ];
  };

  // What filled a model call, as numbers only, so section sizes can be compared across turns and surfaces.
  const contextMetadata = ({ shape }: TurnLogEntry) => {
    if (!shape?.context) return [];
    const { system_sections: sections = {}, ...counts } = shape.context;
    return [
      attr('langfuse.observation.metadata.context_system_bytes', String(shape.system_bytes)),
      attr('langfuse.observation.metadata.context_request_bytes', String(shape.request_bytes)),
      ...Object.entries(counts).map(([key, value]) => attr(`langfuse.observation.metadata.context_${key}`, String(value))),
      ...Object.entries(sections).map(([key, value]) => attr(`langfuse.observation.metadata.context_system_${key}_bytes`, String(value))),
    ];
  };

  const io = ({ text }: TurnLogEntry) => {
    if (!context.captureText || !text) return [];
    return [
      attr('langfuse.observation.input', text.input),
      ...(text.output === undefined ? [] : [attr('langfuse.observation.output', text.reasoning ? JSON.stringify({ reasoning: text.reasoning, text: text.output }) : text.output)]),
    ];
  };

  // Langfuse's trace list/preview reads langfuse.trace.input/output off the ROOT span; the
  // per-hop observation attrs above don't surface there. The turn entry carries the owner's
  // message and the final reply, gated by the same captureText switch.
  const traceIo = ({ text }: TurnLogEntry) => {
    if (!context.captureText || !text) return [];
    return [
      attr('langfuse.trace.input', text.input),
      ...(text.output === undefined ? [] : [attr('langfuse.trace.output', text.reasoning ? JSON.stringify({ reasoning: text.reasoning, text: text.output }) : text.output)]),
    ];
  };

  const totals = (spans: readonly Span[]) => {
    const usages = spans.flatMap(({ entry }) => (entry.usage ? [entry.usage] : []));
    const costs = usages.map(modelCost).filter((cost) => cost !== null);
    const cost = costs.reduce((sum, value) => sum + value.total, 0);
    const unpriced = usages.length - costs.length;
    return [
      attr('langfuse.trace.metadata.model_calls', String(usages.length)),
      attr('langfuse.trace.metadata.tokens_input', String(usages.reduce((sum, usage) => sum + usage.input, 0))),
      attr('langfuse.trace.metadata.tokens_output', String(usages.reduce((sum, usage) => sum + usage.output, 0))),
      attr('langfuse.trace.metadata.tokens_cached', String(usages.reduce((sum, usage) => sum + usage.cached, 0))),
      attr('langfuse.trace.metadata.cost_kind', 'estimate'),
      attr('langfuse.trace.metadata.cost_scope', 'pre_root_hops'),
      attr('langfuse.trace.metadata.pricing_limit', 'flat_table_not_tier_or_bill_reconciled'),
      attr('langfuse.trace.metadata.priced_model_calls', String(costs.length)),
      attr('langfuse.trace.metadata.unpriced_model_calls', String(unpriced)),
      attr('langfuse.trace.metadata.cost_coverage', unpriced === 0 ? 'table_priced' : costs.length === 0 ? 'unpriced' : 'partial'),
      ...(costs.length ? [attr('langfuse.trace.metadata.estimated_cost_usd', cost.toFixed(8))] : []),
    ];
  };

  const span = (traceId: string, spanId: string, parentSpanId: string | undefined, { entry, endMs }: Span, extra: readonly object[] = [], rootHop = 'turn') => ({
    traceId, spanId, ...(parentSpanId ? { parentSpanId } : {}),
    name: parentSpanId ? entry.hop : rootName(entry.hop), kind: 1,
    startTimeUnixNano: nanos(endMs - entry.ms), endTimeUnixNano: nanos(endMs),
    attributes: [
      attr('langfuse.environment', context.environment),
      attr('langfuse.user.id', context.userId),
      attr('langfuse.session.id', context.sessionId),
      attr('langfuse.release', context.release),
      attr('langfuse.version', context.release),
      attr('langfuse.trace.name', rootName(rootHop)),
      attr('langfuse.trace.metadata.channel', context.channel),
      attr('langfuse.trace.metadata.trace_key', entry.trace),
      // Keep channel labels compatible; canonical identity is separate metadata.
      attr('langfuse.trace.metadata.owner_attribution', ownerTraceIdentity(entry) ? 'canonical_owner_supplied' : 'canonical_owner_not_supplied'),
      ...Object.entries(ownerTraceFields(ownerTraceIdentity(entry))).flatMap(([key, value]) => [
        attr(`langfuse.trace.metadata.${key}`, value), attr(`langfuse.observation.metadata.${key}`, value),
      ]),
      attr('langfuse.observation.metadata.hop', entry.hop),
      attr('langfuse.observation.metadata.feature', hopFeature(entry.hop)),
      attr('langfuse.observation.metadata.trace_key', entry.trace),
      ...(entry.detail ? [attr('langfuse.observation.metadata.detail', entry.detail)] : []),
      // Typed failure identity rides its own attribute so a halted hop stays diagnosable
      // when captureText gates the free-form error off: "code:reason" (e.g.
      // "transient:approval_denied" pins the autonomy gate, "transient:sanitise_denied" the
      // scribe) without exposing any argument or content.
      ...(entry.code ? [attr('langfuse.observation.metadata.code', entry.code)] : []),
      ...(entry.guard ? [attr('langfuse.observation.metadata.guard', entry.guard)] : []),
      ...(entry.owner ? [attr('langfuse.observation.metadata.owner', entry.owner)] : []),
      ...generation(entry),
      ...contextMetadata(entry),
      ...io(entry),
      ...extra,
    ],
    status: entry.ok ? { code: 1 } : { code: 2, message: entry.error ?? ([entry.code, entry.guard].filter(Boolean).join(' ') || 'failed') },
  });

  let inFlight = 0;
  const post = async (spans: readonly object[], parent?: Promise<void>): Promise<void> => {
    if (inFlight >= MAX_RETAINED) throw new Error('otlp_export_capacity');
    inFlight++;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error('otlp_export_timeout'));
          controller.abort();
        }, EXPORT_TIMEOUT_MS);
      });
      const request = Promise.resolve(parent).then(() => send(config.endpoint, {
        method: 'POST', signal: controller.signal,
        headers: { 'content-type': 'application/json', ...config.headers },
        body: JSON.stringify({
          resourceSpans: [{
            resource: { attributes: [attr('service.name', 'waldo-runtime'), attr('service.version', context.release), attr('deployment.environment.name', context.environment)] },
            scopeSpans: [{ scope: { name: 'waldo.turns', version: TRACE_SCHEMA_VERSION }, spans }],
          }],
        }),
      })).then((response) => {
        // The ingestion response body is not an evidence source and is never logged.
        void response.body?.cancel().catch(() => undefined);
        if (!response.ok) throw new Error(`otlp_export_http_${response.status}`);
      }, () => { throw new Error('otlp_export_transport'); });
      await Promise.race([request, timeout]);
    } finally {
      clearTimeout(timer);
      inFlight--;
    }
  };

  return (entry: TurnLogEntry): Promise<void> => {
    if (!validContext) return Promise.reject(new Error('otlp_context_invalid'));
    const gated = gateTraceEntry(entry, context.captureText);
    const item = { entry: { ...gated, text: context.captureText && gated.text ? { ...gated.text } : undefined, usage: gated.usage ? { ...gated.usage } : undefined }, endMs: now(), arrival: nextArrival++ };
    const done = exported.get(entry.trace);
    if (done) return post([span(done.traceId, hex(8), done.rootId, item, [list('langfuse.trace.tags', tagsFor(context, [item]))], done.rootHop)], done.delivery);
    if (entry.hop !== 'turn' && entry.hop !== 'machine_turn') {
      const overflow = bufferedHops >= MAX_BUFFERED_HOPS;
      if (overflow) {
        let oldest = pending.keys().next().value!;
        // Each trace's hops are arrival-ordered; compare heads across all traces.
        for (const [trace, hops] of pending) {
          if (hops[0]!.arrival < pending.get(oldest)![0]!.arrival) oldest = trace;
        }
        const retained = pending.get(oldest)!.slice(1);
        if (retained.length) pending.set(oldest, retained); else pending.delete(oldest);
        bufferedHops--;
        evictedHops++;
      }
      pending.set(entry.trace, [...(pending.get(entry.trace) ?? []), item]);
      bufferedHops++;
      // New work survives; the rejected promise feeds the host's durable export-failure row.
      return overflow ? Promise.reject(new Error('otlp_buffer_evicted')) : Promise.resolve();
    }
    const ids = { traceId: hex(16), rootId: hex(8), rootHop: entry.hop };
    const hops = pending.get(entry.trace) ?? [];
    pending.delete(entry.trace);
    bufferedHops -= hops.length;
    const root = span(ids.traceId, ids.rootId, undefined, item, [
      list('langfuse.trace.tags', tagsFor(context, hops)),
      attr('langfuse.trace.metadata.schema_version', TRACE_SCHEMA_VERSION),
      attr('langfuse.trace.metadata.buffer_evicted_hops', String(evictedHops)),
      attr('langfuse.trace.metadata.outcome', entry.ok ? (entry.hop === 'turn' ? 'answered' : 'completed') : 'failed'),
      ...totals(hops),
      ...traceIo(item.entry),
    ], entry.hop);
    evictedHops = 0;
    const delivery = post([root, ...hops.map((hop) => span(ids.traceId, hex(8), ids.rootId, hop, [list('langfuse.trace.tags', tagsFor(context, hops))], entry.hop))]);
    const record = { ...ids, delivery };
    exported.set(entry.trace, record);
    if (exported.size > MAX_RETAINED) exported.delete(exported.keys().next().value!);
    // Keep rejected delivery promises in the same bounded retention window: late children
    // reject too, instead of becoming orphaned buffers or apparently delivered observations.
    return delivery;
  };
};
