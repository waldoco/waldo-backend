import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { googleClient } from '../src/connectors/google';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { googleTaskApprovals } from '../src/channels/google-task-approvals';
import { pinProxyIntentRoute } from '../src/connectors/proxy-intent-route';
import { googleTaskHandlers } from '../src/tools/live/tasks';
import { GoogleError } from '../src/connectors/google';
import { approvalDesk } from '../src/channels/approvals';

const app = { clientId: 'fixture', clientSecret: 'fixture', redirectUri: 'https://example.test/callback' };
const account = { connection_id: 'connection', email: 'owner@example.test' };
const create = { source: 'google_tasks' as const, action: 'create' as const, task_list_id: 'work/team', changes: { title: 'Prepare proposal', notes: 'Exact body', due_date: '2026-10-11' }, reason: 'Agreed next step' };
const fixture = () => {
  const db = new DatabaseSync(':memory:');
  const sql = { exec: (query: string, ...params: any[]) => {
    const result = db.prepare(query); const rows = result.columns().length ? result.all(...params) : (result.run(...params), []);
    return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
  } } as unknown as SqlStorage;
  const values = new Map<string, unknown>();
  const storage = { kv: { get: (key: string) => structuredClone(values.get(key)), put: (key: string, value: unknown) => values.set(key, structuredClone(value)), list: ({ prefix }: { prefix: string }) => new Map([...values].filter(([key]) => key.startsWith(prefix))) }, transactionSync: <T>(work: () => T) => work() } as unknown as DurableObjectStorage;
  const state = { writes: 0, unavailable: false, responseLost: false, wrongReadback: false, preconditionRejected: false, wrongMutationId: false, revoked: false, wrongAccount: false, cardUnconfirmed: false, onMutation: null as (() => void) | null, cards: [] as string[], task: { kind: 'tasks#task', id: 'existing', title: 'Original', notes: 'Owner notes', due: '2026-10-10T00:00:00.000Z', status: 'needsAction', etag: 'v1' } as Record<string, unknown>, requests: [] as { method: string; url: URL; body: any; headers: Headers }[] };
  let sequence = 0;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'oauth2.googleapis.com') return Response.json({ access_token: 'fixture' });
    const method = init?.method ?? 'GET'; const body = init?.body ? JSON.parse(String(init.body)) : null;
    state.requests.push({ url, method, body, headers: new Headers(init?.headers) });
    if (url.pathname.endsWith('/lists/work%2Fteam')) return Response.json({ kind: 'tasks#taskList', id: 'work/team', title: 'Team work', etag: 'list-version' });
    if (method === 'POST' || method === 'PATCH') {
      if (state.preconditionRejected) return Response.json({ error: { code: 412, message: 'Precondition failed' } }, { status: 412 });
      state.writes++;
      state.task = { ...state.task, ...body, id: method === 'POST' ? 'created' : state.task.id, etag: 'v2' };
      for (const key of ['due', 'notes', 'completed']) if (state.task[key] === null) delete state.task[key];
      state.onMutation?.();
      if (state.responseLost) throw Error('response lost after provider accepted');
      return Response.json(state.wrongMutationId ? { ...state.task, id: 'different-target' } : state.task);
    }
    if (state.unavailable) throw Error('readback temporarily unavailable');
    return Response.json(state.wrongReadback ? { ...state.task, notes: 'Different owner body' } : state.task);
  }) as typeof fetch;
  const open = () => {
    const effects = ownerEffectLedger(storage, () => 1_000);
    const google = { client: async (_feature: unknown, intent: any, guard?: () => Promise<void>, _account?: string) => {
      await guard?.();
      if (state.revoked) return null;
      const candidate = { id: state.wrongAccount ? 'other-connection' : account.connection_id, email: state.wrongAccount ? 'other@example.test' : account.email, rail: 'local' as const };
      pinProxyIntentRoute(sql, intent, 'google:tasks', [candidate], candidate);
      return googleClient(app, { refresh_token: 'fixture' }, fetcher, undefined, { connection_id: candidate.id, email: candidate.email });
    } };
    const adapter = googleTaskApprovals({ sql, google, effects, ownerRef: 'owner' });
    const desk = approvalDesk(sql, { googleTasks: () => adapter, effects, owner: 42, google: (intent, feature, account) => google.client(feature, intent, undefined, account), call: async (_method, body) => { const text = (body as { text?: string }).text; if (text) state.cards.push(text); return state.cardUnconfirmed ? null : { message_id: 1 }; }, newId: () => String(++sequence), now: () => 1000, timezone: 'UTC', log: () => {} });
    return { adapter, effects, desk };
  };
  return { state, open, db };
};

describe('Google Tasks approval and readback journey', () => {
  it('serves a tool proposal through exact shared review, authenticated callback and one effect', async () => {
    const f = fixture(); const first = f.open();
    const handler = googleTaskHandlers({ proposeGoogleTaskChange: first.desk.proposeGoogleTaskChange! })[0]!;
    const result = await handler.handle(handler.schema.parse(create), { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'call' } as never) as any;
    expect(result).toMatchObject({ ok: true, data: { applied: false, status: 'awaiting_owner_approval' } });
    const id = result.data.approval_ref;
    expect(first.desk.pending(1000)[0]).toMatchObject({ id, kind: 'google_task_change', review: { account: account.email, proposal: { args: create }, proposal_digest: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect(f.state.cards[0]).toContain('Exact body');
    await first.desk.callback({ id: 'forged', from: { id: 43 }, data: `a:${id}` }, 'trace');
    expect(f.state.writes).toBe(0);
    expect(await first.desk.decide(id, 'a', 'trace')).toMatchObject({ toast: 'Done' });
    expect(f.state.writes).toBe(1);
    expect(await f.open().desk.decide(id, 'a', 'trace')).toMatchObject({ toast: 'Already handled.' });
    expect(f.state.writes).toBe(1);
    f.db.close();
  });
  it('does not offer truncated notes as an approvable shared card', async () => {
    const f = fixture(); const first = f.open();
    const id = await first.desk.proposeGoogleTaskChange!({ ...create, changes: { ...create.changes, notes: 'x'.repeat(8192) } });
    expect(first.desk.pending(1000)[0]).toMatchObject({ id, state: 'review_only' });
    expect(await first.desk.decide(id, 'a', 'trace')).toMatchObject({ toast: 'Already handled.' });
    expect(f.state.writes).toBe(0);
    f.db.close();
  });
  it('does not apply or repeat a card whose delivery was unconfirmed', async () => {
    const f = fixture(); f.state.cardUnconfirmed = true; const first = f.open();
    await expect(first.desk.proposeGoogleTaskChange!(create, 'tool:fixed')).rejects.toThrow('card');
    await expect(f.open().desk.proposeGoogleTaskChange!(create, 'tool:fixed')).rejects.toThrow('unconfirmed');
    expect(f.state.writes).toBe(0);
    f.db.close();
  });
  it('prepares the exact account/list before approval, then independently verifies an approved create', async () => {
    const f = fixture(); const { adapter } = f.open();
    const proposal = await adapter.prepare('proposal', create);
    expect(f.state.writes).toBe(0);
    expect(proposal).toMatchObject({ account, list: { id: 'work/team', title: 'Team work' }, args: create });
    expect(await adapter.apply('proposal', proposal)).toMatchObject({ status: 'done', receipt: { provider_id: 'created', result: { readback_verified: true, task: { title: 'Prepare proposal', notes: 'Exact body', due_date: '2026-10-11', task_list_id: 'work/team' } } } });
    expect(f.state.writes).toBe(1);
    expect(f.state.requests.at(-1)!.url.pathname).toContain('/tasks/created');
    expect(f.state.requests.find(r => r.method === 'POST')!.body).toEqual({ title: 'Prepare proposal', notes: 'Exact body', due: '2026-10-11T00:00:00.000Z', status: 'needsAction' });
    f.db.close();
  });
  it('recovers an acknowledged creation after restart without another POST', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', create);
    f.state.unavailable = true;
    expect(await first.adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    expect(first.effects.get('approval:proposal:apply')?.state).toBe('unknown');
    f.state.unavailable = false;
    expect(await f.open().adapter.apply('proposal', p)).toMatchObject({ status: 'done', receipt: { provider_id: 'created' } });
    expect(f.state.writes).toBe(1);
    f.db.close();
  });
  it('keeps a response-lost creation unknown even when an equal task exists', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', create);
    f.state.responseLost = true;
    expect(await first.adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    f.state.responseLost = false;
    expect(await f.open().adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    expect(f.state.writes).toBe(1);
    expect(f.state.requests.filter(r => r.method === 'GET' && r.url.pathname.endsWith('/tasks/created'))).toHaveLength(0);
    f.db.close();
  });
  it('fails a stale approval before patching the owner’s later version', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', { source: 'google_tasks', action: 'complete', task_list_id: create.task_list_id, task_id: 'existing', reason: 'Owner request' });
    f.state.task = { ...f.state.task, title: 'Owner edited', etag: 'owner-v2' };
    expect(await first.adapter.apply('proposal', p)).toMatchObject({ status: 'stale' });
    expect(f.state.writes).toBe(0);
    f.db.close();
  });
  it('edits only selected fields and verifies retained owner fields', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', { source: 'google_tasks', action: 'update', task_list_id: create.task_list_id, task_id: 'existing', changes: { notes: null, due_date: null }, reason: 'Owner request' });
    expect(await first.adapter.apply('proposal', p)).toMatchObject({ status: 'done', receipt: { result: { task: { title: 'Original', notes: null, due_date: null, status: 'todo' } } } });
    const write = f.state.requests.find(r => r.method === 'PATCH')!;
    expect(write.body).toEqual({ notes: null, due: null });
    expect(write.headers.get('if-match')).toBe('v1');
    expect(f.state.writes).toBe(1);
    f.db.close();
  });
  it.each(['complete', 'reopen'] as const)('verifies %s without replacing notes or the due date', async action => {
    const f = fixture(); if (action === 'reopen') f.state.task = { ...f.state.task, status: 'completed', completed: '2026-10-09T00:00:00Z' };
    const first = f.open(); const p = await first.adapter.prepare('proposal', { source: 'google_tasks', action, task_list_id: create.task_list_id, task_id: 'existing', reason: 'Owner request' });
    expect(await first.adapter.apply('proposal', p)).toMatchObject({ status: 'done', receipt: { result: { task: { status: action === 'complete' ? 'done' : 'todo', notes: 'Owner notes', due_date: '2026-10-10' } } } });
    const write = f.state.requests.find(r => r.method === 'PATCH')!;
    expect(write.body).toEqual(action === 'complete' ? { status: 'completed' } : { status: 'needsAction', completed: null });
    f.db.close();
  });
  it('does not treat a different readback body or later version as a receipt', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', create);
    f.state.wrongReadback = true;
    expect(await first.adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    f.state.wrongReadback = false; f.state.task = { ...f.state.task, etag: 'owner-later-version' };
    expect(await f.open().adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    expect(f.state.writes).toBe(1);
    f.db.close();
  });
  it.each(['revoked', 'wrongAccount'] as const)('does not retarget a proposal after %s', async field => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', create);
    f.state[field] = true;
    await expect(f.open().adapter.apply('proposal', p)).rejects.toThrow();
    expect(f.state.writes).toBe(0);
    f.db.close();
  });
  it('rejects changed frozen payload after an uncertain effect without provider I/O', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', create);
    f.state.unavailable = true; expect(await first.adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    f.state.unavailable = false; const reads = f.state.requests.length;
    await expect(f.open().adapter.apply('proposal', { ...p, args: { ...p.args, changes: { ...p.args.changes, notes: 'Changed approved body' } } })).rejects.toThrow('identity conflict');
    expect(f.state.requests.length).toBe(reads);
    expect(f.state.writes).toBe(1);
    f.db.close();
  });
  it('requires an existing immutable route for approved application', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', create);
    await expect(first.adapter.apply('never-prepared', p)).rejects.toThrow();
    expect(f.state.writes).toBe(0);
    f.db.close();
  });
  it('keeps response-lost PATCH unknown because equal final values alone cannot prove this effect', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', { source: 'google_tasks', action: 'complete', task_list_id: create.task_list_id, task_id: 'existing', reason: 'Owner request' });
    f.state.responseLost = true; expect(await first.adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    f.state.responseLost = false; expect(await f.open().adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    expect(f.state.writes).toBe(1);
    f.db.close();
  });
  it('checks current task source before preparing provider data', async () => {
    const f = fixture(); const first = f.open();
    await expect(first.adapter.prepare('proposal', create, { assertTaskSourceCurrent: async () => { throw new Error('source revoked'); } } as never)).rejects.toThrow('source revoked');
    expect(f.state.requests).toHaveLength(0);
    f.db.close();
  });
  it('does not publish a task ACK after source revocation at the provider response and never retries on regrant', async () => {
    const f = fixture(), first = f.open(), proposal = await first.adapter.prepare('proposal', create);
    const guard = async () => { if (f.state.revoked) throw Error('source revoked'); };
    f.state.onMutation = () => { f.state.revoked = true; };
    expect(await first.adapter.apply('proposal', proposal, undefined, { assertTaskSourceCurrent: guard })).toEqual({ status: 'unknown' });
    expect(f.db.prepare('SELECT * FROM google_task_effect_ack').all()).toHaveLength(0); expect(f.state.writes).toBe(1);
    f.state.revoked = false; f.state.onMutation = null;
    expect(await f.open().adapter.apply('proposal', proposal, undefined, { assertTaskSourceCurrent: guard })).toEqual({ status: 'unknown' }); expect(f.state.writes).toBe(1);
    f.db.close();
  });
  it('closes an authoritative conditional rejection as stale without applying or retrying', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', { source: 'google_tasks', action: 'complete', task_list_id: create.task_list_id, task_id: 'existing', reason: 'Owner request' });
    f.state.preconditionRejected = true;
    expect(await first.adapter.apply('proposal', p)).toMatchObject({ status: 'stale' });
    expect(await f.open().adapter.apply('proposal', p)).toMatchObject({ status: 'stale' });
    expect(f.state.writes).toBe(0);
    expect(f.state.requests.filter(r => r.method === 'PATCH')).toHaveLength(1);
    f.db.close();
  });
  it('does not accept a mutation acknowledgement for a different target task', async () => {
    const f = fixture(); const first = f.open(); const p = await first.adapter.prepare('proposal', { source: 'google_tasks', action: 'complete', task_list_id: create.task_list_id, task_id: 'existing', reason: 'Owner request' });
    f.state.wrongMutationId = true;
    expect(await first.adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    expect(await f.open().adapter.apply('proposal', p)).toEqual({ status: 'unknown' });
    expect(f.state.writes).toBe(1);
    f.db.close();
  });
});
describe('Google Tasks serving tool', () => {
  it('returns only a shared approval reference without executing provider effects', async () => {
    const seen: unknown[] = [];
    const handler = googleTaskHandlers({ proposeGoogleTaskChange: async (...args) => { seen.push(args); return 'proposal'; } })[0]!;
    const args = handler.schema.parse(create);
    expect(await handler.handle(args, { authenticatedUserId: 'owner', turnId: 'turn', toolCallId: 'tool' } as never)).toMatchObject({ ok: true, source_taint: 'external', data: { approval_ref: 'proposal', applied: false, source: 'google_tasks' } });
    expect((seen[0] as unknown[])[0]).toEqual(create);
    expect((seen[0] as unknown[])[1]).toMatch(/^tool:[a-f0-9]{64}$/);
    expect(handler.autonomy_gated).toBe(false);
    expect(handler.mutates_state).toBe(true);
  });
  it('returns a typed reconnect intent on a revoked provider grant', async () => {
    const handler = googleTaskHandlers({ proposeGoogleTaskChange: async () => { throw new GoogleError(401, 'grant revoked'); } })[0]!;
    expect(await handler.handle(handler.schema.parse(create), {} as never)).toMatchObject({ ok: false, code: 'auth_failed', source_taint: 'external', connect: { status: 'auth_required', service: 'google', feature: 'tasks', reason: 'reauth_needed' } });
  });
});
