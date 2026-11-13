import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyPromotion, claimStore, constellationBlock, promotionInstruction, PROMOTION_INSTRUCTION, withOutsideNotes, type ClaimStore, type PromotionEvidenceReceipt } from '../src/memory/claims';
import { nodeSupports } from '../src/memory/node-sources';
import { outsideView } from '../src/memory/outside-view';

// With outside notes recalled (MEMORY_OUTSIDE_NOTES), a constellation node may rest on a note from any source that has one:
// the owner's words, mail or calendar, an import, a wearable summary. The model judges whether something recurs; code checks
// only that the notes it cites exist and have a source. A node resting on outside content stays Waldo's read.
const AT = '2026-11-12T08:00:00.000Z';
const withStore = <T>(name: string, work: (store: ClaimStore) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`constellation-sources-${name}`)), async (_instance, state) => work(claimStore(state.storage.sql, (run) => state.storage.transactionSync(run))));
const plan = (spots: readonly number[], promoted: readonly number[] = []) => JSON.stringify({ nodes: [{ id: null, domain: 'work rhythm', label: 'Thursdays are review days', summary: 'Design reviews cluster on Thursdays.', strength: 0.7, status: 'active', durable: true, reason: 'a standing rhythm', supporting_spots: spots }], edges: [], promoted });
const seed = (store: ClaimStore) => {
  store.add({ kind: 'fact', text: 'I keep Thursdays for reviews', source: 'stated', evidence: '"I keep Thursdays for reviews"', origin: 'owner', source_ref: 'owner, app-1' }, AT);
  store.add({ kind: 'fact', text: 'Weekly design review on Thursdays', source: 'inferred', evidence: '"a weekly design review on Thursdays"', origin: 'untrusted', source_ref: 'outside, calendar change, 2026-11-12' }, AT);
  store.add({ kind: 'fact', text: 'Reviews run long', source: 'inferred', evidence: 'seems so' }, AT);
  store.add({ kind: 'fact', text: 'Reviews are tiring', source: 'inferred', evidence: 'writer said so', origin: 'agent' }, AT);
  const id = (text: string) => store.claims().find((claim) => claim.text === text)!.id;
  return { said: id('I keep Thursdays for reviews'), calendar: id('Weekly design review on Thursdays'), legacy: id('Reviews run long'), unsourced: id('Reviews are tiring') };
};

describe('what may support a constellation node', () => {
  it('with outside notes: a note of any kind from the owner and one from the calendar, saved the same day, support a node; it keeps both links with their origin', async () => {
    await withStore('mixed', (store) => {
      const ids = seed(store), view = withOutsideNotes(store);
      const receipts: PromotionEvidenceReceipt[] = [];
      applyPromotion(view, plan([ids.said, ids.calendar]), AT, (receipt) => receipts.push(receipt));
      expect(receipts.map((receipt) => receipt.outcome)).toEqual(['admitted']);
      const [node] = store.nodes();
      expect(nodeSupports(store.claims(), node!).map((claim) => [claim.id, claim.origin]).sort()).toEqual([[ids.said, 'owner'], [ids.calendar, 'untrusted']]);
      // It rests on outside content, so no turn is shown it until the owner confirms its wording.
      expect(constellationBlock(store, 2_000)).not.toContain('Thursdays are review days');
      expect(constellationBlock(store, 2_000)).toContain('1 more of Waldo\'s reads');
    });
  });
  it('with outside notes: one note with a source is enough, and recurrence is not a code rule', async () => {
    await withStore('one', (store) => {
      const ids = seed(store);
      applyPromotion(withOutsideNotes(store), plan([ids.calendar]), AT);
      expect(store.nodes().map((node) => node.label)).toEqual(['Thursdays are review days']);
    });
  });
  it('with outside notes: a node that cites only a missing note, one with no recorded origin, or Waldo\'s own unsourced read is held', async () => {
    await withStore('unsourced', (store) => {
      const ids = seed(store);
      const receipts: PromotionEvidenceReceipt[] = [];
      applyPromotion(withOutsideNotes(store), plan([ids.legacy, ids.unsourced, 999_999]), AT, (receipt) => receipts.push(receipt));
      expect(receipts).toEqual([{ outcome: 'held', reason: 'untrusted_or_missing', source_kind: 'owner_observation_pattern', count: 1 }]);
      expect(store.nodes()).toEqual([]);
    });
  });
  it('with outside notes: only the owner\'s own note is promoted, however often the calendar note was seen', async () => {
    await withStore('promoted', (store) => {
      const ids = seed(store);
      for (const id of [ids.said, ids.calendar]) store.seen(id, AT);
      applyPromotion(withOutsideNotes(store), plan([ids.said, ids.calendar], [ids.said, ids.calendar]), AT);
      expect(store.claims('promoted').map((claim) => claim.id)).toEqual([ids.said]);
    });
  });
  it('with outside notes: a node resting on a health note is admitted, and stays out of a turn built from outside content', async () => {
    await withStore('health', (store) => {
      store.add({ kind: 'health', text: 'Knee physio every morning', source: 'stated', evidence: '"knee physio every morning"', origin: 'owner', source_ref: 'owner, app-2' }, AT);
      const view = withOutsideNotes(store);
      applyPromotion(view, plan([store.claims()[0]!.id]), AT);
      expect(view.nodes()).toHaveLength(1);
      expect(outsideView(view).nodes()).toEqual([]);
    });
  });
  it('without outside notes: the same plan is held, as before', async () => {
    await withStore('off', (store) => {
      const ids = seed(store);
      const receipts: PromotionEvidenceReceipt[] = [];
      applyPromotion(store, plan([ids.said, ids.calendar]), AT, (receipt) => receipts.push(receipt));
      expect(receipts.map((receipt) => receipt.outcome)).toEqual(['held']);
      expect(store.nodes()).toEqual([]);
    });
  });
  it('the pass is told the rule its store follows', async () => {
    await withStore('instruction', (store) => {
      expect(promotionInstruction(store)).toBe(PROMOTION_INSTRUCTION);
      const told = promotionInstruction(withOutsideNotes(store));
      expect(told).toContain('origin="outside"');
      expect(told).not.toContain('different days');
      expect(told.split('\n')).toHaveLength(PROMOTION_INSTRUCTION.split('\n').length);
    });
  });
});
