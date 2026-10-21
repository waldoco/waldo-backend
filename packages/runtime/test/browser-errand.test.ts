import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { BrowserErrandCheckpoint } from '@waldo/contracts';
import { browserErrand, type BrowserErrandEngine, type BrowserErrandPlan, type BrowserErrandStore } from '../src/channels/browser-errand';
import { approvalDesk, type BrowserSubmitProposal } from '../src/channels/approvals';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';

const SECRET_REFS = ['vendor-session-secret', 'vendor-run-prepare', 'vendor-run-submit', 'https://live.vendor.test/view/secret-token', 'vendor-profile-secret'];

const plan: BrowserErrandPlan = {
  errandType: 'subscription_cancel', origin: 'https://shop.example', goal: 'Cancel the synthetic streaming plan.',
  finalAction: 'Confirm cancellation', expected: { status: 'Cancelled' }, verifyCheck: 'Open the plan page and report its status.',
  profileRef: 'vendor-profile-secret', healthAdjacent: false,
};

type Script = {
  prepare: Awaited<ReturnType<BrowserErrandEngine['prepare']>>;
  submit: () => Promise<Awaited<ReturnType<BrowserErrandEngine['submit']>>>;
  find: Awaited<ReturnType<BrowserErrandEngine['findSubmit']>>;
  run: () => Promise<Awaited<ReturnType<BrowserErrandEngine['run']>>>;
  verify: Awaited<ReturnType<BrowserErrandEngine['verify']>>;
};

function harness(overrides: Partial<Script> = {}) {
  let row: unknown = null, lock: Promise<unknown> = Promise.resolve(), now = 1_000_000, grant = true;
  let failSave: ((record: BrowserErrandCheckpoint) => boolean) | undefined, fenceFails = false;
  const calls = { prepare: 0, submit: 0, find: 0, run: 0, verify: 0, release: 0, fence: 0, loginStart: 0, confirm: 0 };
  const script: Script = {
    prepare: { kind: 'review', sessionRef: 'vendor-session-secret', runRef: 'vendor-run-prepare', url: 'https://shop.example/account/cancel', facts: { plan: 'Synthetic Premium', effective: '2026-11-01' } },
    submit: async () => ({ status: 'started', runRef: 'vendor-run-submit' }),
    find: { status: 'absent' },
    run: async () => ({ state: 'finished', vendorClaim: true }),
    verify: { observed: { status: 'cancelled' }, confirmationId: 'CONF-1' },
    ...overrides,
  };
  const store: BrowserErrandStore = {
    exclusive: async work => { const next = lock.then(work); lock = next.catch(() => undefined); return next; },
    load: async () => row === null ? null : structuredClone(row),
    save: async record => { if (failSave?.(record)) { failSave = undefined; throw Error('process died'); } row = structuredClone(record); },
  };
  const engine: BrowserErrandEngine = {
    name: 'browser_use_v4',
    prepare: async () => { calls.prepare++; return script.prepare; },
    submit: async () => { calls.submit++; return script.submit(); },
    findSubmit: async () => { calls.find++; return script.find; },
    run: async () => { calls.run++; return script.run(); },
    verify: async () => { calls.verify++; return script.verify; },
    release: async () => { calls.release++; },
    fence: async () => { calls.fence++; if (fenceFails) throw Error('vendor unavailable'); },
    login: {
      start: async () => { calls.loginStart++; return { sessionRef: 'vendor-session-secret', liveViewUrl: 'https://live.vendor.test/view/secret-token' }; },
      confirm: async ({ account }) => { calls.confirm++; return account === 'owner@shop.example'; },
    },
  };
  const make = (adopted = true) => browserErrand({
    enabled: true, ownerId: 'owner-a', errandId: 'errand-1', engine, store, now: () => now, newId: () => crypto.randomUUID(),
    admit: async () => grant ? 'host-grant' : null, submitAdopted: type => adopted && type === 'subscription_cancel',
    holdSeconds: 1800, submitMarginMs: 120_000,
  });
  return {
    make, calls, script, engine,
    row: () => row as BrowserErrandCheckpoint,
    advance: (ms: number) => { now += ms; },
    revoke: () => { grant = false; },
    dieOnSave: (when: (record: BrowserErrandCheckpoint) => boolean) => { failSave = when; },
    failFence: (on: boolean) => { fenceFails = on; },
  };
}

const prepared = async (errand: ReturnType<ReturnType<typeof harness>['make']>) => {
  const result = await errand.prepare('owner-a', plan);
  if (result.status !== 'review') throw Error(`expected review, got ${result.status}`);
  return result.proposal;
};

describe('browser errand seam', () => {
  it('holds the browser for the card, submits once after approval and verifies on the account', async () => {
    const h = harness(); const errand = h.make();
    const proposal = await prepared(errand);
    expect(proposal).toMatchObject({ url: 'https://shop.example/account/cancel', binding: { plan: 'Synthetic Premium' }, action: { description: 'Confirm cancellation' } });
    expect(proposal.approvalExpiresAt).toBe(1_000_000 + 1_800_000 - 120_000);
    expect(h.row().phase).toBe('awaiting_approval');
    expect(h.calls.release).toBe(0);
    const outcome = await errand.submit('owner-a', proposal, 'approval-1');
    expect(outcome).toMatchObject({ status: 'verified_with_receipt', receipt: { id: 'CONF-1', source: 'provider' } });
    expect(h.calls).toMatchObject({ submit: 1, verify: 1, release: 1 });
    expect(h.row().custody.sessionRef).toBeNull();
    if (outcome.status !== 'verified_with_receipt') throw Error('unreachable');
    expect(await errand.receiptVerified('owner-a', proposal.continuation!.proposalId, outcome.receipt)).toBe(true);
    expect(await errand.receiptVerified('owner-a', proposal.continuation!.proposalId, { ...outcome.receipt, id: 'forged' })).toBe(false);
  });

  it('never lets vendor references reach the card, the view or an outcome', async () => {
    const h = harness(); const errand = h.make();
    const proposal = await prepared(errand);
    const outcome = await errand.submit('owner-a', proposal, 'approval-1');
    const visible = JSON.stringify([proposal, outcome, await errand.view('owner-a')]);
    for (const secret of SECRET_REFS) expect(visible).not.toContain(secret);
  });

  it('approval timeout: the sweep closes the held browser and a late approval submits nothing', async () => {
    const h = harness(); const errand = h.make();
    const proposal = await prepared(errand);
    h.advance(1_800_000 - 120_000);
    expect(await errand.sweep('owner-a')).toBe('expired');
    expect(h.calls.release).toBe(1);
    expect(h.row().custody.sessionRef).toBeNull();
    expect(await errand.submit('owner-a', proposal, 'approval-late')).toMatchObject({ status: 'rejected' });
    expect(h.calls.submit).toBe(0);
  });

  it('approval timeout without a sweep: the late approval itself closes the browser and submits nothing', async () => {
    const h = harness(); const errand = h.make();
    const proposal = await prepared(errand);
    h.advance(1_800_000);
    expect(await errand.submit('owner-a', proposal, 'approval-late')).toMatchObject({ status: 'rejected', message: expect.stringContaining('expired') });
    expect(h.calls).toMatchObject({ submit: 0, release: 1 });
    expect(h.row().phase).toBe('expired');
  });

  it('crash between submit and verify: a new instance follows the recorded run and never submits again', async () => {
    const h = harness(); const crashed = h.make();
    const proposal = await prepared(crashed);
    h.script.run = async () => { throw Error('process died while polling'); };
    expect(await crashed.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'uncertain' });
    expect(h.row()).toMatchObject({ phase: 'unknown', custody: { submitRunRef: 'vendor-run-submit' } });
    h.script.run = async () => ({ state: 'finished', vendorClaim: null });
    const restarted = h.make();
    expect(await restarted.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'verified_with_receipt' });
    expect(h.calls).toMatchObject({ submit: 1, fence: 0 });
  });

  it('crash after the submit request but before its run was recorded: fence, find the run, verify, no second submit', async () => {
    const h = harness({ find: { status: 'found', runRef: 'vendor-run-submit' } }); const crashed = h.make();
    const proposal = await prepared(crashed);
    h.dieOnSave(record => record.phase === 'submitted');
    await expect(crashed.submit('owner-a', proposal, 'approval-1')).rejects.toThrow('process died');
    expect(h.row()).toMatchObject({ phase: 'submitting', custody: { submitRunRef: null } });
    expect(await h.make().reconcile('owner-a')).toMatchObject({ status: 'verified_with_receipt' });
    expect(h.calls).toMatchObject({ submit: 1, fence: 1, find: 1 });
  });

  it('crash before the run was recorded and the engine shows no run: not applied, never resubmitted', async () => {
    const h = harness({ find: { status: 'absent' } }); const crashed = h.make();
    const proposal = await prepared(crashed);
    h.dieOnSave(record => record.phase === 'submitted');
    await expect(crashed.submit('owner-a', proposal, 'approval-1')).rejects.toThrow('process died');
    expect(await h.make().submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'rejected', message: expect.stringContaining('never started') });
    expect(h.row().phase).toBe('not_applied');
    expect(await h.make().submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'rejected' });
    expect(h.calls).toMatchObject({ submit: 1, fence: 1 });
  });

  it('a lost submit answer with an unknown engine state stays uncertain and is never retried', async () => {
    const h = harness({ find: { status: 'unknown' }, submit: async () => { throw Error('response lost'); } }); const errand = h.make();
    const proposal = await prepared(errand);
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'uncertain' });
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'uncertain' });
    expect(h.calls.submit).toBe(1);
    expect(h.row().phase).toBe('unknown');
  });

  it('duplicate submit: concurrent approvals and a replay after success make one final submit', async () => {
    const h = harness(); const errand = h.make();
    const proposal = await prepared(errand);
    const results = await Promise.all([errand.submit('owner-a', proposal, 'approval-1'), h.make().submit('owner-a', proposal, 'approval-1')]);
    expect(results.map(result => result.status)).toEqual(['verified_with_receipt', 'verified_with_receipt']);
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'verified_with_receipt' });
    expect(h.calls.submit).toBe(1);
  });

  it('a vendor success claim without a matching account read is not completion', async () => {
    const h = harness({ verify: { observed: { status: 'Active' }, confirmationId: 'CONF-1' } }); const errand = h.make();
    const proposal = await prepared(errand);
    const outcome = await errand.submit('owner-a', proposal, 'approval-1');
    expect(outcome.status).toBe('acknowledged_unverified');
    expect(h.row().phase).toBe('unknown');
    expect(await errand.receiptVerified('owner-a', proposal.continuation!.proposalId, { id: 'CONF-1', observed_at: '2026-10-21T00:00:00Z', source: 'provider', action_digest: `sha256:${'a'.repeat(64)}`, binding_digest: `sha256:${'b'.repeat(64)}` })).toBe(false);
    h.script.verify = null;
    expect((await errand.reconcile('owner-a')).status).toBe('acknowledged_unverified');
    expect(h.calls.submit).toBe(1);
  });

  it('a run still going is reported as such and checked again later without resubmitting', async () => {
    const h = harness({ run: async () => ({ state: 'running' }) }); const errand = h.make();
    const proposal = await prepared(errand);
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'uncertain', message: expect.stringContaining('still running') });
    expect(h.calls.verify).toBe(0);
    h.script.run = async () => ({ state: 'finished', vendorClaim: false });
    expect(await errand.reconcile('owner-a')).toMatchObject({ status: 'verified_with_receipt' });
    expect(h.calls.submit).toBe(1);
  });

  it('a held browser that closed before the final step asks for a fresh review, never a blind submit', async () => {
    const h = harness({ submit: async () => ({ status: 'not_started' }) }); const errand = h.make();
    const proposal = await prepared(errand);
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'rejected', message: expect.stringContaining('prepare it again') });
    expect(h.row()).toMatchObject({ phase: 'ready', proposalId: null, custody: { sessionRef: null } });
    expect(h.calls.fence, 'the held browser is ended, not forgotten').toBe(1);
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'rejected' });
    h.script.submit = async () => ({ status: 'started', runRef: 'vendor-run-submit' });
    const fresh = await prepared(errand);
    expect(fresh.continuation!.proposalId).not.toBe(proposal.continuation!.proposalId);
    expect(h.calls.verify).toBe(0);
  });

  it('a final step that could not start, whose browser could not be ended, is ended by the next sweep', async () => {
    const h = harness({ submit: async () => ({ status: 'not_started' }) }); const errand = h.make();
    const proposal = await prepared(errand);
    h.failFence(true);
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'rejected' });
    expect(h.row()).toMatchObject({ phase: 'ready', custody: { sessionRef: 'vendor-session-secret' } });
    h.failFence(false);
    expect(await errand.sweep('owner-a')).toBe('ready');
    expect(h.row().custody.sessionRef).toBeNull();
    expect(h.calls.fence).toBe(2);
  });

  it('refuses a changed approval, an unadopted errand type, a revoked grant and another owner', async () => {
    const h = harness(); const errand = h.make();
    const proposal = await prepared(errand);
    expect(await errand.submit('owner-a', { ...proposal, binding: { ...proposal.binding, plan: 'Synthetic Basic' } }, 'approval-1')).toMatchObject({ status: 'rejected' });
    expect(await errand.submit('owner-a', { ...proposal, continuation: { ...proposal.continuation!, proposalId: 'other' } }, 'approval-1')).toMatchObject({ status: 'rejected' });
    await expect(errand.submit('owner-b', proposal, 'approval-1')).rejects.toThrow('unavailable');
    h.revoke();
    expect(await errand.submit('owner-a', proposal, 'approval-1')).toMatchObject({ status: 'rejected' });
    expect(h.calls.submit).toBe(0);
    const g = harness(); const unadopted = g.make(false);
    expect(await unadopted.submit('owner-a', await prepared(unadopted), 'approval-1')).toMatchObject({ status: 'rejected' });
    expect(g.calls).toMatchObject({ submit: 0, release: 1 });
  });

  it('returns structured blocks and keeps the browser only for a login wall', async () => {
    for (const reason of ['challenge', 'js_required'] as const) {
      const h = harness({ prepare: { kind: 'blocked', reason, sessionRef: 'vendor-session-secret', runRef: 'vendor-run-prepare' } });
      expect(await h.make().prepare('owner-a', plan)).toEqual({ status: 'blocked', blocked: reason });
      expect(h.calls.release).toBe(1);
    }
    const h = harness({ prepare: { kind: 'blocked', reason: 'login_required', sessionRef: 'vendor-session-secret', runRef: 'vendor-run-prepare' } });
    expect(await h.make().prepare('owner-a', plan)).toEqual({ status: 'blocked', blocked: 'login_required' });
    expect(h.calls.release).toBe(0);
  });

  it('refuses a health-adjacent errand and a review screen on another site', async () => {
    const h = harness();
    expect(await h.make().prepare('owner-a', { ...plan, healthAdjacent: true })).toMatchObject({ status: 'failed' });
    expect(h.calls.prepare).toBe(0);
    const g = harness({ prepare: { kind: 'review', sessionRef: 's', runRef: 'r', url: 'https://elsewhere.example/pay', facts: { total: '9' } } });
    expect(await g.make().prepare('owner-a', plan)).toMatchObject({ status: 'failed' });
    expect(g.calls.release).toBe(1);
  });

  it('login handoff: automation paused while the owner signs in, one confirm read, then a fresh review', async () => {
    const h = harness({ prepare: { kind: 'blocked', reason: 'login_required', sessionRef: 'vendor-agent-session', runRef: 'vendor-run-prepare' } });
    const errand = h.make();
    await errand.prepare('owner-a', plan);
    await errand.beginLogin('owner-a');
    expect(h.calls).toMatchObject({ release: 1, loginStart: 1 });
    expect(await errand.liveView('owner-a')).toBe('https://live.vendor.test/view/secret-token');
    expect(h.row().login?.state).toBe('owner_in_control');
    await expect(errand.prepare('owner-a', plan)).rejects.toThrow('already exists');
    expect(h.calls).toMatchObject({ prepare: 1, verify: 0, confirm: 0 });
    expect(await errand.loginEvent('owner-a', { type: 'owner_done' }, 'owner@shop.example')).toBe('signed_in');
    expect(h.row()).toMatchObject({ phase: 'ready', custody: { liveViewUrl: null, sessionRef: null } });
    expect(await errand.liveView('owner-a')).toBeNull();
    h.script.prepare = { kind: 'review', sessionRef: 'vendor-session-secret', runRef: 'vendor-run-prepare', url: 'https://shop.example/account/cancel', facts: { plan: 'Synthetic Premium' } };
    expect((await errand.prepare('owner-a', plan)).status).toBe('review');
    expect(h.calls.confirm).toBe(1);
  });

  it('login handoff: a wrong account fails, and an abandoned handoff expires and closes the browser', async () => {
    const blocked = { kind: 'blocked', reason: 'login_required', sessionRef: 'vendor-agent-session', runRef: 'vendor-run-prepare' } as const;
    const h = harness({ prepare: blocked }); const errand = h.make();
    await errand.prepare('owner-a', plan); await errand.beginLogin('owner-a');
    expect(await errand.loginEvent('owner-a', { type: 'owner_done' }, 'someone@else.example')).toBe('failed');
    expect(h.row().phase).toBe('failed');
    const g = harness({ prepare: blocked }); const abandoned = g.make();
    await abandoned.prepare('owner-a', plan); await abandoned.beginLogin('owner-a');
    g.advance(15 * 60_000);
    expect(await abandoned.sweep('owner-a')).toBe('expired');
    expect(g.calls.release).toBe(2);
    expect(await abandoned.liveView('owner-a')).toBeNull();
  });
});

it('runs through the approval desk and effect ledger: one submit, a host-checked receipt, replay stays handled', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('browser-errand-desk'));
  await runInDurableObject(stub, async (_instance, state) => {
    const h = harness(); const errand = h.make();
    const proposal = await prepared(errand);
    const effects = ownerEffectLedger(state.storage, () => 1000);
    const desk = approvalDesk(state.storage.sql, { owner: 42, call: async () => ({}), google: async () => null, newId: () => 'errand', now: () => 1000, timezone: 'UTC', log: () => {}, effects,
      browserSubmit: (bp: BrowserSubmitProposal, id?: string) => errand.submit('owner-a', bp, id ?? ''),
      browserReconcile: () => errand.reconcile('owner-a'),
      browserDeny: async bp => errand.deny('owner-a', bp.continuation!.proposalId),
      browserReceiptVerified: (bp, receipt) => errand.receiptVerified('owner-a', bp.continuation!.proposalId, receipt),
    });
    const id = await desk.proposeBrowserSubmit(proposal);
    expect((await desk.decide(id, 'a', 'test')).toast).toBe('Verified');
    expect((await desk.decide(id, 'a', 'test')).toast).toBe('Already handled.');
    expect(effects.get(`approval:${id}:apply`)?.receipt?.provider_id).toBe('CONF-1');
    expect(h.calls.submit).toBe(1);
  });
});
