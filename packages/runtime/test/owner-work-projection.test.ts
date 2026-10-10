import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { RunLoopDO } from '../src/run-loop/do';
import { routerSignature } from '../src/identity/owner-directory';
import { WaldoCoordinator } from '../src/coordinator/waldo-coordinator';
import { ownerWorkProjectionFromHost } from '../src/channels/owner-work-projection';
import { signOwnerWorkProjectionRequest, ownerWorkRootName } from '../src/identity/owner-work-projection-request';
import { sha256Hex } from '../src/connectors/google';
import type { CommonOwnerAuthority } from '../src/identity/common-owner-authority';
import type { OwnerRuntimeAuthority, OwnerRuntimeLocator } from '../src/identity/owner-runtime-authority';

const secret = 'isolated-work-read-hmac-test-secret-0000000000';
const ownerName = 'owner-app-without-telegram', ownerUuid = '11111111-2222-4333-8444-555555555555', authUuid = '66666666-7777-4888-8999-aaaaaaaaaaaa';
const physicalId = 'a'.repeat(64), rootId = 'b'.repeat(64);
const runtime: OwnerRuntimeAuthority = { ownerId: ownerUuid, authenticatedUserId: authUuid, doName: ownerName, stateVersion: 1, admissionRevision: '8' };
const fixture = async (state: DurableObjectState, seed = true) => {
  const coordinator = new WaldoCoordinator(state.storage), ownerId = `owner_${await sha256Hex(authUuid)}`, subject = ownerId.replace(/^owner_/, 'supabase_subject_');
  if (seed) {
    const admitted: CommonOwnerAuthority = { custodyDigest: 'c'.repeat(64), kind: 'verified_message_presence', ownerId, authenticatedSubjectRef: subject,
      authenticatedUserId: authUuid, directoryOwnerId: ownerUuid, doName: ownerName, presenceId: '11111111-0000-4000-8000-000000000001', provider: 'whatsapp', subject: '15550001000', stateVersion: 1, admissionRevision: '8' };
    await coordinator.captureMessageResponsibility({ requestId: 'read-fixture-capture', commandId: 'read-fixture-command', correlationId: 'read-fixture-correlation',
      payload: { userStatement: 'Prepare my canonical private work', workUnits: [{ responsibility: 'Prepare my canonical private work', inputs: [], dependencyPositions: [], expectedEvidence: [], requiredCapabilities: [], stopConditions: [] }] } }, admitted, async () => {});
  }
  const rootName = await ownerWorkRootName(authUuid); let reads = 0, revoked = false, afterRead: (() => void) | null = null;
  const options = { secret, now: () => 1_000_000, actualRootDoId: rootId,
    physicalDoIdForName: (name: string) => name === ownerName ? physicalId : 'f'.repeat(64), rootDoIdForName: (name: string) => name === rootName ? rootId : 'e'.repeat(64),
    directory: { resolve: async (locator: OwnerRuntimeLocator) => { locator.assertCurrent(); if (revoked) throw Error('authority revoked'); return runtime; },
      assertCurrent: async (_authority: OwnerRuntimeAuthority, locator: OwnerRuntimeLocator) => { afterRead?.(); locator.assertCurrent(); if (revoked) throw Error('authority revoked'); } },
    readUnits: (owner: string, admittedSubject: string) => { reads++; return coordinator.readOwnerWorkUnits(owner, admittedSubject); } };
  const request = await signOwnerWorkProjectionRequest(secret, { version: 'owner-work-read.v1', do_name: ownerName, physical_do_id: physicalId, directory_owner_id: ownerUuid,
    state_version: 1, admission_revision: '8', request_id: crypto.randomUUID(), at: 1000 });
  return { options, request, coordinator, ownerId, subject, revoke: () => { revoked = true; }, after: (hook: () => void) => { afterRead = hook; }, get reads() { return reads; } };
};
const journey = (name: string, run: (state: DurableObjectState) => Promise<void>) => runInDurableObject(env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(name)), async (_, state) => run(state));

it('reads the actual canonical WorkUnit materialization under app/account authority without activating execution', async () => journey('work-owner-read-existing', async state => {
  const f = await fixture(state), result = await ownerWorkProjectionFromHost(f.options, f.request);
  expect(result).toMatchObject({ version: 'owner-work-read.v1', directory_owner_id: ownerUuid, canonical_owner_id: f.ownerId, complete: true });
  expect(result.units).toHaveLength(1); expect(result.units[0]).toMatchObject({ ownerId: f.ownerId, state: 'planned', responsibility: 'Prepare my canonical private work' });
  expect(f.reads).toBe(2); expect(state.storage.sql.exec('SELECT count(*) AS n FROM planning_execution_requests').one().n).toBe(0);
  expect(state.storage.sql.exec('SELECT count(*) AS n FROM presence_sessions').one().n).toBe(0);
}));
it('reports a real empty canonical source without binding a root or claiming completion from an unavailable source', async () => journey('work-owner-read-empty', async state => {
  const f = await fixture(state, false), result = await ownerWorkProjectionFromHost(f.options, f.request);
  expect(result.complete).toBe(true); expect(result.units).toEqual([]); expect(state.storage.sql.exec('SELECT count(*) AS n FROM owner_roots').one().n).toBe(0);
  await expect(ownerWorkProjectionFromHost({ ...f.options, readUnits: () => { throw Error('source unavailable'); } }, f.request)).rejects.toThrow('source unavailable');
}));
it('rejects unsigned changes, a wrong physical host, a wrong owner root and another account before returning Work', async () => journey('work-owner-read-routing', async state => {
  const f = await fixture(state);
  await expect(ownerWorkProjectionFromHost(f.options, { ...f.request, directory_owner_id: authUuid })).rejects.toThrow();
  await expect(ownerWorkProjectionFromHost({ ...f.options, actualRootDoId: 'e'.repeat(64) }, f.request)).rejects.toThrow('root route rejected');
  const wrongPhysical = await signOwnerWorkProjectionRequest(secret, { ...f.request, physical_do_id: 'f'.repeat(64) });
  await expect(ownerWorkProjectionFromHost(f.options, wrongPhysical)).rejects.toThrow('physical route rejected');
  const wrongAccount = await signOwnerWorkProjectionRequest(secret, { ...f.request, directory_owner_id: authUuid });
  await expect(ownerWorkProjectionFromHost(f.options, wrongAccount)).rejects.toThrow('authority changed');
  expect(f.reads).toBe(0);
}));
it('checks admission freshness and exact materialized snapshot after the awaited directory read', async () => journey('work-owner-read-currentness', async state => {
  const f = await fixture(state);
  f.after(() => state.storage.sql.exec('UPDATE work_units SET revision = revision + 1'));
  await expect(ownerWorkProjectionFromHost(f.options, f.request)).rejects.toThrow('source changed');
  f.after(f.revoke); await expect(ownerWorkProjectionFromHost(f.options, f.request)).rejects.toThrow('authority revoked');
}));
it('rejects a mismatched root owner and expired signed read rather than hiding them as an empty collection', async () => journey('work-owner-read-root-custody', async state => {
  const f = await fixture(state);
  state.storage.sql.exec('UPDATE owner_roots SET authenticated_subject_ref = ?', 'supabase_subject_' + 'f'.repeat(64));
  await expect(ownerWorkProjectionFromHost(f.options, f.request)).rejects.toThrow('root mismatch');
  await expect(ownerWorkProjectionFromHost({ ...f.options, now: () => 1_061_000 }, f.request)).rejects.toThrow('read rejected');
}));

it('the real RunLoop read method serves the signed app/account host with verified directory RPC and refuses another physical root', async () => {
  const rootName = await ownerWorkRootName(authUuid), rootStub = env.RUN_LOOP_DO.get(env.RUN_LOOP_DO.idFromName(rootName));
  await runInDurableObject(rootStub, async (_, state) => {
    const f = await fixture(state), settings = { ...env, COMMON_OWNER_TASKS: '0', SUPABASE_PROJECT_URL: 'https://work-read-directory.fixture.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: secret };
    let reads = 0;
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (String(input) !== `${settings.SUPABASE_PROJECT_URL}/rest/v1/rpc/owner_runtime_authority`) throw Error('unlisted provider I/O');
      const args = JSON.parse(String(init?.body)); expect(args.p_do_name).toBe(ownerName);
      expect(args.p_sig).toBe(await routerSignature(secret, args.p_at, `owner.runtime.${ownerName}`)); reads++;
      return Response.json({ owner_id: ownerUuid, auth_user_id: authUuid, do_name: ownerName, state_version: 1, admission_revision: '8' });
    });
    const request = await signOwnerWorkProjectionRequest(secret, { ...f.request, physical_do_id: env.TELEGRAM_OWNER_DO!.idFromName(ownerName).toString(), at: Math.floor(Date.now() / 1000) });
    try {
      const actual = new RunLoopDO(state, settings);
      expect(await actual.readOwnerWorkProjectionFromHost(request)).toMatchObject({ complete: true, canonical_owner_id: f.ownerId, units: [{ ownerId: f.ownerId }] });
      expect(reads).toBe(2); expect(state.storage.sql.exec('SELECT count(*) AS n FROM planning_execution_requests').one().n).toBe(0);
      const other = { ...request, physical_do_id: env.TELEGRAM_OWNER_DO!.idFromName('other-owner').toString() };
      await expect(actual.readOwnerWorkProjectionFromHost(await signOwnerWorkProjectionRequest(secret, other))).rejects.toThrow('physical route rejected'); expect(reads).toBe(2);
    } finally { fetcher.mockRestore(); await state.storage.deleteAlarm(); }
  });
});
