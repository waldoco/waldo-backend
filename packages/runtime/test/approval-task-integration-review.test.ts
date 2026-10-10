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
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, effectOwnerRef: 'owner-do:actual-owner', google: async () => null, call: async () => null, newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
    await expect(desk.proposeGoogleTaskChange!(args, 'tool:fixed')).rejects.toThrow('card');
    expect(desk.pending(1000)).toContainEqual(expect.objectContaining({ id: 'preview', kind: 'google_task_change', state: 'unconfirmed' }));
    expect((await desk.decide('preview', 'a', 'review')).toast).toBe('Already handled.');
    expect(tasks.apply).not.toHaveBeenCalled();
  });
});

it('replays equivalent task arguments using canonical identity rather than object key insertion order', async () => {
  await taskFixture('review-task-replay-canonical', async state => {
    const tasks = adapter();
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, effectOwnerRef: 'owner-do:actual-owner', google: async () => null, call: async () => ({ message_id: 1 }), newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
    const first = await desk.proposeGoogleTaskChange!(args, 'tool:fixed');
    const reordered = { reason: args.reason, changes: args.changes, task_list_id: args.task_list_id, action: args.action, account: args.account, source: args.source };
    expect(await desk.proposeGoogleTaskChange!(reordered, 'tool:fixed')).toBe(first);
    expect(tasks.prepare).toHaveBeenCalledTimes(1); expect(tasks.apply).not.toHaveBeenCalled();
  });
});

it('rejects changed frozen task bytes before invoking the provider adapter', async () => {
  await taskFixture('review-task-frozen-digest', async state => {
    const tasks = adapter();
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, effectOwnerRef: 'owner-do:actual-owner', google: async () => null, call: async () => ({ message_id: 1 }), newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
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
    const desk = approvalDesk(state.storage.sql, { effects: ownerEffectLedger(state.storage, () => 1000), googleTasks: () => tasks, owner: 42, effectOwnerRef: 'owner-do:actual-owner', google: async () => null, call: async () => ({ message_id: 1 }), newId: () => 'review', now: () => 1000, timezone: 'UTC', log: () => {} });
    const id = await desk.proposeGoogleTaskChange!(args);
    const decision = await desk.decide(id, 'a', 'review');
    expect(decision.toast).toBe('The task changed');
    expect(approvalControlReceipt(decision).state).toBe('rejected');
    expect(state.storage.sql.exec<{status:string}>('SELECT status FROM ledger WHERE id = ?', id).one().status).toBe('rejected');
  });
});

it('uses the physical owner binding for new effects and preserves legacy effect identity across surfaces', async () => {
  await taskFixture('review-approval-owner-migration', async state => {
    let sent = 0, landed = false;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const client = { account: { connection_id: 'account-a', email: args.account }, sendRaw: async () => { sent++; throw new Error('response lost'); }, findSentByMessageId: async (messageId: string) => landed ? { message_id: 'provider-a', thread_id: 'provider-thread-a', rfc822_message_id: messageId, label_ids: ['SENT'] } : false } as unknown as GoogleClient;
    const base = { effects, google: async () => client, call: async () => ({ message_id: 1 }), newId: () => 'legacy', now: () => 1000, timezone: 'UTC', log: () => {} };
    const legacy = approvalDesk(state.storage.sql, { ...base, owner: 42 });
    const proposal = { account: args.account, to: ['recipient@example.test'], subject: 'Actual subject', body: 'Actual body', raw: 'exact approved bytes', digest: await sha256Hex('exact approved bytes'), message_id: '<review@waldo>' };
    const id = await legacy.proposeSendEmail(proposal);
    expect((await legacy.decide(id, 'a', 'telegram')).toast).toBe('Outcome unknown');
    expect(effects.get(`approval:${id}:apply`)?.owner_ref).toBe('42');
    landed = true;
    const native = approvalDesk(state.storage.sql, { ...base, owner: 99, effectOwnerRef: 'owner-do:actual-owner' });
    expect((await native.decide(id, 'a', 'app')).toast).toBe('Sent');
    expect(effects.get(`approval:${id}:apply`)?.owner_ref).toBe('42'); expect(sent).toBe(1);
    const fresh = approvalDesk(state.storage.sql, { ...base, owner: 99, effectOwnerRef: 'owner-do:actual-owner', newId: () => 'fresh', google: async () => ({ ...client, sendRaw: async () => ({ message_id: 'provider-a' }) }) as GoogleClient });
    const next = await fresh.proposeSendEmail({ ...proposal, message_id: '<fresh@waldo>' });
    expect((await fresh.decide(next, 'a', 'app')).toast).toBe('Sent');
    expect(effects.get(`approval:${next}:apply`)?.owner_ref).toBe('owner-do:actual-owner');
  });
});

it('blocks provider dispatch when an authenticated decision closes during token refresh', async () => {
  await taskFixture('review-approval-token-revocation', async state => {
    let tokenStarted!: () => void, releaseToken!: () => void, revoked = false, writes = 0;
    const started = new Promise<void>(resolve => { tokenStarted = resolve; }), released = new Promise<void>(resolve => { releaseToken = resolve; });
    const guard = async () => { if (revoked) throw new Error('owner decision closed'); };
    const requests: string[] = [];
    const fetcher = (async (input, init) => {
      const url = new URL(String(input)); requests.push(url.hostname + url.pathname);
      if (url.hostname === 'oauth2.googleapis.com') { tokenStarted(); await released; return Response.json({ access_token: 'synthetic-token' }); }
      if (init?.method === 'POST') { writes++; return Response.json({ id: 'provider-a', threadId: 'provider-thread' }); }
      return Response.json({ messages: [] });
    }) as typeof fetch;
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const desk = approvalDesk(state.storage.sql, { effects, owner: 42, effectOwnerRef: 'owner-do:actual-owner',
      google: async (_intent, _feature, _account, assertCurrent) => googleClient({ clientId: 'synthetic', clientSecret: 'synthetic', redirectUri: 'https://app.invalid/callback' }, { refresh_token: 'synthetic-token' }, taskSourceFetch(assertCurrent, fetcher), undefined, { connection_id: 'account-a', email: args.account }),
      call: async () => ({ message_id: 1 }), newId: () => 'refresh', now: () => 1000, timezone: 'UTC', log: () => {} });
    const id = await desk.proposeSendEmail({ account: args.account, to: ['recipient@example.test'], subject: 'Actual subject', body: 'Actual body', raw: 'exact bytes', digest: await sha256Hex('exact bytes'), message_id: '<refresh@waldo>' });
    const decision = desk.decide(id, 'a', 'app', guard);
    await started; revoked = true; releaseToken(); await decision;
    expect(writes).toBe(0);
    expect(requests).toEqual(['oauth2.googleapis.com/token']);
    expect(effects.get(`approval:${id}:apply`)?.state).not.toBe('done');
  });
});

it('does not create local effect custody after the decision guard closes before dispatch', async () => {
  await taskFixture('review-approval-late-reservation', async state => {
    let guardCalls = 0, writes = 0;
    const guard = async () => { if (++guardCalls >= 4) throw new Error('owner decision closed'); };
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const client = { account: { connection_id: 'account-a', email: args.account }, sendRaw: async () => { writes++; return { message_id: 'provider-a' }; }, findSentByMessageId: async () => false } as unknown as GoogleClient;
    const desk = approvalDesk(state.storage.sql, { effects, owner: 42, effectOwnerRef: 'owner-do:actual-owner', google: async () => client, call: async () => ({ message_id: 1 }), newId: () => 'closed', now: () => 1000, timezone: 'UTC', log: () => {} });
    const id = await desk.proposeSendEmail({ account: args.account, to: ['recipient@example.test'], subject: 'Actual subject', body: 'Actual body', raw: 'exact bytes', digest: await sha256Hex('exact bytes'), message_id: '<closed@waldo>' });
    await desk.decide(id, 'a', 'app', guard);
    expect(writes).toBe(0);
    expect(effects.get(`approval:${id}:apply`)).toBeNull();
  });
});
