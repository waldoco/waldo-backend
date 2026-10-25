import { ownerTyped } from './helpers/owner-typed';
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { narrativeContextSchema } from '@waldo/contracts';
import type { TurnLogEntry } from '../src/channels/telegram-listener';
import type { ContextHealthMaterial } from '../src/context-composer/types';

// Synthetic values only. Every number and zone word below is invented for this test.
const seen = vi.hoisted(() => ({ outputs: [] as unknown[][], texts: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async () => ({
  id: 'fixture', output_text: seen.texts.shift() ?? 'pong', output: seen.outputs.shift() ?? [],
  usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } },
}) }; } }));
const { createOwnerResponder } = await import('../src/channels/owner-turn');
const { gateTraceEntry } = await import('../src/observability/trace-privacy');
const { otlpTurnExporter } = await import('../src/observability/otlp-turns');
const { traceBook } = await import('../src/channels/harness');
const { getHealthHandler, healthReadBook } = await import('../src/tools/live/health');
const { renderHealth } = await import('../src/context-composer/prompt');
const { healthSection } = await import('../src/channels/health-log');
const { HEALTH_WITHHELD } = await import('../src/observability/trace-health-scrub');
const { toContextHealthMaterial } = await import('../src/channels/health-context');
const { createOwnerTurnContext } = await import('../src/context-composer/owner-turn');
const { ownerMessageAdmission } = await import('../src/identity/owner-message-admission');

beforeEach(() => { seen.outputs = []; seen.texts = []; });

const config = { endpoint: 'https://langfuse.test/api/public/otel/v1/traces', headers: {} };
const exportBodies = async (entries: readonly TurnLogEntry[], captureText: boolean): Promise<string> => {
  const bodies: string[] = [];
  const exporter = otlpTurnExporter(config, { environment: 'staging', release: 'test', channel: 'telegram', userId: 'tg:1', sessionId: 's', captureText },
    async (_url, init) => { bodies.push(String(init.body)); return new Response('{}', { status: 200 }); });
  for (const entry of entries) await exporter(entry);
  // The exporter sends a trace when its root hop arrives; the channel listener logs that root after the responder's hops.
  for (const trace of new Set(entries.map((entry) => entry.trace))) {
    if (!entries.some((entry) => entry.trace === trace && (entry.hop === 'turn' || entry.hop === 'machine_turn'))) await exporter({ trace, hop: 'turn', ms: 1, ok: true });
  }
  return bodies.join('\n');
};
const traceNotes = (entries: readonly TurnLogEntry[]): string => {
  const notes: string[] = [];
  const sql = { exec: (query: string, ...args: unknown[]) => {
    if (query.startsWith('INSERT INTO trace_log')) notes.push(String(args[5] ?? ''));
    return { toArray: () => [] };
  } };
  const book = traceBook(sql as never);
  for (const entry of entries) book.record(entry, Date.now());
  return notes.join('\n');
};
// Every sink the owner DO feeds from one gated entry: the DO trace table, the console JSON line and the OTLP exporter.
const sinks = async (entries: readonly TurnLogEntry[], captureText = true) => {
  const gated = entries.map((entry) => gateTraceEntry(entry, captureText));
  return { gated, otlp: await exportBodies(gated, captureText), notes: traceNotes(gated), console: gated.map((entry) => JSON.stringify({ ...entry, text: undefined })).join('\n') };
};

const material: ContextHealthMaterial = {
  view: {
    authority: 'backend', algorithm_version: 'form.safte-fast.v1', form_zone: 'flagging', trend: 'declining', freshness: 'fresh',
    missing_components: [], confidence_band: 'high', provenance_refs: ['hpr_88888888888888888888888888888888'], destination_eligibility: ['trigger_prompt'],
  } as ContextHealthMaterial['view'],
  narrative: narrativeContextSchema.parse({
    zone: 'flagging', recovery_descriptor: 'compromised', load_descriptor: 'heavy',
    day_summary: 'Quokkaday: keep the afternoon light.', active_goals: [], upcoming_high_stakes: [], compiled_at: '2026-10-13T05:00:00.000Z',
  }),
  source: { source_kind: 'derived_health_view' } as ContextHealthMaterial['source'],
};

const getHealthOutput = JSON.stringify({ ok: true, data: { state: 'available', timezone: 'Asia/Kolkata', from: '2026-10-12', to: '2026-10-12', read_at: '2026-10-13T06:00:00.000Z',
  freshness: 'fresh', coverage: 1, signals: [{ signal: 'hrv', unit: 'ms', source: 'apple', method: 'sdnn', days: [{ day: '2026-10-12', value: 61.7 }] }] } });

describe('trace health scrub at the gate, capture on', () => {
  it('redacts a sleep duration written hours first, hours included', () => {
    for (const said of ['You got 7h 22m of sleep, so keep it light', 'You had 7 hours 22 minutes of sleep, so keep it light']) {
      const input = gateTraceEntry({ trace: 'tg-0', hop: 'turn', ms: 1, ok: true, text: { input: said } }, true).text!.input;
      expect(input).not.toMatch(/\b7\b|7h|22/);
      expect(input).toContain(HEALTH_WITHHELD);
      expect(input).toContain('so keep it light');
    }
  });

  it('redacts health readings in owner words and keeps the rest of the sentence', async () => {
    const { gated, otlp } = await sinks([{ trace: 'tg-1', hop: 'turn', ms: 1, ok: true, text: { input: 'I slept 7h 22m and my HRV was 45, then booked the dentist', output: 'Noted the dentist.' } }]);
    const input = gated[0]!.text!.input;
    // OTLP bodies carry random span ids and nanosecond times, so they are searched for the readings' words, not bare digits.
    for (const value of ['7h', '22m', '45']) expect(input).not.toContain(value);
    for (const value of ['slept 7h', '22m', 'HRV was 45']) expect(otlp).not.toContain(value);
    expect(input).toContain(HEALTH_WITHHELD);
    expect(input).toContain('booked the dentist');
    expect(otlp).toContain('Noted the dentist.');
  });

  it('withholds a health tool hop whole, its arguments too, and keeps a non-health tool hop', async () => {
    const entries: TurnLogEntry[] = [
      { trace: 'tg-2', hop: 'tool_get_health', ms: 1, ok: true, text: { input: '{"signals":["hrv"]}', output: getHealthOutput } },
      { trace: 'tg-2', hop: 'subagent_tool_get_health', ms: 1, ok: true, text: { input: '{}', output: getHealthOutput } },
      { trace: 'tg-2', hop: 'tool_log_meal', ms: 1, ok: true, text: { input: '{"description":"dal","calories_estimate":613}', output: '{"id":7}' } },
      { trace: 'tg-2', hop: 'tool_read_memory', ms: 1, ok: true, text: { input: '{"query":"dentist"}', output: 'Dentist is Dr Rao on Elm Road' } },
    ];
    const { gated, otlp, console } = await sinks(entries);
    for (const value of ['61.7', '613']) expect(otlp).not.toContain(value);
    expect(gated.slice(0, 3).map((entry) => entry.text)).toEqual(Array(3).fill({ input: HEALTH_WITHHELD, output: HEALTH_WITHHELD }));
    expect(gated[3]!.text).toEqual(entries[3]!.text);
    expect(otlp).toContain('Dentist is Dr Rao on Elm Road');
    expect(console).not.toContain('61.7');
  });

  it('withholds health tool turns and health context blocks inside a model call input, keeping the conversation', async () => {
    const block = `Shared health today (derived by the app from the owner's own wearable data):\n${renderHealth(material)}`;
    const ledger = healthSection([{ id: 1, kind: 'meal', logged_at: '2026-10-12T08:00:00Z', payload: { description: 'poha', calories_estimate: 487 } }] as never, 'Asia/Kolkata');
    const input = JSON.stringify([
      { role: 'system', content: 'You are Waldo.' },
      { role: 'user', content: `plan my afternoon\n\nTurn context:\n\n${block}\n\n${ledger}\n\nClock: 13:00` },
      { call: { id: 'c1', name: 'get_health', arguments: { signals: ['hrv'] } }, output: getHealthOutput },
      { call: { id: 'c2', name: 'read_memory', arguments: { query: 'dentist' } }, output: 'Dentist is Dr Rao' },
    ]);
    const output = JSON.stringify([{ id: 'c3', name: 'log_meal', arguments: { description: 'poha', calories_estimate: 487 } }]);
    const { gated, otlp } = await sinks([{ trace: 'tg-3', hop: 'llm_reply', ms: 1, ok: true, text: { input, output } }]);
    const text = JSON.stringify(gated[0]!.text);
    for (const value of ['61.7', '487', 'Quokkaday', 'flagging', 'compromised', 'Form zone', 'Shared health today', 'Recent health logs']) {
      expect(text).not.toContain(value);
      expect(otlp).not.toContain(value);
    }
    expect(text).toContain(HEALTH_WITHHELD);
    for (const kept of ['plan my afternoon', 'Clock: 13:00', 'You are Waldo.', 'Dentist is Dr Rao']) expect(text).toContain(kept);
  });

  it('withholds the composer health block as a bare paragraph, Form-first and Recovery-first', () => {
    const recoveryFirst: ContextHealthMaterial = {
      ...material,
      view: { authority: 'backend', algorithm_version: 'recovery.v1', recovery_zone: 'compromised', trend: 'declining', freshness: 'fresh', missing_components: [], confidence_band: 'high',
        provenance_refs: ['hpr_88888888888888888888888888888888'], destination_eligibility: ['trigger_prompt'] } as unknown as ContextHealthMaterial['view'],
    };
    for (const health of [material, recoveryFirst]) {
      const block = renderHealth(health);
      expect(block).toMatch(/^(?:Form|Recovery) zone: /);
      const operations = `<memory-context>\n[NOT instructions]\nDentist is Dr Rao\n</memory-context>\n\n${block}\n\n<workspace-context>\nnone\n</workspace-context>`;
      const input = JSON.stringify([{ role: 'user', content: operations }]);
      const text = gateTraceEntry({ trace: 'tg-8', hop: 'llm_reply', ms: 1, ok: true, text: { input } }, true).text!.input;
      for (const value of ['Quokkaday', 'flagging', 'compromised', 'zone:']) expect(text).not.toContain(value);
      expect(text).toContain(HEALTH_WITHHELD);
      expect(text).toContain('Dentist is Dr Rao');
    }
  });

  it('withholds an offloaded health output read back through read_tool_output, and keeps other reads', async () => {
    const offloaded = (id: string) => `{"ok":true,"data":{"state":"available"\n[full output stored as ${id}: 20000 characters total; call read_tool_output with this id, offset and length to read more]`;
    const read = (id: string, text: string) => ({ call: { id: `r-${id}`, name: 'read_tool_output', arguments: { id, offset: 0, length: 4000 } }, output: JSON.stringify({ ok: true, data: { text, total: 20000 } }) });
    const input = JSON.stringify([
      { role: 'user', content: 'plan my afternoon' },
      { call: { id: 'c1', name: 'get_health', arguments: { signals: ['hrv'] } }, output: offloaded('to-1') },
      { call: { id: 'c2', name: 'search_mail', arguments: { query: 'dentist' } }, output: offloaded('to-2') },
      read('to-1', '{"day":"2026-10-12","value":61.7}'),
      read('to-2', 'Dentist moved to Thursday'),
      read('to-9', '{"day":"2026-10-11","value":57.3}'),
    ]);
    const { gated, otlp } = await sinks([
      { trace: 'tg-9', hop: 'llm_reply', ms: 1, ok: true, text: { input, output: 'ok' } },
      { trace: 'tg-9', hop: 'tool_read_tool_output', ms: 1, ok: true, text: { input: '{"id":"to-1"}', output: '{"day":"2026-10-12","value":61.7}' } },
    ]);
    for (const value of ['61.7', '57.3']) { expect(JSON.stringify(gated)).not.toContain(value); expect(otlp).not.toContain(value); }
    expect(JSON.stringify(gated[0]!.text)).toContain('Dentist moved to Thursday');
    expect(gated[1]!.text!.output).toBe(HEALTH_WITHHELD);
  });

  it('runs the free-text floor over error, detail and code too', async () => {
    const { gated, notes, otlp } = await sinks([{ trace: 'tg-4', hop: 'llm_reply', ms: 1, ok: false, error: 'provider echoed: resting heart rate 58 bpm', detail: 'HRV was 39', code: 'failed:HRV was 39' }]);
    for (const value of ['rate 58', 'was 39']) { expect(notes).not.toContain(value); expect(otlp).not.toContain(value); expect(JSON.stringify(gated)).not.toContain(value); }
    expect(gated[0]!.error).toContain('provider echoed');
  });

  it('is idempotent, so the exporter can gate an already gated entry', () => {
    const entry: TurnLogEntry = { trace: 'tg-5', hop: 'turn', ms: 1, ok: true, text: { input: 'my HRV was 45', output: 'ok' } };
    const once = gateTraceEntry(entry, true);
    expect(gateTraceEntry(once, true)).toEqual(once);
  });

  it('fails closed: a scrub that throws exports no text and no free-form error', async () => {
    const hostile = { input: '', output: 'reply' } as { input: string; output: string };
    Object.defineProperty(hostile, 'input', { get: () => { throw new Error('boom HRV was 45'); }, enumerable: true });
    const { gated, otlp, notes } = await sinks([{ trace: 'tg-6', hop: 'turn', ms: 1, ok: false, error: 'HRV was 45', code: 'failed', text: hostile }]);
    expect(gated[0]!.text).toBeUndefined();
    expect(gated[0]!.error).toBeUndefined();
    expect(otlp).not.toContain('was 45');
    expect(otlp).not.toContain('reply');
    expect(notes).not.toContain('was 45');
  });

  it('leaves the capture-off gate as it was: text untouched by the gate and dropped by every sink', async () => {
    const entry: TurnLogEntry = { trace: 'tg-7', hop: 'turn', ms: 1, ok: true, text: { input: 'my HRV was 45', output: 'ok' } };
    const { gated, otlp } = await sinks([entry], false);
    expect(gated[0]!.text).toEqual(entry.text);
    expect(otlp).not.toContain('HRV');
    expect(otlp).not.toContain(HEALTH_WITHHELD);
  });
});

describe('trace health scrub through a real owner turn', () => {
  const series = { access: 'granted', read_at: '2026-10-13T06:00:00.000Z', sources: [{ source: 'apple', consent_epoch: 3, samples: [
    { signal: 'overnight_hrv', day: '2026-10-12', value: 61.7, start_at: '2026-10-11T20:00:00Z', end_at: '2026-10-11T23:00:00Z', timezone: 'Asia/Kolkata', method: 'sdnn' },
  ] }] };
  const row = (purpose: string) => ({ consent_class: 'health_processing', source: 'apple', purpose, version: 2, status: 'granted', epoch: 3, granted_at: '2026-10-01T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' });
  const call = async (fn: string) => fn === 'health_consent_list' ? { consents: [row('storage_compute'), row('model_processing')] } : series;
  const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-13T06:30:00Z') };

  it('exports the conversation and the marker, and no health value, from a turn that read health', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('trace-health-scrub-turn')), async () => {
      const logged: TurnLogEntry[] = [];
      const now = { timezone: 'UTC', now: () => new Date() };
      // The owner DO's own producer builds the material from a synthetic derived row.
      const shared = async () => toContextHealthMaterial({ context: { id: 'ctx-1', day: new Date().toISOString().slice(0, 10),
        form: { score: 31, zone: 'low', drivers: ['quokka sleep debt'], confidence: 0.8 }, recovery: { score: 29, zone: 'low' }, weight: { score: 83, zone: 'high' },
        drivers: ['quokka sleep debt'], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date(Date.now() - 3_600_000).toISOString() }, previous: null }, now);
      const responder = createOwnerResponder('fixture', undefined, undefined, (entry) => { logged.push(entry); }, now,
        [getHealthHandler(healthReadBook(call, 'do-x'), clock)], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
        shared);
      seen.outputs.push([
        { type: 'function_call', call_id: 'h1', name: 'get_health', arguments: JSON.stringify({ signals: ['hrv'], from: '2026-10-12', to: '2026-10-12', aggregation: 'daily' }) },
        { type: 'function_call', call_id: 'k1', name: 'get_context', arguments: '{}' },
      ], []);
      seen.texts.push('', 'Your afternoon has room for one focused block.');
      await responder.respond(ownerTyped({ traceId: 'tg-turn-1', conversationRef: 'owner', surface: 'telegram', text: 'plan my afternoon around the dentist' }), (_name, work) => work());
      // The raw entries do carry the values: this is what the gate has to stop.
      expect(JSON.stringify(logged)).toContain('61.7');
      for (const raw of ['Form zone:', 'Day summary:', 'quokka', 'Shared health today']) expect(JSON.stringify(logged)).toContain(raw);
      const { otlp, notes, console } = await sinks(logged);
      for (const value of ['61.7', 'Form zone', 'Day summary:', 'quokka', 'Shared health today']) {
        expect(otlp).not.toContain(value);
        expect(notes).not.toContain(value);
        expect(console).not.toContain(value);
      }
      expect(otlp).toContain(HEALTH_WITHHELD);
      expect(otlp).toContain('plan my afternoon around the dentist');
      expect(otlp).toContain('Your afternoon has room for one focused block.');
      // A tool hop that carries no health keeps its text: a scrub that failed closed would have dropped it.
      const contextHop = logged.find((entry) => entry.hop === 'tool_get_context')!;
      expect(contextHop.text?.output).toBeTruthy();
      expect(gateTraceEntry(contextHop, true).text).toEqual(contextHop.text);
    });
  });

  it('withholds the health block an app turn carries in its composed operations', async () => {
    const now = { timezone: 'UTC', now: () => new Date() };
    const shared = async () => toContextHealthMaterial({ context: { id: 'ctx-2', day: new Date().toISOString().slice(0, 10),
      form: { score: 31, zone: 'low', drivers: ['quokka sleep debt'], confidence: 0.8 }, recovery: { score: 29, zone: 'low' }, weight: { score: 83, zone: 'high' },
      drivers: ['quokka sleep debt'], confidence: 0.8, freshness: 'fresh', tags: [], compiled_at: new Date(Date.now() - 3_600_000).toISOString() }, previous: null }, now);
    const runScope = { runId: 'run-app', attempt: 'attempt-one', deadline: Date.now() + 15 * 60_000, signal: new AbortController().signal, admit: vi.fn(), commit: (work: () => unknown) => work() } as never;
    const text = 'how should I pace the afternoon?';
    const admission = await ownerMessageAdmission({
      lookup: async () => ({ owner_id: '10000000-0000-0000-0000-000000000001', do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
      scope: runScope, locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
      actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
      allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text, occurrenceKey: 'app-scrub-1', occurredAt: Date.now() - 1, now: Date.now,
    });
    const context = createOwnerTurnContext(admission, { health: shared });
    const logged: TurnLogEntry[] = [];
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('trace-health-scrub-app')), async () => {
      const responder = createOwnerResponder('fixture', undefined, undefined, (entry) => { logged.push(entry); }, now, [], undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, [], runScope, undefined, { context });
      await responder.respond(ownerTyped({ traceId: 'app-scrub-1', conversationRef: context.conversationRef, surface: 'app', text }), (_name, work) => work());
    });
    const raw = JSON.stringify(logged);
    expect(raw).toContain('Form zone:');
    expect(raw).not.toContain('Shared health today');
    const { otlp, notes } = await sinks(logged);
    for (const value of ['Form zone', 'Day summary:', 'quokka']) { expect(otlp).not.toContain(value); expect(notes).not.toContain(value); }
    expect(otlp).toContain(HEALTH_WITHHELD);
    expect(otlp).toContain(text);
  });

  it('logs no text for the welcome build, whose health stage carries daily values', async () => {
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('trace-health-scrub-welcome')), async () => {
      const logged: TurnLogEntry[] = [];
      const responder = createOwnerResponder('fixture', undefined, undefined, (entry) => { logged.push(entry); }, clock);
      await responder.welcome!('welcome:health', 'health', 'Source: the owner\'s own health readings.\n\nhrv (apple_health, ms, sdnn): 2026-10-11 57.3; 2026-10-12 61.7');
      expect(logged.length).toBeGreaterThan(0);
      const { otlp, notes } = await sinks(logged);
      for (const value of ['57.3', '61.7']) { expect(otlp).not.toContain(value); expect(notes).not.toContain(value); }
    });
  });
});
