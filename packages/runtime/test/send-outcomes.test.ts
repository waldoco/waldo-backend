import { describe, expect, it } from 'vitest';
import { recordAppSend, recordSendEnded, sendsToday, sendsTodaySection, waldoFirst, type SendsDeps } from '../src/channels/send-outcomes';
import type { FinalRecord } from '../src/channels/telegram-final-outbox';

const kvOf = () => {
  const map = new Map<string, unknown>();
  return { map, kv: {
    get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, structuredClone(value)); },
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { prefix: string }) => [...map.entries()].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)) as [string, T][],
  } };
};
// 2026-11-27 09:00 in London (UTC in winter); fictional, synthetic records only.
const NINE = Date.parse('2026-11-27T09:00:00Z');
const record = (extra: Partial<FinalRecord> = {}): FinalRecord => ({
  id: 'r1', trace: 't', payload: { chat_id: 1, text: 'synthetic' }, digest: 'd', ownerSubject: '1', doName: 'owner',
  status: 'pending', dueAt: 0, createdAt: NINE, attempts: 0, ...extra,
});
const deps = (kv: SendsDeps['kv'], extra: Partial<SendsDeps> = {}): SendsDeps => ({ kv, records: [], windowOpen: true, knock: null, timezone: 'Europe/London', now: NINE + 3_600_000, ...extra });

describe('every Waldo-first send ends with one recorded outcome', () => {
  it('a reply inside the owner\'s turn and a reaction are not Waldo-first; a card, a reminder and a task report are', () => {
    expect(waldoFirst(record({ inbox: { id: 'i', runId: 'r', attempt: 'a' } }))).toBe(false);
    expect(waldoFirst(record({ reaction: { message_id: 1, emoji: '👍' } }))).toBe(false);
    expect(waldoFirst(record({ dayCard: { day: '2026-11-27', card: 'card:brief', foldUpTo: 0 } }))).toBe(true);
    expect(waldoFirst(record({ reminder: { id: 'm', occurrence: 0, runId: 'r', schedulerRunId: null, once: true } }))).toBe(true);
    expect(waldoFirst(record({ answersOwner: true }))).toBe(true);
  });

  it('records delivered, failed with its reason code, and unknown; a replayed ending writes once', () => {
    const { kv, map } = kvOf();
    recordSendEnded(kv, record({ id: 'card', status: 'delivered', deliveredAt: NINE + 60_000, dayCard: { day: '2026-11-27', card: 'card:brief', foldUpTo: 0 } }), 'app', NINE + 60_000);
    recordSendEnded(kv, record({ id: 'copy', status: 'blocked', reason: 'whatsapp_payment_required' }), 'whatsapp', NINE + 120_000);
    recordSendEnded(kv, record({ id: 'rem', status: 'quarantined', reason: 'send_unknown', reminder: { id: 'm', occurrence: 0, runId: 'r', schedulerRunId: null, once: true } }), 'telegram', NINE + 180_000);
    recordSendEnded(kv, record({ id: 'copy', status: 'blocked', reason: 'whatsapp_payment_required' }), 'whatsapp', NINE + 240_000);
    expect(map.size).toBe(3);
    expect(sendsToday(deps(kv)).map(({ id, outcome, code }) => ({ id, outcome, code }))).toEqual([
      { id: 'card', outcome: 'delivered', code: undefined }, { id: 'copy', outcome: 'failed', code: 'whatsapp_payment_required' }, { id: 'rem', outcome: 'unknown', code: 'send_unknown' },
    ]);
  });

  it('records nothing for a record still under way or a turn\'s own reply, and never keeps message text', () => {
    const { kv, map } = kvOf();
    for (const status of ['pending', 'attempting', 'accepted'] as const) recordSendEnded(kv, record({ status }), 'whatsapp', NINE);
    recordSendEnded(kv, record({ status: 'delivered', inbox: { id: 'i', runId: 'r', attempt: 'a' } }), 'telegram', NINE);
    expect(map.size).toBe(0);
    recordSendEnded(kv, record({ status: 'blocked', reason: 'provider_failed', payload: { chat_id: 1, text: 'Your synthetic reading was 42' } }), 'whatsapp', NINE);
    expect(JSON.stringify([...map.values()])).not.toContain('42');
  });

  it('two sends at once each keep their own row', () => {
    const { kv } = kvOf();
    recordAppSend(kv, 'app-a', 'message', NINE);
    recordAppSend(kv, 'app-b', 'day_card', NINE);
    expect(sendsToday(deps(kv)).map(row => row.id).sort()).toEqual(['app-a', 'app-b']);
  });

  it('a send still waiting reads as waiting, naming the closed window and the knock that failed, until it ends', () => {
    const { kv } = kvOf();
    const waiting = record({ id: 'whatsapp-copy:row1', dayCard: undefined });
    const knock = { reason: 'whatsapp_payment_required' as const, at: NINE };
    expect(sendsToday(deps(kv, { records: [waiting], windowOpen: false, knock }))).toEqual([
      { id: 'whatsapp-copy:row1', kind: 'whatsapp_copy', surface: 'whatsapp', at: NINE, outcome: 'waiting', code: 'window_closed:knock_failed:whatsapp_payment_required' },
    ]);
    recordSendEnded(kv, { ...waiting, status: 'blocked', reason: 'superseded' }, 'whatsapp', NINE + 60_000);
    expect(sendsToday(deps(kv, { records: [{ ...waiting, status: 'blocked', reason: 'superseded' }], windowOpen: false, knock }))).toMatchObject([{ outcome: 'failed', code: 'superseded' }]);
  });

  it('reads the owner\'s own day: yesterday\'s sends drop out at their midnight, and rows older than two days are let go', () => {
    const { kv, map } = kvOf();
    const lateYesterday = Date.parse('2026-11-26T23:30:00Z');
    recordAppSend(kv, 'late', 'message', lateYesterday);
    recordAppSend(kv, 'early', 'message', Date.parse('2026-11-27T00:30:00Z'));
    expect(sendsToday(deps(kv, { now: Date.parse('2026-11-27T00:45:00Z') })).map(row => row.id)).toEqual(['early']);
    // In New York the same instants are both on the 26th.
    expect(sendsToday(deps(kv, { now: Date.parse('2026-11-27T00:45:00Z'), timezone: 'America/New_York' })).map(row => row.id)).toEqual(['late', 'early']);
    recordAppSend(kv, 'later', 'message', lateYesterday + 48.5 * 3_600_000);
    expect([...map.keys()].sort()).toEqual(['send_outcome:early', 'send_outcome:later']);
  });

  it('a record or row without a usable time is left out, never thrown: the section must not take down the view or the turn that reads it', () => {
    const { kv } = kvOf();
    kv.put('send_outcome:broken', { id: 'broken', kind: 'message', surface: 'app', outcome: 'delivered' });
    recordAppSend(kv, 'good', 'message', NINE);
    const records = [{ id: 'odd', status: 'pending' } as unknown as FinalRecord];
    expect(() => sendsTodaySection(deps(kv, { records }))).not.toThrow();
    expect(sendsToday(deps(kv, { records })).map(row => row.id)).toEqual(['good']);
  });

  it('marks an answer to what the owner asked, so the model never takes it for something Waldo sent unasked', () => {
    const { kv } = kvOf();
    recordSendEnded(kv, record({ id: 'report', status: 'delivered', answersOwner: true }), 'app', NINE);
    recordAppSend(kv, 'connected', 'answer', NINE + 60_000);
    recordAppSend(kv, 'nudge', 'message', NINE + 120_000);
    const section = sendsTodaySection(deps(kv));
    expect(section).toContain('- 09:00 answer to what the owner asked, to the app: delivered');
    expect(section).toContain('- 09:01 answer to what the owner asked, to the app: delivered');
    expect(section).toContain('- 09:02 message to the app: delivered');
  });

  it('records the provider\'s own reason for a failure when it gave one, and the record\'s reason otherwise', () => {
    const { kv } = kvOf();
    recordSendEnded(kv, record({ id: 'a', status: 'blocked', reason: 'provider_failed', failure: 'whatsapp_payment_required' }), 'whatsapp', NINE);
    recordSendEnded(kv, record({ id: 'b', status: 'blocked', reason: 'provider_failed' }), 'whatsapp', NINE);
    expect(sendsToday(deps(kv)).map(row => row.code)).toEqual(['whatsapp_payment_required', 'provider_failed']);
  });

  it('a stored row of the wrong shape is left out', () => {
    const { kv } = kvOf();
    kv.put('send_outcome:x', { id: 7, kind: null, at: NINE, outcome: 'delivered' });
    kv.put('send_outcome:y', { id: 'y', kind: 'message', at: NINE, outcome: 'sent' });
    recordAppSend(kv, 'good', 'message', NINE);
    expect(() => sendsTodaySection(deps(kv))).not.toThrow();
    expect(sendsToday(deps(kv)).map(row => row.id)).toEqual(['good']);
  });

  it('says, for each delivered send, whether the owner has written since, so the model can judge what landed and what met silence', () => {
    const { kv } = kvOf();
    recordAppSend(kv, 'brief', 'day_card', NINE);
    recordAppSend(kv, 'nudge', 'message', NINE + 30 * 60_000);
    recordSendEnded(kv, record({ id: 'copy:1', status: 'blocked', reason: 'provider_failed' }), 'whatsapp', NINE);
    const section = sendsTodaySection(deps(kv, { spokeSince: at => at < NINE + 15 * 60_000 }));
    expect(section).toContain('- 09:00 day card to the app: delivered; the owner has written since');
    expect(section).toContain('- 09:30 message to the app: delivered; no word from the owner since');
    expect(section).toContain('- 09:00 message to WhatsApp: failed (provider_failed)\n');
  });

  it('gives the next run one section of kinds, times, surfaces and outcomes, and none on a day with no sends', () => {
    const { kv } = kvOf();
    expect(sendsTodaySection(deps(kv))).toBe('');
    recordSendEnded(kv, record({ id: 'card', status: 'delivered', dayCard: { day: '2026-11-27', card: 'card:brief', foldUpTo: 0 } }), 'app', NINE);
    recordSendEnded(kv, record({ id: 'copy:1', status: 'quarantined', reason: 'delivery_unconfirmed' }), 'whatsapp', NINE);
    expect(sendsTodaySection(deps(kv))).toBe([
      'Messages Waldo sent first today (not replies), oldest first, and what became of each. An answer to what the owner asked is marked; the rest Waldo sent unasked:',
      '- 09:00 day card to the app: delivered',
      '- 09:00 message to WhatsApp: unknown, it may not have arrived (delivery_unconfirmed)',
    ].join('\n'));
  });
});
