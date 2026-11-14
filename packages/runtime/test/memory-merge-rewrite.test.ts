import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyClaimOps, claimStore, CLAIM_OPS_SCHEMA, nightlyInput, withOutsideNotes, type ClaimStore } from '../src/memory/claims';
import { nodeSupports } from '../src/memory/node-sources';

// Merge and rewrite: the nightly pass may write one note in place of others. The result is Waldo's wording and never the
// owner's; the notes it replaced end and stay linked, so deleting any of them takes the note that carries their words.
const AT = '2026-11-12T08:00:00.000Z', LATER = '2026-11-13T08:00:00.000Z';
const withStore = <T>(name: string, work: (store: ClaimStore) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`merge-rewrite-${name}`)), async (_instance, state) => work(claimStore(state.storage.sql, (run) => state.storage.transactionSync(run))));
const ops = (partial: Record<string, unknown>) => JSON.stringify({ add: [], corrections: [], retire: [], merge: [], rewrite: [], seen: [], confirm: [], dismiss: [], forget_claims: [], forget_nodes: [], forget_topic: null, pin: [], unpin: [], areas: [], ...partial });
// The nightly pass's call: it alone may pin, so it alone tidies.
const nightly = (store: ClaimStore, partial: Record<string, unknown>, at = LATER) => applyClaimOps(store, ops(partial), at, 'owner, day of t', undefined, { owner: '' }, false, undefined, true);
const owned = (store: ClaimStore, text: string, ref: string) => { store.add({ kind: 'fact', text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: `owner, ${ref}` }, AT); return store.lastClaimId(); };
const fromMail = (store: ClaimStore, text: string) => { store.add({ kind: 'fact', text, source: 'inferred', evidence: `"${text}"`, origin: 'untrusted', source_ref: 'outside, mail from Priya Shah <priya@example.com>, 2026-11-11' }, AT); return store.lastClaimId(); };
const live = (store: ClaimStore) => store.claims().map((claim) => claim.text).sort();

describe('merge and rewrite', () => {
  it('merges two of the owner\'s notes into one that is Waldo\'s read, linked to both, and no longer in the pinned profile', async () => {
    await withStore('owner-pair', (store) => {
      const a = owned(store, 'I run on Tuesdays', 'app-1'), b = owned(store, 'Tuesday is my run day', 'app-2');
      store.pin(a, 'profile', 0);
      const view = withOutsideNotes(store);
      expect(nightly(view, { merge: [{ ids: [a, b], kind: 'routine', text: 'Runs on Tuesdays' }] })).toContain('combined1');
      const [note] = store.claims();
      expect(live(store)).toEqual(['Runs on Tuesdays']);
      expect(note).toMatchObject({ kind: 'routine', origin: 'agent', source: 'inferred', source_ref: `notes:${a},${b}`, pinned: null });
      expect(store.allClaims().filter((claim) => claim.status === 'superseded').map((claim) => claim.id).sort()).toEqual([a, b]);
    });
  });
  it('a merge that takes in a note learned from mail is outside content, however many of the owner\'s notes it also replaced', async () => {
    await withStore('mixed', (store) => {
      const a = owned(store, 'Acme is my largest client', 'app-1'), b = fromMail(store, 'Acme invoices are paid to the Lisbon account');
      nightly(withOutsideNotes(store), { merge: [{ ids: [a, b], kind: 'fact', text: 'Acme, the largest client, is paid through the Lisbon account' }] });
      expect(store.allClaims().find((claim) => claim.status === 'active')).toMatchObject({ origin: 'untrusted', source_ref: `notes:${a},${b}` });
    });
  });
  it('rewrites one note; a note learned from one mail keeps that mail as its source', async () => {
    await withStore('rewrite', (store) => {
      const a = fromMail(store, 'Lease renewal is due in march 2027');
      nightly(withOutsideNotes(store), { rewrite: [{ id: a, kind: 'fact', text: 'The lease renews in March 2027' }] });
      expect(store.allClaims().find((claim) => claim.status === 'active')).toMatchObject({ text: 'The lease renews in March 2027', origin: 'untrusted', source_ref: 'outside, mail from Priya Shah <priya@example.com>, 2026-11-11' });
    });
  });
  it('a node resting on a merged note now rests on the note that replaced it', async () => {
    await withStore('node', (store) => {
      const a = owned(store, 'I run on Tuesdays', 'app-1'), b = owned(store, 'Tuesday is my run day', 'app-2');
      const node = store.saveNode({ id: null, domain: 'training', label: 'Tuesday runs', summary: 'Runs on Tuesdays.', strength: 0.6, status: 'active', supporting_spots: [a, b] }, AT);
      nightly(withOutsideNotes(store), { merge: [{ ids: [a, b], kind: 'routine', text: 'Runs on Tuesdays' }] });
      expect(nodeSupports(store.claims(), store.nodes().find((row) => row.id === node)!).map((claim) => claim.text)).toEqual(['Runs on Tuesdays']);
    });
  });
  it('deleting a source note takes the merged note and every node that cited it; the other source stands again', async () => {
    await withStore('delete', (store) => {
      const a = owned(store, 'Acme is my largest client', 'app-1'), b = fromMail(store, 'Acme invoices are paid to the Lisbon account');
      const view = withOutsideNotes(store);
      nightly(view, { merge: [{ ids: [a, b], kind: 'fact', text: 'Acme, the largest client, is paid through the Lisbon account' }] });
      const merged = store.claims()[0]!.id;
      nightly(view, { rewrite: [{ id: merged, kind: 'fact', text: 'Acme (largest client) pays into the Lisbon account' }] }, '2026-11-14T08:00:00.000Z');
      const twice = store.claims()[0]!.id;
      store.saveNode({ id: null, domain: 'work rhythm', label: 'Acme billing', summary: 'Acme pays into Lisbon.', strength: 0.6, status: 'active', supporting_spots: [twice] }, AT);
      expect(store.purge([b], '2026-11-15T08:00:00.000Z').ready).toBe(true);
      store.settle([b, merged, twice]);
      expect(store.allClaims().map((claim) => [claim.text, claim.status])).toEqual([['Acme is my largest client', 'active']]);
      expect(store.nodes()).toEqual([]);
    });
  });
  it('deleting the merged note takes the notes it replaced', async () => {
    await withStore('delete-merged', (store) => {
      const a = owned(store, 'I run on Tuesdays', 'app-1'), b = owned(store, 'Tuesday is my run day', 'app-2');
      nightly(withOutsideNotes(store), { merge: [{ ids: [a, b], kind: 'routine', text: 'Runs on Tuesdays' }] });
      const merged = store.claims()[0]!.id;
      expect(store.purge([merged], '2026-11-15T08:00:00.000Z').ready).toBe(true);
      store.settle([a, b, merged]);
      expect(store.allClaims()).toEqual([]);
    });
  });
  it('refuses a health note, a reading, a missing or already replaced note, a forgotten wording, a copy of a live note, and a merge of one', async () => {
    await withStore('refused', (store) => {
      const a = owned(store, 'I run on Tuesdays', 'app-1'), b = owned(store, 'Tuesday is my run day', 'app-2'), c = owned(store, 'I lift on Fridays', 'app-3');
      store.add({ kind: 'health', text: 'Knee physio every morning', source: 'stated', evidence: '"knee physio every morning"', origin: 'owner', source_ref: 'owner, app-4' }, AT);
      const knee = store.lastClaimId();
      const gone = owned(store, 'I swim on Sundays', 'app-5');
      store.purge([gone], AT);
      store.settle([gone]);
      const before = live(store);
      const detail = nightly(withOutsideNotes(store), {
        merge: [{ ids: [a, knee], kind: 'routine', text: 'Runs and does physio' }, { ids: [a, b], kind: 'routine', text: 'Resting heart rate 48 bpm on run days' }, { ids: [a, 999_999], kind: 'routine', text: 'Runs' },
          { ids: [a, b], kind: 'routine', text: 'I lift on Fridays' }, { ids: [a], kind: 'routine', text: 'Runs weekly' }, { ids: [a, b], kind: 'nonsense', text: 'Runs weekly' }, { ids: [a, b], kind: 'fact', text: 'I swim on Sundays' }],
        rewrite: [{ id: knee, kind: 'health', text: 'Does knee physio daily' }, { id: c, kind: 'fact', text: '   ' }],
      });
      expect(detail).not.toContain('combined');
      expect(live(store)).toEqual(before);
    });
  });
  it('a note is replaced once per reply, and not one the same reply corrects or forgets', async () => {
    await withStore('once', (store) => {
      const a = owned(store, 'I run on Tuesdays', 'app-1'), b = owned(store, 'Tuesday is my run day', 'app-2'), c = owned(store, 'I lift on Fridays', 'app-3');
      const detail = nightly(withOutsideNotes(store), { merge: [{ ids: [a, b], kind: 'routine', text: 'Runs on Tuesdays' }], rewrite: [{ id: a, kind: 'routine', text: 'Tuesday runner' }, { id: c, kind: 'routine', text: 'Lifts on Fridays' }], forget_claims: [c] });
      expect(detail).toContain('combined1');
      expect(live(store)).toEqual(['I lift on Fridays', 'Runs on Tuesdays']);
    });
  });
  it('does nothing on a store that does not recall outside notes, or in a pass that may not pin', async () => {
    await withStore('off', (store) => {
      const a = owned(store, 'I run on Tuesdays', 'app-1'), b = owned(store, 'Tuesday is my run day', 'app-2');
      const merge = { merge: [{ ids: [a, b], kind: 'routine', text: 'Runs on Tuesdays' }] };
      nightly(store, merge);
      applyClaimOps(withOutsideNotes(store), ops(merge), LATER, 'owner, day of t', undefined, { owner: '' }, false);
      expect(live(store)).toEqual(['I run on Tuesdays', 'Tuesday is my run day']);
    });
  });
  it('the schema carries both operations, and only a store that recalls outside notes is told about them', async () => {
    await withStore('told', (store) => {
      expect(CLAIM_OPS_SCHEMA.required).toEqual(expect.arrayContaining(['merge', 'rewrite']));
      expect(nightlyInput(store, 'day')).not.toContain('merge');
      expect(nightlyInput(withOutsideNotes(store), 'day')).toContain('merge replaces claims');
    });
  });
});
