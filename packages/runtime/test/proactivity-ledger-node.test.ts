import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProactivityBook } from '../src/proactivity/book';
import { proactivityDeliveryEligible, runProactivityCycle, type ProactivityPorts } from '../src/proactivity/runner';
import { ProactivityConflict, SourceCursorExpired, type FreshCheck, type Observation, type ProactiveDecision, type SourceKey, type Watch } from '../src/proactivity/types';

const databases: DatabaseSync[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const mail: SourceKey = { source: 'mail', accountId: 'personal', collection: 'inbox' };
const calendar: SourceKey = { source: 'calendar', accountId: 'work', collection: 'team-calendar' };
function fixture(ownerKey = 'owner-a') {
  const db = new DatabaseSync(':memory:'); databases.push(db);
  let now = Date.parse('2026-10-10T10:00:00Z'), sequence = 0;
  const sql = { exec(query: string, ...args: (string | number | null)[]) {
    const stmt = db.prepare(query);
    return { toArray: () => stmt.all(...args) };
  } } as unknown as SqlStorage;
  // DDL/DML is eager in Workers SqlStorage; mirror that behavior using real SQLite.
  sql.exec = ((query: string, ...args: (string | number | null)[]) => {
    const stmt = db.prepare(query), rows = stmt.all(...args);
    return { toArray: () => rows };
  }) as SqlStorage['exec'];
  const transaction = <T>(work: () => T): T => {
    db.exec('BEGIN');
    try { const result = work(); db.exec('COMMIT'); return result; } catch (error) { db.exec('ROLLBACK'); throw error; }
  };
  const deps = { ownerKey, now: () => now, newId: () => `p${++sequence}`, transaction };
  const book = createProactivityBook(sql, deps);
  const observation = (resourceId = 'form-thread', revision = 'v1', source: SourceKey = mail): Observation => ({ ...source, resourceId, revision, observedAt: now, deleted: false, contentRef: `source:${resourceId}:${revision}` });
  const access = (source: SourceKey = mail, epoch = 1) => book.setSourceAccess({ ...source, epoch, connected: true });
  const watch = (source: SourceKey = mail): Watch => { access(source); return book.createWatch({ responsibilityId: 'responsibility-form', responsibilityRevision: 1, sources: [{ ...source, epoch: 1 }], audience: 'owner-private', condition: { kind: 'source_change', resourceIds: ['form-thread'] }, nextCheckAt: now, expiresAt: now + 7 * 86_400_000, subscription: null }); };
  const check = (value: Watch, status: FreshCheck['status'] = 'open', revision = 'v1'): FreshCheck => ({ refs: [observation('form-thread', revision, value.sources[0]!)], checkedAt: now, coverage: 'complete', status, evidenceRefs: ['provider:full-thread-read'], responsibilityRevision: value.responsibilityRevision, audience: value.audience });
  const decision = (value: Watch, disposition: ProactiveDecision['disposition'] = 'notify') => {
    book.observeFresh([observation('form-thread', 'v1', value.sources[0]!)]);
    const wake = book.wake(value.id, 'first', now)!; book.claimWake(wake.id);
    return book.recordDecision(wake.id, check(value), { disposition, rationale: 'Current thread confirms a useful open deadline.', text: 'Your form is due November 2.', ...(disposition === 'batch' ? { batchAt: now + 60_000 } : {}) }, { nextCheckAt: now + 3_600_000, expiresAt: now + 86_400_000 });
  };
  return { db, sql, deps, book, now: () => now, advance: (ms: number) => { now += ms; }, access, observation, watch, check, decision };
}

describe('durable owner discovery coverage', () => {
  it('retains partial pages across restart and commits the cursor only after all 25 messages apply', () => {
    const f = fixture(); f.access();
    const first = f.book.beginSweep(mail, 1);
    const partial = f.book.applyPage(first.id, first.revision, { observations: Array.from({ length: 10 }, (_, i) => f.observation(`message-${i}`)), nextPageToken: 'page-2', nextCursor: 'ignored-partial' });
    expect(f.book.coverage(mail)).toBeNull();
    const restarted = createProactivityBook(f.sql, f.deps);
    expect(restarted.beginSweep(mail, 1)).toEqual(partial);
    const last = restarted.applyPage(partial.id, partial.revision, { observations: Array.from({ length: 15 }, (_, i) => f.observation(`message-${i + 10}`)), nextPageToken: null, nextCursor: 'history-25' });
    expect(last.state).toBe('complete');
    expect(restarted.coverage(mail)).toMatchObject({ cursor: 'history-25', applied: 25 });
    expect(restarted.observations(mail)).toHaveLength(25);
  });
  it('rolls back a page whose later observation is invalid', () => {
    const f = fixture(); f.access(); const sweep = f.book.beginSweep(mail, 1);
    expect(() => f.book.applyPage(sweep.id, sweep.revision, { observations: [f.observation('valid'), { ...f.observation('invalid'), revision: '' }], nextPageToken: null, nextCursor: 'lost' })).toThrow(ProactivityConflict);
    expect(f.book.observations()).toHaveLength(0); expect(f.book.coverage(mail)).toBeNull();
    expect(f.book.sweep(sweep.id)).toEqual(sweep);
  });
  it('partitions coverage and references by source account, collection, and authenticated owner', () => {
    const f = fixture(); f.access(); f.access(calendar);
    for (const source of [mail, calendar]) { const sweep = f.book.beginSweep(source, 1); f.book.applyPage(sweep.id, 1, { observations: [f.observation('same-id', 'v1', source)], nextPageToken: null, nextCursor: source.accountId }); }
    const other = createProactivityBook(f.sql, { ...f.deps, ownerKey: 'owner-b' });
    expect(other.observations()).toEqual([]); expect(other.coverage(mail)).toBeNull();
    expect(f.book.observations()).toHaveLength(2); expect(f.book.coverage(calendar)?.cursor).toBe('work');
  });
  it('rejects stale page application and keeps deletion evidence instead of an active obligation', () => {
    const f = fixture(); f.access(); const sweep = f.book.beginSweep(mail, 1);
    const partial = f.book.applyPage(sweep.id, 1, { observations: [f.observation()], nextPageToken: 'next', nextCursor: null });
    expect(() => f.book.applyPage(sweep.id, 1, { observations: [], nextPageToken: null, nextCursor: 'bad' })).toThrow(ProactivityConflict);
    f.advance(1000); f.book.applyPage(sweep.id, partial.revision, { observations: [{ ...f.observation('form-thread', 'v2'), deleted: true, contentRef: null }], nextPageToken: null, nextCursor: 'good' });
    expect(f.book.observations(mail)[0]).toMatchObject({ deleted: true, revision: 'v2' });
  });
});

describe('checked responsibility watches and owner controls', () => {
  it('source detection wakes only the matching account and resource and deduplicates unchanged revisions', () => {
    const f = fixture(), watch = f.watch(), other = f.watch(calendar);
    const later = f.book.reviseWatch(watch.id, 1, { responsibilityRevision: 1, audience: watch.audience, condition: watch.condition, nextCheckAt: f.now() + 3600_000, expiresAt: watch.expiresAt });
    f.book.reviseWatch(other.id, 1, { responsibilityRevision: 1, audience: other.audience, condition: other.condition, nextCheckAt: f.now() + 3600_000, expiresAt: other.expiresAt });
    const sweep = f.book.beginSweep(mail, 1);
    const page = f.book.applyPage(sweep.id, 1, { observations: [f.observation(), f.observation('unrelated-thread')], nextPageToken: 'second', nextCursor: null });
    const first = f.book.dueWakes(); expect(first).toHaveLength(1); expect(first[0]?.watchId).toBe(later.id);
    f.book.applyPage(sweep.id, page.revision, { observations: [f.observation()], nextPageToken: null, nextCursor: 'end' });
    expect(f.book.dueWakes()).toEqual(first);
  });
  it('deduplicates event wakes, and fallback checks survive an expired event subscription', () => {
    const f = fixture(), watch = f.watch();
    const subscribed = f.book.renewSubscription(watch.id, 1, { id: 'provider-sub', renewAt: f.now() + 1000, expiresAt: f.now() + 2000 });
    expect(subscribed.revision).toBe(1);
    expect(f.book.wake(watch.id, 'event-1', f.now())).toEqual(f.book.wake(watch.id, 'event-1', f.now()));
    f.advance(3000); expect(f.book.subscriptionsDue()).toHaveLength(1);
    expect(f.book.dueWakes().map(wake => wake.eventKey)).toContain(`fallback:${watch.nextCheckAt}`);
  });
  it('holds batch output until its selected time and records a silent decision without claiming delivery', () => {
    const f = fixture(); const batch = f.decision(f.watch(), 'batch');
    expect(f.book.deliveryCandidates()).toEqual([]); f.advance(60_000);
    expect(f.book.deliveryCandidates().map(row => row.id)).toEqual([batch.id]);
    const silent = f.decision(f.watch(), 'silent'); expect(silent).toMatchObject({ state: 'silent', text: '', deliveredAt: null });
  });
  it('rechecks newer completion evidence before enqueue and never reports a delivery', () => {
    const f = fixture(), watch = f.watch(), delivery = f.decision(watch);
    const result = f.book.checkDelivery(delivery.id, f.check(watch, 'handled'));
    expect(result).toMatchObject({ state: 'blocked', reason: 'already_handled', deliveredAt: null });
    expect(f.book.deliveryCandidates()).toEqual([]);
  });
  it('blocks a frozen nudge when the provider revision changes after preparation', () => {
    const f = fixture(), watch = f.watch(), delivery = f.decision(watch); f.advance(1000);
    f.book.observeFresh([f.observation('form-thread', 'v2')]);
    expect(f.book.checkDelivery(delivery.id, f.check(watch, 'open', 'v2'))).toMatchObject({ state: 'blocked', reason: 'source_changed' });
  });
  it('requires current full source checks rather than stale memory or an empty cache', () => {
    const f = fixture(), watch = f.watch(); f.book.observeFresh([f.observation()]);
    const wake = f.book.wake(watch.id, 'source-event', f.now())!; f.book.claimWake(wake.id);
    for (const check of [{ ...f.check(watch), coverage: 'partial' as const }, { ...f.check(watch), refs: [] }, { ...f.check(watch), evidenceRefs: [] }]) {
      expect(() => f.book.recordDecision(wake.id, check, { disposition: 'notify', rationale: 'Inferred deadline.', text: 'Nudge' }, { nextCheckAt: f.now() + 3600_000, expiresAt: f.now() + 86_400_000 })).toThrow(ProactivityConflict);
    }
  });
  it('blocks a prepared nudge after a newer manual responsibility revision or changed audience', () => {
    for (const patch of [{ responsibilityRevision: 2 }, { audience: 'work-group' }]) {
      const f = fixture(), watch = f.watch(), delivery = f.decision(watch);
      expect(f.book.checkDelivery(delivery.id, { ...f.check(watch), ...patch })).toMatchObject({ state: 'blocked', reason: 'source_changed' });
    }
  });
  it('pauses or corrects an exact revision and rejects old controls and queued output', () => {
    const f = fixture(), watch = f.watch(), delivery = f.decision(watch);
    const paused = f.book.controlWatch(watch.id, 1, 'pause');
    expect(f.book.delivery(delivery.id)).toMatchObject({ state: 'blocked', reason: 'watch_pause' });
    expect(() => f.book.controlWatch(watch.id, 1, 'resume')).toThrow(ProactivityConflict);
    const resumed = f.book.controlWatch(watch.id, paused.revision, 'resume');
    const corrected = f.book.reviseWatch(watch.id, resumed.revision, { responsibilityRevision: 2, audience: 'owner-private', condition: { kind: 'cadence', intervalMs: 3600_000 }, nextCheckAt: f.now() + 3600_000, expiresAt: watch.expiresAt });
    expect(corrected.responsibilityRevision).toBe(2);
  });
  it('disconnect removes derived source references and cancels associated watches without touching another account', () => {
    const f = fixture(), watch = f.watch(), delivery = f.decision(watch); const other = f.watch(calendar);
    f.book.observeFresh([f.observation('other', 'v1', calendar)]);
    f.book.setSourceAccess({ ...mail, epoch: 2, connected: false });
    expect(f.book.watch(watch.id)?.state).toBe('cancelled'); expect(f.book.delivery(delivery.id)?.state).toBe('blocked');
    expect(f.book.observations(mail)).toEqual([]); expect(f.book.observations(calendar)).toHaveLength(1);
    expect(f.book.watch(other.id)?.state).toBe('active');
    expect(() => f.book.setSourceAccess({ ...mail, epoch: 2, connected: true })).toThrow(ProactivityConflict);
    f.book.setSourceAccess({ ...mail, epoch: 3, connected: true });
    expect(f.book.watch(watch.id)?.state).toBe('cancelled');
  });
  it('requires evidence for watch closure and expires pending work durably', () => {
    const f = fixture(), watch = f.watch();
    expect(() => f.book.controlWatch(watch.id, 1, 'complete')).toThrow(ProactivityConflict);
    expect(f.book.controlWatch(watch.id, 1, 'complete', 'provider:submission-receipt').state).toBe('satisfied');
    const other = f.watch(); f.advance(8 * 86_400_000); f.book.dueWakes();
    expect(f.book.watch(other.id)?.state).toBe('expired');
  });
  it('never resends after a lost ACK and accepts only a usable exact delivery receipt', () => {
    const f = fixture(), watch = f.watch(), delivery = f.decision(watch);
    f.book.checkDelivery(delivery.id, f.check(watch)); f.book.claimDelivery(delivery.id);
    const restarted = createProactivityBook(f.sql, f.deps); restarted.recover();
    expect(restarted.delivery(delivery.id)).toMatchObject({ state: 'unknown', deliveredAt: null });
    expect(restarted.deliveryCandidates()).toEqual([]);
    expect(() => restarted.settleDelivery(delivery.id, { state: 'delivered' })).toThrow(ProactivityConflict);
    expect(restarted.settleDelivery(delivery.id, { state: 'delivered', receiptRef: 'app:visible-message-17' })).toMatchObject({ state: 'delivered', receiptRef: 'app:visible-message-17', deliveredAt: f.now() });
  });
});

function ports(f: ReturnType<typeof fixture>, overrides: Partial<ProactivityPorts> = {}): ProactivityPorts {
  return {
    admit: async () => ({ ownerKey: f.book.ownerKey, epoch: 1, connected: true, available: true }),
    fetchPage: async () => ({ observations: [f.observation()], nextPageToken: null, nextCursor: 'next-history' }),
    discovered: async () => undefined,
    checkCurrent: async watch => ({ check: f.check(watch), observations: [f.observation('form-thread', 'v1', watch.sources[0]!)] }),
    decide: async () => ({ disposition: 'notify', rationale: 'Current sources confirm the deadline.', text: 'The form is due November 2.' }),
    enqueue: async () => ({ state: 'delivered', receiptRef: 'app:visible-message-17' }), now: f.now,
    ...overrides,
  };
}
describe('composed source detection to checked work to delivery', () => {
  it('sweeps 25 mail arrivals and 51 calendar changes through every page without targeted items', async () => {
    const f = fixture(); const discovered = vi.fn();
    const run = ports(f, { discovered, fetchPage: async sweep => {
      const offset = Number(sweep.pageToken ?? 0), count = sweep.source === 'mail' ? 25 : 51, end = Math.min(offset + 10, count);
      return { observations: Array.from({ length: end - offset }, (_, index) => f.observation(`resource-${offset + index}`, 'v1', sweep)), nextPageToken: end === count ? null : String(end), nextCursor: `${sweep.source}-cursor-${count}` };
    } });
    const result = await runProactivityCycle(f.book, run, [mail, calendar], { maxPages: 10 });
    expect(result).toMatchObject({ pages: 9, discoveries: 2, failures: [] });
    expect(f.book.coverage(mail)?.applied).toBe(25); expect(f.book.coverage(calendar)?.applied).toBe(51);
    expect(discovered.mock.calls.map(args => args[1].length)).toEqual([25, 51]);
  });
  it('rebuilds an expired provider cursor on the next bounded cycle', async () => {
    const f = fixture(); f.access(); const sweep = f.book.beginSweep(mail, 1); f.book.applyPage(sweep.id, 1, { observations: [], nextPageToken: null, nextCursor: 'old-history' });
    const failed = await runProactivityCycle(f.book, ports(f, { fetchPage: async () => { throw new SourceCursorExpired(); } }), [mail]);
    expect(failed.failures[0]?.code).toBe('cursor_expired'); expect(f.book.coverage(mail)).toBeNull();
    const fetchPage = vi.fn(async (next: import('../src/proactivity/types').Sweep) => ({ observations: [], nextPageToken: null, nextCursor: 'rebuilt' }));
    await runProactivityCycle(f.book, ports(f, { fetchPage }), [mail]);
    expect(fetchPage.mock.calls[0]![0]).toMatchObject({ mode: 'baseline', cursor: null });
  });
  it('suppresses already-handled items and incomplete access without invoking judgment or sending', async () => {
    for (const status of ['handled', 'unknown'] as const) {
      const f = fixture(), watch = f.watch(), decide = vi.fn(), enqueue = vi.fn();
      const result = await runProactivityCycle(f.book, ports(f, { decide, enqueue, checkCurrent: async () => ({ check: f.check(watch, status), observations: [f.observation()] }) }), []);
      expect(result.checks).toBe(1); expect(decide).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled(); expect(f.book.deliveries()[0]?.state).toBe('silent');
    }
  });
  it('returns a real adapter ACK separately from a queued outbox operation', async () => {
    const f = fixture(); f.watch();
    const result = await runProactivityCycle(f.book, ports(f, { enqueue: async () => ({ state: 'queued' }) }), []);
    expect(result).toMatchObject({ checks: 1, queued: 1, delivered: 0, failures: [] });
    const delivery = f.book.deliveries()[0]!; expect(delivery.state).toBe('sending'); expect(delivery.deliveredAt).toBeNull();
    expect(await proactivityDeliveryEligible(f.book, ports(f), delivery.id)).toBe(true);
    f.book.settleDelivery(delivery.id, { state: 'delivered', receiptRef: 'telegram:message-117' });
    expect(f.book.delivery(delivery.id)?.state).toBe('delivered');
  });
  it('blocks after a source revokes during a fresh check before enqueue', async () => {
    const f = fixture(), watch = f.watch(), enqueue = vi.fn(); let connected = true;
    const result = await runProactivityCycle(f.book, ports(f, { admit: async () => ({ ownerKey: f.book.ownerKey, epoch: connected ? 1 : 2, connected, available: connected }), checkCurrent: async () => { connected = false; return { check: f.check(watch), observations: [f.observation()] }; }, enqueue }), []);
    expect(result.blocked).toBe(1); expect(enqueue).not.toHaveBeenCalled(); expect(f.book.watch(watch.id)?.state).toBe('cancelled');
  });
  it('treats temporary token expiry as reauthentication instead of forgetting connected context', async () => {
    const f = fixture(), watch = f.watch(); f.book.observeFresh([f.observation()]);
    await runProactivityCycle(f.book, ports(f, { admit: async () => ({ ownerKey: f.book.ownerKey, epoch: 1, connected: true, available: false }) }), []);
    expect(f.book.watch(watch.id)?.state).toBe('active'); expect(f.book.observations()).toHaveLength(1);
  });
  it('defers a claimed wake after temporary source unavailability and recovers without eviction or another send owner', async () => {
    const f = fixture(), watch = f.watch(); let available = true;
    const checkCurrent = vi.fn(async () => { available = false; return { check: f.check(watch), observations: [f.observation()] }; });
    const first = await runProactivityCycle(f.book, ports(f, { admit: async () => ({ ownerKey: f.book.ownerKey, epoch: 1, connected: true, available }), checkCurrent }), []);
    expect(first.blocked).toBe(1); expect(f.book.deliveries()).toEqual([]);
    f.advance(3600_000); available = true;
    const next = await runProactivityCycle(f.book, ports(f), []);
    expect(next.delivered).toBe(1); expect(f.book.watch(watch.id)?.state).toBe('active');
  });
  it('rejects a different owner from the connector port before reading or delivery', async () => {
    const f = fixture(), fetchPage = vi.fn();
    const result = await runProactivityCycle(f.book, ports(f, { admit: async () => ({ ownerKey: 'owner-b', epoch: 1, connected: true, available: true }), fetchPage }), [mail]);
    expect(fetchPage).not.toHaveBeenCalled(); expect(result.failures[0]?.code).toBe('source_revoked'); expect(f.book.access(mail)).toBeNull();
  });
});
