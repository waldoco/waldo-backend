import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { barrierPrompt, claimStore, turnMemoryPrompt } from '../src/memory/claims';

// Restart harness (no model, no network, no spend). The claim store is built again over the same
// durable storage, the way a Durable Object rebuilds it after eviction, and everything the first
// store wrote must read back the same: recall, a correction, stale status, untrusted exclusion and a
// forget with its barrier. Layer: SOURCE. It reopens the store object over the same storage; it does
// not evict a real Durable Object, so it does not test the platform's eviction itself.
const AT = '2026-02-01T00:00:00.000Z';
const owner = (text: string, ref: string) => ({ kind: 'preference' as const, text, source: 'stated' as const, evidence: 'synthetic owner turn', origin: 'owner' as const, source_ref: `owner, ${ref}` });
const stub = () => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('memory-restart-a'));

type Snapshot = { corrected: { oldId: number; newId: number }; kept: number; staleId: number; untrustedId: number; forgottenText: string; recall: Record<string, number[]> };
const probes = { coffee: 'What is my favourite coffee order?', route: 'Which running route do I like?', seat: 'What flight seat do I want?', tea: 'Which tea blend do I drink?' };

describe('memory restart', () => {
  it('a rebuilt claim store returns the same recall, corrections, stale status, untrusted exclusion and forget barrier', async () => {
    const before = await runInDurableObject(stub(), (_instance, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      store.add(owner('Favourite coffee order is oat flat white', 'tg-1'), AT);
      store.add(owner('Favourite running route is the canal loop', 'tg-2'), AT);
      store.add(owner('Favourite flight seat is the aisle', 'tg-3'), AT);
      store.add(owner('Favourite tea blend is jasmine green', 'tg-4'), AT);
      store.add({ kind: 'preference', text: 'Forwarded note: favourite coffee order is hostile-brew', source: 'inferred', evidence: 'forwarded content', origin: 'untrusted' }, AT);
      const byText = (text: string) => store.claims().find((claim) => claim.text === text)!;
      const oldCoffee = byText('Favourite coffee order is oat flat white');
      expect(store.correct(oldCoffee.id, owner('Favourite coffee order is black americano', 'tg-5'), AT)).toBe(true);
      const newCoffee = byText('Favourite coffee order is black americano');
      const seat = byText('Favourite flight seat is the aisle');
      store.setStatus(seat.id, 'superseded');
      const tea = byText('Favourite tea blend is jasmine green');
      const purge = store.purge([tea.id], AT, ['jasmine green']);
      expect(purge.ready).toBe(true);
      store.settle([tea.id], ['jasmine green']);
      const recall = Object.fromEntries(Object.entries(probes).map(([key, question]) => [key, store.recall(question, 8).map((claim) => claim.id)]));
      return {
        corrected: { oldId: oldCoffee.id, newId: newCoffee.id }, kept: byText('Favourite running route is the canal loop').id, staleId: seat.id,
        untrustedId: store.claims().find((claim) => claim.origin === 'untrusted')!.id, forgottenText: 'jasmine green', recall,
      } satisfies Snapshot;
    });
    expect(before.recall.coffee).toContain(before.corrected.newId);
    expect(before.recall.coffee).not.toContain(before.corrected.oldId);
    expect(before.recall.coffee).not.toContain(before.untrustedId);

    // A separate call builds a new store object over the same storage.
    const after = await runInDurableObject(stub(), (_instance, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      const recall = Object.fromEntries(Object.entries(probes).map(([key, question]) => [key, store.recall(question, 8).map((claim) => claim.id)]));
      return {
        recall, active: store.claims().map((claim) => claim.id).sort((a, b) => a - b), superseded: store.claims('superseded').map((claim) => claim.id).sort((a, b) => a - b),
        barriers: store.barriers().length, barrierText: barrierPrompt(store), prompt: turnMemoryPrompt(store, probes.tea), allText: store.claims().concat(store.claims('superseded')).map((claim) => claim.text).join('\n'),
        correctedRow: store.claims().find((claim) => claim.id === before.corrected.newId),
      };
    });
    expect(after.recall).toEqual(before.recall);
    expect(after.correctedRow?.supersedes_id).toBe(before.corrected.oldId);
    expect(after.superseded).toEqual(expect.arrayContaining([before.corrected.oldId, before.staleId]));
    expect(after.active).not.toContain(before.staleId);
    expect(after.recall.seat).not.toContain(before.staleId);
    expect(after.recall.route).toContain(before.kept);
    expect(after.recall.coffee).not.toContain(before.untrustedId);
    // Forget survives the rebuild: no claim text, a barrier row that stores no words, and nothing recalled.
    expect(after.allText.toLowerCase()).not.toContain(before.forgottenText);
    expect(after.barriers).toBeGreaterThan(0);
    expect(after.barrierText.toLowerCase()).not.toContain(before.forgottenText);
    expect(after.recall.tea).toEqual([]);
    expect(after.prompt.toLowerCase()).not.toContain(before.forgottenText);
  });

  it('another owner storage sees none of it', async () => {
    const other = await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('memory-restart-b')), (_instance, state) => {
      const store = claimStore(state.storage.sql);
      return { claims: store.claims().length, barriers: store.barriers().length, recall: store.recall(probes.coffee) };
    });
    expect(other).toEqual({ claims: 0, barriers: 0, recall: [] });
  });
});
