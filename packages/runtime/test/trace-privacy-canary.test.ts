import { describe, expect, it } from 'vitest';
import { gateTraceEntry, resolveCaptureText } from '../src/observability/trace-privacy';
import { otlpTurnExporter, type TraceContext } from '../src/observability/otlp-turns';
import { traceBook } from '../src/channels/harness';
import { consoleActionTraceDetail } from '../src/channels/console';
import { dayPlanTraceDetail } from '../src/channels/day-cards';
import type { TurnLogEntry } from '../src/channels/telegram-listener';

// Synthetic marker that must never survive the privacy gate: if any sink leaks free-form
// detail, error or text while the capture switch is off, this string shows up in the output.
const MARKER = 'ZXQ-CANARY-9f3e2';
const config = { endpoint: 'https://langfuse.test/api/public/otel/v1/traces', headers: {} };

const context = (captureText: boolean): TraceContext => ({
  environment: 'test', release: 'test', channel: 'telegram', userId: 'tg:1', sessionId: 's', captureText,
});

const markerTurn = (): TurnLogEntry[] => [
  { trace: 't1', hop: 'google_linked_notice', ms: 5, ok: false, detail: `notice ${MARKER}`, error: `provider says ${MARKER}`, code: 'send_failed' },
  { trace: 't1', hop: 'turn', ms: 10, ok: true, detail: 'answered', text: { input: `owner ${MARKER}`, output: `reply ${MARKER}` } },
];

const exportBodies = async (entries: TurnLogEntry[], captureText: boolean): Promise<string> => {
  const bodies: string[] = [];
  const exporter = otlpTurnExporter(config, context(captureText), async (_url, init) => {
    bodies.push(String(init.body));
    return new Response('{}', { status: 200 });
  });
  for (const entry of entries) await exporter(entry);
  return bodies.join('\n');
};

// Minimal SqlStorage stub: traceBook only calls exec; the canary reads the persisted note column.
const noteSink = () => {
  const notes: (string | null)[] = [];
  const sql = {
    exec: (query: string, ...args: unknown[]) => {
      if (query.startsWith('INSERT INTO trace_log')) notes.push((args[5] as string | null) ?? null);
      return { toArray: () => [] };
    },
  };
  return { sql: sql as never, notes };
};

describe('trace privacy canary', () => {
  it('leaks the marker into no sink when capture is off', async () => {
    const gated = markerTurn().map((entry) => gateTraceEntry(entry, false));
    const bodies = await exportBodies(gated, false);
    expect(bodies).not.toContain(MARKER);
    expect(bodies).toContain('send_failed');

    const sink = noteSink();
    const book = traceBook(sink.sql);
    for (const entry of gated) book.record(entry, Date.now());
    expect(sink.notes.join('\n')).not.toContain(MARKER);
    expect(sink.notes[0]).toBe('send_failed');

    const consoleLines = gated.map((entry) => JSON.stringify({ ...entry, text: undefined })).join('\n');
    expect(consoleLines).not.toContain(MARKER);
  });

  it('keeps typed memory and health receipt codes without private text when capture is off', async () => {
    const entries = [
      { trace: 'night:constellation', hop: 'constellation_evidence', ms: 0, ok: false, code: 'same_day', detail: 'held:same_day:owner_observation_pattern:1', error: MARKER },
      { trace: 'tg-test', hop: 'health_context', ms: 5, ok: true, code: 'absent', detail: MARKER, error: MARKER },
    ].map((entry) => gateTraceEntry(entry, false));
    expect(entries.map((entry) => entry.detail)).toEqual(['held:same_day:owner_observation_pattern:1', 'absent']);
    const payload = await exportBodies([...entries, { trace: 'night:constellation', hop: 'machine_turn', ms: 1, ok: true }, { trace: 'tg-test', hop: 'turn', ms: 6, ok: true }], false);
    expect(payload).not.toContain(MARKER);
    expect(payload).toContain('same_day');
    expect(payload).toContain('absent');
    const failed = gateTraceEntry({ trace: 'tg-failed', hop: 'health_context', ms: 0, ok: false, code: 'read_failed', error: MARKER }, false);
    expect(failed.detail).toBe('read_failed');
    expect(JSON.stringify(failed)).not.toContain(MARKER);
  });

  it('keeps semantic recall\'s counts with capture off, and only counts', () => {
    const kept = [
      ['memory_embedding', 'sweep texts=32'], ['memory_embedding', 'query rows=118 scan_ms=3'], ['memory_embedding', 'query'],
      ['memory_embed', 'embedded=31 withheld=1'], ['memory_embed', 'sweep'],
    ] as const;
    for (const [hop, detail] of kept) {
      const entry: TurnLogEntry = { trace: 'memory:semantic', hop, ms: 0, ok: true, detail };
      expect(gateTraceEntry(entry, false).detail).toBe(detail);
      expect(gateTraceEntry(entry, true).detail).toBe(detail);
    }
    for (const detail of [`query rows=5 note=${MARKER}`, `sweep texts=2 ${MARKER}`, 'query rows=1234567890 scan_ms=1', MARKER]) {
      const gated = gateTraceEntry({ trace: 'memory:semantic', hop: 'memory_embedding', ms: 0, ok: false, code: 'embed_failed', detail }, false);
      expect(gated.detail).toBe('embed_failed');
      expect(JSON.stringify(gated)).not.toContain(MARKER);
    }
  });

  it('rejects forged safe-hop codes that carry a private marker', () => {
    const bad = gateTraceEntry({ trace: 't', hop: 'constellation_evidence', ms: 0, ok: false, detail: `held:same_day:owner_observation_pattern:1 ${MARKER}`, code: MARKER }, false);
    expect(bad.detail).toBeUndefined();
    expect(bad.code).toBeUndefined();
    expect(JSON.stringify(bad)).not.toContain(MARKER);
  });

  it('keeps the marker in the OTLP body when capture is on (the test is not vacuous)', async () => {
    const bodies = await exportBodies(markerTurn().map((entry) => gateTraceEntry(entry, true)), true);
    expect(bodies).toContain(MARKER);
  });

  it('a typed tool failure keeps its code:reason while free-form error text is stripped', async () => {
    const entry: TurnLogEntry = { trace: 't2', hop: 'tool_query_calendar', ms: 3, ok: false, error: `google says ${MARKER}`, code: 'oversize:tool_result' };
    const gated = gateTraceEntry(entry, false);
    expect(gated.error).toBeUndefined();
    expect(gated.detail).toBe('oversize:tool_result');
    const bodies = await exportBodies([gated, { trace: 't2', hop: 'turn', ms: 10, ok: true }], false);
    expect(bodies).toContain('oversize:tool_result');
    expect(bodies).not.toContain(MARKER);
    expect(bodies).toContain('"message":"oversize:tool_result"');
  });

  it('a guard stage:reason diagnostic survives capture-off in the DO trace, console JSON and OTLP - with no free-form text', async () => {
    // The dispatcher's typed guard diagnostic is enum-only; it must reach every sink with the
    // capture switch off while the free-form error carrying the same enums plus content dies.
    const entry: TurnLogEntry = {
      trace: 't3', hop: 'tool_query_calendar', ms: 4, ok: false,
      error: `tool result failed the offload guard: canary_token:canary_leak ${MARKER}`,
      code: 'forbidden:sanitise_denied',
      guard: 'canary_token:canary_leak',
    };
    const gated = gateTraceEntry(entry, false);
    expect(gated.error).toBeUndefined();
    expect(gated.guard).toBe('canary_token:canary_leak');

    const sink = noteSink();
    const book = traceBook(sink.sql);
    book.record(gated, Date.now());
    expect(sink.notes[0]).toBe('canary_token:canary_leak');

    const consoleLine = JSON.stringify({ ...gated, text: undefined });
    expect(consoleLine).toContain('canary_token:canary_leak');
    expect(consoleLine).not.toContain(MARKER);

    const bodies = await exportBodies([gated, { trace: 't3', hop: 'turn', ms: 10, ok: true }], false);
    expect(bodies).toContain('canary_token:canary_leak');
    expect(bodies).not.toContain(MARKER);
  });

  it('a malformed guard value (free-form text) is dropped at the gate and reaches no sink, capture off', async () => {
    // The gate is the boundary: even if a caller stuffs provider text into guard, capture-off
    // output must exclude it from the DO trace, console JSON and OTLP (owner review #203 r2).
    const entry: TurnLogEntry = {
      trace: 't4', hop: 'tool_get_communication', ms: 4, ok: false,
      code: 'forbidden:sanitise_denied',
      guard: `canary_token:canary_leak ${MARKER}`,
    };
    const gated = gateTraceEntry(entry, false);
    expect(gated.guard).toBeUndefined();

    const sink = noteSink();
    const book = traceBook(sink.sql);
    book.record(gated, Date.now());
    expect(sink.notes[0]).toBe('forbidden:sanitise_denied');
    expect(sink.notes.join('\n')).not.toContain(MARKER);

    const consoleLine = JSON.stringify({ ...gated, text: undefined });
    expect(consoleLine).not.toContain(MARKER);

    const bodies = await exportBodies([gated, { trace: 't4', hop: 'turn', ms: 10, ok: true }], false);
    expect(bodies).not.toContain(MARKER);
  });

  it('a guard carrying the denial stage label survives capture-off in every sink', async () => {
    for (const guard of ['size_cap:invalid_payload:decode:nesting:base64:3', 'size_cap:invalid_payload:health', 'size_cap:invalid_payload:pii']) {
      const gated = gateTraceEntry({ trace: 't6', hop: 'tool_get_tasks', ms: 4, ok: false, code: 'forbidden:sanitise_denied', error: `${guard} ${MARKER}`, guard }, false);
      expect(gated.guard).toBe(guard);
      const sink = noteSink();
      traceBook(sink.sql).record(gated, Date.now());
      expect(sink.notes[0]).toBe(guard);
      const bodies = await exportBodies([gated, { trace: 't6', hop: 'turn', ms: 10, ok: true }], false);
      expect(bodies).toContain(guard);
      expect(bodies).not.toContain(MARKER);
    }
  });

  it('a stage label outside the enums, out of order or with trailing text is dropped at the gate', () => {
    for (const guard of [
      `size_cap:invalid_payload:decode:${MARKER}`,
      'size_cap:invalid_payload:decode:nesting:base64:9',
      'size_cap:invalid_payload:decode:nesting:base64',
      'size_cap:invalid_payload:nesting:decode:base64:3',
      'size_cap:invalid_payload:health:extra',
      `size_cap:invalid_payload:pii ${MARKER}`,
    ]) {
      expect(gateTraceEntry({ trace: 't7', hop: 'tool_get_tasks', ms: 4, ok: false, guard }, false).guard).toBeUndefined();
    }
  });

  it('a non-string guard (object with toString yielding a valid enum pair) is dropped at the gate - no sink serializes it', async () => {
    // Structural malformed-caller boundary: the gate must require a real string, never a
    // coercible object carrying private fields.
    const crafted = { toString: () => 'canary_token:canary_leak', private: MARKER };
    const entry = { trace: 't5', hop: 'tool_query_calendar', ms: 4, ok: false, code: 'forbidden:sanitise_denied', guard: crafted } as unknown as TurnLogEntry;
    const gated = gateTraceEntry(entry, false);
    expect(gated.guard).toBeUndefined();

    const sink = noteSink();
    const book = traceBook(sink.sql);
    book.record(gated, Date.now());
    expect(sink.notes[0]).toBe('forbidden:sanitise_denied');
    expect(sink.notes.join('\n')).not.toContain(MARKER);

    expect(JSON.stringify({ ...gated, text: undefined })).not.toContain(MARKER);

    const bodies = await exportBodies([gated, { trace: 't5', hop: 'turn', ms: 10, ok: true }], false);
    expect(bodies).not.toContain(MARKER);
  });

  it('producer-to-sinks: a free-form console form id reaches no sink even on a whitelisted hop', async () => {
    // The real producer path: console.ts accepts any id string, and the console_action hop is
    // whitelisted, so the detail builder itself is the only thing between owner-typed text and
    // the DO trace table, the wrangler console line and the OTLP exporter.
    const entry: TurnLogEntry = {
      trace: `console:${Date.now()}`, hop: 'console_action', ms: 0, ok: true,
      detail: consoleActionTraceDetail('timezone.set', MARKER),
    };
    const gated = gateTraceEntry(entry, false);
    expect(gated.detail).toBe('timezone.set');

    const bodies = await exportBodies([gated], false);
    expect(bodies).not.toContain(MARKER);

    const sink = noteSink();
    const book = traceBook(sink.sql);
    book.record(gated, Date.now());
    expect(sink.notes.join('\n')).not.toContain(MARKER);

    const consoleLines = JSON.stringify({ ...gated, text: undefined });
    expect(consoleLines).not.toContain(MARKER);
  });

  it('producer-to-sinks: day_plan detail keeps the count, never the owner\'s planned times', async () => {
    const entry: TurnLogEntry = {
      trace: 't-day', hop: 'day_plan', ms: 0, ok: true,
      detail: dayPlanTraceDetail([{ card: 'morning' as never, time: MARKER, reason: 'x' }]),
    };
    const gated = gateTraceEntry(entry, false);
    expect(gated.detail).toBe('1 planned');

    const bodies = await exportBodies([gated], false);
    expect(bodies).not.toContain(MARKER);
    const sink = noteSink();
    traceBook(sink.sql).record(gated, Date.now());
    expect(sink.notes.join('\n')).not.toContain(MARKER);
    expect(JSON.stringify({ ...gated, text: undefined })).not.toContain(MARKER);
  });

  it('consoleActionTraceDetail keeps integer target ids and drops everything else', () => {
    expect(consoleActionTraceDetail('spot.dismiss', '2')).toBe('spot.dismiss 2');
    expect(consoleActionTraceDetail('spot.dismiss', `2 ${MARKER}`)).toBe('spot.dismiss');
    expect(consoleActionTraceDetail('timezone.set', MARKER)).toBe('timezone.set');
    expect(consoleActionTraceDetail('card.pin', 'card.morning')).toBe('card.pin');
    expect(consoleActionTraceDetail('google.disconnect', '')).toBe('google.disconnect');
  });

  it('keeps verified count/enum detail for whitelisted hops while gating free-form detail', () => {
    const safe = gateTraceEntry({ trace: 't', hop: 'brief_sweep', ms: 0, ok: true, detail: '3 sent' }, false);
    expect(safe.detail).toBe('3 sent');
    const free = gateTraceEntry({ trace: 't', hop: 'event_brief', ms: 0, ok: true, detail: MARKER }, false);
    expect(free.detail).toBeUndefined();
  });
});

describe('staging release gate: production can never export text', () => {
  it('capture switch + staging/development allows text; production ignores the switch entirely', () => {
    // staging: capture on exports text (the debugging path)
    expect(resolveCaptureText({ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'staging' })).toBe(true);
    expect(resolveCaptureText({ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'development' })).toBe(true);
    // production: the switch is inert - a misconfigured prod deploy fails safe, types/counts only
    expect(resolveCaptureText({ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'production' })).toBe(false);
    // capture off anywhere: never
    expect(resolveCaptureText({ LANGFUSE_CAPTURE_TEXT: 'false', WALDO_ENVIRONMENT: 'staging' })).toBe(false);
    expect(resolveCaptureText({})).toBe(false);
    // a production entry gated by the resolver still strips free-form text end-to-end
    const entry = gateTraceEntry(
      { trace: 't', hop: 'model_reply', ms: 1, ok: false, error: `provider raw ${MARKER}`, detail: `free-form ${MARKER}`, code: 'provider_error' } as TurnLogEntry,
      resolveCaptureText({ LANGFUSE_CAPTURE_TEXT: 'true', WALDO_ENVIRONMENT: 'production' }),
    );
    expect(entry.error).toBeUndefined();
    expect(entry.detail).toBe('provider_error');
  });
});


it.each(['invalid_decision', 'uncertain', 'retained_invalid', 'retained_uncertain', 'invalid_decision:json_syntax', 'invalid_decision:invalid_shape', 'invalid_decision:unknown_decision', 'invalid_decision:invalid_sources', 'invalid_decision:invalid_evidence'] as const)('task custody %s diagnostic survives capture-off without private classifier data', async code => {
  const entry: TurnLogEntry = { trace: 'scope-recovery', hop: 'task_source_custody', ms: 0, ok: code.startsWith('retained_'), code, detail: MARKER, error: MARKER, text: { input: MARKER, output: MARKER } };
  const gated = gateTraceEntry(entry, false);
  const bodies = await exportBodies([gated, { trace: entry.trace, hop: 'turn', ms: 0, ok: true }], false);
  expect(bodies).toContain(code); expect(bodies).not.toContain(MARKER);
  const sink = noteSink(); traceBook(sink.sql).record(gated, Date.now());
  expect(sink.notes).toEqual([code]);
});

describe('v9 typed fields at the gate', () => {
  it('keeps the typed v9 fields with capture off and drops any that are not in their vocabulary', () => {
    const typed: TurnLogEntry = {
      trace: 't9', hop: 'tool_draft_email', ms: 5, ok: false, error: `provider says ${MARKER}`,
      error_code: 'rate_limited', rung: 'email', blocked_reason: 'approval_required', provider: 'openai', fallback_fired: true,
      ttft_ms: 120, tools_called: 1, parallel_batches: 1, job_id: 'job_01', job_profile: 'reader', outcome: 'blocked', browser_ms: 0, sandbox_ms: 0,
    };
    const gated = gateTraceEntry(typed, false);
    expect(gated).toMatchObject({ error_code: 'rate_limited', rung: 'email', blocked_reason: 'approval_required', provider: 'openai', fallback_fired: true, ttft_ms: 120, tools_called: 1, parallel_batches: 1, job_id: 'job_01', job_profile: 'reader', outcome: 'blocked', browser_ms: 0, sandbox_ms: 0 });
    expect(JSON.stringify(gated)).not.toContain(MARKER);

    const smuggled = gateTraceEntry({
      ...typed, error_code: `rate_limited ${MARKER}`, rung: MARKER as never, blocked_reason: MARKER as never, provider: MARKER as never,
      job_id: `job ${MARKER}`, job_profile: `reader ${MARKER}`, outcome: MARKER as never, ttft_ms: Number.NaN, tools_called: -1,
    }, false);
    expect(JSON.stringify(smuggled)).not.toContain(MARKER);
    for (const key of ['error_code', 'rung', 'blocked_reason', 'provider', 'job_id', 'job_profile', 'outcome', 'ttft_ms', 'tools_called'] as const) expect(smuggled[key]).toBeUndefined();
  });

  it('keeps a tool search rejection made of identifiers and drops one that carries words', () => {
    const base: TurnLogEntry = { trace: 't13', hop: 'llm_reply', ms: 5, ok: true, tool_search_degraded: true };
    const reason = 'OpenAI request failed (400 unsupported_parameter tools[12].type)';
    expect(gateTraceEntry({ ...base, tool_search_rejection: reason }, false).tool_search_rejection).toBe(reason);
    const smuggled = gateTraceEntry({ ...base, tool_search_rejection: `OpenAI request failed: "${MARKER}, my dentist is on Elm Road"` }, false);
    expect(smuggled.tool_search_rejection).toBeUndefined();
    expect(JSON.stringify(smuggled)).not.toContain(MARKER);
  });
  it('keeps tool_search_degraded as a boolean with capture off and drops anything else', () => {
    const base: TurnLogEntry = { trace: 't12', hop: 'llm_reply', ms: 5, ok: true };
    expect(gateTraceEntry({ ...base, tool_search_degraded: true }, false).tool_search_degraded).toBe(true);
    const smuggled = gateTraceEntry({ ...base, tool_search_degraded: MARKER as never }, false);
    expect(smuggled.tool_search_degraded).toBeUndefined();
    expect(JSON.stringify(smuggled)).not.toContain(MARKER);
  });
});
