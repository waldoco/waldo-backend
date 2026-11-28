import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyPromotion, claimStore, constellationBlock, JOIN_INSTRUCTION, promotionInput, promotionInstruction, withOutsideNotes, type ClaimStore, type PromotionEvidenceReceipt } from '../src/memory/claims';
import { nodeSupports } from '../src/memory/node-sources';
import { outsideView } from '../src/memory/outside-view';

// The join pass may rest a constellation on any spot that has a source: the owner's words, mail or calendar, a wearable's zone
// words. The model judges what joins; code checks only that a constellation rests on two or more sourced spots it was shown. A
// constellation resting on outside content stays Waldo's read.
const AT = '2026-11-12T08:00:00.000Z';
const withStore = <T>(name: string, work: (store: ClaimStore) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`constellation-sources-${name}`)), async (_instance, state) => work(claimStore(state.storage.sql, (run) => state.storage.transactionSync(run))));
const plan = (spots: readonly number[], promoted: readonly number[] = []) => JSON.stringify({ constellations: [{ id: null, replaces: [], area: 'work', label: 'Thursdays are review days', summary: 'Your design reviews cluster on Thursdays.', strength: 0.7, spots }], links: [], promoted });
const seed = (store: ClaimStore) => {
  store.add({ kind: 'fact', text: 'I keep Thursdays for reviews', source: 'stated', evidence: '"I keep Thursdays for reviews"', origin: 'owner', source_ref: 'owner, app-1' }, AT);
  store.add({ kind: 'fact', text: 'Weekly design review on Thursdays', source: 'inferred', evidence: '"a weekly design review on Thursdays"', origin: 'untrusted', source_ref: 'outside, calendar change, 2026-11-12' }, AT);
  store.add({ kind: 'fact', text: 'Reviews run long', source: 'inferred', evidence: 'seems so' }, AT);
  store.add({ kind: 'fact', text: 'Reviews are tiring', source: 'inferred', evidence: 'writer said so', origin: 'agent' }, AT);
  const id = (text: string) => store.claims().find((claim) => claim.text === text)!.id;
  return { said: id('I keep Thursdays for reviews'), calendar: id('Weekly design review on Thursdays'), legacy: id('Reviews run long'), unsourced: id('Reviews are tiring') };
};

describe('what may support a constellation', () => {
  it('a note from the owner and one from the calendar, saved the same day, join; it keeps both links with their origin', async () => {
    await withStore('mixed', (store) => {
      const ids = seed(store);
      const receipts: PromotionEvidenceReceipt[] = [];
      applyPromotion(store, plan([ids.said, ids.calendar]), AT, (receipt) => receipts.push(receipt));
      expect(receipts.map((receipt) => receipt.outcome)).toEqual(['admitted']);
      const [node] = store.nodes();
      expect(nodeSupports(store.claims(), node!).map((claim) => [claim.id, claim.origin]).sort()).toEqual([[ids.said, 'owner'], [ids.calendar, 'untrusted']]);
      // It rests on outside content, so no turn is shown it until the owner confirms its wording.
      expect(constellationBlock(store, 2_000)).not.toContain('Thursdays are review days');
      expect(constellationBlock(store, 2_000)).toContain('1 more of Waldo\'s reads');
    });
  });
  it('one spot is not a pattern', async () => {
    await withStore('one', (store) => {
      const ids = seed(store);
      const receipts: PromotionEvidenceReceipt[] = [];
      applyPromotion(store, plan([ids.calendar]), AT, (receipt) => receipts.push(receipt));
      expect(receipts).toEqual([{ outcome: 'held', reason: 'too_few_claims', source_kind: 'owner_observation_pattern', count: 1 }]);
      expect(store.nodes()).toEqual([]);
    });
  });
  it('a missing note, one with no recorded origin, or Waldo\'s own unsourced read is never shown to the pass and never support', async () => {
    await withStore('unsourced', (store) => {
      const ids = seed(store);
      expect(promotionInput(store)).not.toMatch(/Reviews run long|Reviews are tiring/);
      const receipts: PromotionEvidenceReceipt[] = [];
      applyPromotion(store, plan([ids.legacy, ids.unsourced, 999_999]), AT, (receipt) => receipts.push(receipt));
      applyPromotion(store, plan([ids.said, ids.unsourced]), AT, (receipt) => receipts.push(receipt));
      expect(receipts.map((receipt) => receipt.reason)).toEqual(['untrusted_or_missing', 'untrusted_or_missing']);
      expect(store.nodes()).toEqual([]);
    });
  });
  it('only the owner\'s own note is promoted, however often the calendar note was seen', async () => {
    await withStore('promoted', (store) => {
      const ids = seed(store);
      for (const id of [ids.said, ids.calendar]) store.seen(id, AT);
      applyPromotion(store, plan([ids.said, ids.calendar], [ids.said, ids.calendar]), AT);
      expect(store.claims('promoted').map((claim) => claim.id)).toEqual([ids.said]);
    });
  });
  it('a constellation resting on health notes is admitted, and stays out of a turn built from outside content', async () => {
    await withStore('health', (store) => {
      store.add({ kind: 'health', text: 'Knee physio every morning', source: 'stated', evidence: '"knee physio every morning"', origin: 'owner', source_ref: 'owner, app-2' }, AT);
      store.add({ kind: 'health', text: 'The knee aches after long runs', source: 'stated', evidence: '"the knee aches after long runs"', origin: 'owner', source_ref: 'owner, app-3' }, AT);
      const view = withOutsideNotes(store);
      applyPromotion(view, JSON.stringify({ constellations: [{ id: null, replaces: [], area: 'body', label: 'Looking after the knee', summary: 'You do physio each morning; long runs set the knee off.', strength: 0.6, spots: store.claims().map((claim) => claim.id) }], links: [], promoted: [] }), AT);
      expect(view.nodes()).toHaveLength(1);
      expect(outsideView(view).nodes()).toEqual([]);
    });
  });
  it('while the owner keeps health out of memory, the pass is shown no body spot and builds no body constellation', async () => {
    await withStore('health-off', (store) => {
      store.add({ kind: 'health', text: 'Knee physio every morning', source: 'stated', evidence: '"knee physio every morning"', origin: 'owner', source_ref: 'owner, app-2', area: 'body' }, AT);
      const ids = seed(store), off: ClaimStore = { ...store, keepsHealth: () => false };
      expect(promotionInput(off)).not.toContain('Knee physio');
      expect(promotionInput(off)).toContain('health notes off');
      const receipts: PromotionEvidenceReceipt[] = [];
      applyPromotion(off, JSON.stringify({ constellations: [{ id: null, replaces: [], area: 'body', label: 'Review days wear you out', summary: 'Thursdays leave you tired.', strength: 0.5, spots: [ids.said, ids.calendar] }], links: [], promoted: [] }), AT, (receipt) => receipts.push(receipt));
      expect(receipts.map((receipt) => receipt.reason)).toEqual(['refused']);
    });
  });
  it('the pass is told the same rule whichever store it reads, outside notes included', async () => {
    await withStore('instruction', (store) => {
      expect(promotionInstruction(store)).toBe(JOIN_INSTRUCTION);
      expect(promotionInstruction(withOutsideNotes(store))).toBe(JOIN_INSTRUCTION);
      expect(JOIN_INSTRUCTION).toContain('origin="outside"');
    });
  });
});
