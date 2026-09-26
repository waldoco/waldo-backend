import { describe, expect, it } from 'vitest';
import { gateTraceEntry, resolveCaptureText } from '../src/observability/trace-privacy';
import { otlpTurnExporter, type TraceContext } from '../src/observability/otlp-turns';
import { traceBook } from '../src/channels/harness';
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
