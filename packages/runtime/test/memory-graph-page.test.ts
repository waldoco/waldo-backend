import { describe, expect, it } from 'vitest';
import { projectMemoryGraph } from '../src/channels/memory-graph';
import { pageMemoryGraph } from '../src/channels/memory-graph-page';

const claim = (id: number) => ({ id, kind: 'observation', text: `c${id}`, evidence: 'w', origin: 'owner', source: 'stated', status: 'active', source_ref: '', created_at: '2026-09-28', last_seen_at: '2026-09-28', seen_count: 1 });
const node = (id: number, spots: number[]) => ({ id, label: `n${id}`, domain: 'work', summary: 's', strength: 0.5, status: 'active', last_confirmed: '2026-09-29', supporting_spots: JSON.stringify(spots) });
// hub node 1 linked to nodes 2..8
const graph = () => projectMemoryGraph({
  scope: 'o', complete: true,
  claims: [1, 2, 3, 4, 5].map(claim),
  nodes: [1, 2, 3, 4, 5, 6, 7, 8].map((i) => node(i, [1, 2])),
  edges: [2, 3, 4, 5, 6, 7, 8].map((to) => ({ from_id: 1, to_id: to, relation: 'r', strength: 0.5, evidence_count: 1 })),
});
const q = (o: Record<string, string>) => new URLSearchParams(o);
const items = (r: { body: Record<string, unknown> }) => r.body.items as { local_id: number }[];

describe('Memory pagination and bounded pattern view', () => {
  it('summary reports counts and no actions', () => {
    const r = pageMemoryGraph(graph(), q({}));
    expect(r.status).toBe(200);
    expect(r.body.counts).toEqual({ claims: 5, interpretations: 8, associations: 7 });
    expect(r.body.actions).toEqual([]);
  });
  it('claims paginate completely with no duplicates or gaps', () => {
    const g = graph(); const seen: number[] = []; let cursor = '';
    for (let i = 0; i < 10; i++) {
      const r = pageMemoryGraph(g, q({ view: 'claims', limit: '2', ...(cursor ? { cursor } : {}) }));
      seen.push(...items(r).map((x) => x.local_id));
      const next = (r.body.page as { next_cursor: string | null }).next_cursor;
      if (!next) break; cursor = next;
    }
    expect(seen).toEqual([1, 2, 3, 4, 5]);
  });
  it('limit is required and never defaulted', () => {
    expect(pageMemoryGraph(graph(), q({ view: 'claims' })).body.error).toBe('limit_required');
    expect(pageMemoryGraph(graph(), q({ view: 'claims', limit: '0' })).status).toBe(400);
    expect(pageMemoryGraph(graph(), q({ view: 'claims', limit: '-1' })).status).toBe(400);
  });
  it('an injected ceiling rejects over-large requests', () => {
    expect(pageMemoryGraph(graph(), q({ view: 'claims', limit: '9' }), { ceiling: 5 }).body.error).toBe('limit_over_ceiling');
  });
  it('cursor from another view or garbage is rejected', () => {
    const g = graph();
    const c = (pageMemoryGraph(g, q({ view: 'claims', limit: '1' })).body.page as { next_cursor: string }).next_cursor;
    expect(pageMemoryGraph(g, q({ view: 'interpretations', limit: '1', cursor: c })).body.error).toBe('cursor_invalid');
    expect(pageMemoryGraph(g, q({ view: 'claims', limit: '1', cursor: '!!' })).body.error).toBe('cursor_invalid');
  });
  it('detail returns a claim with its linked interpretations and 404s unknown ids', () => {
    const g = graph();
    const claimRef = g.claims[0]!.id;
    const d = pageMemoryGraph(g, q({ view: 'detail', id: claimRef }));
    expect(d.body.kind).toBe('claim');
    expect((d.body.linked_interpretation_ids as string[]).length).toBe(8);
    expect(pageMemoryGraph(g, q({ view: 'detail', id: 'nope' })).status).toBe(404);
  });
  it('pattern is bounded, says showing N of M, and expands without losing neighbours', () => {
    const g = graph(); const hub = g.nodes.find((n) => n.local_id === 1)!.id;
    const first = pageMemoryGraph(g, q({ view: 'pattern', id: hub, max_nodes: '3', max_links: '100' }));
    expect(first.body.showing).toEqual({ nodes: 3, of_nodes: 7, links: 3, of_links: 7 });
    expect(first.body.truncated).toBe(true);
    expect(first.body.omitted_links).toBe(4);
    const shown = new Set((first.body.nodes as { local_id: number }[]).map((n) => n.local_id));
    let cursor = (first.body.expand as { next_cursor: string | null }).next_cursor;
    while (cursor) {
      const r = pageMemoryGraph(g, q({ view: 'pattern', id: hub, max_nodes: '3', max_links: '100', cursor }));
      for (const n of r.body.nodes as { local_id: number }[]) { expect(shown.has(n.local_id)).toBe(false); shown.add(n.local_id); }
      cursor = (r.body.expand as { next_cursor: string | null }).next_cursor;
    }
    expect([...shown].sort()).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });
  it('link cap is reported, not silent', () => {
    const g = graph(); const hub = g.nodes.find((n) => n.local_id === 1)!.id;
    const r = pageMemoryGraph(g, q({ view: 'pattern', id: hub, max_nodes: '7', max_links: '2' }));
    expect(r.body.showing).toMatchObject({ links: 2, of_links: 7 });
    expect(r.body.truncated).toBe(true);
    expect((r.body.expand as { links_capped: boolean }).links_capped).toBe(true);
  });
  it('pattern requires both bounds and a known node', () => {
    const g = graph(); const hub = g.nodes[0]!.id;
    expect(pageMemoryGraph(g, q({ view: 'pattern', id: hub, max_links: '5' })).body.error).toBe('max_nodes_required');
    expect(pageMemoryGraph(g, q({ view: 'pattern', id: hub, max_nodes: '5' })).body.error).toBe('max_links_required');
    expect(pageMemoryGraph(g, q({ view: 'pattern', id: 'x', max_nodes: '5', max_links: '5' })).status).toBe(404);
  });
  it('partial state is carried on every page, never hidden', () => {
    const g = projectMemoryGraph({ scope: 'o', complete: false, claims: [claim(1)], nodes: [], edges: [] });
    const r = pageMemoryGraph(g, q({ view: 'claims', limit: '5' }));
    expect(r.body.state).toBe('partial'); expect(r.body.complete).toBe(false);
  });
  it('unknown view is a 400', () => {
    expect(pageMemoryGraph(graph(), q({ view: 'zzz' })).body.error).toBe('view_unknown');
  });
});
