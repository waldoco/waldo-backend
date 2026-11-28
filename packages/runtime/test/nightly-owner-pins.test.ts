import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, memoryPrompt, type ClaimOutcome, type ClaimStore } from '../src/memory/claims';

// A pin records who set it. The nightly pass curates the pinned blocks, but only the pins it set itself: a pin the owner set,
// or one set before the setter was recorded, is never unpinned, moved or dismissed by it. Synthetic claims only.
const AT = '2026-11-27T03:00:00.000Z';
const withStore = <T>(name: string, work: (store: ClaimStore, sql: SqlStorage) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`nightly-owner-pins-${name}`)), async (_instance, state) => work(claimStore(state.storage.sql, (run) => state.storage.transactionSync(run)), state.storage.sql));
const said = (store: ClaimStore, text: string, ref: string) => {
  store.add({ kind: 'preference', text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: ref }, AT);
  return store.claims().find((claim) => claim.text === text)!.id;
};
const nightly = (store: ClaimStore, ops: Readonly<{ pin?: readonly unknown[]; unpin?: readonly number[]; dismiss?: readonly number[]; retire?: readonly unknown[] }>, owner?: string): ClaimOutcome => {
  let outcome: ClaimOutcome | undefined;
  applyClaimOps(store, JSON.stringify({ add: [], corrections: [], retire: ops.retire ?? [], seen: [], confirm: [], dismiss: ops.dismiss ?? [], forget_claims: [], forget_nodes: [], forget_topic: null, pin: ops.pin ?? [], unpin: ops.unpin ?? [] }),
    AT, 'owner agreed', undefined, owner === undefined ? undefined : { owner }, false, (result) => { outcome = result; }, true, true);
  return outcome!;
};
const row = (store: ClaimStore, id: number) => store.allClaims().find((claim) => claim.id === id)!;

describe('the nightly pass and the owner\'s pins', () => {
  it('never unpins, moves or dismisses a pin the owner set', async () => {
    await withStore('owner', (store) => {
      const id = said(store, 'Keeps mornings for deep work', 'owner, app-1');
      expect(store.pin(id, 'facts', 2)).toBe(true);
      const before = JSON.stringify(row(store, id));
      expect(nightly(store, { unpin: [id] })).toMatchObject({ unpinned: 0 });
      expect(nightly(store, { pin: [{ id, block: 'profile', order: 0 }] })).toMatchObject({ pinned: 0 });
      expect(nightly(store, { dismiss: [id] })).toMatchObject({ dismissed: 0 });
      // The same retire on the owner's own words ends a claim that is not pinned, and leaves the pinned one.
      const loose = said(store, 'Keeps evenings for reading', 'owner, app-7');
      nightly(store, { retire: [{ id, replaced_by_text: null, evidence: '"I gave up deep work mornings"' }, { id: loose, replaced_by_text: null, evidence: '"I gave up reading in the evenings"' }] }, 'I gave up deep work mornings. I gave up reading in the evenings');
      expect(row(store, loose).status).toBe('superseded');
      expect(JSON.stringify(row(store, id))).toBe(before);
      expect(row(store, id)).toMatchObject({ pinned: 'facts', pin_order: 2, pinned_by: 'owner', status: 'active' });
    });
  });

  it('treats a pin set before the setter was recorded as the owner\'s', async () => {
    await withStore('legacy', (store, sql) => {
      const id = said(store, 'Walks after lunch', 'owner, app-2');
      sql.exec("UPDATE claims SET pinned = 'profile', pin_order = 1, pinned_by = NULL WHERE id = ?", id);
      expect(nightly(store, { unpin: [id], dismiss: [id] })).toMatchObject({ unpinned: 0, dismissed: 0 });
      expect(row(store, id)).toMatchObject({ pinned: 'profile', status: 'active' });
      expect(memoryPrompt(store)).toContain('pinned="profile" order="1" pinned_by="owner"');
    });
  });

  it('curates its own pins, and an owner\'s re-pin makes the pin theirs', async () => {
    await withStore('waldo', (store) => {
      const id = said(store, 'Reads before bed', 'owner, app-3');
      expect(nightly(store, { pin: [{ id, block: 'facts', order: 0 }] })).toMatchObject({ pinned: 1 });
      expect(row(store, id).pinned_by).toBe('waldo');
      expect(memoryPrompt(store)).not.toContain('pinned_by="owner"');
      expect(nightly(store, { pin: [{ id, block: 'profile', order: 3 }] })).toMatchObject({ pinned: 1 });
      expect(nightly(store, { unpin: [id] })).toMatchObject({ unpinned: 1 });
      expect(row(store, id).pinned).toBeNull();
      expect(nightly(store, { pin: [{ id, block: 'facts', order: 0 }] })).toMatchObject({ pinned: 1 });
      expect(store.pin(id, 'facts', 0)).toBe(true);
      expect(row(store, id).pinned_by).toBe('owner');
      expect(nightly(store, { unpin: [id] })).toMatchObject({ unpinned: 0 });
    });
  });

  it('an owner\'s correction keeps the pin the owner\'s', async () => {
    await withStore('correct', (store) => {
      const id = said(store, 'Runs on Sundays', 'owner, app-4');
      expect(store.pin(id, 'profile', 0)).toBe(true);
      expect(store.correct(id, { kind: 'preference', text: 'Runs on Saturdays', source: 'stated', evidence: '"Runs on Saturdays"', origin: 'owner', source_ref: 'owner, app-5' }, AT)).toBe(true);
      const now = store.claims().find((claim) => claim.text === 'Runs on Saturdays')!;
      expect(now).toMatchObject({ pinned: 'profile', pinned_by: 'owner' });
      expect(nightly(store, { unpin: [now.id] })).toMatchObject({ unpinned: 0 });
    });
  });

  it('the owner can unpin any pin', async () => {
    await withStore('unpin', (store) => {
      const id = said(store, 'Tea, never coffee', 'owner, app-6');
      expect(nightly(store, { pin: [{ id, block: 'facts', order: 0 }] })).toMatchObject({ pinned: 1 });
      expect(store.unpin(id)).toBe(true);
      expect(row(store, id)).toMatchObject({ pinned: null, pinned_by: null });
    });
  });
});
