import { expect, it } from 'vitest';
import { browserTaskContinuity, type BrowserTaskStore } from '../src/channels/browser-task-continuity';
import { fixtureDigest } from '../src/channels/public-fixture-browser';
import type { BrowserTaskCheckpoint } from '@waldo/contracts';
const fixture = () => {
  let row: unknown = null, lock: Promise<unknown> = Promise.resolve(), starts = 0, submits = 0, ends = 0, value = 'synthetic initial', now = 100, grant = true;
  const store: BrowserTaskStore = { exclusive: async work => { const next = lock.then(work); lock = next.catch(() => undefined); return next; }, load: async () => row === null ? null : structuredClone(row), save: async next => { row = structuredClone(next); } };
  const driver = { provider: 'cloudflare_playwright' as const, origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'run-one', submitRef: '#submit', start: async () => { starts++; return 'private-provider-session'; }, navigate: async () => {}, inspect: async () => ({ url: 'https://fixture.example/form', stateDigest: await fixtureDigest({ value }), binding: { value } }), fill: async (_id: string, _field: string, next: string, _digest: string, before: () => Promise<void>) => { await before(); value = next; }, submit: async (_id: string, _digest: string, before: () => Promise<void>) => { await before(); submits++; }, verify: async (_digest: string) => null as { id: string; observed_at: string; source: 'controlled_fixture'; binding_digest: string } | null, end: async () => { ends++; } };
  const options = { enabled: true, ownerId: 'owner-a', taskId: 'run-one', manifestDigest: `sha256:${'a'.repeat(64)}`, store, driver, now: () => now, newId: () => crypto.randomUUID(), admit: async (): Promise<string | null> => grant ? 'host-current-grant' : null };
  return { options, driver, counts: () => ({ starts, submits, ends }), row: () => row as BrowserTaskCheckpoint, setTime: (next: number) => { now = next; }, revoke: () => { grant = false; } };
};
it('persists one owner/site/task session and filled state across service recreation and approval', async () => {
  const f = fixture(); const first = browserTaskContinuity(f.options);
  await first.open('owner-a', 10000);
  await first.fill('owner-a', 'value', 'synthetic approved');
  const resumed = browserTaskContinuity(f.options);
  expect(await resumed.inspect('owner-a')).toMatchObject({ binding: { value: 'synthetic approved' } });
  const proposal = await resumed.propose('owner-a');
  expect(proposal).toMatchObject({ binding: { value: 'synthetic approved' }, actionRef: '#submit' });
  expect(f.counts()).toEqual({ starts: 1, submits: 0, ends: 0 });
  expect(JSON.stringify(proposal)).not.toContain('private-provider-session');
});

it('commits final intent once, never retries unknown submit, and later reconciles only by receipt readback', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000); const proposal = await task.propose('owner-a');
  f.driver.submit = async (_id, _state, before) => { await before(); throw Error('response lost after possible effect'); };
  expect(await task.submit('owner-a', proposal.id, 'owner-approval')).toMatchObject({ status: 'uncertain' });
  expect(f.row().phase).toBe('unknown');
  expect(await browserTaskContinuity(f.options).submit('owner-a', proposal.id, 'owner-approval')).toMatchObject({ status: 'uncertain' });
  f.driver.verify = async bindingDigest => ({ id: 'synthetic-receipt', observed_at: '2026-10-03T12:00:00Z', source: 'controlled_fixture', binding_digest: bindingDigest });
  expect(await task.reconcile('owner-a')).toMatchObject({ status: 'verified_with_receipt' });
  expect(f.counts().starts).toBe(1);
  expect(f.counts().ends).toBe(1);
});

it('denies another owner and closes an expired or revoked task without reviving it', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000);
  await expect(task.inspect('owner-b')).rejects.toThrow('unavailable');
  await expect(task.cancel('owner-b')).rejects.toThrow('unavailable');
  expect(f.counts().ends).toBe(0);
  f.setTime(10100);
  await expect(task.fill('owner-a', 'value', 'synthetic')).rejects.toThrow('expired or revoked');
  expect(f.row().phase).toBe('closed');
  expect(f.counts().ends).toBe(1);
});

it('concurrent approval executes at most one final action and returns a bound receipt', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000); const proposal = await task.propose('owner-a');
  f.driver.verify = async bindingDigest => ({ id: 'fixture-receipt', observed_at: '2026-10-03T12:00:00Z', source: 'controlled_fixture', binding_digest: bindingDigest });
  const results = await Promise.all([task.submit('owner-a', proposal.id, 'approval'), task.submit('owner-a', proposal.id, 'approval')]);
  expect(results.every(result => result.status === 'verified_with_receipt')).toBe(true);
  expect(f.counts().submits).toBe(1); expect(f.counts().ends).toBe(1);
});

it('rejects any filled-state drift before submission and demands a new proposal', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000); const proposal = await task.propose('owner-a');
  f.driver.inspect = async () => ({ url: 'https://fixture.example/form', stateDigest: `sha256:${'f'.repeat(64)}`, binding: { value: 'changed' } });
  expect(await task.submit('owner-a', proposal.id, 'approval')).toMatchObject({ status: 'rejected' });
  expect(f.row().proposal).toBeNull(); expect(f.counts().submits).toBe(0);
});

it('retains cleanup failure and allows the same owner to stop even after feature disable', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000);
  f.driver.end = async () => { throw Error('private provider failure'); };
  await task.cancel('owner-a'); expect(f.row().phase).toBe('cleanup_pending');
  f.options.enabled = false; f.driver.end = async () => {};
  await task.cancel('owner-a'); expect(f.row().phase).toBe('closed');
});

it('checks revocation immediately before click and never overwrites terminal cleanup with active state', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000); const proposal = await task.propose('owner-a');
  f.driver.submit = async (_id, _state, before) => { f.revoke(); await before(); throw Error('must not reach click'); };
  expect(await task.submit('owner-a', proposal.id, 'approval')).toMatchObject({ status: 'uncertain' });
  expect(f.row().phase).toBe('closed'); expect(f.row().session.state).toBe('ended');
  expect(f.counts().submits).toBe(0);
});

it('counts physical attempts durably and rejects an empty fill before consuming a step', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000);
  await expect(task.fill('owner-a', 'value', '')).rejects.toThrow('fill rejected');
  expect(f.row().steps).toBe(0);
  for (let n = 0; n < 5; n++) await task.fill('owner-a', 'value', `synthetic-${n}`);
  await expect(browserTaskContinuity(f.options).fill('owner-a', 'value', 'overflow')).rejects.toThrow('preparation unavailable');
  expect(f.row().steps).toBe(5);
});

it('off gate or missing initial grant performs no allocation or durable task mutation', async () => {
  const f = fixture(); f.revoke();
  await expect(browserTaskContinuity(f.options).open('owner-a', 10000)).rejects.toThrow('unavailable');
  expect(f.row()).toBeNull(); expect(f.counts().starts).toBe(0);
  f.options.enabled = false;
  await expect(browserTaskContinuity(f.options).open('owner-a', 10000)).rejects.toThrow('unavailable');
  expect(f.counts().starts).toBe(0);
});

it('allocation uncertainty preserves lost/cleanup evidence rather than claiming an unknown session ended', async () => {
  const f = fixture(); f.driver.start = async () => { throw Error('allocation response lost'); };
  const task = browserTaskContinuity(f.options);
  await expect(task.open('owner-a', 10000)).rejects.toThrow('could not open');
  expect(f.row()).toMatchObject({ phase: 'cleanup_pending', session: { providerSessionId: 'pending', state: 'lost' } });
  await task.cancel('owner-a');
  expect(f.row()).toMatchObject({ phase: 'cleanup_pending', session: { state: 'lost' } });
  expect(f.counts().ends).toBe(0);
});

it('rejects a foreign or changed-manifest checkpoint before any provider I/O', async () => {
  const f = fixture(); const task = browserTaskContinuity(f.options);
  await task.open('owner-a', 10000); const record = f.row();
  await f.options.store.save({ ...record, session: { ...record.session, ownerId: 'owner-b' } });
  await expect(task.inspect('owner-a')).rejects.toThrow('unavailable');
  expect(f.counts().starts).toBe(1); expect(f.counts().ends).toBe(0);
  await f.options.store.save({ ...record, manifestDigest: `sha256:${'f'.repeat(64)}` });
  await expect(task.inspect('owner-a')).rejects.toThrow('unavailable');
  expect(f.counts().ends).toBe(0);
});
it('rejects receipt reconciliation after the private session generation changes', async () => {
  const f = fixture(), host = browserTaskContinuity(f.options);
  await host.open('owner-a'); const proposal = await host.propose('owner-a');
  await host.submit('owner-a', proposal.id, 'fresh-approval');
  await f.options.store.save({ ...f.row(), session: { ...f.row().session, generation: f.row().session.generation + 1 } });
  let reads = 0; f.driver.verify = async digest => { reads++; return { id: 'receipt', observed_at: '2026-10-03T15:00:00Z', source: 'controlled_fixture', binding_digest: digest }; };
  expect(await host.reconcile('owner-a')).toMatchObject({ status: 'rejected' });
  expect(reads).toBe(0); expect(f.counts().submits).toBe(1);
});
it('closes and blocks submit when final admission resolves after absolute expiry', async () => {
  const f = fixture(), host = browserTaskContinuity(f.options);
  await host.open('owner-a', 10000); const proposal = await host.propose('owner-a');
  f.options.admit = async () => { if (f.row().phase === 'submitting') f.setTime(f.row().session.expiresAt); return 'late-current-grant'; };
  expect(await host.submit('owner-a', proposal.id, 'fresh-approval')).toMatchObject({ status: 'uncertain' });
  expect(f.counts()).toMatchObject({ submits: 0, ends: 1 }); expect(f.row().phase).toBe('closed');
});
it('cancel reports pending physical cleanup while fencing further actions', async () => {
  const f = fixture(), host = browserTaskContinuity(f.options); await host.open('owner-a');
  f.driver.end = async () => { throw Error('lost provider response'); };
  expect(await host.cancel('owner-a')).toEqual({ stopped: 'cleanup_pending', actions_fenced: true });
  expect(f.row().phase).toBe('cleanup_pending'); await expect(host.fill('owner-a','value','new')).rejects.toThrow();
});
it('reprepares retained form after unpublished or modified proposal and rejects old approval', async () => {
  const f = fixture(), host = browserTaskContinuity(f.options); await host.open('owner-a');
  const old = await host.propose('owner-a');
  await host.fill('owner-a', 'value', 'synthetic revised');
  const revised = await host.propose('owner-a'); expect(revised.id).not.toBe(old.id);
  const retry = await host.propose('owner-a'); expect(retry.id).not.toBe(revised.id);
  expect(await host.submit('owner-a', old.id, 'old-desk-approval')).toMatchObject({ status: 'rejected' });
  expect(await host.submit('owner-a', revised.id, 'superseded-desk-approval')).toMatchObject({ status: 'rejected' });
  expect(f.counts().submits).toBe(0);
});
it('denies late initial admission without allocation or persistent mutation', async () => {
  for (const cause of ['disable', 'expire']) {
    const f = fixture(), host = browserTaskContinuity(f.options);
    f.options.admit = async () => { if (cause === 'disable') f.options.enabled = false; else f.setTime(20000); return 'late-current-grant'; };
    await expect(host.open('owner-a', 10000)).rejects.toThrow('unavailable');
    expect(await f.options.store.load()).toBeNull(); expect(f.counts().starts).toBe(0);
  }
});
it('independent stop admission fences an in-flight action before queued cleanup', async () => {
  const f = fixture(), host = browserTaskContinuity(f.options); await host.open('owner-a'); const p = await host.propose('owner-a');
  let entered!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const physical = f.driver.submit;
  f.driver.submit = async (...args) => { entered(); await gate; return physical(...args); };
  const submit = host.submit('owner-a', p.id, 'fresh-desk-approval'); await ready;
  f.revoke(); // Canonical host authority is changed independently of task mutex.
  const cleanup = host.cancel('owner-a'); release();
  expect(await submit).toMatchObject({ status: 'uncertain' }); await cleanup;
  expect(f.counts().submits).toBe(0); expect(f.row().phase).toBe('closed');
});
it('malformed authoritative driver receipts remain uncertain without physical retry', async () => {
  const f = fixture(), host = browserTaskContinuity(f.options); await host.open('owner-a'); const p = await host.propose('owner-a');
  f.driver.verify = async digest => ({ id: '', observed_at: 'invalid', source: 'controlled_fixture', binding_digest: digest });
  expect(await host.submit('owner-a', p.id, 'fresh-approval')).toMatchObject({ status: 'uncertain' });
  expect(await host.reconcile('owner-a')).toMatchObject({ status: 'uncertain' });
  expect(f.row().receipt).toBeNull(); expect(f.row().phase).toBe('unknown'); expect(f.counts().submits).toBe(1);
});
