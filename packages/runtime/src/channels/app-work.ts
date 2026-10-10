import {
  APP_WORK_MAX_REQUEST_BYTES, appWorkApprovalIntentV1Schema, appWorkBrowserIntentV1Schema,
  appWorkBrowserStateV1Schema, appWorkDetailV1Schema, appWorkIntentV1Schema, appWorkListQueryV1Schema,
  appWorkOperationIdV1Schema, appWorkOperationResultV1Schema, appWorkProjectionV1Schema, appWorkRefV1Schema,
  type AppWorkApprovalIntentV1, type AppWorkApprovalV1, type AppWorkBrowserIntentV1, type AppWorkControlV1,
  type AppWorkFileV1, type AppWorkIntentV1, type AppWorkOperationResultV1, type AppWorkReceiptV1, type AppWorkTaskV1,
} from '../../../contracts/src/app/work';
import type { ResponsibilityBook } from './responsibilities';
import type { EffectRecord } from './owner-effect-ledger';
import { sha256Hex } from '../connectors/google';
import { stableJson } from '../context-composer/canonical';

export type AppWorkCanonicalUnit = Readonly<{
  id: string; ownerId: string; outcomeId: string; revision: number; responsibility: string; state: string;
  createdAt: string; updatedAt: string;
}>;
export type AppWorkRun = Readonly<{ id: string; kind: string; status: string; summary: string | null; parent_id: string | null; started: string; ended: string | null }>;
export type AppWorkAppliedControl = Pick<AppWorkReceiptV1, 'state' | 'revision' | 'cancellation' | 'external_effects' | 'message' | 'evidence_refs'>;
export type AppWorkHandoffState = Readonly<{ state: string; origin: string; reason: string; expiresAt: number; session_handle: string; generation: number; handoff_id: string }>;
export type AppWorkHost = Readonly<{
  accountRef: string; principalRef: string; sessionRef: string;
  storage: Pick<DurableObjectStorage, 'kv'>; commit<T>(change: () => T): T;
  now(): number; assertCurrent(): Promise<void>; sourceRevision(): number;
  responsibilities: Pick<ResponsibilityBook, 'all' | 'get' | 'items'>;
  canonicalWorkUnits(): Promise<readonly AppWorkCanonicalUnit[]>;
  runs(): Promise<readonly AppWorkRun[]>;
  effects(): readonly EffectRecord[];
  // This producer reads frozen proposals from the existing approval ledger. A
  // missing exact digest permits inspection but never advertises approval.
  approvals(): Promise<readonly AppWorkApprovalV1[]>;
  files(): Promise<readonly AppWorkFileV1[]>;
  controls(workRef: string): AppWorkControlV1;
  control(intent: AppWorkIntentV1, assertCurrent: () => Promise<void>): Promise<AppWorkAppliedControl>;
  decide(intent: AppWorkApprovalIntentV1, assertCurrent: () => Promise<void>): Promise<AppWorkAppliedControl>;
  browser: Readonly<{
    state(assertCurrent: () => Promise<void>): Promise<AppWorkHandoffState | undefined>;
    open(intent: AppWorkBrowserIntentV1, assertCurrent: () => Promise<void>): Promise<AppWorkHandoffState & { url: string }>;
    resume(intent: AppWorkBrowserIntentV1, assertCurrent: () => Promise<void>): Promise<AppWorkAppliedControl>;
    revoke(intent: AppWorkBrowserIntentV1, assertCurrent: () => Promise<void>): Promise<{ ended: true; session_handle: string; generation: number }>;
  }>;
}>;
type StoredOperation = { digest: string; session: string; receipt: AppWorkReceiptV1 };
type ProjectionQuery = { limit: number; kind?: 'responsibility' | 'work_unit' | 'run'; cursor?: string };
type ProjectionWitness = { revision: string; session: string; expires_at: number; query: ProjectionQuery | { detail: string } };
class WorkFault extends Error { constructor(readonly status: number, readonly code: string) { super(code); } }
const reply = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'private, no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' } });
const epoch = (value: string | null): number | null => value !== null && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const queues = new WeakMap<object, Promise<unknown>>();
async function serialize<T>(storage: object, operation: () => Promise<T>) {
  const queued = (queues.get(storage) ?? Promise.resolve()).catch(() => undefined).then(operation);
  queues.set(storage, queued);
  try { return await queued; } finally { if (queues.get(storage) === queued) queues.delete(storage); }
}
async function readJson<T>(request: Request, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T> {
  if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json' || !request.body) throw new WorkFault(400, 'invalid_request');
  const reader = request.body.getReader(), parts: Uint8Array[] = []; let size = 0, expired = false;
  const timeout = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try {
    while (true) { const part = await reader.read(); if (expired) throw new WorkFault(503, 'body_timeout'); if (part.done) break;
      size += part.value.byteLength; if (size > APP_WORK_MAX_REQUEST_BYTES) { await reader.cancel(); throw new WorkFault(413, 'body_too_large'); } parts.push(part.value); }
  } finally { clearTimeout(timeout); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let raw: unknown; try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw new WorkFault(400, 'invalid_request'); }
  const parsed = schema.safeParse(raw); if (!parsed.success) throw new WorkFault(400, 'invalid_request'); return parsed.data;
}

export function appWork(host: AppWorkHost) {
  const prefix = `app:work.v1:${host.accountRef}:operation:`;
  const witnessKey = `app:work.v1:${host.accountRef}:projections`;
  const issued = () => host.storage.kv.get<ProjectionWitness[]>(witnessKey) ?? [];
  const witness = (revision: string, query: ProjectionWitness['query']) => host.commit(() => {
    const current = issued().filter(row => row.expires_at > host.now() && !(row.revision === revision && row.session === host.sessionRef));
    // Only the query and digest survive restart; source bodies and review payloads
    // stay in their canonical books. Recent pages remain controllable independently.
    host.storage.kv.put(witnessKey, [...current.slice(-63), { revision, query, session: host.sessionRef, expires_at: host.now() + 300_000 } satisfies ProjectionWitness]);
  });
  const tasks = async (): Promise<AppWorkTaskV1[]> => {
    const units = await host.canonicalWorkUnits(), runs = await host.runs();
    await host.assertCurrent();
    if (units.some(unit => unit.ownerId !== host.principalRef)) throw new WorkFault(503, 'work_owner_mismatch');
    return [
      ...host.responsibilities.all().map(row => ({
        work_ref: `responsibility:${row.id}`, kind: 'responsibility' as const, source_ref: row.created_from,
        title: row.title, intent: row.intent, status: row.status, revision: row.revision, account: row.account, grant_ref: row.grant_ref,
        outcome_ref: null, parent_ref: null, created_at: row.created_at, updated_at: null, closed_at: row.closed_at,
        closure_evidence_ref: row.closed_by_evidence, items: host.responsibilities.items(row.id).map(({ responsibility_id: _parent, ...item }) => ({ ...item, depends_on: [...item.depends_on] })),
        controls: host.controls(`responsibility:${row.id}`),
      })),
      ...units.map(unit => ({
        work_ref: `work_unit:${unit.id}`, kind: 'work_unit' as const, source_ref: unit.id, title: unit.responsibility, intent: null,
        status: unit.state, revision: unit.revision, account: null, grant_ref: null, outcome_ref: unit.outcomeId, parent_ref: null,
        created_at: epoch(unit.createdAt), updated_at: epoch(unit.updatedAt), closed_at: null, closure_evidence_ref: null, items: [], controls: host.controls(`work_unit:${unit.id}`),
      })),
      ...runs.map(run => ({
        work_ref: `run:${run.id}`, kind: 'run' as const, source_ref: run.id, title: run.summary ?? run.kind, intent: null,
        status: run.status, revision: null, account: null, grant_ref: null, outcome_ref: null, parent_ref: run.parent_id,
        created_at: epoch(run.started), updated_at: epoch(run.ended), closed_at: epoch(run.ended), closure_evidence_ref: null, items: [], controls: host.controls(`run:${run.id}`),
      })),
    ].sort((a, b) => (b.created_at ?? 0) - (a.created_at ?? 0) || a.work_ref.localeCompare(b.work_ref));
  };
  const envelope = () => ({ version: 'work.v1' as const, account_ref: host.accountRef, source_revision: host.sourceRevision(), observed_at: host.now() });
  const projection = async (query: ProjectionQuery = { limit: 20 }) => {
    const sourceRevision = host.sourceRevision(), retained = await tasks(), all = retained.filter(task => !query.kind || task.kind === query.kind);
    const byKind = { responsibility: 0, work_unit: 0, run: 0 }, statuses = new Map<string, { kind: AppWorkTaskV1['kind']; status: string; count: number }>();
    for (const task of retained) {
      byKind[task.kind]++;
      const key = `${task.kind}:${task.status}`, count = statuses.get(key) ?? { kind: task.kind, status: task.status, count: 0 };
      count.count++; statuses.set(key, count);
    }
    const counts = { scope: 'retained_owner_records' as const, total: retained.length, by_kind: byKind, by_status: [...statuses.values()].sort((a, b) => a.kind.localeCompare(b.kind) || a.status.localeCompare(b.status)) };
    const start = query.cursor ? all.findIndex(task => task.work_ref === query.cursor) + 1 : 0;
    if (query.cursor && start === 0) throw new WorkFault(409, 'cursor_changed');
    const selected = all.slice(start, start + query.limit), approvals = await host.approvals(), files = await host.files();
    const effects = await Promise.all(host.effects().map(async effect => ({ operation_ref: effect.operationId, tool: effect.tool, state: effect.state,
      created_at: effect.created_at, provider_ref: effect.receipt?.provider_id ?? null, payload_digest: await sha256Hex(stableJson(effect.payload)) })));
    await host.assertCurrent(); if (sourceRevision !== host.sourceRevision()) throw new WorkFault(409, 'source_changed');
    const material = { version: 'work.v1' as const, account_ref: host.accountRef, source_revision: sourceRevision, counts, tasks: selected, approvals, effects, files,
      next_cursor: start + selected.length < all.length ? selected.at(-1)!.work_ref : null };
    const value = appWorkProjectionV1Schema.parse({ ...material, observed_at: host.now(), revision: await sha256Hex(stableJson(material)) });
    await host.assertCurrent(); if (sourceRevision !== host.sourceRevision()) throw new WorkFault(409, 'source_changed');
    witness(value.revision, query); return value;
  };
  const detail = async (id: string) => {
    const sourceRevision = host.sourceRevision(), task = (await tasks()).find(task => task.work_ref === id);
    if (!task) throw new WorkFault(404, 'work_not_found');
    const material = { ...envelope(), task };
    if (sourceRevision !== material.source_revision) throw new WorkFault(409, 'source_changed');
    const revision = await sha256Hex(stableJson({ account_ref: host.accountRef, source_revision: sourceRevision, task }));
    await host.assertCurrent(); if (sourceRevision !== host.sourceRevision()) throw new WorkFault(409, 'source_changed');
    const value = appWorkDetailV1Schema.parse({ ...material, revision }); witness(revision, { detail: id }); return value;
  };
  const browserState = async () => {
    const state = await host.browser.state(host.assertCurrent); await host.assertCurrent();
    const handoff = state ? { session_handle: state.session_handle, generation: state.generation, handoff_id: state.handoff_id,
      origin: state.origin, reason: state.reason, expires_at: state.expiresAt } : null;
    if (state && (state.state !== 'pending' || state.expiresAt <= host.now())) throw new WorkFault(409, 'handoff_changed');
    const material = { version: 'work.v1' as const, state: state ? 'waiting_for_owner' as const : 'none_recorded' as const, handoff };
    const value = appWorkBrowserStateV1Schema.parse({ ...material, revision: await sha256Hex(stableJson(material)) });
    await host.assertCurrent(); return value;
  };
  const lookup = (id: string) => host.storage.kv.get<StoredOperation>(prefix + id);
  const record = async (path: string, intent: AppWorkIntentV1 | AppWorkApprovalIntentV1 | AppWorkBrowserIntentV1): Promise<AppWorkOperationResultV1> => serialize(host.storage, async () => {
    await host.assertCurrent(); const digest = await sha256Hex(stableJson([path, intent])); await host.assertCurrent();
    const prior = lookup(intent.operation_id);
    if (prior) { if (prior.digest !== digest || prior.session !== host.sessionRef) throw new WorkFault(409, 'operation_conflict'); return { receipt: prior.receipt, duplicate: true, handoff: null }; }
    let action: AppWorkReceiptV1['action'], target: string;
    if ('expected' in intent) {
      const state = await browserState(); if (state.revision !== intent.revision || stableJson(intent.expected) !== stableJson(state.handoff && { session_handle: state.handoff.session_handle, generation: state.handoff.generation, handoff_id: state.handoff.handoff_id })) throw new WorkFault(409, 'handoff_changed');
      action = path.endsWith('/open') ? 'browser.open' : path.endsWith('/resume') ? 'browser.resume' : 'browser.revoke'; target = intent.expected.handoff_id;
    } else {
      const issuedPage = issued().find(row => row.revision === intent.projection_revision && row.session === host.sessionRef && row.expires_at > host.now());
      if (!issuedPage) throw new WorkFault(409, 'stale_projection');
      if ('detail' in issuedPage.query && (!('work_ref' in intent) || intent.work_ref !== issuedPage.query.detail)) throw new WorkFault(409, 'stale_projection');
      const shown = 'detail' in issuedPage.query ? await detail(issuedPage.query.detail) : await projection(issuedPage.query);
      if (shown.revision !== intent.projection_revision || shown.source_revision !== intent.expected_source_revision) throw new WorkFault(409, 'stale_projection');
      action = intent.action;
      if ('work_ref' in intent) {
        const task = 'task' in shown ? shown.task : shown.tasks.find(task => task.work_ref === intent.work_ref);
        if (!task || task.controls.revision !== intent.expected_revision || !task.controls.allowed.includes(intent.action)) throw new WorkFault(409, 'control_changed'); target = intent.work_ref;
      } else {
        const proposal = 'approvals' in shown ? shown.approvals.find(proposal => proposal.id === intent.approval_id) : undefined;
        if (!proposal || proposal.proposal_digest !== intent.proposal_digest || !proposal.actions.includes(intent.action)) throw new WorkFault(409, 'proposal_changed'); target = intent.approval_id;
      }
    }
    await host.assertCurrent();
    let receipt: AppWorkReceiptV1 = { version: 'work.v1', operation_id: intent.operation_id, target_ref: target, action, state: 'unconfirmed', recorded_at: host.now(),
      revision: null, cancellation: action === 'stop' || action === 'pause' || action === 'browser.revoke' ? 'unconfirmed' : 'not_requested', external_effects: 'unresolved',
      message: 'The operation outcome is unconfirmed. Read this exact receipt before issuing another operation.', evidence_refs: [] };
    // Intent is durable before I/O. Interrupted or uncertain operations remain
    // inspectable and can never be retried implicitly by a transport replay.
    host.commit(() => { if (lookup(intent.operation_id)) throw new WorkFault(409, 'operation_conflict'); host.storage.kv.put(prefix + intent.operation_id, { digest, session: host.sessionRef, receipt } satisfies StoredOperation); });
    let handoff: AppWorkOperationResultV1['handoff'] = null;
    try {
      let applied: AppWorkAppliedControl;
      if ('work_ref' in intent) applied = await host.control(intent, host.assertCurrent);
      else if ('approval_id' in intent) applied = await host.decide(intent, host.assertCurrent);
      else if (action === 'browser.open') {
        const opened = await host.browser.open(intent, host.assertCurrent), url = new URL(opened.url);
        if (opened.session_handle !== intent.expected.session_handle || opened.generation !== intent.expected.generation || opened.handoff_id !== intent.expected.handoff_id || url.origin !== 'https://live.browser.run' || url.username || url.password || opened.expiresAt <= host.now() || opened.expiresAt > host.now() + 300_000) throw new WorkFault(503, 'handoff_unavailable');
        handoff = { url: opened.url, origin: opened.origin, expires_at: opened.expiresAt };
        applied = { state: 'recorded', revision: opened.generation, cancellation: 'not_requested', external_effects: 'none_recorded', message: 'Owner browser handoff is ready. This does not verify a completed sign-in.', evidence_refs: [opened.handoff_id] };
      } else if (action === 'browser.revoke') {
        const ended = await host.browser.revoke(intent, host.assertCurrent);
        if (!ended.ended || ended.session_handle !== intent.expected.session_handle || ended.generation !== intent.expected.generation) throw new WorkFault(503, 'handoff_unavailable');
        applied = { state: 'recorded', revision: ended.generation, cancellation: 'fenced', external_effects: 'none_recorded', message: 'Browser session closure was verified. Earlier external effects remain independent.', evidence_refs: [intent.expected.handoff_id] };
      } else applied = await host.browser.resume(intent, host.assertCurrent);
      await host.assertCurrent(); receipt = appWorkOperationResultV1Schema.shape.receipt.parse({ ...receipt, ...applied });
      host.commit(() => host.storage.kv.put(prefix + intent.operation_id, { digest, session: host.sessionRef, receipt } satisfies StoredOperation));
    } catch { handoff = null; }
    return appWorkOperationResultV1Schema.parse({ receipt, duplicate: false, handoff });
  });
  return {
    projection, browserState,
    async request(request: Request): Promise<Response | null> {
      const url = new URL(request.url), path = url.pathname;
      if (path !== '/app/v1/work' && !path.startsWith('/app/v1/work/')) return null;
      try {
        await host.assertCurrent();
        if (request.method === 'GET') {
          if (path === '/app/v1/work') {
            if ([...url.searchParams.keys()].some(key => !['kind', 'limit', 'cursor'].includes(key) || url.searchParams.getAll(key).length !== 1)) throw new WorkFault(400, 'invalid_query');
            const query = appWorkListQueryV1Schema.safeParse(Object.fromEntries(url.searchParams)); if (!query.success) throw new WorkFault(400, 'invalid_query'); return reply(await projection(query.data));
          }
          if (url.search) throw new WorkFault(400, 'invalid_query');
          if (path === '/app/v1/work/browser') return reply(await browserState());
          if (path.startsWith('/app/v1/work/operations/')) {
            const id = path.slice('/app/v1/work/operations/'.length); if (!appWorkOperationIdV1Schema.safeParse(id).success) throw new WorkFault(400, 'invalid_operation');
            const row = lookup(id); if (!row) throw new WorkFault(404, 'operation_not_found'); await host.assertCurrent(); return reply(appWorkOperationResultV1Schema.parse({ receipt: row.receipt, duplicate: true, handoff: null }));
          }
          if (path.startsWith('/app/v1/work/tasks/')) {
            let id: string; try { id = decodeURIComponent(path.slice('/app/v1/work/tasks/'.length)); } catch { throw new WorkFault(400, 'invalid_work_ref'); }
            if (!appWorkRefV1Schema.safeParse(id).success) throw new WorkFault(400, 'invalid_work_ref');
            return reply(await detail(id));
          }
          throw new WorkFault(404, 'not_found');
        }
        if (request.method !== 'POST') throw new WorkFault(405, 'method_not_allowed');
        if (url.search || request.headers.get('origin') !== null && request.headers.get('origin') !== url.origin) throw new WorkFault(400, 'invalid_request');
        const schema = path === '/app/v1/work/operations' ? appWorkIntentV1Schema : path === '/app/v1/work/approvals' ? appWorkApprovalIntentV1Schema : /^\/app\/v1\/work\/browser\/(open|resume|revoke)$/.test(path) ? appWorkBrowserIntentV1Schema : null;
        if (!schema) throw new WorkFault(404, 'not_found');
        const intent = await readJson(request, schema as { safeParse(value: unknown): { success: true; data: AppWorkIntentV1 | AppWorkApprovalIntentV1 | AppWorkBrowserIntentV1 } | { success: false } });
        return reply(await record(path, intent));
      } catch (error) { return error instanceof WorkFault ? reply({ error: error.code }, error.status) : reply({ error: 'work_unavailable' }, 503); }
    },
  };
}
