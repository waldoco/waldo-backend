// The final outbox for a surface that accepts a message first and reports later whether it arrived (WhatsApp). The record
// waits in `accepted` for that report; the outbox, the one writer, applies the reports, retires records whose surface is
// gone, never evicts a record that is still waiting, and says how many wait and since when.
import { describe, expect, it, vi } from 'vitest';
import { dashboardOverview } from '../src/channels/dashboard-overview';
import { EARLY_STATUS_KEY, FINAL_OUTBOX_KEY, MAX_EARLY_STATUSES, TelegramFinalOutbox, observeSurfaceStatuses, outboxRunNotes, redactJobReportEntries, retireSurfaceRecords, unconfirmedCards, type FinalRecord } from '../src/channels/telegram-final-outbox';

const DAY = 24 * 60 * 60 * 1000;
const store = () => {
  const values = new Map<string, unknown>();
  return { get: <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: (key: string, value: unknown) => { values.set(key, structuredClone(value)); } };
};
const base = { trace: 'fixture', payload: { chat_id: 42, text: 'The Brief: lunch with the harbour fund.' }, ownerSubject: '42', doName: 'owner' };
const addressed = (record: FinalRecord) => record.payload.chat_id === 42;

// A surface that takes every part and hands back the next message id, reporting arrival later.
const accepting = (clock: { now: number }, settled = vi.fn(async () => undefined)) => {
  let wamid = 0;
  const sent: string[] = [];
  return { sent, settled, delivery: {
    allowed: async () => true, defer: async () => null, settled,
    send: async (payload: { text: string }) => { sent.push(payload.text); wamid += 1; return wamid; },
    receipt: (ack: unknown) => ({ providerMessageId: `wamid.${String(ack)}`, arrivalBy: clock.now + 30 * DAY }),
  } };
};
const drained = async (kv: ReturnType<typeof store>, clock: { now: number }, input: Partial<FinalRecord> & { id: string }) => {
  const outbox = new TelegramFinalOutbox(kv, () => clock.now);
  await outbox.enqueue({ ...base, ...input });
  clock.now += 300;
  const surface = accepting(clock);
  await outbox.drain(surface.delivery);
  return { outbox, surface };
};
const rows = (kv: ReturnType<typeof store>) => new TelegramFinalOutbox(kv).records().map(({ id, status, reason }) => ({ id, status, ...(reason ? { reason } : {}) }));

describe('a record a surface accepted and reports on later', () => {
  it('waits, unsettled, until every part is reported arrived; nothing is recorded at acceptance', async () => {
    const kv = store(), clock = { now: 1_000 };
    const { surface } = await drained(kv, clock, { id: 'card', dayCard: { day: '2026-10-18', card: 'card:brief', foldUpTo: 900 } });
    expect(rows(kv)).toEqual([{ id: 'card', status: 'accepted' }]);
    expect(surface.settled).toHaveBeenCalledTimes(1);
    expect(surface.settled.mock.calls[0]).toMatchObject([{ status: 'accepted' }]);
    // A drain pass neither settles nor sends it again while it waits.
    await new TelegramFinalOutbox(kv, () => clock.now).drain(surface.delivery);
    expect(surface.sent).toHaveLength(1);
    expect(surface.settled).toHaveBeenCalledTimes(1);
    expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now)).toBe(1);
    expect(rows(kv)).toEqual([{ id: 'card', status: 'delivered' }]);
    await new TelegramFinalOutbox(kv, () => clock.now).drain(surface.delivery);
    expect(surface.settled).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'delivered' }));
    expect(new TelegramFinalOutbox(kv).records()[0]!.settled).toBe(true);
  });

  it('survives a restart: the restart sweep quarantines only an attempt in flight, never a record waiting for its report', async () => {
    const kv = store(), clock = { now: 1_000 };
    await drained(kv, clock, { id: 'report', standingOrder: { runId: 'run', gate: 'act_and_report' } });
    await new TelegramFinalOutbox(kv, () => clock.now).drain(accepting(clock).delivery);
    expect(rows(kv)).toEqual([{ id: 'report', status: 'accepted' }]);
  });

  it('applies a report that arrived while the record was still being sent once the send finishes', async () => {
    const kv = store(), clock = { now: 1_000 };
    const outbox = new TelegramFinalOutbox(kv, () => clock.now);
    await outbox.enqueue({ ...base, id: 'card' });
    clock.now += 300;
    const surface = accepting(clock);
    await outbox.drain({ ...surface.delivery, send: async payload => {
      // Meta's report reaches the owner before the send's own answer has been recorded.
      expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now)).toBe(0);
      return surface.delivery.send(payload);
    } });
    expect(rows(kv)).toEqual([{ id: 'card', status: 'delivered' }]);
  });

  it('keeps a report on an earlier part that arrives while a later part is being sent, without disturbing the send', async () => {
    const kv = store(), clock = { now: 1_000 };
    const outbox = new TelegramFinalOutbox(kv, () => clock.now);
    await outbox.enqueue({ ...base, id: 'card', payload: { chat_id: 42, text: `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}` } });
    clock.now += 300;
    const surface = accepting(clock);
    await outbox.drain({ ...surface.delivery, send: async payload => {
      if (payload.text.startsWith('b')) expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now)).toBe(0);
      return surface.delivery.send(payload);
    } });
    const [row] = new TelegramFinalOutbox(kv).records();
    expect(row).toMatchObject({ status: 'accepted', providerMessageIds: ['wamid.1', 'wamid.2'], arrived: [true, false] });
    observeSurfaceStatuses(kv, [{ id: 'wamid.2', kind: 'arrived', at: clock.now }], addressed, clock.now);
    expect(rows(kv)).toEqual([{ id: 'card', status: 'delivered' }]);
  });

  it('sends again only the part Meta refused, never one it took', async () => {
    const kv = store(), clock = { now: 1_000 };
    const { surface } = await drained(kv, clock, { id: 'card', payload: { chat_id: 42, text: `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}` } });
    observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'refused', at: clock.now }], addressed, clock.now);
    clock.now += 300;
    await new TelegramFinalOutbox(kv, () => clock.now).drain(surface.delivery);
    expect(surface.sent.map(text => text[0])).toEqual(['a', 'b', 'a']);
    expect(new TelegramFinalOutbox(kv).records()[0]).toMatchObject({ status: 'accepted', providerMessageIds: ['wamid.3', 'wamid.2'] });
  });

  it('ignores a refusal or a failure about a part that already arrived, such as a replayed report', async () => {
    const kv = store(), clock = { now: 1_000 };
    const { surface } = await drained(kv, clock, { id: 'card', payload: { chat_id: 42, text: `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}` } });
    expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now)).toBe(1);
    expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'refused', at: clock.now }], addressed, clock.now)).toBe(0);
    expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'failed', at: clock.now }], addressed, clock.now)).toBe(0);
    clock.now += 300;
    await new TelegramFinalOutbox(kv, () => clock.now).drain(surface.delivery);
    expect(surface.sent).toHaveLength(2);
    expect(new TelegramFinalOutbox(kv).records()[0]).toMatchObject({ status: 'accepted', arrived: [true, false], providerMessageIds: ['wamid.1', 'wamid.2'] });
    observeSurfaceStatuses(kv, [{ id: 'wamid.2', kind: 'arrived', at: clock.now }], addressed, clock.now);
    expect(rows(kv)).toEqual([{ id: 'card', status: 'delivered' }]);
  });

  it('ends unconfirmed once its time to report has passed, and that settles it as not delivered', async () => {
    const kv = store(), clock = { now: 1_000 };
    const { surface } = await drained(kv, clock, { id: 'report', standingOrder: { runId: 'run', gate: 'act_and_report' } });
    clock.now += 30 * DAY;
    await new TelegramFinalOutbox(kv, () => clock.now).drain(surface.delivery);
    expect(rows(kv)).toEqual([{ id: 'report', status: 'quarantined', reason: 'delivery_unconfirmed' }]);
    expect(surface.settled).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'quarantined', reason: 'delivery_unconfirmed' }));
  });
});

const SPLIT = { chat_id: 42, text: `${'a'.repeat(3000)}\n\n${'b'.repeat(3000)}` };
// A two-part record whose head Meta refused after taking both: the tail's id stays, so part of it is on the owner's phone.
const splitWithTailTaken = async () => {
  const kv = store(), clock = { now: 1_000 };
  const { surface } = await drained(kv, clock, { id: 'card', payload: SPLIT });
  observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'refused', at: clock.now }], addressed, clock.now);
  expect(new TelegramFinalOutbox(kv).records()[0]).toMatchObject({ status: 'pending', providerMessageIds: [null, 'wamid.2'] });
  clock.now += 300;
  return { kv, clock, surface };
};

describe('a pending record that ends without going out again', () => {
  it.each([
    ['its window never reopens and it lapses', 'lapsed', { lapsed: () => true }],
    ['the route that held it is gone and refuses it', 'owner_binding', { allowed: async () => false }],
  ] as const)('ends quarantined, not blocked, when part of it already reached the provider, and %s', async (_why, reason, route) => {
    const { kv, clock, surface } = await splitWithTailTaken();
    await new TelegramFinalOutbox(kv, () => clock.now).drain({ ...surface.delivery, ...route });
    expect(rows(kv)).toEqual([{ id: 'card', status: 'quarantined', reason }]);
    expect(surface.settled).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'quarantined', reason }));
    expect(surface.sent).toHaveLength(2);
  });

  it('still ends blocked when nothing went out', async () => {
    const kv = store(), clock = { now: 1_000 };
    const outbox = new TelegramFinalOutbox(kv, () => clock.now);
    await outbox.enqueue({ ...base, id: 'card', payload: SPLIT });
    clock.now += 300;
    const surface = accepting(clock);
    await outbox.drain({ ...surface.delivery, lapsed: () => true });
    expect(rows(kv)).toEqual([{ id: 'card', status: 'blocked', reason: 'lapsed' }]);
    expect(surface.sent).toEqual([]);
  });
});

describe('a report that lands while a drain pass waits on the network', () => {
  // The knock in a WhatsApp route's defer, a check in allowed and a settlement can all fetch; the object takes requests then.
  it.each(['defer', 'allowed', 'settled'] as const)('is kept, not overwritten by the pass (%s)', async step => {
    const kv = store(), clock = { now: 1_000 };
    await drained(kv, clock, { id: 'accepted' });
    const outbox = new TelegramFinalOutbox(kv, () => clock.now);
    await outbox.enqueue({ ...base, id: step === 'settled' ? 'other' : 'next' });
    if (step === 'settled') { const rows = outbox.records(); rows[1]!.status = 'blocked'; rows[1]!.reason = 'owner_binding'; kv.put(FINAL_OUTBOX_KEY, rows); }
    clock.now += 300;
    const report = async () => { observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now); await Promise.resolve(); };
    const surface = accepting(clock);
    await outbox.drain({ ...surface.delivery,
      defer: async () => { if (step === 'defer') { await report(); return clock.now + DAY; } return null; },
      allowed: async () => { if (step === 'allowed') await report(); return step !== 'allowed'; },
      settled: async record => { if (step === 'settled' && record.id === 'other') await report(); },
    });
    expect(new TelegramFinalOutbox(kv).records().find(row => row.id === 'accepted')).toMatchObject({ status: 'delivered', arrived: [true] });
  });
});

describe('the surface is unlinked or its number replaced', () => {
  it('retires its records in one step: unsent ones blocked, sent ones unconfirmed, none sent again, later reports ignored', async () => {
    const kv = store(), clock = { now: 1_000 };
    const { surface } = await drained(kv, clock, { id: 'sent' });
    await new TelegramFinalOutbox(kv, () => clock.now).enqueue({ ...base, id: 'waiting' });
    await new TelegramFinalOutbox(kv, () => clock.now).enqueue({ ...base, id: 'other', payload: { chat_id: 7, text: 'Another surface.' }, ownerSubject: '7' });
    expect(retireSurfaceRecords(kv, addressed)).toEqual(['sent', 'waiting']);
    expect(rows(kv)).toEqual([
      { id: 'sent', status: 'quarantined', reason: 'surface_unlinked' },
      { id: 'waiting', status: 'blocked', reason: 'surface_unlinked' },
      { id: 'other', status: 'pending' },
    ]);
    expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now)).toBe(0);
    clock.now += 300;
    await new TelegramFinalOutbox(kv, () => clock.now).drain({ ...surface.delivery, select: addressed });
    expect(surface.sent).toEqual([base.payload.text]);
    expect(rows(kv).slice(0, 2).map(row => row.status)).toEqual(['quarantined', 'blocked']);
  });
});

describe('an unlink with a record already ended and not yet settled', () => {
  it('hands it back to be settled as it ended, since no pass for the surface runs again', async () => {
    const kv = store(), clock = { now: 1_000 };
    const outbox = new TelegramFinalOutbox(kv, () => clock.now);
    await outbox.enqueue({ ...base, id: 'forgotten' });
    expect(redactJobReportEntries(kv, ['harbour fund'], '[forgotten]', undefined)).toEqual({ rewritten: 0, remaining: 0 });
    const ended = outbox.records();
    ended[0] = { ...ended[0]!, status: 'blocked', reason: 'owner_forget', settled: false };
    kv.put(FINAL_OUTBOX_KEY, ended);
    expect(retireSurfaceRecords(kv, addressed)).toEqual(['forgotten']);
    expect(rows(kv)).toEqual([{ id: 'forgotten', status: 'blocked', reason: 'owner_forget' }]);
    const settled = vi.fn(async () => undefined);
    await new TelegramFinalOutbox(kv, () => clock.now).settleEnded(['forgotten'], settled);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ id: 'forgotten', status: 'blocked', reason: 'owner_forget' }));
  });
});

describe('settling the records an unlink retired', () => {
  it('settles only them, and leaves a send another pass has in flight alone', async () => {
    const kv = store(), clock = { now: 1_000 };
    await drained(kv, clock, { id: 'retired' });
    const outbox = new TelegramFinalOutbox(kv, () => clock.now);
    await outbox.enqueue({ ...base, id: 'live', payload: { chat_id: 7, text: 'For another surface.' }, ownerSubject: '7' });
    clock.now += 300;
    let release!: () => void, reached!: () => void;
    const inFlight = new Promise<void>(resolve => { reached = resolve; });
    const surface = accepting(clock);
    const pass = outbox.drain({ ...surface.delivery, send: async payload => { reached(); await new Promise<void>(go => { release = go; }); return surface.delivery.send(payload); } });
    // The owner unlinks WhatsApp while that pass waits on its send.
    await inFlight;
    expect(retireSurfaceRecords(kv, addressed)).toEqual(['retired']);
    const settled = vi.fn(async () => undefined);
    await new TelegramFinalOutbox(kv, () => clock.now).settleEnded(['retired'], settled);
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({ id: 'retired', status: 'quarantined', reason: 'surface_unlinked' }));
    release();
    await pass;
    expect(rows(kv)).toEqual([{ id: 'retired', status: 'quarantined', reason: 'surface_unlinked' }, { id: 'live', status: 'accepted' }]);
    expect(new TelegramFinalOutbox(kv).records().find(row => row.id === 'retired')!.settled).toBe(true);
  });
});

describe('the reports kept for a record the outbox cannot match yet', () => {
  const counted = () => {
    const kv = store(), puts: string[] = [];
    return { puts, kv: { get: kv.get, put: (key: string, value: unknown) => { puts.push(key); kv.put(key, value); } }, plain: kv };
  };
  const early = (kv: ReturnType<typeof store>) => Object.keys(kv.get<Record<string, unknown>>(EARLY_STATUS_KEY) ?? {});

  it('writes only when something changed: a report that matches a record, or one already kept, writes nothing', async () => {
    const { kv, puts, plain } = counted(), clock = { now: 1_000 };
    await drained(plain, clock, { id: 'card' });
    expect(observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now)).toBe(1);
    expect(puts.filter(key => key === EARLY_STATUS_KEY)).toEqual([]);
    observeSurfaceStatuses(kv, [{ id: 'wamid.unknown', kind: 'arrived', at: clock.now }], addressed, clock.now);
    expect(puts.filter(key => key === EARLY_STATUS_KEY)).toHaveLength(1);
    observeSurfaceStatuses(kv, [{ id: 'wamid.unknown', kind: 'arrived', at: clock.now + 1 }], addressed, clock.now + 1);
    expect(puts.filter(key => key === EARLY_STATUS_KEY)).toHaveLength(1);
    expect(early(plain)).toEqual(['wamid.unknown']);
  });

  it('keeps only the newest reports, so a flood of reports for messages that are not records cannot grow it without bound', () => {
    const kv = store();
    const flood = Array.from({ length: MAX_EARLY_STATUSES + 40 }, (_, index) => ({ id: `wamid.reply.${index}`, kind: 'arrived' as const, at: 1_000 }));
    observeSurfaceStatuses(kv, flood, addressed, 1_000);
    expect(early(kv)).toHaveLength(MAX_EARLY_STATUSES);
    expect(early(kv)).toContain(`wamid.reply.${MAX_EARLY_STATUSES + 39}`);
    expect(early(kv)).not.toContain('wamid.reply.0');
  });

  it('drops a report older than a day when the next one comes in', () => {
    const kv = store();
    observeSurfaceStatuses(kv, [{ id: 'wamid.old', kind: 'arrived', at: 0 }], addressed, 1_000);
    observeSurfaceStatuses(kv, [{ id: 'wamid.new', kind: 'arrived', at: 0 }], addressed, 1_000 + DAY + 1);
    expect(early(kv)).toEqual(['wamid.new']);
  });
});

describe('a full outbox', () => {
  it('refuses a new record with a reason and evicts none that is still waiting for its report', async () => {
    const kv = store(), clock = { now: 1_000 };
    const outbox = new TelegramFinalOutbox(kv, () => clock.now);
    await outbox.enqueue({ ...base, id: 'seed' });
    const seed = outbox.records()[0]!;
    kv.put(FINAL_OUTBOX_KEY, Array.from({ length: 256 }, (_, index) => ({ ...seed, id: `accepted-${index}`, status: 'accepted', providerMessageIds: [`wamid.${index}`], arrivalBy: clock.now + DAY })));
    await expect(outbox.enqueue({ ...base, id: 'one-more' })).rejects.toThrow('final outbox capacity');
    expect(outbox.records()).toHaveLength(256);
    expect(outbox.records().every(row => row.status === 'accepted')).toBe(true);
  });
});

describe('what the owner and the operator can see while records wait', () => {
  it('counts the records waiting for a report and dates the oldest, with no ids or text', async () => {
    const kv = store(), clock = { now: 1_000 };
    await drained(kv, clock, { id: 'first' });
    clock.now += 5_000;
    await drained(kv, clock, { id: 'second' });
    expect(new TelegramFinalOutbox(kv).unconfirmed()).toEqual({ count: 2, oldestSince: 1_000 });
  });

  it('names the waiting state for the job behind a record, and the Brief as sent but unconfirmed', async () => {
    const kv = store(), clock = { now: Date.parse('2026-10-18T09:00:00Z') };
    await drained(kv, clock, { id: 'report', standingOrder: { runId: 'run-1', gate: 'act_and_report' } });
    await drained(kv, clock, { id: 'card', dayCard: { day: '2026-10-18', card: 'card:brief', foldUpTo: 0 } });
    observeSurfaceStatuses(kv, [{ id: 'wamid.1', kind: 'refused', at: clock.now }], addressed, clock.now);
    const records = new TelegramFinalOutbox(kv).records();
    expect([...outboxRunNotes(records)]).toEqual([['run-1', 'waiting for your next message']]);
    expect([...unconfirmedCards(records, '2026-10-18')]).toEqual(['card:brief']);
    const overview = dashboardOverview({ now: clock.now, timezone: 'UTC', plans: [{ card: 'card:brief', time: '08:00', reason: 'r', sent: false }], cards: [{ id: 'card:brief', name: 'The Brief' }],
      unconfirmed: unconfirmedCards(records, '2026-10-18'), approvals: [], run: null, trace: null, grants: [] });
    expect(overview.brief.status).toBe('sent_unconfirmed');
  });
});

describe('owner forget on a record that has started going out', () => {
  it('keeps the parts it sent, even when the redacted text would now fit in fewer', async () => {
    const kv = store(), clock = { now: 1_000 };
    const secret = 'the harbour fund '.repeat(12).trim();
    const { surface } = await drained(kv, clock, { id: 'card', payload: { chat_id: 42, text: `${'a'.repeat(3800)} ${secret}\n\n${'b'.repeat(150)}` }, dayCard: { day: '2026-10-18', card: 'card:brief', foldUpTo: 0 } });
    expect(surface.sent).toHaveLength(2);
    expect(redactJobReportEntries(kv, [secret], '[forgotten]')).toEqual({ rewritten: 1, remaining: 0 });
    const [row] = new TelegramFinalOutbox(kv).records();
    expect(row!.parts).toHaveLength(2);
    expect(row!.parts![0]!.text).toBe(`${'a'.repeat(3800)} [forgotten]`);
    expect(row!.parts![1]!.text).toBe('b'.repeat(150));
    observeSurfaceStatuses(kv, [{ id: 'wamid.2', kind: 'arrived', at: clock.now }, { id: 'wamid.1', kind: 'arrived', at: clock.now }], addressed, clock.now);
    expect(rows(kv)).toEqual([{ id: 'card', status: 'delivered' }]);
  });

  it('redacts each part in place, so a later report still names the right part', async () => {
    const kv = store(), clock = { now: 1_000 };
    const parts = [`${'a'.repeat(3000)} the harbour fund`, 'b'.repeat(3000)];
    const { surface } = await drained(kv, clock, { id: 'card', payload: { chat_id: 42, text: parts.join('\n\n') }, dayCard: { day: '2026-10-18', card: 'card:brief', foldUpTo: 0 } });
    expect(surface.sent).toHaveLength(2);
    redactJobReportEntries(kv, ['the harbour fund'], '[forgotten]');
    const [row] = new TelegramFinalOutbox(kv).records();
    expect(row!.parts!.map(part => part.text)).toEqual([`${'a'.repeat(3000)} [forgotten]`, parts[1]]);
    expect(row!.providerMessageIds).toEqual(['wamid.1', 'wamid.2']);
    // Refused after the forget, it is cancelled rather than sent again.
    observeSurfaceStatuses(kv, [{ id: 'wamid.2', kind: 'refused', at: clock.now }], addressed, clock.now);
    expect(rows(kv)).toEqual([{ id: 'card', status: 'blocked', reason: 'owner_forget' }]);
  });
});
