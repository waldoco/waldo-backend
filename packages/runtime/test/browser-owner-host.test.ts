import { expect, it } from 'vitest';
import { browserOwnerHost, type BrowserOwnerGrantRequest } from '../src/channels/browser-owner-host';
import { fixtureDigest } from '../src/channels/public-fixture-browser';
function fixture() {
  const rows = new Map<string, unknown>(); let alarm: number | null = null, starts = 0, now = 100;
  const storage = { get: async (key: string) => rows.get(key), put: async (key: string | Record<string, unknown>, value?: unknown) => { for (const [k, v] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) rows.set(k as string, structuredClone(v)); }, getAlarm: async () => alarm, setAlarm: async (value: number) => { alarm = value; } } as unknown as DurableObjectStorage;
  const binding = { owner_id: '10000000-0000-0000-0000-000000000001', presence_id: '20000000-0000-0000-0000-000000000001', do_name: 'physical-owner-a', provider: 'telegram' as const, subject: '81101', admission_revision: '1', state_version: 0 };
  const principal = 'prn_10000000000000000000000000000001';
  const driver = { provider: 'cloudflare_playwright' as const, origin: 'https://fixture.example', pageUrl: 'https://fixture.example/form', runId: 'run-one', submitRef: '#submit', start: async () => { starts++; return 'private-provider-id'; }, navigate: async () => {}, inspect: async () => ({ url: 'https://fixture.example/form', stateDigest: await fixtureDigest('synthetic'), binding: { value: 'synthetic' } }), fill: async (_id: string, _field: string, _value: string, _state: string, before: () => Promise<void>) => { await before(); }, submit: async (_id: string, _state: string, before: () => Promise<void>) => { await before(); }, verify: async () => null, end: async () => {} };
  const config = { enabled: true, binding, manifestDigest: `sha256:${'a'.repeat(64)}`, driver, lookup: async () => ({ ...binding }), grant: async (request: BrowserOwnerGrantRequest) => ({ ...request, ref: 'fresh-grant', expiresAt: now + 1000 }) };
  const options = { storage, physical: () => ({ doName: binding.do_name, subject: binding.subject, matches: true }), config, now: () => now, newId: () => crypto.randomUUID(), approved: () => false };
  return { options, rows, principal, driver, starts: () => starts, alarm: () => alarm, time: (value: number) => { now = value; } };
}
it('default-off owner host rejects typed allocation and preserves the legacy handler', async () => {
  const f = fixture(); const disabled = browserOwnerHost({ ...f.options, config: undefined });
  expect(await disabled.resolve(f.principal)).toBeNull();
  expect(f.starts()).toBe(0);
});
it('persists the canonical owner session and expiry wake across host recreation', async () => {
  const f = fixture(), task = await browserOwnerHost(f.options).resolve(f.principal);
  expect(task).not.toBeNull(); await task!.read(f.principal);
  expect(f.starts()).toBe(1); expect(f.alarm()).toBe(60100);
  const resumed = await browserOwnerHost(f.options).resolve(f.principal);
  expect(await resumed!.read(f.principal)).toMatchObject({ binding: { value: 'synthetic' } });
  expect(f.starts()).toBe(1);
});
it('rejects a different principal, physical owner, stale directory revision and wrong grant evidence without allocation', async () => {
  const f = fixture();
  expect(await browserOwnerHost(f.options).resolve('prn_ffffffffffffffffffffffffffffffff')).toBeNull();
  expect(await browserOwnerHost({ ...f.options, physical: () => ({ doName: 'foreign-do', subject: '81101', matches: false }) }).resolve(f.principal)).toBeNull();
  f.options.config.lookup = async () => ({ ...f.options.config.binding, admission_revision: '2' });
  expect(await browserOwnerHost(f.options).resolve(f.principal)).toBeNull();
  f.options.config.lookup = async () => ({ ...f.options.config.binding });
  f.options.config.grant = async request => ({ ...request, task: 'foreign-task', ref: 'forged', expiresAt: 1000 });
  const host = await browserOwnerHost(f.options).resolve(f.principal);
  await expect(host!.read(f.principal)).rejects.toThrow('unavailable'); expect(f.starts()).toBe(0);
});
it('serializes reconstructed same-owner hosts while another owner remains independent', async () => {
  const a = fixture(), b = fixture();
  const first = await browserOwnerHost(a.options).resolve(a.principal), resumed = await browserOwnerHost(a.options).resolve(a.principal);
  await Promise.all([first!.read(a.principal), resumed!.read(a.principal), (await browserOwnerHost(b.options).resolve(b.principal))!.read(b.principal)]);
  expect(a.starts()).toBe(1); expect(b.starts()).toBe(1);
});
it('expires idle sessions, preserves failed cleanup and retries after feature disable', async () => {
  const f = fixture(), coordinator = browserOwnerHost(f.options);
  await (await coordinator.resolve(f.principal))!.read(f.principal);
  f.driver.end = async () => { throw Error('synthetic cleanup failure'); };
  f.time(60100); await browserOwnerHost(f.options).maintain();
  expect(f.rows.get('browser_owner_task_v1')).toMatchObject({ phase: 'cleanup_pending' });
  expect(f.rows.get('browser_owner_task_due_v1')).toBe(90100);
  f.driver.end = async () => {}; f.options.config.enabled = false;
  await browserOwnerHost(f.options).maintain();
  expect(f.rows.get('browser_owner_task_v1')).toMatchObject({ phase: 'closed' });
});
it('fences stop before the task mutex and denies a paused physical action without repeating cleanup', async () => {
  const f = fixture(); let physicalActions = 0, ends = 0;
  let reached!: () => void, resume!: () => void;
  const entered = new Promise<void>(resolve => { reached = resolve; }), release = new Promise<void>(resolve => { resume = resolve; });
  f.driver.fill = async (_id, _field, _value, _state, before) => { reached(); await release; await before(); physicalActions++; };
  f.driver.end = async () => { ends++; };
  const coordinator = browserOwnerHost(f.options), task = (await coordinator.resolve(f.principal))!;
  await task.read(f.principal);
  const pending = task.fill(f.principal, 'value', 'synthetic next'); await entered;
  await coordinator.revoke();
  expect(f.rows.get('browser_owner_task_revoked_v1')).toBe('run-one');
  const cleanup = coordinator.stop(); resume();
  await expect(pending).rejects.toThrow('expired or revoked'); await cleanup;
  expect(physicalActions).toBe(0); expect(ends).toBe(1);
});
it('durably caps fresh authorizations per owner task and cannot replenish by reconstruction', async () => {
  const f = fixture(), task = (await browserOwnerHost(f.options).resolve(f.principal))!;
  await task.read(f.principal);
  for (let n = 0; n < 29; n++) await task.inspect(f.principal);
  expect(f.rows.get('browser_owner_task_admissions_v1')).toBe(32);
  await expect((await browserOwnerHost(f.options).resolve(f.principal))!.inspect(f.principal)).rejects.toThrow('expired or revoked');
  expect(f.starts()).toBe(1); expect(f.rows.get('browser_owner_task_v1')).toMatchObject({ phase: 'closed' });
});
it('caps failed physical cleanup attempts durably across reconstruction and retains the unresolved provider identity', async () => {
  const f = fixture(); let attempts = 0;
  f.driver.end = async () => { attempts++; throw Error('synthetic cleanup remains unavailable'); };
  await (await browserOwnerHost(f.options).resolve(f.principal))!.read(f.principal);
  for (let n = 0; n < 6; n++) { f.time(60100 + n * 30000); await browserOwnerHost(f.options).maintain(); }
  expect(attempts).toBe(3);
  expect(f.rows.get('browser_owner_task_due_v1')).toBeNull();
  expect(f.rows.get('browser_owner_task_cleanup_v1')).toMatchObject({ attempts: 3, status: 'exhausted' });
  expect(f.rows.get('browser_owner_task_v1')).toMatchObject({ phase: 'cleanup_pending', session: { providerSessionId: 'private-provider-id' } });
});
it('retires missing-driver and lost-allocation retry wakes without claiming provider closure', async () => {
  const f = fixture(); await (await browserOwnerHost(f.options).resolve(f.principal))!.read(f.principal);
  await browserOwnerHost({ ...f.options, config: undefined }).maintain();
  expect(f.rows.get('browser_owner_task_due_v1')).toBeNull();
  expect(f.rows.get('browser_owner_task_cleanup_v1')).toMatchObject({ status: 'driver_unavailable' });
  const lost = fixture(); lost.driver.start = async () => { throw Error('allocation response missing'); };
  await expect((await browserOwnerHost(lost.options).resolve(lost.principal))!.read(lost.principal)).rejects.toThrow('could not open');
  expect(lost.rows.get('browser_owner_task_due_v1')).toBeNull();
  expect(lost.rows.get('browser_owner_task_v1')).toMatchObject({ phase: 'cleanup_pending', session: { providerSessionId: 'pending', state: 'lost' } });
  expect(lost.rows.get('browser_owner_task_cleanup_v1')).toMatchObject({ status: 'identity_unavailable' });
});
it('retires cleanup when trusted configuration no longer identifies the stored session without selecting a new provider identity', async () => {
  const f = fixture(); await (await browserOwnerHost(f.options).resolve(f.principal))!.read(f.principal);
  const original = f.rows.get('browser_owner_task_v1');
  f.options.config.manifestDigest = `sha256:${'b'.repeat(64)}`; f.time(60100);
  await expect(browserOwnerHost(f.options).maintain()).resolves.toBeUndefined();
  expect(f.rows.get('browser_owner_task_due_v1')).toBeNull();
  expect(f.rows.get('browser_owner_task_v1')).toEqual(original);
  expect(f.rows.get('browser_owner_task_cleanup_v1')).toMatchObject({ status: 'configuration_mismatch' });
});

it('denies a captured task after source narrowing during directory lookup, without allocating', async () => {
  const f = fixture(); let allowed = true, narrow = false;
  f.options.config.lookup = async () => { if (narrow) allowed = false; return { ...f.options.config.binding }; };
  const source = async () => { if (!allowed) throw Error('supplied only'); };
  const task = (await browserOwnerHost(f.options).resolve(f.principal, source))!; narrow = true;
  await expect(task.read(f.principal)).rejects.toThrow('unavailable'); expect(f.starts()).toBe(0);
});
it('withholds paused inspection after source narrowing, prevents fill, and still cleans up', async () => {
  const f = fixture(); let allowed = true, narrow = false, fills = 0, ends = 0;
  const inspect = f.driver.inspect; f.driver.inspect = async () => { const value = await inspect(); if (narrow) allowed = false; return value; };
  f.driver.fill = async () => { fills++; }; f.driver.end = async () => { ends++; };
  const coordinator = browserOwnerHost(f.options), task = (await coordinator.resolve(f.principal, async () => { if (!allowed) throw Error('supplied only'); }))!;
  await task.read(f.principal); narrow = true;
  await expect(task.fill(f.principal, 'value', 'new')).rejects.toThrow('supplied only');
  expect(fills).toBe(0); await coordinator.stop(); expect(ends).toBe(1);
});
