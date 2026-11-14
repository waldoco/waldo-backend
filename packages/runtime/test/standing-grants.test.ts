import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { AppAutonomyGrantTermsV1 } from '../../contracts/src/app/autonomy';
import { standingGrants, type OwnBlockChange } from '../src/channels/standing-grants';

// Tuesday 3 Nov 2026, 09:00 in Kolkata (03:30 UTC).
const NOW = Date.UTC(2026, 10, 3, 3, 30);
const DAY = 86_400_000;
const MIN = 60_000;
const terms = (over: Partial<AppAutonomyGrantTermsV1> = {}): AppAutonomyGrantTermsV1 => ({
  scope: { class: 'calendar.move_own_block', account: 'sam@example.com', window: { from: '08:00', to: '19:00' }, weekdays: [1, 2, 3, 4, 5], min_lead_minutes: 30 },
  limits: { max_per_day: 3, timezone: 'Asia/Kolkata' }, valid_from: NOW - DAY, expires_at: NOW + 30 * DAY, ...over,
});
// 14:00 to 15:00 Kolkata today, on the primary calendar.
const block = (over: Partial<OwnBlockChange> = {}): OwnBlockChange => ({ action: 'create', account: 'sam@example.com',
  start: new Date(NOW + 5 * 60 * MIN).toISOString(), end: new Date(NOW + 6 * 60 * MIN).toISOString(), ...over });
// A block Waldo created, read back with its mark, as a move or a cancel sees it.
const own = (over: Partial<OwnBlockChange> = {}): OwnBlockChange => block({ action: 'move', event_id: 'e1', seen_start: block().start!, seen_end: block().end!, seen_made: true, ...over });
const removal = (over: Partial<OwnBlockChange> = {}): OwnBlockChange => own({ action: 'cancel', start: null, end: null, ...over });

const withGrants = (name: string, run: (g: ReturnType<typeof standingGrants>, clock: { set(ms: number): void }, flags: { on: boolean }) => Promise<void> | void) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`${name}-${crypto.randomUUID()}`)), async (_instance, state) => {
    let now = NOW, n = 0;
    const flags = { on: true };
    const grants = standingGrants(state.storage, { now: () => now, newId: () => `g${++n}`, enabled: () => flags.on, ownerRef: () => 'owner-1' });
    await run(grants, { set: ms => { now = ms; } }, flags);
  });

describe('standing grants: the store', () => {
  it('stores a grant, raises its revision on a change, and ends it on revoke', () => withGrants('store', grants => {
    const first = grants.grant(terms(), 'app');
    expect(first).toMatchObject({ grant_id: 'g1', revision: 1, created_via: 'app', ended: null });
    expect(grants.change('g1', terms({ limits: { max_per_day: 5, timezone: 'Asia/Kolkata' } })).revision).toBe(2);
    expect(grants.revoke('g1')).toBe(true);
    expect(grants.list()[0]).toMatchObject({ grant_id: 'g1', revision: 2, ended: { at: NOW, reason: 'revoked' } });
    expect(grants.revoke('g1')).toBe(false);
    expect(() => grants.change('g1', terms())).toThrow(/ended/);
  }));

  it('refuses terms the contract refuses', () => withGrants('store-invalid', grants => {
    expect(() => grants.grant(terms({ expires_at: NOW + 91 * DAY }), 'app')).toThrow();
    expect(() => grants.grant({ ...terms(), limits: { max_per_day: 21, timezone: 'UTC' } }, 'app')).toThrow();
    expect(grants.list()).toEqual([]);
  }));
});

describe('standing grants: calendar.move_own_block eligibility (host bounds only)', () => {
  it('a block Waldo places, moves or removes on the primary calendar within the grant is authorized, with a class-and-account budget', () => withGrants('eligible', grants => {
    grants.grant(terms(), 'app');
    const decision = grants.ownBlock(block(), 'owner');
    expect(decision).toMatchObject({ use: { grant_id: 'g1', revision: 1, class: 'calendar.move_own_block',
      quota: { owner_ref: 'owner-1', grant_ref: 'calendar.move_own_block:sam@example.com', area: 'calendar', action: 'own_block', local_day: '2026-11-03', timezone: 'Asia/Kolkata', max_per_day: 3 } } });
    expect('use' in decision && decision.use.authorize()).toBe(true);
    expect(grants.ownBlock(own(), 'waldo')).toHaveProperty('use');
    expect(grants.ownBlock(removal(), 'owner')).toHaveProperty('use');
    expect(grants.ownBlock(block(), 'owner_standing')).toHaveProperty('use');
    for (const calendar_id of ['primary', 'sam@example.com', 'Sam@Example.com']) expect(grants.ownBlock(block({ calendar_id }), 'owner')).toHaveProperty('use');
  }));

  it('a new revision keeps the day\'s budget key, so a change never resets the count', () => withGrants('budget-key', grants => {
    grants.grant(terms(), 'app');
    const before = grants.ownBlock(block(), 'owner');
    grants.change('g1', terms({ limits: { max_per_day: 5, timezone: 'Asia/Kolkata' } }));
    const after = grants.ownBlock(block(), 'owner');
    expect('use' in before && 'use' in after && after.use.quota.grant_ref).toBe('use' in before && before.use.quota.grant_ref);
  }));

  const refusals: readonly [string, (g: ReturnType<typeof standingGrants>) => unknown, string][] = [
    ['no grant', g => g.ownBlock(block(), 'owner'), 'no_grant'],
    ['an outside-text run', g => { g.grant(terms(), 'app'); return g.ownBlock(block(), 'external'); }, 'origin'],
    ['a run of unknown origin', g => { g.grant(terms(), 'app'); return g.ownBlock(block(), undefined); }, 'origin'],
    ['another calendar of the owner\'s', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ calendar_id: 'team@group.calendar.google.com' }), 'owner'); }, 'not_primary'],
    ['a calendar id that only looks like the account', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ calendar_id: 'sam@example.com ' }), 'owner'); }, 'not_primary'],
    ['a move of an event Waldo did not create', g => { g.grant(terms(), 'app'); return g.ownBlock(own({ seen_made: undefined }), 'owner'); }, 'not_waldo_made'],
    ['a cancel of an event Waldo did not create', g => { g.grant(terms(), 'app'); return g.ownBlock(removal({ seen_made: undefined }), 'owner'); }, 'not_waldo_made'],
    ['another account (no grant there)', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ account: 'other@example.com' }), 'owner'); }, 'no_grant'],
    ['guests', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ attendees: ['ann@example.com'] }), 'owner'); }, 'shape'],
    ['emailing', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ send_updates: 'none' }), 'owner'); }, 'shape'],
    ['a rename', g => { g.grant(terms(), 'app'); return g.ownBlock(own({ rename_to: 'x' }), 'owner'); }, 'shape'],
    ['a place', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ location: 'Office' }), 'owner'); }, 'shape'],
    ['notes', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ description: 'call 555' }), 'owner'); }, 'shape'],
    ['a Meet link', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ add_meet_link: true }), 'owner'); }, 'shape'],
    ['a cancel that emails', g => { g.grant(terms(), 'app'); return g.ownBlock(removal({ send_updates: 'all' }), 'owner'); }, 'shape'],
    ['a recurring event of Waldo\'s', g => { g.grant(terms(), 'app'); return g.ownBlock(own({ seen_recurring: true }), 'owner'); }, 'shape'],
    ['an event of Waldo\'s that now has guests', g => { g.grant(terms(), 'app'); return g.ownBlock(own({ seen_guests: 2 }), 'owner'); }, 'shape'],
    ['removing an event of Waldo\'s that now has guests', g => { g.grant(terms(), 'app'); return g.ownBlock(removal({ seen_guests: 1 }), 'owner'); }, 'shape'],
    ['before the window', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ start: new Date(NOW - 2 * 60 * MIN + DAY).toISOString(), end: new Date(NOW - 60 * MIN + DAY).toISOString() }), 'owner'); }, 'outside_bounds'],
    ['past the window', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ end: new Date(NOW + 11 * 60 * MIN).toISOString() }), 'owner'); }, 'outside_bounds'],
    ['a weekday not granted (Sunday)', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ start: new Date(NOW + 5 * DAY + 5 * 60 * MIN).toISOString(), end: new Date(NOW + 5 * DAY + 6 * 60 * MIN).toISOString() }), 'owner'); }, 'outside_bounds'],
    ['across midnight', g => { g.grant(terms({ scope: { class: 'calendar.move_own_block', account: 'sam@example.com', window: { from: '00:00', to: '23:59' }, weekdays: [0, 1, 2, 3, 4, 5, 6], min_lead_minutes: 30 } }), 'app');
      return g.ownBlock(block({ start: new Date(NOW + 14 * 60 * MIN).toISOString(), end: new Date(NOW + 16 * 60 * MIN).toISOString() }), 'owner'); }, 'outside_bounds'],
    ['an unreadable time', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ start: 'soon' }), 'owner'); }, 'outside_bounds'],
    ['too soon', g => { g.grant(terms(), 'app'); return g.ownBlock(block({ start: new Date(NOW + 10 * MIN).toISOString() }), 'owner'); }, 'lead'],
    ['moving a block about to start', g => { g.grant(terms(), 'app'); return g.ownBlock(own({ seen_start: new Date(NOW + 10 * MIN).toISOString(), seen_end: new Date(NOW + 70 * MIN).toISOString() }), 'owner'); }, 'lead'],
    ['removing a block about to start', g => { g.grant(terms(), 'app'); return g.ownBlock(removal({ seen_start: new Date(NOW + 10 * MIN).toISOString(), seen_end: new Date(NOW + 70 * MIN).toISOString() }), 'owner'); }, 'lead'],
    ['removing a block outside the window', g => { g.grant(terms(), 'app'); return g.ownBlock(removal({ seen_end: new Date(NOW + 11 * 60 * MIN).toISOString() }), 'owner'); }, 'outside_bounds'],
    ['removing an all-day event (no time read)', g => { g.grant(terms(), 'app'); return g.ownBlock(removal({ seen_start: undefined, seen_end: undefined }), 'owner'); }, 'outside_bounds'],
    ['an expired grant', g => { g.grant(terms({ valid_from: NOW - 30 * DAY, expires_at: NOW }), 'app'); return g.ownBlock(block(), 'owner'); }, 'no_grant'],
    ['a grant not yet valid', g => { g.grant(terms({ valid_from: NOW + 1, expires_at: NOW + DAY }), 'app'); return g.ownBlock(block(), 'owner'); }, 'no_grant'],
    ['a revoked grant', g => { g.grant(terms(), 'app'); g.revoke('g1'); return g.ownBlock(block(), 'owner'); }, 'no_grant'],
    ['a paused owner', g => { g.grant(terms(), 'app'); g.pause('app'); return g.ownBlock(block(), 'owner'); }, 'paused'],
  ];
  for (const [name, decide, reason] of refusals) {
    it(`cards ${name}`, () => withGrants(`refuse-${name.replace(/\W+/g, '-')}`, grants => {
      expect(decide(grants)).toEqual({ refused: reason });
    }));
  }

  it('cards everything with the switch off, grants and all', () => withGrants('off', (grants, _clock, flags) => {
    grants.grant(terms(), 'app');
    flags.on = false;
    expect(grants.ownBlock(block(), 'owner')).toEqual({ refused: 'off' });
  }));
});

describe('standing grants: the recheck at dispatch', () => {
  const evaluated = (grants: ReturnType<typeof standingGrants>) => {
    const decision = grants.ownBlock(block(), 'owner');
    if (!('use' in decision)) throw new Error('expected a grant');
    return decision.use.authorize;
  };
  it('fails after a revoke', () => withGrants('recheck-revoke', grants => { grants.grant(terms(), 'app'); const authorize = evaluated(grants); grants.revoke('g1'); expect(authorize()).toBe(false); }));
  it('fails after a change to the terms', () => withGrants('recheck-change', grants => { grants.grant(terms(), 'app'); const authorize = evaluated(grants); grants.change('g1', terms()); expect(authorize()).toBe(false); }));
  it('fails while paused, and holds again on resume', () => withGrants('recheck-pause', grants => {
    grants.grant(terms(), 'app');
    const authorize = evaluated(grants);
    grants.pause('whatsapp');
    expect(grants.paused()).toEqual({ at: NOW, via: 'whatsapp' });
    expect(authorize()).toBe(false);
    grants.resume();
    expect(authorize()).toBe(true);
  }));
  it('fails at the expiry instant', () => withGrants('recheck-expiry', (grants, clock) => {
    grants.grant(terms({ expires_at: NOW + 60 * MIN }), 'app');
    const authorize = evaluated(grants);
    clock.set(NOW + 60 * MIN);
    expect(authorize()).toBe(false);
  }));
  it('fails with the switch turned off', () => withGrants('recheck-off', (grants, _clock, flags) => { grants.grant(terms(), 'app'); const authorize = evaluated(grants); flags.on = false; expect(authorize()).toBe(false); }));
});
