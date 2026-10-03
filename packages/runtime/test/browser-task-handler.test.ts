import { expect, it } from 'vitest';
import { browseActArgsSchema } from '@waldo/contracts';
import { browseActHandler, executeBrowserSubmit } from '../src/tools/live/browser';
import { browserTaskHandler, browserTaskApprovalBridge } from '../src/tools/live/browser-task';
import type { BrowserSubmitProposal } from '../src/channels/approvals';

const context = { authenticatedUserId: 'owner-a' } as never;
it('preserves free-text legacy calls and never falls back for a typed command without a host', async () => {
  let legacyCalls = 0;
  const legacy = { ...browseActHandler(undefined, undefined, undefined), handle: async () => { legacyCalls++; return { ok: true as const, data: { legacy: true }, source_taint: 'external' as const }; } };
  const handler = browserTaskHandler({ legacy, host: async () => null, propose: async () => 'must-not-propose' });
  expect(await handler.handle(browseActArgsSchema.parse({ url: 'https://fixture.example/form', task: 'read' }), context)).toMatchObject({ ok: true, data: { legacy: true } });
  expect(await handler.handle(browseActArgsSchema.parse({ url: 'https://fixture.example/form', task: 'inspect', command: { operation: 'inspect' } }), context)).toMatchObject({ ok: false, code: 'rejected', source_taint: 'external' });
  expect(legacyCalls).toBe(1);
});

it('routes prepare-submit into the existing approval payload and exposes no private session', async () => {
  let payload: BrowserSubmitProposal | undefined, approved = 0;
  const scopeDigest = `sha256:${'a'.repeat(64)}`;
  const host = { taskRef: 'task-one', pageUrl: 'https://fixture.example/form', read: async (owner: string) => { expect(owner).toBe('owner-a'); return { url: 'https://fixture.example/form', binding: { value: 'synthetic' } }; }, propose: async () => ({ id: 'prepared-one', url: 'https://fixture.example/form', actionRef: '#submit', scopeDigest, binding: { value: 'synthetic' } }), validateProposal: async () => true, validateReceipt: async () => true, submit: async (_owner: string, id: string, approval: string) => { expect(id).toBe('prepared-one'); expect(approval).toBe('fresh-desk-approval'); approved++; return { status: 'acknowledged_unverified' as const, message: 'not verified' }; } };
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, propose: async next => { payload = next; return 'desk-proposal'; } });
  const prepared = await handler.handle(browseActArgsSchema.parse({ url: host.pageUrl, task: 'prepare', command: { operation: 'prepare_submit' } }), context);
  expect(prepared).toMatchObject({ ok: true, data: { stopped: 'approval_pending', proposal_id: 'desk-proposal' }, source_taint: 'external' });
  expect(payload).toMatchObject({ binding: { value: 'synthetic' }, continuation: { version: 1, taskRef: 'task-one', proposalId: 'prepared-one', scopeDigest } });
  expect(approved).toBe(0);
  const bridge = browserTaskApprovalBridge({ ownerId: 'owner-a', host: async () => host as never });
  expect(await bridge.submit(payload!)).toMatchObject({ status: 'rejected' });
  await bridge.submit(payload!, 'fresh-desk-approval'); expect(approved).toBe(1);
});

it('the old fresh-session submit executor rejects continuation proposals before any provider request', async () => {
  let calls = 0;
  const proposal: BrowserSubmitProposal = { url: 'https://fixture.example/form', action: { selector: '#submit', method: 'click', description: 'Submit' }, binding: { value: 'synthetic' }, steps: [], continuation: { version: 1, taskRef: 'task-one', proposalId: 'prepared-one', scopeDigest: `sha256:${'a'.repeat(64)}` } };
  expect(await executeBrowserSubmit('key', 'project', undefined, proposal, (async () => { calls++; throw Error('must not call'); }) as typeof fetch)).toMatchObject({ status: 'rejected' });
  expect(calls).toBe(0);
});
it('reports fenced actions with unresolved physical cleanup honestly', async () => {
  const host = { pageUrl: 'https://fixture.example/form', cancel: async () => ({ stopped: 'cleanup_pending', actions_fenced: true }) };
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, stopAdmission: async () => {}, propose: async () => 'unused' });
  expect(await handler.handle(browseActArgsSchema.parse({ url: host.pageUrl, task: 'stop', command: { operation: 'cancel' } }), context)).toMatchObject({ ok: true, data: { stopped: 'cleanup_pending', actions_fenced: true } });
});
it('can retry publication after the approval desk throws without repeating submit', async () => {
  const { browserTaskContinuity } = await import('../src/channels/browser-task-continuity');
  const { fixtureDigest } = await import('../src/channels/public-fixture-browser');
  let row: unknown = null, clicks = 0, publications = 0;
  const host = browserTaskContinuity({ enabled: true, ownerId: 'owner-a', taskId: 'publish-run', manifestDigest: `sha256:${'a'.repeat(64)}`, now: () => 1, newId: () => crypto.randomUUID(), admit: async () => 'host-grant',
    store: { exclusive: async work => work(), load: async () => row, save: async next => { row = next; } },
    driver: { provider: 'cloudflare_playwright', origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'publish-run', submitRef: '#submit', start: async () => 'private-session', navigate: async () => {}, inspect: async () => ({ url: 'https://fixture.example/form', binding: { value: 'synthetic' }, stateDigest: await fixtureDigest({ value: 'synthetic' }) }), fill: async () => {}, submit: async () => { clicks++; }, verify: async () => null, end: async () => {} },
  });
  await host.open('owner-a');
  const handler = browserTaskHandler({ legacy: browseActHandler(undefined, undefined, undefined), host: async () => host, propose: async () => { if (++publications === 1) throw Error('desk unavailable'); return 'published-desk-proposal'; } });
  const args = browseActArgsSchema.parse({ url: host.pageUrl, task: 'prepare', command: { operation: 'prepare_submit' } });
  expect(await handler.handle(args, context)).toMatchObject({ ok: false });
  expect(await handler.handle(args, context)).toMatchObject({ ok: true, data: { proposal_id: 'published-desk-proposal' } });
  expect(clicks).toBe(0); expect(publications).toBe(2);
});
it('requires independent stop admission and fences it before task cleanup', async () => {
  const events: string[] = [], host = { pageUrl: 'https://fixture.example/form', cancel: async () => { events.push('cleanup'); return { stopped: 'cancelled', actions_fenced: true }; } };
  const base = { legacy: browseActHandler(undefined, undefined, undefined), host: async () => host as never, propose: async () => 'unused' };
  const args = browseActArgsSchema.parse({ url: host.pageUrl, task: 'stop', command: { operation: 'cancel' } });
  expect(await browserTaskHandler(base).handle(args, context)).toMatchObject({ ok: false }); expect(events).toEqual([]);
  await browserTaskHandler({ ...base, stopAdmission: async () => { events.push('revoked'); } }).handle(args, context);
  expect(events).toEqual(['revoked','cleanup']);
});
