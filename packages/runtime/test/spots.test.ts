import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { applyPromotion, applySpotOps, spotStore, spotsPrompt } from '../src/memory/spots';

let sequence = 0;
const withSql = <T>(fn: (sql: SqlStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`spots-${sequence++}`)), (_instance, state) => fn(state.storage.sql));
const ops = (value: object) => JSON.stringify({ add: [], seen: [], dismiss: [], forget_spots: [], forget_nodes: [], ...value });

describe('spots and constellation', () => {
  it('adds, re-sees, dismisses and forgets spots from model ops', async () => {
    await withSql((sql) => {
      const store = spotStore(sql);
      applySpotOps(store, ops({ add: [
        { kind: 'pattern', text: 'Sleeps badly after late calls', source: 'stated', evidence: 'owner, 23 Sep' },
        { kind: 'preference', text: 'Prefers gym at 11am', source: 'inferred', evidence: 'two turns' },
      ] }), '2026-09-23T10:00:00Z');
      const [late, gym] = [...store.spots()].sort((a, b) => a.id - b.id);
      applySpotOps(store, ops({ seen: [late!.id, 999], dismiss: [gym!.id] }), '2026-09-24T10:00:00Z');
      expect(store.spots().map((spot) => [spot.text, spot.seen_count])).toEqual([['Sleeps badly after late calls', 2]]);
      expect(store.spots('dismissed')).toHaveLength(1);
      expect(spotsPrompt(store)).toMatch(/source="stated" seen="2" [^>]*>Sleeps badly after late calls \| evidence: owner, 23 Sep</);
      applySpotOps(store, ops({ forget_spots: [late!.id] }), '2026-09-24T11:00:00Z');
      expect(store.spots()).toHaveLength(0);
    });
  });

  it('promotes spots to nodes and edges, and forgetting a node drops its edges', async () => {
    await withSql((sql) => {
      const store = spotStore(sql);
      applySpotOps(store, ops({ add: [{ kind: 'pattern', text: 'Late calls most weeks', source: 'stated', evidence: 'calendar' }] }), '2026-09-23T10:00:00Z');
      const spot = store.spots()[0]!.id;
      applyPromotion(store, JSON.stringify({
        nodes: [
          { id: null, domain: 'work rhythm', label: 'Late calls', summary: 'Calls after 10pm', strength: 0.7, status: 'active', supporting_spots: [spot] },
          { id: null, domain: 'sleep', label: 'Short sleep', summary: 'Under 6h', strength: 0.6, status: 'active', supporting_spots: [] },
        ],
        edges: [{ from: 'new:0', to: 'new:1', relation: 'tends to precede', strength: 0.5, evidence_count: 3 }, { from: 'new:0', to: '404', relation: 'worsens', strength: 1, evidence_count: 1 }],
        promoted: [spot],
      }), '2026-09-24T03:00:00Z');
      expect(store.nodes().map((node) => node.label)).toEqual(['Late calls', 'Short sleep']);
      expect(store.edges()).toHaveLength(1);
      expect(store.spots('promoted')).toHaveLength(1);
      expect(spotsPrompt(store)).toContain('<edge>Late calls tends to precede Short sleep (strength 0.5)</edge>');
      applySpotOps(store, ops({ forget_nodes: [store.nodes()[0]!.id] }), '2026-09-24T09:00:00Z');
      expect(store.nodes().map((node) => node.label)).toEqual(['Short sleep']);
      expect(store.edges()).toHaveLength(0);
    });
  });
});
