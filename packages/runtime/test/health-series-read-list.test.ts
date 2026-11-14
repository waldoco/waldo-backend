import { describe, expect, it } from 'vitest';
import { md5Hex } from '../src/channels/md5';
import { healthStage } from '../src/onboarding/welcome-sources';
import { healthReadBook, SIGNALS } from '../src/tools/live/health';

// The welcome health stage once asked health_series_read for every get_health signal by its stored name, repeats included
// (sleep and its four stages all read sleep_duration). The RPC refuses a list longer than its known signals before it removes
// repeats, so the stage settled as unavailable for every owner with health consent. These tests go through the real
// healthReadBook against a fake plane that applies the RPC's own list rules, read from the migration that defines it.

// Vite replaces a literal import.meta.glob call at build time; this package carries no vite client types, hence the directive.
// @ts-expect-error import.meta.glob is provided by vite at test time
const migrations: Record<string, string> = import.meta.glob('../../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true });
// The newest migration that (re)defines waldo.health_series_read holds the list the live RPC checks against.
const definition = Object.entries(migrations).filter(([, sql]) => /create or replace function waldo\.health_series_read\(/.test(sql)).sort(([a], [b]) => a.localeCompare(b)).at(-1)?.[1] ?? '';
const rpcBody = definition.slice(definition.indexOf('function waldo.health_series_read('));
const KNOWN = [...(/v_all constant text\[\] := array\[([^\]]+)\]/.exec(rpcBody)?.[1] ?? '').matchAll(/'([a-z_0-9]+)'/g)].map(match => match[1]!);
const PAYLOAD_MAX_BYTES = Number(/octet_length\(p_payload\) > (\d+)/.exec(rpcBody)?.[1] ?? 0);

const NOW = Date.parse('2026-11-06T09:00:00Z');
const consentRows = { consents: [
  { source: 'apple', purpose: 'storage_compute', status: 'granted', epoch: 1 },
  { source: 'apple', purpose: 'model_processing', status: 'granted', epoch: 1 },
] };
const series = { access: 'granted', read_at: '2026-11-06T09:00:00.000Z', sources: [{ source: 'apple', consent_epoch: 1, samples: [
  { signal: 'overnight_hrv', day: '2026-11-05', value: 41, method: 'rmssd', start_at: null, end_at: '2026-11-05T06:00:00.000Z', timezone: 'Asia/Kolkata' },
] }] };

// A plane that answers the way waldo.health_series_read does for the parts that matter here: the payload cap, a list of 1 to
// cardinality(v_all) names checked before repeats are removed, and every name a known one.
const plane = () => {
  const asked: { message: string; payload: string }[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    if (fn === 'health_consent_list') return consentRows;
    if (fn !== 'health_series_read') throw new Error(`unexpected rpc ${fn}`);
    const payload = String(args['p_payload']);
    asked.push({ message, payload });
    if (new TextEncoder().encode(payload).length > PAYLOAD_MAX_BYTES) return { error: 'invalid_request' };
    const signals = (JSON.parse(payload) as { signals?: unknown[] }).signals;
    if (signals !== undefined && (signals.length < 1 || signals.length > KNOWN.length || signals.some(name => typeof name !== 'string' || !KNOWN.includes(name)))) return { error: 'invalid_request' };
    return series;
  };
  return { asked, book: healthReadBook(call, 'do-x') };
};

describe('health_series_read list', () => {
  it('reads the RPC rules from the migration that defines it', () => {
    expect(KNOWN.length).toBeGreaterThanOrEqual(23);
    expect(new Set(KNOWN).size).toBe(KNOWN.length);
    expect(PAYLOAD_MAX_BYTES).toBe(1024);
  });

  it('sends each stored name once, and signs the payload it sends', async () => {
    const { asked, book } = plane();
    await book.series({ from: '2026-11-01', to: '2026-11-06', signals: ['sleep_duration', 'overnight_hrv', 'sleep_duration', 'sleep_duration'] });
    const [sent] = asked;
    expect(JSON.parse(sent!.payload)).toEqual({ from: '2026-11-01', to: '2026-11-06', signals: ['sleep_duration', 'overnight_hrv'] });
    expect(sent!.message).toBe(`health.series_read.do-x.${md5Hex(sent!.payload)}`);
  });

  it('lets the welcome stage read every signal it asks for, so an owner with health consent gets their readings', async () => {
    const { asked, book } = plane();
    const result = await healthStage(book, () => 'Asia/Kolkata', () => NOW, () => true)();
    expect(result.kind).toBe('input');
    if (result.kind !== 'input') return;
    expect(result.text).toContain('hrv (apple_health, ms, rmssd): 2026-11-05 41');
    const signals = (JSON.parse(asked[0]!.payload) as { signals: string[] }).signals;
    expect(signals.length).toBe(new Set(signals).size);
    expect(signals.length).toBeLessThanOrEqual(KNOWN.length);
  });

  it('keeps every stored name get_health and the welcome stage can ask for inside the RPC\'s list', () => {
    // A signal whose stored name the RPC does not know would refuse the whole welcome read, the same way.
    const stored = new Set(Object.values(SIGNALS).map(spec => spec.stored));
    expect([...stored].filter(name => !KNOWN.includes(name))).toEqual([]);
  });
});
