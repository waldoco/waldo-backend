import { expect, it } from 'vitest';
import { buildModel, ROOT, visible } from './memory-map-graph';
import type { Claim, Interpretation } from './memory-model';
const spot = (id: string, source = 'inferred'): Claim => ({ id, kind: 'preference', text: `Spot ${id}`, source, origin: 'owner', status: 'active', evidence: { kind: 'writer_note', text: '' }, source_reference: { state: 'unverified', link: null }, recorded_at: '2026-10-01T00:00:00Z', writer_seen_count: 1 });
const pattern = (id: string, ids: string[]): Interpretation => ({ id, type: 'interpretation', label: `Pattern ${id}`, summary: '', domain: 'day', stored_status: 'active', recorded_active_at: '2026-10-01T00:00:00Z', estimate: null, support: { claim_ids: ids, unavailable_count: 0, independent_observations: 'unverified' } });
const model = buildModel([pattern('p1', ['a', 'b', 'c', 'missing']), pattern('p2', ['c'])], [spot('a', 'stated'), spot('b', 'confirmed'), spot('c'), spot('loose')]);

it('links only saved support that this read returned', () => {
  expect(model.spotsOf.get('p1')).toEqual(['a', 'b', 'c']);
  expect(model.patternsOf.get('c')).toEqual(['p1', 'p2']);
});
it('starts with Waldo, every pattern, a first ring of Spots, and loose Spots greyed', () => {
  const { nodes, links } = visible(model, null);
  expect(nodes.map(n => n.id)).toEqual([ROOT, 'p1', 'a', 'b', 'p2', 'c', 'loose']);
  expect(nodes.find(n => n.id === 'loose')?.connected).toBe(true);
  expect(nodes.find(n => n.id === 'a')?.shape).toBe('circle');
  expect(nodes.find(n => n.id === 'b')?.shape).toBe('square');
  expect(links.find(l => l.target === 'c')?.kind).toBe('dashed');
});
it('narrows a chosen pattern to its Spots and the patterns that share them', () => {
  const { nodes } = visible(model, 'p1');
  expect(nodes.map(n => n.id)).toEqual([ROOT, 'p1', 'a', 'b', 'c', 'p2']);
  expect(nodes.find(n => n.id === 'p2')?.connected).toBe(true);
});
it('hangs a chosen Spot on its first pattern and greys the others it supports', () => {
  expect(visible(model, 'c').nodes.map(n => [n.id, !!n.connected])).toEqual([[ROOT, false], ['p1', false], ['c', false], ['p2', true]]);
  expect(visible(model, 'loose').links.map(l => l.source)).toEqual([ROOT]);
});
