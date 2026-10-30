import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';
import { readMemoryGraph } from '../src/channels/memory-graph';

// A correction replaces the fact a node cites; the node must keep standing on the replacement, not vanish until the
// nightly pass re-admits it. A forget is different: the node goes with the claim it rested on.
const AT = '2026-10-30T04:00:00Z';
let sequence = 0;
const withStore = <T>(fn: (store: ReturnType<typeof claimStore>, sql: SqlStorage) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`correction-node-${sequence++}`)), (_instance, state) =>
    fn(claimStore(state.storage.sql, (work) => state.storage.transactionSync(work)), state.storage.sql));
const owned = (store: ReturnType<typeof claimStore>, text: string, kind = 'observation') => {
  store.add({ kind, text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: `owner, tg-${sequence++}` }, AT);
  return store.claims().find((claim) => claim.text === text)!.id;
};
const node = (store: ReturnType<typeof claimStore>, supports: readonly number[]) =>
  store.saveNode({ id: null, domain: 'work', label: 'Deep work in the mornings', summary: 'Does focused work before noon', strength: 0.7, status: 'active', supporting_spots: supports }, AT);
const supportsOf = (store: ReturnType<typeof claimStore>, id: number) => JSON.parse(store.nodes().find((row) => row.id === id)!.supporting_spots) as number[];
const correction = (text: string, kind = 'observation') => ({ kind, text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: 'owner, tg-fix' });

describe('a correction and the nodes that cite the corrected claim', () => {
  it('keeps the node, now resting on the new claim, in the graph and the turn block', async () => {
    await withStore((store, sql) => {
      const early = owned(store, 'Writes before 10am'), quiet = owned(store, 'Mutes chat until noon');
      const id = node(store, [early, quiet]);
      expect(store.correct(early, correction('Writes before 11am'), AT)).toBe(true);
      const replacement = store.claims().find((claim) => claim.text === 'Writes before 11am')!.id;
      expect(supportsOf(store, id)).toEqual([replacement, quiet]);
      const graph = readMemoryGraph(sql, 'owner');
      expect(graph.state).toBe('available');
      expect(graph.nodes.map((row) => [row.local_id, row.support.claim_ids])).toEqual([[id, [`owner:claim:${replacement}`, `owner:claim:${quiet}`]]]);
      expect(turnMemoryPrompt(store, 'unrelated')).toContain(`[n${id} `);
    });
  });

  it('points the node at the owner\'s already-recorded twin, once', async () => {
    await withStore((store, sql) => {
      const old = owned(store, 'Commutes by train'), twin = owned(store, 'Commutes by metro'), other = owned(store, 'Leaves at 8');
      const single = node(store, [old, other]), both = node(store, [old, twin]);
      expect(store.correct(old, correction('Commutes by metro'), AT)).toBe(true);
      expect(supportsOf(store, single)).toEqual([twin, other]);
      expect(supportsOf(store, both)).toEqual([twin]);
      expect(readMemoryGraph(sql, 'owner').nodes.map((row) => row.local_id).sort()).toEqual([single, both].sort());
    });
  });

  it('leaves the node alone when the correction is refused', async () => {
    await withStore((store) => {
      const old = owned(store, 'Commutes by train');
      store.add({ kind: 'observation', text: 'Commutes by metro', source: 'inferred', evidence: 'forwarded mail', origin: 'untrusted' }, AT);
      const id = node(store, [old]);
      expect(store.correct(old, correction('Commutes by metro'), AT)).toBe(false);
      expect(supportsOf(store, id)).toEqual([old]);
    });
  });

  it('leaves a node built on Waldo\'s read citing the superseded row, so it stays out rather than turning into the owner\'s words', async () => {
    await withStore((store, sql) => {
      store.add({ kind: 'observation', text: 'Clears investor mail first', source: 'inferred', evidence: 'read from a thread', origin: 'untrusted', source_ref: 'welcome:gmail:t1' }, AT);
      const read = store.claims().find((claim) => claim.text === 'Clears investor mail first')!.id;
      const id = node(store, [read]);
      expect(store.correct(read, correction('Clears investor mail after standup'), AT)).toBe(true);
      expect(supportsOf(store, id)).toEqual([read]);
      expect(readMemoryGraph(sql, 'owner').nodes).toEqual([]);
      expect(turnMemoryPrompt(store, 'unrelated')).not.toContain(`[n${id} `);
    });
  });

  it('carries a pin to the replacement as before', async () => {
    await withStore((store) => {
      const pinned = owned(store, 'Desk is by the window', 'fact');
      expect(store.pin(pinned, 'profile', 1)).toBe(true);
      const id = node(store, [pinned]);
      expect(store.correct(pinned, correction('Desk is by the door', 'fact'), AT)).toBe(true);
      const replacement = store.claims().find((claim) => claim.text === 'Desk is by the door')!;
      expect(replacement).toMatchObject({ pinned: 'profile', pin_order: 1, supersedes_id: pinned });
      expect(supportsOf(store, id)).toEqual([replacement.id]);
    });
  });

  it('a forget of the claim still takes the node out and marks the graph partial', async () => {
    await withStore((store, sql) => {
      const early = owned(store, 'Writes before 10am');
      const id = node(store, [early]);
      expect(store.correct(early, correction('Writes before 11am'), AT)).toBe(true);
      const replacement = store.claims().find((claim) => claim.text === 'Writes before 11am')!.id;
      store.purge([replacement], AT);
      const graph = readMemoryGraph(sql, 'owner');
      expect(graph.state).toBe('partial');
      expect(graph.nodes).toEqual([]);
      expect(turnMemoryPrompt(store, 'unrelated')).not.toContain(`[n${id} `);
    });
  });
});
