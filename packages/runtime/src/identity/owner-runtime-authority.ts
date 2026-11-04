import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';

export type OwnerRuntimeAuthority = Readonly<{
  ownerId: string; authenticatedUserId: string; doName: string;
  stateVersion: number; admissionRevision: string;
}>;
export type OwnerRuntimeLocator = Readonly<{
  doName: string; actualDoId: string; expectedDoId(doName: string): string;
  assertCurrent(): void;
}>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Background work belongs to the authenticated account even when no messaging
// surface is linked. Ingress and egress still verify their own current binding.
export function ownerRuntimeAuthority(env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = Date.now) {
  const rpc = signedRpc(env, fetcher, now);
  const resolve = async (locator: OwnerRuntimeLocator): Promise<OwnerRuntimeAuthority> => {
    if (!rpc) throw new Error('owner runtime authority unavailable');
    const physical = () => {
      locator.assertCurrent();
      if (!locator.doName || locator.doName.length > 240 || !locator.actualDoId
        || locator.expectedDoId(locator.doName) !== locator.actualDoId) throw new Error('owner runtime authority rejected');
    };
    physical();
    const raw = await rpc('owner_runtime_authority', `owner.runtime.${locator.doName}`, { p_do_name: locator.doName });
    physical();
    if (raw === null) throw new Error('owner runtime authority revoked');
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('owner runtime authority rejected');
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'admission_revision,auth_user_id,do_name,owner_id,state_version'
      || typeof row.owner_id !== 'string' || !uuid.test(row.owner_id)
      || typeof row.auth_user_id !== 'string' || !uuid.test(row.auth_user_id) || row.do_name !== locator.doName
      || typeof row.state_version !== 'number' || !Number.isSafeInteger(row.state_version) || row.state_version < 0
      || typeof row.admission_revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.admission_revision)
      || BigInt(row.admission_revision) > 9223372036854775807n) throw new Error('owner runtime authority rejected');
    return Object.freeze({ ownerId: row.owner_id.toLowerCase(), authenticatedUserId: row.auth_user_id.toLowerCase(),
      doName: locator.doName, stateVersion: row.state_version, admissionRevision: row.admission_revision });
  };
  return { resolve, async assertCurrent(admitted: OwnerRuntimeAuthority, locator: OwnerRuntimeLocator) {
    const fresh = await resolve(locator);
    if (Object.keys(admitted).some(key => admitted[key as keyof OwnerRuntimeAuthority] !== fresh[key as keyof OwnerRuntimeAuthority]))
      throw new Error('owner runtime authority revoked');
  } };
}
