import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppAutonomyGrantTermsV1 } from '../../contracts/src/app/autonomy';
import type { RunOrigin } from '../../contracts/src/runtime/standing-grant';
import { approvalDesk, UNDO_WINDOW_MS } from '../src/channels/approvals';
import { readAccessLog } from '../src/channels/dashboard-access-log';
import { ownerEffectLedger, type OwnerEffectLedger } from '../src/channels/owner-effect-ledger';
import { standingGrants, type OwnBlockChange } from '../src/channels/standing-grants';
import type { GoogleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';

// Tuesday 3 Nov 2026, 09:00 in Kolkata.
const NOW = Date.UTC(2026, 10, 3, 3, 30);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const ACCOUNT = 'sam@example.com';
const iso = (ms: number) => new Date(ms).toISOString() as never;
const terms = (over: Partial<AppAutonomyGrantTermsV1> = {}): AppAutonomyGrantTermsV1 => ({
  scope: { class: 'calendar.move_own_block', account: ACCOUNT, window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
  limits: { max_per_day: 3, timezone: 'Asia/Kolkata' }, valid_from: NOW - DAY, expires_at: NOW + 30 * DAY, ...over,
});
const focus = (startMs = NOW + 5 * HOUR, over: Record<string, unknown> = {}) =>
  ({ action: 'create' as const, title: 'Focus', start: iso(startMs), end: iso(startMs + HOUR), reason: 'plan the day', block: 'deep_work' as const, ...over });
// Events as the primary calendar reads them back: e1 is a block Waldo created, r1 one in a series, x1 one Waldo created that has
// since gained a guest, and u1 the owner's own event, with no mark.
const MARKED = new Set(['e1', 'r1', 'x1']);

type Grants = ReturnType<typeof standingGrants>;
const world = (state: DurableObjectState, options: Readonly<{ grants?: (real: Grants) => Pick<Grants, 'ownBlock' | 'enabled'>; effects?: (real: OwnerEffectLedger) => OwnerEffectLedger; createThrows?: boolean; undoCancels?: boolean }> = {}) => {
  let now = NOW, n = 0, g = 0;
  const writes: unknown[][] = [];
  const cards: string[] = [];
  const logs: Record<string, unknown>[] = [];
  // The version each event is at after Waldo's own writes, so an undo reads back the version it wrote.
  const versions = new Map<string, string>();
  // Creates Waldo asked for, and the ones a readback finds on the calendar after the create's answer was lost.
  const created = new Map<string, Record<string, unknown>>(), landed = new Set<string>();
  const client = {
    account: { connection_id: `local:${ACCOUNT}`, email: ACCOUNT },
    event: async (id: string, calendarId?: string) => landed.has(id) ? { id, title: created.get(id)!.title, start: created.get(id)!.start, end: created.get(id)!.end, all_day: false, etag: 'v2', status: 'confirmed', operation_marker: created.get(id)!.operationMarker } : ({ id, title: 'Focus', start: iso(NOW + 5 * HOUR), end: iso(NOW + 6 * HOUR), all_day: false, etag: versions.get(id) ?? (id === 'e1' || id === 'r1' || id === 'u1' ? 'v1' : 'v2'), calendar: calendarId,
      ...(id === 'r1' ? { recurring_event_id: 'series' } : {}), ...(MARKED.has(id) ? { waldo_made: true } : {}), ...(id === 'x1' ? { attendees: 1 } : {}) }),
    createEvent: async (input: Record<string, unknown>) => { writes.push(['create', input]); created.set(String(input.id), input); if (options.createThrows) throw new Error('socket closed'); return { id: String(input.id), title: 'Focus', start: '', end: '', all_day: false, etag: 'v2' }; },
    moveEvent: async (...args: unknown[]) => { writes.push(['move', ...args]); return { id: 'e1', title: 'Focus', start: '', end: '', all_day: false, etag: 'v3' }; },
    cancelEvent: async (...args: unknown[]) => { writes.push(['cancel', ...args]); versions.set(String(args[0]), 'v4'); return { id: String(args[0]), title: 'Focus', start: '', end: '', all_day: false, etag: 'v4', status: 'cancelled' }; },
    restoreEvent: async (...args: unknown[]) => { writes.push(['restore', ...args]); return { id: String(args[0]), title: 'Focus', start: '', end: '', all_day: false, etag: 'v5' }; },
  } as unknown as GoogleClient;
  const real = standingGrants(state.storage, { now: () => now, newId: () => `g${++g}`, enabled: () => true, ownerRef: () => 'owner-1' });
  const realEffects = ownerEffectLedger(state.storage, () => now);
  const effects = options.effects ? options.effects(realEffects) : realEffects;
  const desk = approvalDesk(state.storage.sql, {
    call: async (method, body) => { if (method === 'sendMessage') cards.push(String((body as { text?: string }).text)); return { message_id: cards.length }; },
    owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: entry => logs.push(entry as Record<string, unknown>),
    effects, ownerRef: () => 'owner-1', grants: options.grants ? options.grants(real) : real, ...(options.undoCancels ? { undoCancels: true } : {}),
  });
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const propose = (p: ReturnType<typeof focus>, ...origin: [RunOrigin | undefined] | []) => desk.propose(p, 'turn-1', `tool:${n + 1}`, { origin: origin.length ? origin[0] : 'owner' });
  return { desk, client, grants: real, writes, cards, logs, status, propose, effects, land: (id: string) => landed.add(id), clock: { set: (ms: number) => { now = ms; } } };
};
const inDo = (name: string, run: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => run(state));

const midway = (real: Grants, then: () => void): Pick<Grants, 'ownBlock' | 'enabled'> =>
  ({ enabled: real.enabled, ownBlock: (change: OwnBlockChange, origin: RunOrigin | undefined) => { const decision = real.ownBlock(change, origin); then(); return decision; } });

describe('calendar.move_own_block: Waldo places, moves and removes its own blocks on the primary calendar without a card', () => {
  it('golden path: evaluate, reserve with the recheck, write, report; then undo until the block starts', () => inDo('own-golden', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus());
    expect(w.cards).toEqual([]);
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]![1]).toMatchObject({ title: 'Focus', made: true });
    expect(w.writes[0]![1]).not.toHaveProperty('calendarId');
    expect(w.status(id)).toBe('done');
    expect(w.desk.grantOutcome(id)).toMatchObject({ state: 'done' });
    expect(w.desk.grantOutcome(id)!.message).toMatch(/^Done under your standing grant: Add "Focus"/);
    expect(w.logs.filter(entry => String(entry.hop).startsWith('grant_')).map(entry => [entry.hop, entry.ok, entry.detail ?? entry.code])).toEqual([
      ['grant_eval', true, 'granted'], ['grant_use', true, 'done'],
    ]);
    // It was never the owner's approval: the app's list and the access log leave it out, and the ledger says what allowed it.
    expect((await w.desk.approvals(NOW)).map(item => item.approval_id)).not.toContain(id);
    expect(w.desk.ledger([])).toContain('(by the owner\'s standing grant, with no card)');
    expect(readAccessLog(state.storage.sql, NOW + MIN, {}).approvals.rows).toEqual([]);
    const record = w.effects.get('tool:1:apply')!;
    expect(record.state).toBe('done');
    expect(record.quota).toMatchObject({ grant_ref: `calendar.move_own_block:${ACCOUNT}`, max_per_day: 3 });
    // Past the desk's 10-minute window but before the block starts, undo still works.
    w.clock.set(NOW + 3 * HOUR);
    expect((await w.desk.decide(id, 'u', 't')).toast).toBe('Undone');
    expect(w.writes.at(-1)![0]).toBe('cancel');
  }));

  it('undo closes once the block has started', () => inDo('own-undo-closes', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus(NOW + HOUR));
    w.clock.set(NOW + HOUR + 1);
    expect((await w.desk.decide(id, 'u', 't')).toast).toBe('Too late to undo');
    expect(w.writes.map(write => write[0])).toEqual(['create']);
  }));

  it('moves a block Waldo created, keeping the move undoable', () => inDo('own-move', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose({ ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'e1' } as never);
    expect(w.cards).toEqual([]);
    expect(w.writes[0]!.slice(0, 2)).toEqual(['move', 'e1']);
    expect(w.status(id)).toBe('done');
  }));

  it('falls back to the ordinary card when the grant is revoked between evaluation and dispatch', () => inDo('own-revoke-mid', async state => {
    const w = world(state, { grants: real => midway(real, () => real.revoke('g1')) });
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus());
    expect(w.writes).toEqual([]);
    expect(w.cards).toHaveLength(1);
    expect(w.status(id)).toBe('open');
    expect(w.desk.grantOutcome(id)).toBeNull();
    expect(w.logs.find(entry => entry.hop === 'grant_use')).toMatchObject({ ok: false, code: 'refused' });
  }));

  it('falls back to the card when the grant expires or the owner pauses before dispatch', () => inDo('own-expire-pause', async state => {
    const expiring = world(state, { grants: real => midway(real, () => expiring.clock.set(NOW + 2 * HOUR)) });
    expiring.grants.grant(terms({ expires_at: NOW + HOUR }), 'app');
    const first = await expiring.propose(focus());
    expect(expiring.status(first)).toBe('open');
    expect(expiring.writes).toEqual([]);
  }));

  it('a block that comes inside its lead time between evaluation and dispatch cards it', () => inDo('own-lead-mid', async state => {
    const w = world(state, { grants: real => midway(real, () => w.clock.set(NOW + 5 * HOUR - 10 * MIN)) });
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus(NOW + 5 * HOUR));
    expect(w.status(id)).toBe('open');
    expect(w.writes).toEqual([]);
    expect(w.logs.find(entry => entry.hop === 'grant_use')).toMatchObject({ ok: false, code: 'refused' });
  }));

  it('a granted change is claimed in the same commit as its reserve, so before it the row is still an ordinary unconfirmed card', () => inDo('own-claim-at-reserve', async state => {
    const row = () => state.storage.sql.exec<{ status: string; grant_json: string | null }>('SELECT status, grant_json FROM ledger').one();
    const before: { status: string; grant_json: string | null }[] = [];
    const w = world(state, { effects: real => ({ ...real, execute: (...args) => { before.push(row()); return real.execute(...args); } }) });
    w.grants.grant(terms(), 'app');
    await w.propose(focus());
    expect(before).toEqual([{ status: 'card_unconfirmed', grant_json: null }]);
    expect(row()).toMatchObject({ status: 'done', grant_json: expect.stringContaining('"grant_id":"g1"') });
  }));

  it('a run that stops before its reserve leaves no hidden granted row: the change is an ordinary card the owner sees', () => inDo('own-stop-before-reserve', async state => {
    const w = world(state, { effects: real => ({ ...real, execute: async () => { throw new Error('evicted'); } }) });
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus());
    expect(state.storage.sql.exec<{ grant_json: string | null }>('SELECT grant_json FROM ledger WHERE id = ?', id).one().grant_json).toBeNull();
    expect(w.effects.get('tool:1:apply')).toBeNull();
    expect(w.writes).toEqual([]);
    expect((await w.desk.approvals(NOW)).map(item => [item.approval_id, item.state])).toEqual([[id, 'open']]);
  }));

  it('a granted change whose outcome is unknown is listed as outcome unknown; one that is done stays out of the list', () => inDo('own-unknown-listed', async state => {
    const unknown = world(state, { createThrows: true });
    unknown.grants.grant(terms(), 'app');
    const id = await unknown.propose(focus());
    const listed = await unknown.desk.approvals(NOW);
    expect(listed.map(item => [item.approval_id, item.state, item.actions])).toEqual([[id, 'outcome_unknown', []]]);
    expect(await unknown.desk.approvals(NOW, { state: 'outcome_unknown' })).toHaveLength(1);
  }));

  it('a granted change that is done is not listed as an approval', () => inDo('own-done-unlisted', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    expect(w.status(await w.propose(focus()))).toBe('done');
    expect(await w.desk.approvals(NOW)).toEqual([]);
  }));

  it('pausing between evaluation and dispatch cards it', () => inDo('own-pause-mid', async state => {
    const w = world(state, { grants: real => midway(real, () => real.pause('app')) });
    w.grants.grant(terms(), 'app');
    expect(w.status(await w.propose(focus()))).toBe('open');
    expect(w.writes).toEqual([]);
  }));

  it('once the day\'s budget is used, the next block is a card', () => inDo('own-budget', async state => {
    const w = world(state);
    w.grants.grant(terms({ limits: { max_per_day: 1, timezone: 'Asia/Kolkata' } }), 'app');
    const first = await w.propose(focus(NOW + 5 * HOUR));
    const second = await w.propose(focus(NOW + 7 * HOUR, { title: 'Reading' }));
    expect([w.status(first), w.status(second)]).toEqual(['done', 'open']);
    expect(w.writes).toHaveLength(1);
    expect(w.cards).toHaveLength(1);
    expect(w.logs.filter(entry => entry.hop === 'grant_use').map(entry => entry.code)).toEqual(['done', 'budget']);
  }));

  it('an unknown provider outcome is reported as unknown, never done, and is not retried', () => inDo('own-unknown', async state => {
    const w = world(state, { createThrows: true });
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus());
    expect(w.status(id)).toBe('uncertain');
    expect(w.desk.grantOutcome(id)).toMatchObject({ state: 'outcome_unknown' });
    expect(w.writes).toHaveLength(1);
    expect(w.cards).toEqual([]);
  }));

  describe('a granted change whose outcome is unknown settles from its effect record when the owner next looks, and never runs again', () => {
    const row = (state: DurableObjectState) => state.storage.sql.exec<{ id: string; status: string; undo_json: string | null }>('SELECT id, status, undo_json FROM ledger').one();
    // An object stopped once at the given point of its first granted effect, as an eviction would stop it.
    const stoppedOnce = (at: 'after_reserve' | 'after_done') => (real: OwnerEffectLedger): OwnerEffectLedger => {
      let stopped = false;
      return { ...real, execute: async (intent, adapter, ...rest) => {
        if (stopped) return real.execute(intent, adapter, ...rest);
        stopped = true;
        if (at === 'after_reserve') real.reserve(intent, rest[0], rest[1], adapter.authorize);
        else await real.execute(intent, adapter, ...rest);
        throw new Error('evicted');
      } };
    };

    it('approving it again settles it in plain words, never an internal error, and runs nothing', () => inDo('settle-decide', async state => {
      const w = world(state, { effects: stoppedOnce('after_reserve') });
      w.grants.grant(terms(), 'app');
      const id = await w.propose(focus());
      const out = await w.desk.decide(id, 'a', 'retap');
      expect(out).toMatchObject({ toast: 'Not done', message: expect.stringContaining('nothing changed') });
      expect(out.message).not.toMatch(/identity|conflict|effect/i);
      expect([w.status(id), w.writes.length]).toEqual(['failed', 0]);
    }));

    it('approving one still unknown answers outcome unknown and writes nothing again', () => inDo('settle-decide-unknown', async state => {
      const w = world(state, { createThrows: true });
      w.grants.grant(terms(), 'app');
      const id = await w.propose(focus());
      expect((await w.desk.decide(id, 'a', 'retap')).toast).toBe('Outcome unknown');
      expect([w.status(id), w.writes.length]).toEqual(['uncertain', 1]);
    }));

    it('once the readback finds the block, the list read settles it done, with no undo a readback cannot make safe, and it leaves the list', () => inDo('settle-landed', async state => {
      const w = world(state, { createThrows: true });
      w.grants.grant(terms(), 'app');
      const id = await w.propose(focus());
      expect((await w.desk.approvals(NOW)).map(item => item.state)).toEqual(['outcome_unknown']);
      w.land(String((w.writes[0]![1] as { id: string }).id));
      expect(await w.desk.approvals(NOW)).toEqual([]);
      expect(row(state)).toMatchObject({ id, status: 'done', undo_json: null });
      expect(w.desk.grantOutcome(id)).toMatchObject({ state: 'done' });
      expect(w.writes).toHaveLength(1);
    }));

    it('an intent reserved but never sent is refused, not resumed: the row reads not done and nothing is written', () => inDo('settle-reserved', async state => {
      const w = world(state, { effects: stoppedOnce('after_reserve') });
      w.grants.grant(terms(), 'app');
      const id = await w.propose(focus());
      expect([w.status(id), w.effects.get('tool:1:apply')?.state]).toEqual(['uncertain', 'reserved']);
      expect(await w.desk.approvals(NOW)).toEqual([]);
      expect([w.status(id), w.effects.get('tool:1:apply')?.state]).toEqual(['failed', 'rejected']);
      expect(w.desk.grantOutcome(id)).toMatchObject({ state: 'not_done' });
      expect(w.writes).toEqual([]);
    }));

    it('an effect recorded done whose row was left unknown settles done from the record, with no second write', () => inDo('settle-recorded', async state => {
      const w = world(state, { effects: stoppedOnce('after_done') });
      w.grants.grant(terms(), 'app');
      const id = await w.propose(focus());
      expect([w.status(id), w.effects.get('tool:1:apply')?.state]).toEqual(['uncertain', 'done']);
      expect(await w.desk.approvals(NOW)).toEqual([]);
      expect(row(state)).toMatchObject({ status: 'done', undo_json: expect.stringContaining('"op":"cancel"') });
      expect(w.writes).toHaveLength(1);
    }));

    it('a row claimed with no effect record never reached Google, so it settles not done', () => inDo('settle-no-record', async state => {
      const w = world(state);
      const id = await w.propose(focus());
      state.storage.sql.exec("UPDATE ledger SET status = 'uncertain', grant_json = ? WHERE id = ?", JSON.stringify({ class: 'calendar.move_own_block', grant_id: 'g1', revision: 1 }), id);
      expect(await w.desk.approvals(NOW)).toEqual([]);
      expect(w.status(id)).toBe('failed');
      expect(w.writes).toEqual([]);
    }));
  });

  const cardsAsToday: readonly [string, ReturnType<typeof focus>, RunOrigin | undefined][] = [
    ['an outside-text run', focus(), 'external'],
    ['a run of unknown origin', focus(), undefined],
    ['another calendar of the owner\'s', focus(undefined, { calendar_id: 'team@group.calendar.google.com' }), 'owner'],
    ['a block with a guest', focus(undefined, { attendees: ['ann@example.com'], send_updates: 'none' }), 'owner'],
    ['a move of the owner\'s own event', { ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'u1' } as never, 'owner'],
    ['a cancel of the owner\'s own event', { action: 'cancel', event_id: 'u1', title: 'Focus', reason: 'x' } as never, 'owner'],
    ['a move of a block of Waldo\'s that now has a guest', { ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'x1' } as never, 'owner'],
    ['a cancel of a block of Waldo\'s from an outside-text run', { action: 'cancel', event_id: 'e1', title: 'Focus', reason: 'x' } as never, 'external'],
  ];
  for (const [name, change, origin] of cardsAsToday) {
    it(`cards ${name} under a matching grant, exactly as a desk with no grants does`, () => inDo(`own-cards-${name.replace(/\W+/g, '-')}`, async state => {
      const w = world(state);
      w.grants.grant(terms(), 'app');
      const id = await w.propose(change, origin);
      expect(w.writes).toEqual([]);
      expect(w.status(id)).toBe('open');
      const granted = state.storage.sql.exec<{ summary: string; payload_json: string }>('SELECT summary, payload_json FROM ledger WHERE id = ?', id).one();
      await inDo(`own-baseline-${name.replace(/\W+/g, '-')}`, async baselineState => {
        const baseline = world(baselineState, { grants: () => ({ enabled: () => false, ownBlock: () => ({ refused: 'off' }) }) });
        const baseId = await baseline.propose(change, origin);
        expect(baselineState.storage.sql.exec<{ summary: string; payload_json: string }>('SELECT summary, payload_json FROM ledger WHERE id = ?', baseId).one()).toEqual(granted);
        expect(baseline.cards).toEqual(w.cards);
      });
    }));
  }

  it('propose_calendar_change carries the turn\'s origin, and tells the model what a grant did', () => inDo('own-tool', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const propose = googleHandlers({ client: async () => w.client }, w.desk, { now: () => new Date(NOW), timezone: 'Asia/Kolkata' } as never).find(tool => tool.name === 'propose_calendar_change')!;
    const call = (origin: RunOrigin, slot: number) => propose.handle(focus(NOW + slot * HOUR) as never, { authenticatedUserId: 'owner-1', turnId: `t${slot}`, toolCallId: 'c1', runOrigin: origin } as never);
    expect(await call('owner', 5)).toMatchObject({ ok: true, data: { applied: true, status: expect.stringMatching(/^Done under your standing grant: Add "Focus"/) } });
    expect(await call('external', 7)).toMatchObject({ ok: true, data: { applied: false, status: expect.stringMatching(/^sent to the owner/) } });
    expect(w.writes).toHaveLength(1);
  }));

  it('a move of a recurring event Waldo created cards, and its stored change has only the keys a card had before', () => inDo('own-recurring', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose({ ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'r1' } as never);
    expect(w.writes).toEqual([]);
    expect(w.status(id)).toBe('open');
    expect(Object.keys(JSON.parse(state.storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM ledger WHERE id = ?', id).one().payload_json)).sort())
      .toEqual(['account', 'action', 'block', 'end', 'event_id', 'operation_ref', 'reason', 'seen_end', 'seen_etag', 'seen_start', 'start', 'time_zone', 'title']);
  }));

  it('a desk without the grant store cards every proposal', () => inDo('own-no-store', async state => {
    const writes: unknown[] = [];
    const desk = approvalDesk(state.storage.sql, { call: async () => ({ message_id: 1 }), owner: 42, google: async () => ({ account: { email: ACCOUNT }, createEvent: async () => { writes.push(1); return {}; } }) as unknown as GoogleClient,
      newId: () => 'x', now: () => NOW, timezone: 'Asia/Kolkata', log: () => undefined, effects: ownerEffectLedger(state.storage, () => NOW) });
    const id = await desk.propose(focus(), 'turn', 'tool:x', { origin: 'owner' });
    expect(writes).toEqual([]);
    expect(desk.grantOutcome(id)).toBeNull();
  }));

  it('falsifier: a grant-backed move of an event Waldo did not create raises a card, never a write', () => inDo('own-falsifier', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose({ ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'u1' } as never);
    expect(w.writes).toEqual([]);
    expect(w.cards).toHaveLength(1);
    expect(w.status(id)).toBe('open');
    expect(w.logs.find(entry => entry.hop === 'grant_eval')).toMatchObject({ detail: 'not_waldo_made' });
    // The same move of Waldo's own block runs.
    expect(w.status(await w.propose({ ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'e1' } as never))).toBe('done');
  }));

  it('removes a block Waldo created, undoable until it would have started', () => inDo('own-cancel', async state => {
    const w = world(state, { undoCancels: true });
    w.grants.grant(terms(), 'app');
    const id = await w.propose({ action: 'cancel', event_id: 'e1', title: 'Focus', reason: 'the day moved' } as never);
    expect(w.cards).toEqual([]);
    expect(w.writes.map(write => write.slice(0, 2))).toEqual([['cancel', 'e1']]);
    expect(w.status(id)).toBe('done');
    w.clock.set(NOW + 4 * HOUR);
    expect((await w.desk.decide(id, 'u', 't')).toast).toBe('Undone');
    expect(w.writes.at(-1)![0]).toBe('restore');
  }));

  it('a remove that could not be undone cards instead', () => inDo('own-cancel-no-undo', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose({ action: 'cancel', event_id: 'e1', title: 'Focus', reason: 'the day moved' } as never);
    expect(w.writes).toEqual([]);
    expect(w.status(id)).toBe('open');
  }));

  it('marks what Waldo creates only while grants can act', () => inDo('own-mark-off', async state => {
    const w = world(state, { grants: real => ({ enabled: () => false, ownBlock: real.ownBlock }) });
    const id = await w.propose(focus());
    await w.desk.decide(id, 'a', 't', { surface: 'telegram', messageRef: '42:1' });
    expect(w.status(id)).toBe('done');
    expect(w.writes[0]![1]).not.toHaveProperty('made');
    await inDo('own-mark-on', async onState => {
      const on = world(onState);
      const approved = await on.propose(focus(undefined, { attendees: ['ann@example.com'], send_updates: 'none' }));
      await on.desk.decide(approved, 'a', 't', { surface: 'telegram', messageRef: '42:1' });
      expect(on.writes[0]![1]).toMatchObject({ made: true });
    });
  }));

  it('the 10-minute undo of a card the owner approved is unchanged', () => inDo('own-card-undo', async state => {
    const w = world(state);
    const id = await w.propose(focus(undefined, { calendar_id: undefined }));
    await w.desk.decide(id, 'a', 't', { surface: 'telegram', messageRef: '42:1' });
    expect(w.status(id)).toBe('done');
    w.clock.set(NOW + UNDO_WINDOW_MS + 1);
    expect((await w.desk.decide(id, 'u', 't')).toast).toBe('Too late to undo');
  }));
});
