import { describe, expect, it } from 'vitest';
import { gateTraceEntry } from './trace-privacy';
import { otlpTurnExporter, type TraceContext } from './otlp-turns';
import { traceBook } from '../channels/harness';
import type { TurnLogEntry } from '../channels/telegram-listener';

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

  it('keeps verified count/enum detail for whitelisted hops while gating free-form detail', () => {
    const safe = gateTraceEntry({ trace: 't', hop: 'brief_sweep', ms: 0, ok: true, detail: '3 sent' }, false);
    expect(safe.detail).toBe('3 sent');
    const free = gateTraceEntry({ trace: 't', hop: 'event_brief', ms: 0, ok: true, detail: MARKER }, false);
    expect(free.detail).toBeUndefined();
  });
});
