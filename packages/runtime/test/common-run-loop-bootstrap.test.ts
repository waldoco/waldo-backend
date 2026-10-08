import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import { commonOwnerAuthority } from '../src/identity/common-owner-authority';
import { signCommonMessageIngress } from '../src/identity/common-message-ingress';
import { signCommonTaskSourceRequest } from '../src/identity/common-task-source-request';
import { signCommonExecutionRequest, type CommonExecutionRequest } from '../src/identity/common-execution-request';
import { RunLoopDO } from '../src/run-loop/do';
import { FakeRunLoopGateway } from '../src/run-loop/adapters';
import { COMMON_EXECUTION_DUE_KEY } from '../src/scheduler/alarm-slot';

const row = {
  owner_id: '10000000-0000-0000-0000-000000000001',
  auth_user_id: '30000000-0000-0000-0000-000000000001',
  presence_id: '20000000-0000-0000-0000-000000000001',
  do_name: 'bootstrap-fixture-owner', provider: 'telegram', subject: '81101',
  state_version: 0, admission_revision: '1',
};
const secret = 'fictional-bootstrap-hmac';
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

async function fixture() {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    expect(String(url)).toBe('https://common-bootstrap.fixture.invalid/rest/v1/rpc/common_owner_authority');
    return Response.json(row);
  });
  vi.stubGlobal('fetch', fetcher);
  const authority = await commonOwnerAuthority(env).resolve('telegram', row.subject, row.do_name);
  expect(authority).not.toBeNull();
  const digest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b => b.toString(16).padStart(2, '0')).join('');
  const root = env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(`owner-root:sha256:${await digest(`waldo-owner-root\0${authority!.ownerId}`)}`)) as DurableObjectStub<RunLoopDO>;
  const ingress = await signCommonMessageIngress(secret, {
    provider: 'telegram', subject: row.subject, doName: row.do_name,
    physicalDoId: env.TELEGRAM_OWNER_DO!.idFromName(row.do_name).toString(),
    occurrenceId: crypto.randomUUID(), text: 'Summarize these supplied notes.',
    at: Math.floor(Date.now() / 1000),
  });
  const request = await signCommonTaskSourceRequest(secret, ingress, {
    operation: 'classify', ownerInput: { inputRef: ingress.occurrenceId, text: ingress.text },
    defaults: ['workspace'], raw: JSON.stringify({ decision: 'retain', sources: [] }),
  });
  return { root, ingress, request, fetcher };
}

it('signed common source RPC works and replays across eviction without legacy provider bindings', async () => {
  expect(env.WALDO_ENV).toBeUndefined();
  expect(env.RUN_LOOP_PROVIDER_MODE).toBeUndefined();
  const { root, ingress, request } = await fixture();
  const first = await root.commonTaskSourceFromHost(ingress, request);
  expect(first).toMatchObject({ operation: 'classify', result: { snapshot: { ready: true, sources: expect.arrayContaining(['workspace']) } } });
  await evictDurableObject(root);
  expect(await root.commonTaskSourceFromHost(ingress, request)).toEqual(first);
  await runInDurableObject(root, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT count(*) AS n FROM outcomes').one().n).toBe(1);
  });
});

async function executionFixture() {
  const source = await fixture();
  const classified = await source.root.commonTaskSourceFromHost(source.ingress, source.request);
  if (classified.operation !== 'classify') throw Error('fixture classification missing');
  const digest = `sha256:${'d'.repeat(64)}`;
  const base = {
    source: classified.result.snapshot, tools: [], maxProviderTurns: 2, maxDurationMs: 60000,
    hostRun: { runId: 'fixture-physical-run', attempt: 'fixture-attempt', deadline: Date.now() + 60000 },
    binding: {
      provider: { category: 'provider' as const, id: 'fixture_model_provider', version: '1.0.0', modelRef: 'fixture_model', manifest: { id: 'fixture_provider_manifest', version: '1.0.0', digest } },
      environment: { category: 'execution_environment' as const, id: 'fixture_registered_host', version: '1.0.0', environmentKind: 'local' as const, manifest: { id: 'fixture_environment_manifest', version: '1.0.0', digest } },
      contextProjectionRef: 'fixture_frozen_context', contextProjectionDigest: digest,
    },
  };
  const request = (operation: CommonExecutionRequest['operation'], extra: Partial<CommonExecutionRequest> = {}) =>
    signCommonExecutionRequest(secret, source.ingress, { ...base, ...extra, operation });
  return { ...source, request, base, digest };
}

it('common execution begins, records provider receipts and settles across root eviction without a legacy backend', async () => {
  const { root, ingress, request, digest } = await executionFixture();
  const begun = await root.commonExecutionFromHost(ingress, await request('begin'));
  expect(begun.state).toBe('running');
  await evictDurableObject(root);
  const providerCall = { ordinal: 1, model: 'fixture_model', requestDigest: digest };
  expect((await root.commonExecutionFromHost(ingress, await request('provider_prepare', { providerCall }))).state).toBe('running');
  await evictDurableObject(root);
  await root.commonExecutionFromHost(ingress, await request('provider_settle', { providerCall: { ...providerCall, resultDigest: digest } }));
  const settled = await request('settle', { result: { ref: 'fixture_result', digest } });
  expect((await root.commonExecutionFromHost(ingress, settled)).state).toBe('settled');
  await evictDurableObject(root);
  expect((await root.commonExecutionFromHost(ingress, settled)).state).toBe('settled');
  const changed = await request('settle', { result: { ref: 'changed_result', digest } });
  await runInDurableObject(root, async instance => {
    await expect(instance.commonExecutionFromHost(ingress, changed)).rejects.toThrow('common execution result conflict');
  });
  await runInDurableObject(root, (_instance, state) => {
    expect(state.storage.sql.exec('SELECT state FROM execution_attempts').one().state).toBe('settled');
  });
});

it('native profile still rejects malformed signatures, foreign physical/root routing and revoked directory authority', async () => {
  const { root, ingress, request, fetcher } = await fixture();
  const before = fetcher.mock.calls.length;
  await runInDurableObject(root, async instance => {
    await expect(instance.commonTaskSourceFromHost({ ...ingress, signature: '0'.repeat(64) }, request)).rejects.toThrow('common message ingress rejected');
  });
  expect(fetcher.mock.calls).toHaveLength(before);
  const foreign = await signCommonMessageIngress(secret, { ...ingress, physicalDoId: 'a'.repeat(64) });
  const foreignRequest = await signCommonTaskSourceRequest(secret, foreign, { ...request });
  await runInDurableObject(root, async instance => {
    await expect(instance.commonTaskSourceFromHost(foreign, foreignRequest)).rejects.toThrow('common host locator rejected');
  });
  expect(fetcher.mock.calls).toHaveLength(before);
  const wrongRoot = env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName('foreign-root')) as DurableObjectStub<RunLoopDO>;
  await runInDurableObject(wrongRoot, async instance => {
    await expect(instance.commonTaskSourceFromHost(ingress, request)).rejects.toThrow('common root route rejected');
  });
  fetcher.mockImplementation(async () => Response.json(null));
  await runInDurableObject(root, async instance => {
    await expect(instance.commonTaskSourceFromHost(ingress, request)).rejects.toThrow('common owner unavailable');
  });
});

it('native profile does not admit local HTTP ingress or test overrides', async () => {
  const { root } = await fixture();
  expect((await root.fetch('https://fixture.invalid/local/fake-runs', { method: 'POST', body: '{}' })).status).toBe(404);
  await runInDurableObject(root, instance => {
    expect(() => instance.__runLoopSetTestOverrides({ providerMode: 'fake' })).toThrow('run-loop test seam is local-only');
  });
});

it('due persisted legacy work still fails provider guards without fake effects or external egress, while common leases rearm', async () => {
  const { root, ingress, request, fetcher } = await executionFixture();
  await root.commonExecutionFromHost(ingress, await request('begin'));
  await runInDurableObject(root, async (instance, state) => {
    // Prepare a historical record through its supported local fixture writer.
    // The native-profile instance, not this fixture writer, dispatches it.
    const fixtureWriter = new RunLoopDO(state, { ...env, WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake' });
    const now = Date.now();
    await fixtureWriter.scheduleFakeRun({ scheduleId: 'brief:legacy', userId: 'fixture-user', occurrenceAt: now, dueAt: now + 120000 });
    state.storage.sql.exec("UPDATE schedule SET due_at = ? WHERE id = 'brief:legacy'", now);
    await state.storage.delete(COMMON_EXECUTION_DUE_KEY);
    const gatewayCalls = vi.spyOn(FakeRunLoopGateway.prototype, 'complete');
    const externalBefore = fetcher.mock.calls.length;
    await instance.alarm();
    expect(gatewayCalls).not.toHaveBeenCalled();
    expect(fetcher.mock.calls).toHaveLength(externalBefore);
    expect(state.storage.sql.exec("SELECT outcome FROM schedule_runs WHERE schedule_id = 'brief:legacy'").one().outcome).toBe('failed');
    expect(state.storage.sql.exec('SELECT state FROM runtime_runs').one().state).not.toBe('DONE');
    expect(await state.storage.get<number>(COMMON_EXECUTION_DUE_KEY)).toBeGreaterThan(now);
    expect(await state.storage.getAlarm()).not.toBeNull();
    // Prevent an automatic local alarm racing the test's storage cleanup.
    await state.storage.deleteAlarm();
  });
});
