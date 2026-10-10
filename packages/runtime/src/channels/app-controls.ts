import { appControlActionV1Schema, appControlProjectionV1Schema, appControlQueryV1Schema, appControlRequestIdV1Schema, appControlResultV1Schema } from '@waldo/contracts';
import { controlAction, controlRevision, approvalControlReceipt } from './dashboard-control-actions';
import { projectControls, readControlsQuery } from './dashboard-controls';
import { projectMemoryControl, resolveMemoryAction } from './dashboard-memory-actions';
import type { ConsoleAction, ConsoleView } from './console';
import type { ApprovalDesk, ApprovalItem } from './approvals';

export type AppControlsHost = {
  csrf: string; expires: number; storage: DurableObjectStorage; scope: string;
  assertCurrent(): Promise<void>; sessions(): Promise<readonly { csrf: string; expires: number }[]>;
  view(page?: { traceBefore?: number; runsBefore?: number }): Promise<ConsoleView>; act(action: ConsoleAction): Promise<boolean | string>; desk: ApprovalDesk;
  connect(feature: string): Promise<string | null>; signout(all: boolean): Promise<boolean>;
  mayApprove?(item: ApprovalItem | undefined): boolean;
};
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'private, no-store' } });
const removal = (view: ConsoleView) => ({ state: view.forgettingSpots.length ? 'incomplete' as const : 'none_recorded' as const, pending_count: view.forgettingSpots.length });
const claimRef = (scope: string, id: number) => `${scope}:claim:${id}`;
const nodeRef = (scope: string, id: number) => `${scope}:node:${id}`;
const controlRef = (id: string) => ({ view: 'memory' as const, id });
const supportingRefs = (scope: string, raw: string): string[] | null => {
  let ids: unknown; try { ids = JSON.parse(raw); } catch { return null; }
  return Array.isArray(ids) && ids.every(id => Number.isSafeInteger(id) && id > 0) ? ids.map(id => claimRef(scope, id)) : null;
};
function memoryIndex(view: ConsoleView, scope: string) {
  const purging = new Set(view.forgettingSpots.map(claim => claim.id));
  const spots = {
    items: view.spots.filter(claim => !purging.has(claim.id)).map(claim => ({
      id: claimRef(scope, claim.id), control_ref: controlRef(claimRef(scope, claim.id)), kind: claim.kind, text: claim.text,
      source: claim.source, account: null, source_ref: claim.source_ref ?? null, evidence: claim.evidence, origin: claim.origin ?? 'legacy', status: claim.status,
      created_at: claim.created_at, last_seen_at: claim.last_seen_at, seen_count: claim.seen_count, learned_at: claim.learned_at ?? null,
      valid_from: claim.valid_from ?? null, valid_to: claim.valid_to ?? null, supersedes_id: claim.supersedes_id == null ? null : claimRef(scope, claim.supersedes_id), verification_status: claim.verification_status ?? null,
    })),
    pending: view.forgettingSpots.map(claim => ({ id: claimRef(scope, claim.id), kind: 'claim' as const, source: claim.source, origin: claim.origin ?? 'legacy', status: 'purging' as const, actions: ['spot.forget'] })),
    retired_count: view.retiredSpots.length, removal: removal(view),
  };
  // Derived labels may still carry text whose removal is incomplete.
  const constellations = {
    nodes: view.forgettingSpots.length ? [] : view.nodes.map(node => ({
      id: nodeRef(scope, node.id), control_ref: controlRef(nodeRef(scope, node.id)), domain: node.domain, label: node.label, summary: node.summary,
      strength: node.strength, status: node.status, first_seen: node.first_seen, last_confirmed: node.last_confirmed, supporting_spots: supportingRefs(scope, node.supporting_spots),
    })),
    edges: view.forgettingSpots.length ? [] : view.edges.map(edge => ({ from_id: nodeRef(scope, edge.from_id), to_id: nodeRef(scope, edge.to_id), relation: edge.relation, strength: edge.strength, evidence_count: edge.evidence_count })),
    removal: removal(view),
  };
  return { kind: 'index' as const, spots, constellations };
}
export async function appControlsRequest(request: Request, host: AppControlsHost): Promise<Response | null> {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/app/v1/controls' && path !== '/app/v1/actions' && !path.startsWith('/app/v1/actions/')) return null;
  await host.assertCurrent();
  if (path.startsWith('/app/v1/actions/')) {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
    const requestId = path.slice('/app/v1/actions/'.length);
    if (!appControlRequestIdV1Schema.safeParse(requestId).success || url.search) return reply({ error: 'invalid_query' }, 400);
    const session = await controlRevision(host.csrf);
    const receipts = await host.storage.get<Record<string, { receipt: unknown; expires: number }>>('console:control-receipts') ?? {};
    const row = receipts[`${session}:${requestId}`];
    if (!row || row.expires <= Date.now()) return reply({ error: 'receipt_not_found' }, 404);
    const result = appControlResultV1Schema.safeParse({ request_id: requestId, receipt: row.receipt, duplicate: true });
    if (!result.success) return reply({ error: 'receipt_unavailable' }, 503);
    await host.assertCurrent(); return reply(result.data);
  }
  let built: ConsoleView | undefined;
  const read = async (page?: { traceBefore?: number; runsBefore?: number }) => built ?? (built = await host.view(page));
  const projection = async (selected: string, id?: string, page?: { traceBefore?: number; runsBefore?: number }) => {
    if (selected === 'memory' && id) {
      const view = await read();
      if (view.forgettingSpots.length && view.nodes.some(node => nodeRef(host.scope, node.id) === id)) return null;
      if (view.forgettingSpots.some(claim => claimRef(host.scope, claim.id) === id)) return projectMemoryControl({ ...view, spots: [] }, host.scope, id);
      return projectMemoryControl(view, host.scope, id);
    }
    if (['memory', 'spots', 'constellations'].includes(selected)) {
      if (id) return null;
      const view = await read(), data = memoryIndex(view, host.scope);
      return { version: 1 as const, view: selected, state: 'available' as const, csrf: view.csrf, data: selected === 'memory' ? data : selected === 'spots' ? data.spots : data.constellations };
    }
    const parsed = readControlsQuery(new URLSearchParams({ view: selected }));
    return parsed ? projectControls(await read(page), parsed.view, host.mayApprove) : null;
  };
  if (path === '/app/v1/controls') {
    if (request.method !== 'GET') return reply({ error: 'method_not_allowed' }, 405);
    if ([...url.searchParams.keys()].some(key => !['view', 'id', 'trace_before', 'runs_before'].includes(key) || url.searchParams.getAll(key).length !== 1)) return reply({ error: 'invalid_query' }, 400);
    const query = appControlQueryV1Schema.safeParse(Object.fromEntries(url.searchParams));
    if (!query.success) return reply({ error: 'invalid_query' }, 400);
    if (query.data.id !== undefined && query.data.view !== 'memory') return reply({ error: 'not_found' }, 404);
    const page = { ...(query.data.trace_before ? { traceBefore: Number(query.data.trace_before) } : {}), ...(query.data.runs_before ? { runsBefore: Number(query.data.runs_before) } : {}) };
    const result = await projection(query.data.view, query.data.id, page);
    if (!result) return reply({ error: 'not_found' }, 404);
    await host.assertCurrent();
    const { csrf: _csrf, ...shown } = result;
    const parsed = appControlProjectionV1Schema.safeParse({ ...shown, revision: await controlRevision(result) });
    return parsed.success ? reply(parsed.data) : reply({ error: 'projection_unavailable' }, 503);
  }
  if (request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  let raw: unknown; try { raw = await request.json(); } catch { return reply({ error: 'invalid_action' }, 400); }
  const parsed = appControlActionV1Schema.safeParse(raw);
  if (!parsed.success) return reply({ error: 'invalid_action' }, 400);
  const form = new FormData();
  for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined) form.set(key, value);
  form.set('csrf', host.csrf);
  const response = await controlAction(form, {
    csrf: host.csrf, expires: host.expires, sessions: host.sessions, store: host.storage, view: read, projection,
    mayApprove: host.mayApprove,
    act: async action => {
      await host.assertCurrent();
      if (action.action.startsWith('approval.')) return approvalControlReceipt(await host.desk.decide(action.id, action.action === 'approval.approve' ? 'a' : action.action === 'approval.skip' ? 's' : action.action === 'approval.edit' ? 'e' : 'u', 'app:approval', host.assertCurrent));
      if (['spot.confirm', 'spot.dismiss', 'spot.forget', 'node.forget'].includes(action.action)) {
        const resolved = resolveMemoryAction(await read(), host.scope, action);
        return resolved ? host.act(resolved) : false;
      }
      if (action.action === 'google.connect') {
        const target = await host.connect(action.value);
        if (!target) return { state: 'rejected', message: 'Connection could not be prepared.' };
        const destination = new URL(target);
        if (destination.origin !== url.origin || !/^\/c\/[A-Za-z0-9_-]{22}$/.test(destination.pathname) || destination.search || destination.hash) return { state: 'rejected', message: 'Connection destination could not be verified.' };
        return { state: 'recorded', message: 'Connection is ready. Provider access has not been granted yet.', navigation: target };
      }
      if (action.action === 'session.signout' || action.action === 'session.signout.all') {
        const result = await host.signout(action.action === 'session.signout.all');
        return result ? { state: 'recorded', message: 'Session revocation was recorded.', signed_out: true } : { state: 'unconfirmed', message: 'Session revocation could not be confirmed.' };
      }
      return host.act(action);
    },
  });
  const body: unknown = await response.json();
  if (typeof body !== 'object' || body === null || !('receipt' in body)) return reply(body as object, response.status);
  const result = appControlResultV1Schema.safeParse({ ...body, request_id: parsed.data.request_id });
  return result.success ? reply(result.data, response.status) : reply({ error: 'receipt_unavailable' }, 503);
}
