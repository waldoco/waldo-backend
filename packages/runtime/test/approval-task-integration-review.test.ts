import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { googleTaskProposalSchema } from '@waldo/contracts';
import { approvalDesk } from '../src/channels/approvals';
import { approvalControlReceipt } from '../src/channels/dashboard-control-actions';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { googleClient, sha256Hex, type GoogleClient } from '../src/connectors/google';
import type { GoogleTaskApprovalAdapter } from '../src/channels/google-task-approvals';
import { taskSourceFetch } from '../src/tools/task-source-io';

const args = { source: 'google_tasks' as const, account: 'owner@example.test', action: 'create' as const, task_list_id: 'list-a', changes: { title: 'Exact task' }, reason: 'Owner asked' };
const taskFixture = async (name: string, work: (state: DurableObjectState) => Promise<void>) => {
  const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
  await runInDurableObject(stub, async (_instance, state) => work(state));
};
const adapter = () => ({
  prepare: vi.fn<GoogleTaskApprovalAdapter['prepare']>(async (_id, input) => googleTaskProposalSchema.parse({ args: input, account: { connection_id: 'account-a', email: args.account }, list: { id: args.task_list_id, title: 'Actual list', etag: 'list-v1' }, before: null })),
  reconcile: vi.fn<GoogleTaskApprovalAdapter['reconcile']>(async () => ({ status: 'unknown' })),
  apply: vi.fn<GoogleTaskApprovalAdapter['apply']>(async () => ({ status: 'done', receipt: { provider_id: 'task-a', result: null } })),
} satisfies GoogleTaskApprovalAdapter);

it('keeps task review delivery failure visible without allowing an effect', async () => {
  await taskFixture('review-task-card-unknown', async state => {
    const tasks = adapter();
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, google: async () => null, call: async () => null, newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
    await expect(desk.proposeGoogleTaskChange!(args, 'tool:fixed')).rejects.toThrow('card');
    expect(desk.pending(1000)).toContainEqual(expect.objectContaining({ id: 'preview', kind: 'google_task_change', state: 'unconfirmed' }));
    expect((await desk.decide('preview', 'a', 'review')).toast).toBe('Already handled.');
    expect(tasks.apply).not.toHaveBeenCalled();
  });
});

it('replays equivalent task arguments using canonical identity rather than object key insertion order', async () => {
  await taskFixture('review-task-replay-canonical', async state => {
    const tasks = adapter();
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, google: async () => null, call: async () => ({ message_id: 1 }), newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
    const first = await desk.proposeGoogleTaskChange!(args, 'tool:fixed');
    const reordered = { reason: args.reason, changes: args.changes, task_list_id: args.task_list_id, action: args.action, account: args.account, source: args.source };
    expect(await desk.proposeGoogleTaskChange!(reordered, 'tool:fixed')).toBe(first);
    expect(tasks.prepare).toHaveBeenCalledTimes(1); expect(tasks.apply).not.toHaveBeenCalled();
  });
});

it('rejects changed frozen task bytes before invoking the provider adapter', async () => {
  await taskFixture('review-task-frozen-digest', async state => {
    const tasks = adapter();
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, google: async () => null, call: async () => ({ message_id: 1 }), newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
    const id = await desk.proposeGoogleTaskChange!(args, 'tool:fixed');
    state.storage.sql.exec("UPDATE ledger SET payload_json = json_set(payload_json, '$.args.changes.title', 'Unapproved replacement') WHERE id = ?", id);
    expect((await desk.decide(id, 'a', 'review')).toast).toBe('That failed');
    expect(tasks.apply).not.toHaveBeenCalled();
    expect(state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('failed');
  });
});

it('closes a task version rejection with a rejected owner receipt', async () => {
  await taskFixture('review-task-stale-receipt', async state => {
    const tasks = adapter(); tasks.apply.mockResolvedValueOnce({ status: 'stale' });
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, google: async () => null, call: async () => ({ message_id: 1 }), newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
    const id = await desk.proposeGoogleTaskChange!(args);
    const decision = await desk.decide(id, 'a', 'review');
    expect(decision.toast).toBe('The task changed');
    expect(approvalControlReceipt(decision).state).toBe('rejected');
    expect(state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('rejected');
  });
});
