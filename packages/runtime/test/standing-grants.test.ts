import { describe, expect, it } from 'vitest';
import type { StandingGrant } from '@waldo/contracts';
import { StandingGrantModule, type StandingGrantStore, type GrantAction } from '../src/channels/standing-grants';

const grant: StandingGrant = {
  id: 'sam-reminders', owner_ref: 'owner', area: 'mail', action: 'send_email',
  constraints: { recipients: ['sam@example.com'], accounts: ['personal'], content_kinds: ['reminder'] },
  mode: 'auto', created_from: { surface: 'telegram', message_ref: 'message-1' }, revision: 1,
};
const action: GrantAction = {
  owner_ref: 'owner', area: 'mail', action: 'send_email', recipients: ['sam@example.com'],
  accounts: ['personal'], content_kind: 'reminder', source_taint: null,
};
const now = Date.parse('2026-11-01T05:15:00Z');
const fixture = (usage?: (input: unknown) => Promise<number>) => {
  const grants = new Map<string, StandingGrant>();
  const modes = new Map<string, 'ask' | 'tell' | 'auto'>();
  const store: StandingGrantStore = {
    list: (owner) => [...grants.values()].filter(g => g.owner_ref === owner),
    get: (owner, id) => grants.get(`${owner}:${id}`) ?? null,
    put: g => { grants.set(`${g.owner_ref}:${g.id}`, structuredClone(g)); },
    getMode: (owner, area) => modes.get(`${owner}:${area}`) ?? null,
    putMode: (owner, area, mode) => { modes.set(`${owner}:${area}`, mode); },
  };
  let n = 0;
  const module = new StandingGrantModule(store, () => now, () => `proposal-${++n}`, usage ? { count: usage } : undefined);
  const approve = (g = grant) => {
    const proposal = module.propose('owner', g);
    module.confirm('owner', proposal.id, proposal.grant);
    module.setMode('owner', g.area, 'auto');
  };
  return { module, store, approve };
};

describe('owner standing permissions', () => {
  it('a habit or proposed permission alone cannot authorize reminders to Sam', async () => {
    const { module } = fixture();
    module.propose('owner', grant);
    expect(module.list('owner')).toEqual([]);
    expect(await module.evaluate(action, 'America/New_York')).toEqual({ disposition: 'card' });
  });
  it('starts every area in ask until explicitly changed', async () => {
    const { module } = fixture();
    const p = module.propose('owner', grant); module.confirm('owner', p.id, p.grant);
    expect(await module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
  });
  it('confirmed reminder permission makes only that exact shape eligible', async () => {
    const { module, approve } = fixture(); approve();
    expect(await module.evaluate(action, 'America/New_York')).toEqual({ disposition: 'eligible', grant_ref: grant.id, revision: 1 });
  });
  it.each([
    { owner_ref: 'other' }, { area: 'calendar' }, { action: 'reply_email' },
    { recipients: ['other@example.com'] }, { recipients: ['sam@example.com', 'hidden@example.com'] },
    { recipients: [] }, { recipients: undefined }, { accounts: ['work'] }, { accounts: undefined },
    { content_kind: 'reply' }, { content_kind: undefined },
  ])('does not extend permission to %j', async change => {
    const { module, approve } = fixture(); approve();
    expect(await module.evaluate({ ...action, ...change } as GrantAction, 'UTC')).toEqual({ disposition: 'card' });
  });
  it('matches every calendar and amount constraint without currency conversion', async () => {
    const { module, approve } = fixture();
    approve({ ...grant, constraints: { calendars: ['primary'], amount_max: { currency: 'USD', value: 10 } } });
    const scoped = { ...action, calendars: ['primary'], amount: { currency: 'USD', value: 10 } };
    expect((await module.evaluate(scoped, 'UTC')).disposition).toBe('eligible');
    for (const change of [{ calendars: ['work'] }, { calendars: undefined }, { amount: undefined },
      { amount: { currency: 'INR', value: 1 } }, { amount: { currency: 'USD', value: 11 } },
      { amount: { currency: 'USD', value: -1 } }, { amount: { currency: 'USD', value: NaN } }]) {
      expect((await module.evaluate({ ...scoped, ...change }, 'UTC')).disposition).toBe('card');
    }
  });
  it('revoke after eligibility restores the card, including on a retry', async () => {
    const { module, approve } = fixture(); approve();
    expect((await module.evaluate(action, 'UTC')).disposition).toBe('eligible');
    expect(module.revoke('other', grant.id)).toBe(false);
    expect(module.revoke('owner', grant.id)).toBe(true);
    expect(await module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
    expect(await module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
  });
  it('external taint still requires a card under auto', async () => {
    const { module, approve } = fixture(); approve();
    expect(await module.evaluate({ ...action, source_taint: 'external' }, 'UTC')).toEqual({ disposition: 'card' });
  });
  it('counts a local calendar day from the ledger and cards exhausted grants', async () => {
    const queries: unknown[] = [];
    const { module, approve } = fixture(async input => { queries.push(input); return 2; });
    approve({ ...grant, constraints: { ...grant.constraints, max_per_day: 2 } });
    expect(await module.evaluate(action, 'America/New_York')).toEqual({ disposition: 'card' });
    expect(queries).toEqual([{ owner_ref: 'owner', grant_ref: grant.id, area: 'mail', action: 'send_email', local_day: '2026-11-01', timezone: 'America/New_York' }]);
  });
  it('rechecks revocation after an asynchronous ledger read', async () => {
    const f = fixture(async () => { f.module.revoke('owner', grant.id); return 0; });
    f.approve({ ...grant, constraints: { ...grant.constraints, max_per_day: 2 } });
    expect(await f.module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
  });
  it('fails closed without usage evidence or on invalid counts', async () => {
    for (const usage of [undefined, async () => -1, async () => NaN, async () => 0.5]) {
      const { module, approve } = fixture(usage); approve({ ...grant, constraints: { max_per_day: 2 } });
      expect(await module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
    }
  });
  it('compares expiry instants across DST and treats equality as expired', async () => {
    const { module, approve } = fixture(); approve({ ...grant, expires_at: '2026-11-01T01:15:00-04:00' });
    expect(await module.evaluate(action, 'America/New_York')).toEqual({ disposition: 'card' });
    approve({ ...grant, revision: 2, expires_at: '2026-11-01T01:15:00-05:00' });
    expect((await module.evaluate(action, 'America/New_York')).disposition).toBe('eligible');
  });
  it('tell prepares only and area auto never grants a missing scope', async () => {
    const { module, approve } = fixture();
    module.setMode('owner', 'mail', 'auto');
    expect(await module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
    approve(); module.setMode('owner', 'mail', 'tell');
    expect(await module.evaluate(action, 'UTC')).toEqual({ disposition: 'prepare' });
  });
  it('ask and tell grants do not become auto when an area changes', async () => {
    for (const mode of ['ask', 'tell'] as const) {
      const { module, approve } = fixture(); approve({ ...grant, mode }); module.setMode('owner', 'mail', 'auto');
      expect((await module.evaluate(action, 'UTC')).disposition).toBe(mode === 'tell' ? 'prepare' : 'card');
    }
  });
  it('conflicting overlapping permissions require a card regardless of insertion order', async () => {
    for (const reverse of [false, true]) {
      const { module, approve } = fixture();
      const other = { ...grant, id: 'ask-sam', mode: 'ask' as const };
      for (const item of reverse ? [other, grant] : [grant, other]) approve(item);
      expect(await module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
    }
  });
  it('a mode change during a ledger read prevents auto eligibility', async () => {
    const f = fixture(async () => { f.module.setMode('owner', 'mail', 'ask'); return 0; });
    f.approve({ ...grant, constraints: { max_per_day: 2 } });
    expect(await f.module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
  });
  it('rechecks overlapping grants added while ledger evidence is pending', async () => {
    const f = fixture(async () => { f.approve({ ...grant, id: 'new-ask', mode: 'ask' }); return 0; });
    f.approve({ ...grant, constraints: { max_per_day: 2 } });
    expect(await f.module.evaluate(action, 'UTC')).toEqual({ disposition: 'card' });
  });
  it('keeps ledger failures visible instead of silently authorizing an action', async () => {
    const { module, approve } = fixture(async () => { throw new Error('ledger unavailable'); });
    approve({ ...grant, constraints: { max_per_day: 2 } });
    await expect(module.evaluate(action, 'UTC')).rejects.toThrow('ledger unavailable');
  });
  it('cannot accept a proposal made before revocation to revive the old permission', () => {
    const { module, approve } = fixture(); approve();
    const p = module.propose('owner', { ...grant, revision: 2 });
    module.revoke('owner', grant.id);
    expect(() => module.confirm('owner', p.id, p.grant)).toThrow();
  });
  it('rejects cross-owner, substituted, reused and stale confirmations', () => {
    const { module, approve } = fixture();
    expect(() => module.propose('other', grant)).toThrow('owner mismatch');
    const p = module.propose('owner', grant);
    expect(() => module.confirm('other', p.id, p.grant)).toThrow();
    expect(() => module.confirm('owner', p.id, { ...p.grant, constraints: {} })).toThrow('shape mismatch');
    module.confirm('owner', p.id, p.grant);
    expect(() => module.confirm('owner', p.id, p.grant)).toThrow();
    expect(() => approve()).toThrow('revision');
  });
  it('lists defensive copies so model callers cannot widen stored grants', () => {
    const { module, approve } = fixture(); approve();
    module.list('owner')[0]!.constraints.recipients!.push('hidden@example.com');
    expect(module.list('owner')[0]!.constraints.recipients).toEqual(['sam@example.com']);
  });
});
