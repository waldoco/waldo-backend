import { describe, expect, it } from 'vitest';
import { FixtureAuthorityClock } from '../evals/fixture-authority';

const fixture = () => ({
  candidate_owner: 'a', control_owner: 'b', world: { clock: '2026-10-05T08:00:00+05:30', owners: [{ id: 'a' }, { id: 'b' }], sources: {} },
  grants: [{ owner_id: 'a', purpose: 'synthetic reschedule', scope: 'calendar-only', effective_at: '2026-10-05T08:00:00+05:30', expires_at: '2026-10-05T09:00:00+05:30' }],
  branches: [{ id: 'exact-approval', trigger_at: '2026-10-05T08:30:00+05:30', owner_id: 'a', permitted_effects: ['calendar.move'] }],
});
describe('evaluator-only fixture authority clock, not a real grant', () => {
  it('activates a branch only at its time under a current synthetic grant, then expires it', () => {
    const clock = new FixtureAuthorityClock(fixture());
    expect(clock.snapshot('a').permitted_effects).toEqual([]);
    clock.advance('2026-10-05T08:29:59+05:30');
    expect(clock.snapshot('a').permitted_effects).toEqual([]);
    clock.advance('2026-10-05T08:30:00+05:30');
    expect(clock.snapshot('a').permitted_effects).toEqual(['calendar.move']);
    expect(clock.snapshot('b').permitted_effects).toEqual([]);
    clock.advance('2026-10-05T09:00:00+05:30');
    expect(clock.snapshot('a').permitted_effects).toEqual([]);
    expect(new FixtureAuthorityClock(fixture()).snapshot('a').active_branches).toEqual([]);
    expect(() => clock.advance('2026-10-05T08:00:00+05:30')).toThrow(/backward/);
  });
  it('rejects malformed identities, intervals and duplicate or unbound branch IDs', () => {
    expect(() => new FixtureAuthorityClock({ ...fixture(), world: { ...fixture().world, owners: [{ id: 'a' }, { id: 'a' }] } })).toThrow(/owners/);
    expect(() => new FixtureAuthorityClock({ ...fixture(), grants: [{ ...fixture().grants[0]!, expires_at: '2026-10-05T08:00:00+05:30' }] })).toThrow(/grant/);
    expect(() => new FixtureAuthorityClock({ ...fixture(), branches: [...fixture().branches, ...fixture().branches] })).toThrow(/branch/);
    expect(() => new FixtureAuthorityClock({ ...fixture(), branches: [{ ...fixture().branches[0]!, owner_id: 'x' }] })).toThrow(/owner/);
  });
});
