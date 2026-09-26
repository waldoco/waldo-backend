import { describe, expect, it } from 'vitest';
import { waInboxFilter, waInboxMark, waInboxRelease, type WaInboxEntry } from '../src/channels/whatsapp-inbox';

const store = () => {
  const map = new Map<string, unknown>();
  return { map, kv: { get: <T,>(k: string) => map.get(k) as T | undefined, put: (k: string, v: unknown) => void map.set(k, v), delete: (k: string) => void map.delete(k) } };
};

const msg = (id: string | undefined, text = 'hi') => ({ id, from: '15550001111', type: 'text', text: { body: text } });

describe('whatsapp durable inbox dedupe', () => {
  it('first delivery passes, replayed delivery with the same provider id is a no-op', () => {
    const { kv } = store();
    const batch = [msg('wamid.A'), msg('wamid.B')];
    const fresh = waInboxFilter(batch, kv, 900);
    expect(fresh.map((m) => m.id)).toEqual(['wamid.A', 'wamid.B']);
    for (const m of fresh) waInboxMark(kv, m.id!, 1000);
    // full redelivery of the same batch: nothing re-enters the pipeline
    expect(waInboxFilter(batch, kv, 900)).toEqual([]);
  });

  it('a message with no provider id fails closed and is never processed', () => {
    const { kv, map } = store();
    expect(waInboxFilter([msg(undefined), msg('wamid.C')], kv, 900).map((m) => m.id)).toEqual(['wamid.C']);
    // and it leaves no tombstone - no silent identity invented for it
    expect([...map.keys()].some((k) => k.includes('undefined'))).toBe(false);
  });

  it('the claim is atomic: a concurrent duplicate is suppressed before any turn completes', () => {
    const { kv } = store();
    const batch = [msg('wamid.A')];
    expect(waInboxFilter(batch, kv, 900).map((m) => m.id)).toEqual(['wamid.A']);
    // a second delivery racing the first turn (nothing marked yet) sees the claim and is a no-op
    expect(waInboxFilter(batch, kv, 901)).toEqual([]);
  });

  it('partial failure: completed turns tombstone, failed and unattempted claims release, the retry reprocesses exactly those', () => {
    const { kv } = store();
    const batch = [msg('wamid.X'), msg('wamid.Y'), msg('wamid.Z')];
    const fresh = waInboxFilter(batch, kv, 900);
    // turn for X succeeds, Y throws, Z never attempted - the abort releases Y and Z
    waInboxMark(kv, fresh[0]!.id!, 1000);
    waInboxRelease(kv, 'wamid.Y');
    waInboxRelease(kv, 'wamid.Z');
    expect(waInboxFilter(batch, kv, 1001).map((m) => m.id)).toEqual(['wamid.Y', 'wamid.Z']);
    // a processed tombstone is never released
    waInboxRelease(kv, 'wamid.X');
    expect(waInboxFilter([msg('wamid.X')], kv, 1002)).toEqual([]);
  });

  it('tombstone metadata is exactly {received_at, result} - no body, no derived content', () => {
    const { kv, map } = store();
    waInboxMark(kv, 'wamid.M', 1234);
    const entry = map.get('wa_inbox:wamid.M') as WaInboxEntry;
    expect(Object.keys(entry).sort()).toEqual(['received_at', 'result']);
    expect(entry).toEqual({ received_at: 1234, result: 'processed' });
    expect(JSON.stringify(entry)).not.toContain('hi');
  });

  it('out-of-order redelivery of an older message alongside a new one processes only the new one', () => {
    const { kv } = store();
    waInboxMark(kv, 'wamid.old', 1000);
    const fresh = waInboxFilter([msg('wamid.new'), msg('wamid.old')], kv, 900);
    expect(fresh.map((m) => m.id)).toEqual(['wamid.new']);
  });
});
