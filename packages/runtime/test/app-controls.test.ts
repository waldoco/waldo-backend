import { describe, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema, appControlResultV1Schema } from '@waldo/contracts';
import { appControlsRequest, type AppControlsHost } from '../src/channels/app-controls';
import type { ApprovalDesk } from '../src/channels/approvals';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';

const request = (path: string, body?: unknown) => new Request(`https://app.invalid/app/v1/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const setup = () => {
  const data = new Map<string, unknown>();
  let view = structuredClone(SAMPLE_CONSOLE_VIEW), revoked = false;
  const act = vi.fn(async () => true as boolean | string), decide = vi.fn(async () => ({ toast: 'Done', message: 'The approved operation was verified.' }));
  const host: AppControlsHost = {
    csrf: 'canonical-session-a', expires: Date.now() + 43_200_000, scope: 'owner-a',
    storage: { get: async <T,>(key: string) => structuredClone(data.get(key)) as T | undefined, put: async (key: string, value: unknown) => { data.set(key, structuredClone(value)); } } as unknown as DurableObjectStorage,
    assertCurrent: async () => { if (revoked) throw new Error('closed'); },
    sessions: async () => [{ csrf: host.csrf, expires: host.expires }], view: async () => ({ ...view, csrf: host.csrf }), act,
    desk: { decide } as unknown as ApprovalDesk, connect: async () => 'https://app.invalid/c/' + 'x'.repeat(22), signout: async () => true,
  };
  const read = async (selected: string, id?: string) => {
    const response = await appControlsRequest(request(`controls?view=${selected}${id ? '&id=' + encodeURIComponent(id) : ''}`), host);
    expect(response?.status).toBe(200);
    return appControlProjectionV1Schema.parse(await response!.json());
  };
  return { host, act, decide, data, read, setView: (next: typeof view) => { view = next; }, revoke: () => { revoked = true; } };
};

describe('canonical app controls serving', () => {
  it('serves every concrete view with no ambient session secret and rejects a view/data mismatch', async () => {
    const env = setup();
    for (const view of ['day', 'connections', 'waiting', 'activity', 'profile', 'setup', 'usage', 'files', 'memory', 'spots', 'constellations']) {
      const result = await env.read(view);
      expect(result.view).toBe(view);
      expect(JSON.stringify(result)).not.toContain(env.host.csrf);
      expect('csrf' in result).toBe(false);
    }
    const day = await env.read('day');
    expect(appControlProjectionV1Schema.safeParse({ ...day, view: 'connections' }).success).toBe(false);
    expect(appControlProjectionV1Schema.safeParse({ ...day, data: { ...day.data, fabricated: true } }).success).toBe(false);
  });

  it('uses stored claim provenance, owner-scoped controls, and exact changed-data revisions', async () => {
    const env = setup(), source = { ...SAMPLE_CONSOLE_VIEW.spots[1]!, source_ref: 'owner-message:abc', learned_at: '2026-09-23T02:00:00Z', verification_status: 'owner_unconfirmed' };
    env.setView({ ...structuredClone(SAMPLE_CONSOLE_VIEW), spots: [source], forgettingSpots: [] });
    const result = await env.read('spots');
    expect(result.view).toBe('spots');
    if (result.view !== 'spots') throw new Error('wrong view');
    expect(result.data.items[0]).toMatchObject({ id: 'owner-a:claim:5', control_ref: { view: 'memory', id: 'owner-a:claim:5' }, account: null, source: 'inferred', source_ref: 'owner-message:abc', learned_at: source.learned_at, verification_status: 'owner_unconfirmed' });
    const detail = await env.read('memory', 'owner-a:claim:5');
    env.setView({ ...structuredClone(SAMPLE_CONSOLE_VIEW), spots: [{ ...source, text: 'Corrected preference' }], forgettingSpots: [] });
    expect((await env.read('memory', 'owner-a:claim:5')).revision).not.toBe(detail.revision);
    for (const id of ['5', 'owner-b:claim:5']) expect((await appControlsRequest(request('controls?view=memory&id=' + id), env.host))?.status).toBe(404);
  });

  it('withholds pending forget text and derived labels, including duplicate stale active rows', async () => {
    const env = setup(), view = structuredClone(SAMPLE_CONSOLE_VIEW), pending = view.forgettingSpots[0]!;
    env.setView({ ...view, spots: [...view.spots, { ...pending, status: 'active' }] });
    const index = await env.read('memory');
    const body = JSON.stringify(index);
    expect(body).toContain('purging'); expect(body).not.toContain(pending.text); expect(body).not.toContain('Calls after 10pm');
    expect(body).not.toContain('owner-a:node:1');
    const detail = await env.read('memory', 'owner-a:claim:7');
    expect(JSON.stringify(detail)).not.toContain(pending.text);
    expect((await appControlsRequest(request('controls?view=memory&id=owner-a:node:1'), env.host))?.status).toBe(404);
  });

  it('projects graph references from stored support and does not invent references for corrupt support', async () => {
    const env = setup(), view = structuredClone(SAMPLE_CONSOLE_VIEW);
    env.setView({ ...view, forgettingSpots: [], nodes: view.nodes.map(node => node.id === 2 ? { ...node, supporting_spots: '{invalid' } : node) });
    const result = await env.read('constellations');
    if (result.view !== 'constellations') throw new Error('wrong view');
    expect(result.data.nodes[0]?.supporting_spots).toEqual(['owner-a:claim:1']);
    expect(result.data.nodes[1]?.supporting_spots).toBeNull();
    expect(result.data.edges[0]).toMatchObject({ from_id: 'owner-a:node:1', to_id: 'owner-a:node:2' });
  });

  it('reconciles a timed-out memory operation using its durable exact receipt and never re-executes', async () => {
    const env = setup(), detail = await env.read('memory', 'owner-a:claim:5');
    env.act.mockResolvedValueOnce('spot.forget.incomplete');
    const operation = { view: 'memory', action: 'spot.forget', id: 'owner-a:claim:5', revision: detail.revision, request_id: 'forget-operation-0001' };
    const first = await appControlsRequest(request('actions', operation), env.host);
    expect(first?.status).toBe(200);
    expect(appControlResultV1Schema.parse(await first!.json())).toMatchObject({ request_id: operation.request_id, duplicate: false, receipt: { state: 'incomplete' } });
    expect(env.act).toHaveBeenCalledWith({ action: 'spot.forget', id: '5', value: '' });
    const restart = { ...env.host };
    const lookup = await appControlsRequest(request('actions/' + operation.request_id), restart);
    expect(lookup?.status).toBe(200);
    expect(appControlResultV1Schema.parse(await lookup!.json())).toMatchObject({ request_id: operation.request_id, duplicate: true, receipt: { state: 'incomplete' } });
    const duplicate = await appControlsRequest(request('actions', operation), restart);
    expect(duplicate?.status).toBe(200); expect(env.act).toHaveBeenCalledTimes(1);
    expect((await appControlsRequest(request('actions', { ...operation, action: 'spot.confirm' }), env.host))?.status).toBe(409);
    expect((await appControlsRequest(request('actions/' + operation.request_id), { ...env.host, csrf: 'other-session' }))?.status).toBe(404);
  });

  it('retains an uncertain executor receipt for readback without turning projection refresh into success', async () => {
    const env = setup(), read = await env.read('day'), request_id = 'uncertain-operation';
    env.act.mockRejectedValueOnce(new Error('private failure detail'));
    const operation = { view: 'day', action: 'timezone.set', value: 'UTC', revision: read.revision, request_id };
    const first = await appControlsRequest(request('actions', operation), env.host);
    expect(first?.status).toBe(503);
    expect(appControlResultV1Schema.parse(await first!.json()).receipt.state).toBe('unconfirmed');
    const status = await appControlsRequest(request('actions/' + request_id), env.host);
    expect(status?.status).toBe(200);
    expect(appControlResultV1Schema.parse(await status!.json()).receipt.state).toBe('unconfirmed');
    expect(env.act).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(await (await appControlsRequest(request('actions', operation), env.host))!.json())).not.toContain('private failure');
    expect(env.act).toHaveBeenCalledTimes(1);
  });

  it('rejects extra identity selectors, duplicate query keys, stale mutations and revoked sessions', async () => {
    const env = setup();
    for (const query of ['view=day&owner_id=foreign', 'view=day&view=connections', 'view=unknown', 'view=day&id=ignored']) expect((await appControlsRequest(request('controls?' + query), env.host))?.status).toBe(query.endsWith('id=ignored') ? 404 : 400);
    const read = await env.read('day');
    const mutation = { view: 'day', action: 'timezone.set', value: 'UTC', revision: read.revision, request_id: 'valid-operation-001' };
    expect((await appControlsRequest(request('actions', { ...mutation, owner: 'foreign' }), env.host))?.status).toBe(400);
    expect((await appControlsRequest(request('actions', { ...mutation, revision: 'f'.repeat(64) }), env.host))?.status).toBe(409);
    env.revoke();
    await expect(appControlsRequest(request('actions', mutation), env.host)).rejects.toThrow('closed');
    expect(env.act).not.toHaveBeenCalled(); expect(env.data.size).toBe(0);
  });

  it('forwards Activity cursors to the actual producer and rejects them on other views', async () => {
    const env = setup(), original = env.host.view;
    env.host.view = vi.fn(async page => ({ ...await original(), page: { trace_before: 3, runs_before: 4, trace_applied: page?.traceBefore ?? null, runs_applied: page?.runsBefore ?? null } }));
    const response = await appControlsRequest(request('controls?view=activity&trace_before=12&runs_before=23'), env.host);
    expect(response?.status).toBe(200);
    expect(env.host.view).toHaveBeenCalledWith({ traceBefore: 12, runsBefore: 23 });
    const result = appControlProjectionV1Schema.parse(await response!.json());
    if (result.view !== 'activity') throw new Error('wrong view');
    expect(result.data.page).toMatchObject({ trace_applied: 12, runs_applied: 23 });
    for (const query of ['view=day&trace_before=12', 'view=activity&trace_before=0', 'view=activity&runs_before=NaN', 'view=activity&trace_before=12&trace_before=13']) expect((await appControlsRequest(request('controls?' + query), env.host))?.status).toBe(400);
  });

  it('keeps target IDs in supported card actions while requiring their exact view revision', async () => {
    const env = setup(), result = await env.read('day');
    const response = await appControlsRequest(request('actions', { view: 'day', action: 'card.pin', id: 'card:close', value: '22:15', revision: result.revision, request_id: 'card-pin-operation1' }), env.host);
    expect(response?.status).toBe(200);
    expect(env.act).toHaveBeenCalledWith({ action: 'card.pin', id: 'card:close', value: '22:15' });
  });

  it('projects exact account, recipient and task proposal evidence through the common approval desk', async () => {
    const env = setup(), view = structuredClone(SAMPLE_CONSOLE_VIEW), digest = 'a'.repeat(64);
    const task = { args: { source: 'google_tasks' as const, account: 'owner@example.com', action: 'create' as const, task_list_id: 'list-a', changes: { title: 'Actual task' }, reason: 'Owner requested this task' }, account: { connection_id: 'connection-a', email: 'owner@example.com' }, list: { id: 'list-a', title: 'Actual list', etag: 'etag-list' }, before: null };
    env.setView({ ...view, approvals: [
      { id: 'mail-a', kind: 'email_send', state: 'open', summary: 'Actual email', undoable: false, review: { kind: 'email_send', account: 'owner@example.com', to: ['recipient@example.com'], cc: ['cc@example.com'], bcc: [], subject: 'Actual subject', body: 'Exact full body' } },
      { id: 'task-a', kind: 'google_task_change', state: 'open', summary: 'Actual task', undoable: false, review: { kind: 'google_task_change', account: 'owner@example.com', proposal: task, proposal_digest: digest } },
    ] });
    env.host.mayApprove = item => !!item && item.state === 'open' && item.review?.kind === item.kind;
    const result = await env.read('waiting');
    if (result.view !== 'waiting') throw new Error('wrong view');
    expect(result.data.proposals[0]?.review).toMatchObject({ account: 'owner@example.com', to: ['recipient@example.com'], cc: ['cc@example.com'], body: 'Exact full body' });
    expect(result.data.proposals[1]?.review).toMatchObject({ proposal: task, proposal_digest: digest });
    expect(result.data.proposals[1]?.actions).toContain('approval.approve');
    const response = await appControlsRequest(request('actions', { view: 'waiting', action: 'approval.approve', id: 'task-a', revision: result.revision, request_id: 'task-approval-0001' }), env.host);
    expect(response?.status).toBe(200); expect(env.decide).toHaveBeenCalledWith('task-a', 'a', 'app:approval', env.host.assertCurrent); expect(env.act).not.toHaveBeenCalled();
  });

  it('records approval edit as the common proposal transition and never sends a replacement payload', async () => {
    const env = setup();
    env.decide.mockResolvedValueOnce({ toast: 'Tell me what to change', message: 'What should I change? (Actual proposal)' });
    const result = await env.read('waiting');
    const response = await appControlsRequest(request('actions', { view: 'waiting', action: 'approval.edit', id: 'p1', revision: result.revision, request_id: 'edit-proposal-0001' }), env.host);
    expect(response?.status).toBe(200);
    expect(appControlResultV1Schema.parse(await response!.json()).receipt).toEqual({ state: 'recorded', message: 'What should I change? (Actual proposal)' });
    expect(env.decide).toHaveBeenCalledWith('p1', 'e', 'app:approval', env.host.assertCurrent); expect(env.act).not.toHaveBeenCalled();
  });
});
