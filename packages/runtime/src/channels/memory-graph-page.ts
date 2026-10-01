// Paginated list/detail and bounded selected-pattern views over the owner-scoped Memory projection.
// Pure functions: no storage, no model, no mutation. Limits are request parameters; there is no
// built-in numeric cap because none has been measured. A deployment may inject a ceiling.
import { projectMemoryGraph } from './memory-graph';

export type MemoryGraph = ReturnType<typeof projectMemoryGraph>;
export type PageOptions = Readonly<{ ceiling?: number }>;
export type PageResult = Readonly<{ status: number; body: Record<string, unknown> }>;

const bad = (error: string, status = 400): PageResult => ({ status, body: { error } });
const posInt = (raw: string | null): number | null => (raw !== null && /^[0-9]{1,9}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null);
const enc = (value: unknown) => btoa(JSON.stringify(value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const dec = (raw: string | null): { v: 1; k: string; after: number } | null => {
  if (!raw) return null;
  try {
    const value = JSON.parse(atob(raw.replace(/-/g, '+').replace(/_/g, '/')));
    return value && value.v === 1 && typeof value.k === 'string' && Number.isSafeInteger(value.after) && value.after >= 0 ? value : null;
  } catch { return null; }
};
const localId = (ref: string) => Number(ref.split(':').pop());

const header = (g: MemoryGraph) => ({
  version: 1 as const, state: g.state, complete: g.complete, unavailable_claim_count: g.unavailable_claim_count, actions: [] as string[],
});

const limitOf = (params: URLSearchParams, name: string, opts: PageOptions): number | PageResult => {
  const n = posInt(params.get(name));
  if (n === null) return bad(`${name}_required`);
  if (opts.ceiling !== undefined && n > opts.ceiling) return bad(`${name}_over_ceiling`);
  return n;
};

export const pageMemoryGraph = (g: MemoryGraph, params: URLSearchParams, opts: PageOptions = {}): PageResult => {
  const view = params.get('view') ?? 'summary';
  if (view === 'summary') {
    return { status: 200, body: { ...header(g), view, counts: { claims: g.claims.length, interpretations: g.nodes.length, associations: g.associations.length }, views: ['claims', 'interpretations', 'detail', 'pattern'] } };
  }
  if (!['claims', 'interpretations', 'detail', 'pattern'].includes(view)) return bad('view_unknown');
  const claimById = new Map(g.claims.map((c) => [c.id, c]));
  const nodeById = new Map(g.nodes.map((n) => [n.id, n]));
  if (view === 'claims' || view === 'interpretations') {
    const limit = limitOf(params, 'limit', opts);
    if (typeof limit !== 'number') return limit;
    const rows = [...(view === 'claims' ? g.claims : g.nodes)].sort((a, b) => a.local_id - b.local_id);
    const cursorRaw = params.get('cursor');
    const cursor = dec(cursorRaw);
    if (cursorRaw && (cursor === null || cursor.k !== view)) return bad('cursor_invalid');
    const rest = rows.filter((r) => r.local_id > (cursor?.after ?? 0));
    const items = rest.slice(0, limit);
    const last = items[items.length - 1];
    const more = rest.length > items.length && last !== undefined;
    return { status: 200, body: { ...header(g), view, items, page: { limit, returned: items.length, total: rows.length, next_cursor: more ? enc({ v: 1, k: view, after: last.local_id }) : null } } };
  }
  const id = params.get('id');
  if (!id) return bad('id_required');
  if (view === 'detail') {
    const claim = claimById.get(id);
    if (claim) {
      const linked = g.nodes.filter((n) => n.support.claim_ids.includes(id)).map((n) => n.id);
      return { status: 200, body: { ...header(g), view, kind: 'claim', item: claim, linked_interpretation_ids: linked } };
    }
    const node = nodeById.get(id);
    if (node) return { status: 200, body: { ...header(g), view, kind: 'interpretation', item: node, support_claim_ids: node.support.claim_ids, support_unavailable_count: node.support.unavailable_count } };
    return bad('not_found', 404);
  }
  if (view === 'pattern') {
    const center = nodeById.get(id);
    if (!center) return bad('not_found', 404);
    const maxNodes = limitOf(params, 'max_nodes', opts);
    if (typeof maxNodes !== 'number') return maxNodes;
    const maxLinks = limitOf(params, 'max_links', opts);
    if (typeof maxLinks !== 'number') return maxLinks;
    const incident = g.associations.filter((a) => a.from === id || a.to === id);
    const neighborIds = [...new Set(incident.map((a) => (a.from === id ? a.to : a.from)))].filter((n) => nodeById.has(n)).sort((a, b) => localId(a) - localId(b));
    const cursorRaw = params.get('cursor');
    const cursor = dec(cursorRaw);
    if (cursorRaw && (cursor === null || cursor.k !== `pattern:${id}`)) return bad('cursor_invalid');
    const pool = neighborIds.filter((n) => localId(n) > (cursor?.after ?? 0));
    const shownIds = pool.slice(0, maxNodes);
    const neighborOf = (a: { from: string; to: string }) => (a.from === id ? a.to : a.from);
    const shownSet = new Set(shownIds);
    const later = new Set(pool.slice(maxNodes));
    const eligible = incident.filter((a) => shownSet.has(neighborOf(a)));
    const links = eligible.slice(0, maxLinks);
    const cappedHere = eligible.length - links.length;
    const remainingLinks = incident.filter((a) => later.has(neighborOf(a))).length;
    const lastShown = shownIds[shownIds.length - 1];
    const moreNodes = pool.length > shownIds.length && lastShown !== undefined;
    return { status: 200, body: {
      ...header(g), view, center, nodes: shownIds.map((n) => nodeById.get(n)), associations: links,
      showing: { nodes: shownIds.length, of_nodes: neighborIds.length, links: links.length, of_links: incident.length },
      truncated: moreNodes || cappedHere > 0,
      // Links still to come on later pages, plus links cut by max_links on this page.
      omitted_links: remainingLinks + cappedHere,
      expand: { next_cursor: moreNodes ? enc({ v: 1, k: `pattern:${id}`, after: localId(lastShown) }) : null, links_capped: cappedHere > 0, capped_links_recoverable: false, capped_links: cappedHere },
    } };
  }
  return bad('view_unknown');
};
