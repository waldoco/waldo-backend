import { describe, expect, it } from 'vitest';
import { FixtureAuthorityClock } from '../evals/fixture-authority';

const fixture = () => ({
  candidate_owner: 'a', control_owner: 'b', world: { clock: '2026-10-05T08:00:00+05:30', owners: [{ id: 'a' }, { id: 'b' }], sources: {} },
  grants: [{ owner_id: 'a', purpose: 'synthetic reschedule', scope: 'calendar-only', allowed_effects: ['calendar.move'], effective_at: '2026-10-05T08:00:00+05:30', expires_at: '2026-10-05T09:00:00+05:30' }],
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
    const readOnly = new FixtureAuthorityClock({ ...fixture(), grants: [{ ...fixture().grants[0]!, scope: 'read only', allowed_effects: [] }] });
    readOnly.advance('2026-10-05T08:30:00+05:30');
    expect(readOnly.snapshot('a').permitted_effects).toEqual([]);
    clock.advance('2026-10-05T09:00:00+05:30');
    expect(clock.snapshot('a').permitted_effects).toEqual([]);
    expect(new FixtureAuthorityClock(fixture()).snapshot('a').active_branches).toEqual([]);
    expect(() => clock.advance('2026-10-05T08:00:00+05:30')).toThrow(/backward/);
  });
  it('rejects malformed identities, intervals and duplicate or unbound branch IDs', () => {
    expect(() => new FixtureAuthorityClock({ ...fixture(), world: { ...fixture().world, owners: [{ id: 'a' }, { id: 'a' }] } })).toThrow(/owners/);
    expect(() => new FixtureAuthorityClock({ ...fixture(), grants: [{ ...fixture().grants[0]!, expires_at: '2026-10-05T08:00:00+05:30' }] })).toThrow(/grant/);
    expect(() => new FixtureAuthorityClock({ ...fixture(), branches: [...fixture().branches, ...fixture().branches] })).toThrow(/branch/);
    expect(() => new FixtureAuthorityClock({ ...fixture(), grants: [{ ...fixture().grants[0]!, allowed_effects: ['calendar.move','calendar.move'] }] })).toThrow(/grant/);
    expect(() => new FixtureAuthorityClock({ ...fixture(), branches: [{ ...fixture().branches[0]!, owner_id: 'x' }] })).toThrow(/owner/);
  });
});
it('old branch cannot revive under a later grant; only a separate newly covered branch becomes active',()=>{
 const f=fixture();const later={...f.grants[0]!,effective_at:'2026-10-05T09:00:00+05:30',expires_at:'2026-10-05T10:00:00+05:30'};
 const clock=new FixtureAuthorityClock({...f,grants:[...f.grants,later]});clock.advance('2026-10-05T09:15:00+05:30');expect(clock.snapshot('a').permitted_effects).toEqual([]);expect(clock.snapshot('a').active_branches).toEqual([]);
 const fresh=new FixtureAuthorityClock({...f,grants:[...f.grants,later],branches:[...f.branches,{...f.branches[0]!,id:'new-approval',trigger_at:'2026-10-05T09:10:00+05:30'}]});fresh.advance('2026-10-05T09:15:00+05:30');expect(fresh.snapshot('a').permitted_effects).toEqual(['calendar.move']);expect(fresh.snapshot('a').active_branches.map(b=>b.id)).toEqual(['new-approval']);
});
it('ambiguous overlapping grants never silently substitute to cover one branch',()=>{
 const f=fixture();const clock=new FixtureAuthorityClock({...f,grants:[...f.grants,{...f.grants[0]!,purpose:'unrelated overlap'}]});clock.advance('2026-10-05T08:40:00+05:30');expect(clock.snapshot('a').permitted_effects).toEqual([]);
});
