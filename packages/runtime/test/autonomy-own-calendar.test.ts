import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppAutonomyGrantTermsV1 } from '../../contracts/src/app/autonomy';
import type { RunOrigin } from '../../contracts/src/runtime/standing-grant';
import { approvalDesk, UNDO_WINDOW_MS } from '../src/channels/approvals';
import { readAccessLog } from '../src/channels/dashboard-access-log';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { standingGrants, type OwnBlockChange } from '../src/channels/standing-grants';
import type { GoogleClient } from '../src/connectors/google';
import { googleHandlers } from '../src/tools/live/google';

// Tuesday 3 Nov 2026, 09:00 in Kolkata.
const NOW = Date.UTC(2026, 10, 3, 3, 30);
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
const OWN = 'waldo-cal@group.calendar.google.com';
const ACCOUNT = 'sam@example.com';
const iso = (ms: number) => new Date(ms).toISOString() as never;
const terms = (over: Partial<AppAutonomyGrantTermsV1> = {}): AppAutonomyGrantTermsV1 => ({
  scope: { class: 'calendar.move_own_block', account: ACCOUNT, window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
  limits: { max_per_day: 3, timezone: 'Asia/Kolkata' }, valid_from: NOW - DAY, expires_at: NOW + 30 * DAY, ...over,
});
const focus = (startMs = NOW + 5 * HOUR, over: Record<string, unknown> = {}) =>
  ({ action: 'create' as const, title: 'Focus', start: iso(startMs), end: iso(startMs + HOUR), reason: 'plan the day', calendar_id: OWN, block: 'deep_work' as const, ...over });

type Grants = ReturnType<typeof standingGrants>;
const world = (state: DurableObjectState, options: Readonly<{ grants?: (real: Grants) => Pick<Grants, 'ownBlock'>; createThrows?: boolean }> = {}) => {
  let now = NOW, n = 0, g = 0;
  const writes: unknown[][] = [];
  const cards: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const client = {
    account: { connection_id: `local:${ACCOUNT}`, email: ACCOUNT },
    event: async (id: string, calendarId?: string) => ({ id, title: 'Focus', start: iso(NOW + 5 * HOUR), end: iso(NOW + 6 * HOUR), all_day: false, etag: id === 'e1' || id === 'r1' ? 'v1' : 'v2', calendar: calendarId, ...(id === 'r1' ? { recurring_event_id: 'series' } : {}) }),
    createEvent: async (input: Record<string, unknown>) => { writes.push(['create', input]); if (options.createThrows) throw new Error('socket closed'); return { id: String(input.id), title: 'Focus', start: '', end: '', all_day: false, etag: 'v2' }; },
    moveEvent: async (...args: unknown[]) => { writes.push(['move', ...args]); return { id: 'e1', title: 'Focus', start: '', end: '', all_day: false, etag: 'v3' }; },
    cancelEvent: async (...args: unknown[]) => { writes.push(['cancel', ...args]); },
  } as unknown as GoogleClient;
  const real = standingGrants(state.storage, { now: () => now, newId: () => `g${++g}`, enabled: () => true, ownerRef: () => 'owner-1', ownCalendar: account => account === ACCOUNT ? OWN : null });
  const effects = ownerEffectLedger(state.storage, () => now);
  const desk = approvalDesk(state.storage.sql, {
    call: async (method, body) => { if (method === 'sendMessage') cards.push(String((body as { text?: string }).text)); return { message_id: cards.length }; },
    owner: 42, google: async () => client, newId: () => String(++n), now: () => now, timezone: 'Asia/Kolkata', log: entry => logs.push(entry as Record<string, unknown>),
    effects, ownerRef: () => 'owner-1', grants: options.grants ? options.grants(real) : real,
  });
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const propose = (p: ReturnType<typeof focus>, ...origin: [RunOrigin | undefined] | []) => desk.propose(p, 'turn-1', `tool:${n + 1}`, { origin: origin.length ? origin[0] : 'owner' });
  return { desk, client, grants: real, writes, cards, logs, status, propose, effects, clock: { set: (ms: number) => { now = ms; } } };
};
const inDo = (name: string, run: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), (_instance, state) => run(state));

describe('calendar.move_own_block: Waldo places and moves its own blocks without a card', () => {
  it('golden path: evaluate, reserve with the recheck, write, report; then undo until the block starts', () => inDo('own-golden', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus());
    expect(w.cards).toEqual([]);
    expect(w.writes).toHaveLength(1);
    expect(w.writes[0]![1]).toMatchObject({ calendarId: OWN, title: 'Focus' });
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

  it('moves an own block, keeping the move undoable', () => inDo('own-move', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose({ ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'e1' } as never);
    expect(w.cards).toEqual([]);
    expect(w.writes[0]!.slice(0, 2)).toEqual(['move', 'e1']);
    expect(w.status(id)).toBe('done');
  }));

  it('falls back to the ordinary card when the grant is revoked between evaluation and dispatch', () => inDo('own-revoke-mid', async state => {
    const w = world(state, { grants: real => ({ ownBlock: (change: OwnBlockChange, origin: RunOrigin | undefined) => { const decision = real.ownBlock(change, origin); real.revoke('g1'); return decision; } }) });
    w.grants.grant(terms(), 'app');
    const id = await w.propose(focus());
    expect(w.writes).toEqual([]);
    expect(w.cards).toHaveLength(1);
    expect(w.status(id)).toBe('open');
    expect(w.desk.grantOutcome(id)).toBeNull();
    expect(w.logs.find(entry => entry.hop === 'grant_use')).toMatchObject({ ok: false, code: 'refused' });
  }));

  it('falls back to the card when the grant expires or the owner pauses before dispatch', () => inDo('own-expire-pause', async state => {
    const expiring = world(state, { grants: real => ({ ownBlock: (change: OwnBlockChange, origin: RunOrigin | undefined) => { const decision = real.ownBlock(change, origin); expiring.clock.set(NOW + 2 * HOUR); return decision; } }) });
    expiring.grants.grant(terms({ expires_at: NOW + HOUR }), 'app');
    const first = await expiring.propose(focus());
    expect(expiring.status(first)).toBe('open');
    expect(expiring.writes).toEqual([]);
  }));

  it('pausing between evaluation and dispatch cards it', () => inDo('own-pause-mid', async state => {
    const w = world(state, { grants: real => ({ ownBlock: (change: OwnBlockChange, origin: RunOrigin | undefined) => { const decision = real.ownBlock(change, origin); real.pause('app'); return decision; } }) });
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

  const cardsAsToday: readonly [string, ReturnType<typeof focus>, RunOrigin | undefined][] = [
    ['an outside-text run', focus(), 'external'],
    ['a run of unknown origin', focus(), undefined],
    ['the primary calendar', focus(undefined, { calendar_id: undefined }), 'owner'],
    ['a block with a guest', focus(undefined, { attendees: ['ann@example.com'], send_updates: 'none' }), 'owner'],
    ['a cancel of an own block', { action: 'cancel', event_id: 'e1', title: 'Focus', reason: 'x', calendar_id: OWN } as never, 'owner'],
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
        const baseline = world(baselineState, { grants: () => ({ ownBlock: () => ({ refused: 'off' }) }) });
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

  it('a move of a recurring event on Waldo\'s calendar cards, and its stored change has only the keys a card had before', () => inDo('own-recurring', async state => {
    const w = world(state);
    w.grants.grant(terms(), 'app');
    const id = await w.propose({ ...focus(NOW + 7 * HOUR), action: 'move', event_id: 'r1' } as never);
    expect(w.writes).toEqual([]);
    expect(w.status(id)).toBe('open');
    expect(Object.keys(JSON.parse(state.storage.sql.exec<{ payload_json: string }>('SELECT payload_json FROM ledger WHERE id = ?', id).one().payload_json)).sort())
      .toEqual(['account', 'action', 'block', 'calendar_id', 'end', 'event_id', 'operation_ref', 'reason', 'seen_end', 'seen_etag', 'seen_start', 'start', 'time_zone', 'title']);
  }));

  it('a desk without the grant store cards every proposal', () => inDo('own-no-store', async state => {
    const writes: unknown[] = [];
    const desk = approvalDesk(state.storage.sql, { call: async () => ({ message_id: 1 }), owner: 42, google: async () => ({ account: { email: ACCOUNT }, createEvent: async () => { writes.push(1); return {}; } }) as unknown as GoogleClient,
      newId: () => 'x', now: () => NOW, timezone: 'Asia/Kolkata', log: () => undefined, effects: ownerEffectLedger(state.storage, () => NOW) });
    const id = await desk.propose(focus(), 'turn', 'tool:x', { origin: 'owner' });
    expect(writes).toEqual([]);
    expect(desk.grantOutcome(id)).toBeNull();
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
