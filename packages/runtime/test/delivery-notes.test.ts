import { describe, expect, it } from 'vitest';
import { forgetDeliveryNotes, noteUndelivered, takeDeliveryNotes } from '../src/channels/delivery-notes';
import { recordSurface } from '../src/channels/proactive-surface';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';

const store = () => {
  const map = new Map<string, unknown>();
  return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); },
    delete: (key: string) => map.delete(key), list: <T>({ prefix }: { prefix: string }) => [...map].filter(([key]) => key.startsWith(prefix)) as [string, T][] };
};
const AT = Date.parse('2026-11-20T09:00:00Z');
const ended = (extra: Partial<FinalRecord>): FinalRecord => ({ id: 'r', trace: 't', payload: { chat_id: 1, text: 'Your 3pm moved to 4pm.' }, digest: 'd', ownerSubject: '1',
  doName: 'o', status: 'blocked', dueAt: 0, createdAt: AT, attempts: 1, ...extra });

describe('a send that did not reach the owner is a fact for the next turn', () => {
  it('names what it was, where it went, why and what it said; the next turn takes it once', () => {
    const kv = store();
    noteUndelivered(kv, ended({ reason: 'provider_failed', update: { recordId: 1 } }), 'whatsapp', 'UTC', AT + 60_000);
    const [line, ...rest] = takeDeliveryNotes(kv, AT + 120_000);
    expect(rest).toEqual([]);
    expect(line).toContain('update');
    expect(line).toContain('WhatsApp');
    expect(line).toContain('did not reach the owner');
    expect(line).toContain('Your 3pm moved to 4pm.');
    expect(line).toContain('2026-11-20 09:00');
    expect(takeDeliveryNotes(kv, AT + 180_000)).toEqual([]);
  });

  it('names the surface the record itself went to, not the one whose pass settled it, and none when that cannot be told', () => {
    expect(recordSurface(ended({ id: 'whatsapp-copy:row-1' }), undefined, 'app')).toBe('whatsapp');
    expect(recordSurface(ended({ ownerSubject: '15550001111' }), '15550001111', 'app')).toBe('whatsapp');
    expect(recordSurface(ended({}), '15550001111', 'app')).toBe('app');
    expect(recordSurface(ended({}), '15550001111', 'whatsapp')).toBeNull();
    const kv = store();
    noteUndelivered(kv, ended({ reason: 'provider_failed' }), null, 'UTC', AT);
    const [line] = takeDeliveryNotes(kv, AT);
    expect(line).toMatch(/^\[Delivery: your message, written 2026-11-20 09:00, did not reach the owner/);
  });

  it('says an unconfirmed send may not have arrived, never that it failed', () => {
    const kv = store();
    noteUndelivered(kv, ended({ status: 'quarantined', reason: 'delivery_unconfirmed' }), 'whatsapp', 'UTC', AT);
    const [line] = takeDeliveryNotes(kv, AT);
    expect(line).toContain('may not have reached the owner');
    expect(line).not.toContain('did not reach');
  });

  it('notes nothing for a record that arrived, still waits, was replaced, or the owner forgot', () => {
    const kv = store();
    for (const record of [ended({ status: 'delivered' }), ended({ status: 'pending', reason: 'window_refused' }), ended({ status: 'accepted' }),
      ended({ reason: 'superseded' }), ended({ reason: 'owner_forget' }), ended({ reason: 'surface_held' })]) noteUndelivered(kv, record, 'app', 'UTC', AT);
    expect(takeDeliveryNotes(kv, AT)).toEqual([]);
  });

  it('masks health-shaped numbers and secret links, and keeps only the newest few', () => {
    const kv = store();
    noteUndelivered(kv, ended({ reason: 'expired', payload: { chat_id: 1, text: 'HRV 42 ms; link https://x.example/cb?code=s3cret' } }), 'telegram', 'UTC', AT);
    const [line] = takeDeliveryNotes(kv, AT);
    expect(line).not.toContain('42');
    expect(line).not.toContain('s3cret');
    for (let index = 0; index < 30; index += 1) noteUndelivered(kv, ended({ id: `r${index}`, reason: 'expired' }), 'app', 'UTC', AT + index);
    expect(takeDeliveryNotes(kv, AT + 60).length).toBe(10);
  });

  it('a note older than a week is dropped, and owner forget reaches a waiting note', () => {
    const kv = store();
    noteUndelivered(kv, ended({ id: 'old', reason: 'expired' }), 'app', 'UTC', AT);
    expect(takeDeliveryNotes(kv, AT + 8 * 86_400_000)).toEqual([]);
    noteUndelivered(kv, ended({ id: 'f', reason: 'expired', payload: { chat_id: 1, text: 'about the harbour fund' } }), 'app', 'UTC', AT);
    expect(forgetDeliveryNotes(kv, ['harbour fund'])).toEqual({ rewritten: 1, remaining: 0 });
    expect(takeDeliveryNotes(kv, AT)).toEqual([]);
  });
});
