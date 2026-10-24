import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, type Claim } from '../src/memory/claims';
import { dashboardMemory } from '../src/channels/dashboard-memory';
import { memoryControl } from '../src/channels/dashboard-memory-actions';
import { renderConsole } from '../src/channels/console';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';

// Two writers confirm a claim. The owner's "That's right" makes it the owner's; the nightly model's confirm is Waldo's read
// of the owner's day and is labelled as Waldo's. Synthetic values only.
let sequence = 0;
const withStore = <T>(fn: (store: ReturnType<typeof claimStore>) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`confirm-semantics-${sequence++}`)), (_instance, state) => fn(claimStore(state.storage.sql, (work) => state.storage.transactionSync(work))));
const AT = '2026-10-24T08:00:00Z';
const ops = (confirm: number[]) => JSON.stringify({ add: [], corrections: [], seen: [], confirm, dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null });

describe('the owner confirming a claim', () => {
  it('makes it owner-grounded and pinnable, noting the console in its evidence', async () => {
    await withStore((store) => {
      store.add({ kind: 'preference', text: 'Prefers aisle seats on short flights', source: 'inferred', evidence: 'booked aisle twice', origin: 'agent' }, AT);
      const [row] = store.claims();
      expect(store.pin(row!.id, 'profile', 1)).toBe(false);
      expect(store.ownerGround(row!.id, '2026-10-24T09:00:00Z', 'owner, console')).toBe(true);
      expect(store.claims()[0]).toMatchObject({ origin: 'owner', verification_status: 'owner-grounded', source: 'confirmed', source_ref: 'owner, console' });
      expect(store.claims()[0]!.evidence).toBe('booked aisle twice | confirmed: owner, console');
      expect(store.pin(row!.id, 'profile', 1)).toBe(true);
    });
  });

  it('keeps an owner source it already had, and grounds a row Waldo confirmed', async () => {
    await withStore((store) => {
      store.add({ kind: 'routine', text: 'Runs on Sunday mornings', source: 'inferred', evidence: '"ran again sunday"', origin: 'agent', source_ref: 'owner, tg-81' }, AT);
      const [row] = store.claims();
      applyClaimOps(store, ops([row!.id]), AT, 'owner, tg-82');
      expect(store.ownerGround(row!.id, AT, 'owner, console')).toBe(true);
      expect(store.claims()[0]).toMatchObject({ origin: 'owner', verification_status: 'owner-grounded', source: 'confirmed', source_ref: 'owner, tg-81' });
    });
  });

  it('touches nothing that is not live', async () => {
    await withStore((store) => {
      store.add({ kind: 'fact', text: 'Old desk at the Pune office', source: 'inferred', evidence: 'mentioned once', origin: 'agent' }, AT);
      const [row] = store.claims();
      store.setStatus(row!.id, 'dismissed');
      expect(store.ownerGround(row!.id, AT, 'owner, console')).toBe(false);
      expect(store.ownerGround(999, AT, 'owner, console')).toBe(false);
      expect(store.claims('dismissed')[0]).toMatchObject({ origin: 'agent', source: 'inferred' });
    });
  });
});

describe('the nightly model confirming a claim', () => {
  it('records it as Waldo confirmed, leaving origin and verification as they were', async () => {
    await withStore((store) => {
      store.add({ kind: 'pattern', text: 'Skips lunch on meeting-heavy days', source: 'inferred', evidence: 'two busy days', origin: 'agent' }, AT);
      const [row] = store.claims();
      applyClaimOps(store, ops([row!.id]), AT, 'owner, tg-9');
      expect(store.claims()[0]).toMatchObject({ source: 'waldo_confirmed', origin: 'agent', verification_status: 'provisional' });
      expect(store.claims()[0]!.evidence).toBe('two busy days | Waldo confirmed: owner, tg-9');
      expect(store.pin(row!.id, 'profile', 1)).toBe(false);
    });
  });
});

describe('what the owner sees', () => {
  const spot = (source: string): Claim => ({ id: 1, kind: 'preference', text: 'Prefers the Brief before 9am', source, evidence: 'opened at 08:40', origin: 'agent', status: 'active', created_at: AT, last_seen_at: AT, seen_count: 1, verification_status: 'provisional' });
  it('labels each writer, and still offers "That\'s right" on what Waldo confirmed', () => {
    const out = dashboardMemory({ now: Date.parse(AT), spots: [spot('waldo_confirmed'), { ...spot('confirmed'), id: 2 }], retired: [], forgetting: [], holds: [], profile: [] });
    expect(out.spots.map((row) => [row.source_label, row.provisional, row.allowed_actions.includes('spot.confirm')]))
      .toEqual([['Waldo confirmed', true, true], ['You confirmed this', false, false]]);
    const view = { ...SAMPLE_CONSOLE_VIEW, spots: SAMPLE_CONSOLE_VIEW.spots.map((row) => row.id === 5 ? { ...row, source: 'waldo_confirmed' } : row) };
    const html = renderConsole(view, 'spots');
    expect(html).toContain('Waldo confirmed');
    expect(html).toContain('name="action" value="spot.confirm"><input type="hidden" name="id" value="5"><button class="btn quiet">That&#39;s right</button>');
    expect(memoryControl(view, 'owner', 'owner:claim:5')?.actions).toContain('spot.confirm');
  });
});
