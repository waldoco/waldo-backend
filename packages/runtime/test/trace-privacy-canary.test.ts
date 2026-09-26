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
