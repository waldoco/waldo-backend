import { describe, expect, it } from 'vitest';
import { COPIES_WAITING_MAX, copySupersedes, supersededBy, WHATSAPP_COPY_PREFIX } from '../src/channels/proactive-surface';
import { TelegramFinalOutbox, type FinalRecord } from '../src/channels/telegram-final-outbox';

const kv = () => { const map = new Map<string, unknown>(); return { get: <T>(key: string) => map.get(key) as T | undefined, put: (key: string, value: unknown) => { map.set(key, value); } }; };
type Input = Parameters<TelegramFinalOutbox['enqueue']>[0];
const input = (id: string, extra: Partial<Input> = {}): Input => ({ id, trace: id, payload: { chat_id: 7, text: `synthetic ${id}` }, ownerSubject: '7', doName: 'owner', ...extra });
const waiting = (id: string, extra: Partial<FinalRecord> = {}): FinalRecord => ({ ...input(id), digest: 'd', status: 'pending', dueAt: 0, createdAt: 0, attempts: 0, ...extra });
const card = (day: string, which: 'card:brief' | 'card:midday' | 'card:close') => ({ dayCard: { day, card: which, foldUpTo: 0 } });

describe('a waiting message ends only when a newer one supersedes it', () => {
  it('a day card supersedes earlier day cards and the day updates still waiting', () => {
    const next = supersededBy(input('day-card:2026-11-20:card:close', card('2026-11-20', 'card:close')));
    expect(next(waiting('day-card:2026-11-20:card:midday', card('2026-11-20', 'card:midday')))).toBe(true);
    expect(next(waiting('day-card:2026-11-19:card:close', card('2026-11-19', 'card:close')))).toBe(true);
    expect(next(waiting('update:3', { update: { recordId: 3 } }))).toBe(true);
    expect(next(waiting('intervention:9'))).toBe(true);
    expect(next(waiting('brief-body:2026-11-20', { revision: { day: '2026-11-20', card: 'card:brief' } }))).toBe(true);
  });

  it('a day update supersedes earlier day updates but never a day card or an in-place edit', () => {
    const next = supersededBy(input('update:4', { update: { recordId: 4 } }));
    expect(next(waiting('update:3', { update: { recordId: 3 } }))).toBe(true);
    expect(next(waiting('intervention:9'))).toBe(true);
    expect(next(waiting('day-card:2026-11-20:card:midday', card('2026-11-20', 'card:midday')))).toBe(false);
    expect(next(waiting('update:2', { update: { recordId: 2 }, revision: { day: '2026-11-20', card: 'card:brief' }, inPlace: true }))).toBe(false);
    expect(supersededBy(input('intervention:10'))(waiting('update:3', { update: { recordId: 3 } }))).toBe(true);
  });

  it('a copy supersedes a copy only as the message it copies would; a notice supersedes the same notice', () => {
    const copy = (id: string, copyOf?: 'day_card' | 'day_update') => input(`${WHATSAPP_COPY_PREFIX}${id}`, copyOf ? { copyOf } : {});
    const parked = (id: string, copyOf?: 'day_card' | 'day_update') => waiting(`${WHATSAPP_COPY_PREFIX}${id}`, copyOf ? { copyOf } : {});
    expect(supersededBy(copy('b', 'day_card'))(parked('a', 'day_card'))).toBe(true);
    expect(supersededBy(copy('b', 'day_card'))(parked('a', 'day_update'))).toBe(true);
    expect(supersededBy(copy('b', 'day_update'))(parked('a', 'day_update'))).toBe(true);
    expect(supersededBy(copy('b', 'day_update'))(parked('a', 'day_card'))).toBe(false);
    expect(supersededBy(copy('b', 'day_card'))(parked('a'))).toBe(false);
    expect(supersededBy(copy('b'))(parked('a'))).toBe(false);
    expect(supersededBy(copy('b', 'day_card'))(waiting('update:3', { update: { recordId: 3 } }))).toBe(false);
    expect(supersededBy(input('google-reauth:abcd:2'))(waiting('google-reauth:abcd:1'))).toBe(true);
    expect(supersededBy(input('google-reauth:abcd:2'))(waiting('google-reauth:ef01:1'))).toBe(false);
    expect(supersededBy(input('connect-app:2'))(waiting('connect-app:1'))).toBe(true);
    expect(supersededBy(input('announce:2', { announcement: { ids: ['b'] } }))(waiting('announce:1', { announcement: { ids: ['a'] } }))).toBe(true);
  });

  it('never reaches a record addressed elsewhere, and leaves the rest alone', () => {
    const next = supersededBy(input('update:4', { update: { recordId: 4 } }));
    expect(next(waiting('update:3', { update: { recordId: 3 }, ownerSubject: '8', payload: { chat_id: 8, text: 'synthetic' } }))).toBe(false);
    expect(next(waiting('standing-order:o:1', { standingOrder: { runId: 'r', gate: 'none' as never } }))).toBe(false);
    expect(next(waiting('reminder:1', { reminder: { id: 'r', occurrence: 1, runId: 'x', schedulerRunId: null, once: true } }))).toBe(false);
    expect(supersededBy(input('message:1'))(waiting('message:0'))).toBe(false);
  });
});

describe('copies waiting behind a closed window are bounded', () => {
  it('past the bound the oldest copy is replaced by the newest, whatever it copies', () => {
    const rows = Array.from({ length: COPIES_WAITING_MAX }, (_, index) => waiting(`${WHATSAPP_COPY_PREFIX}${index}`, { createdAt: index }));
    const replaces = copySupersedes(input(`${WHATSAPP_COPY_PREFIX}new`), rows);
    expect(rows.filter(replaces).map(row => row.id)).toEqual([`${WHATSAPP_COPY_PREFIX}0`]);
    expect(rows.slice(1).filter(copySupersedes(input(`${WHATSAPP_COPY_PREFIX}new`), rows.slice(1)))).toEqual([]);
  });
});

describe('the fenced enqueue supersedes in the same commit', () => {
  it('ends an unsent waiting record superseded and leaves one the provider took', async () => {
    const store = kv(), outbox = new TelegramFinalOutbox(store, () => 1_000);
    await outbox.enqueue(input('update:1', { update: { recordId: 1 } }));
    await outbox.enqueue(input('update:2', { update: { recordId: 2 } }));
    const rows = outbox.records();
    rows[1]!.providerMessageIds = ['wamid.x']; store.put('telegram_final_outbox_v1', rows);
    await outbox.enqueueFenced(input('update:3', { update: { recordId: 3 } }), work => work(), supersededBy(input('update:3', { update: { recordId: 3 } })));
    expect(outbox.records().map(row => [row.id, row.status, row.reason ?? null])).toEqual([
      ['update:1', 'blocked', 'superseded'], ['update:2', 'pending', null], ['update:3', 'pending', null]]);
  });
});
