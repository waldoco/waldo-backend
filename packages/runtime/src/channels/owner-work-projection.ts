import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { ownerRuntimeAuthority, type OwnerRuntimeAuthority, type OwnerRuntimeLocator } from '../identity/owner-runtime-authority';
import {
  ownerWorkProjectionResponseSchema, ownerWorkUnitRowSchema, ownerWorkRootName,
  signOwnerWorkProjectionRequest, verifyOwnerWorkProjectionRequest,
  type OwnerWorkProjectionRequest, type OwnerWorkUnitRow,
} from '../identity/owner-work-projection-request';
import { sha256Hex } from '../connectors/google';
import { stableJson } from '../context-composer/canonical';
import type { RunLoopDO } from '../run-loop/do';
import type { AppWorkCanonicalUnit } from './app-work';

const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
// Private authenticated host read. No common execution flag, transport presence,
// model argument, audit status or empty fallback supplies canonical source authority.
export async function ownerWorkProjectionFromHost(options: Readonly<{
  secret: string | undefined; now(): number; actualRootDoId: string;
  physicalDoIdForName(name: string): string; rootDoIdForName(name: string): string;
  directory: Readonly<{ resolve(locator: OwnerRuntimeLocator): Promise<OwnerRuntimeAuthority>; assertCurrent(authority: OwnerRuntimeAuthority, locator: OwnerRuntimeLocator): Promise<void> }>;
  readUnits(ownerId: string, authenticatedSubjectRef: string): readonly OwnerWorkUnitRow[];
}>, raw: OwnerWorkProjectionRequest) {
  const request = await verifyOwnerWorkProjectionRequest(options.secret, raw, options.now());
  const locator: OwnerRuntimeLocator = { doName: request.do_name, actualDoId: request.physical_do_id,
    expectedDoId: options.physicalDoIdForName, assertCurrent: () => {
      if (options.physicalDoIdForName(request.do_name) !== request.physical_do_id || Math.abs(Math.floor(options.now() / 1000) - request.at) > 60) throw Error('owner Work physical route rejected');
    } };
  const authority = await options.directory.resolve(locator); locator.assertCurrent();
  if (authority.ownerId !== request.directory_owner_id || authority.doName !== request.do_name || authority.stateVersion !== request.state_version || authority.admissionRevision !== request.admission_revision) throw Error('owner Work authority changed');
  const ownerId = `owner_${await sha256Hex(authority.authenticatedUserId)}`;
  const rootName = await ownerWorkRootName(authority.authenticatedUserId); locator.assertCurrent();
  if (options.rootDoIdForName(rootName) !== options.actualRootDoId) throw Error('owner Work root route rejected');
  const subject = `supabase_subject_${await sha256Hex(authority.authenticatedUserId)}`;
  const units = options.readUnits(ownerId, subject).map(row => ownerWorkUnitRowSchema.parse(row));
  if (units.some(row => row.ownerId !== ownerId) || new Set(units.map(row => row.id)).size !== units.length) throw Error('owner Work source mismatch');
  const material = stableJson(units);
  if (new TextEncoder().encode(material).byteLength > MAX_SOURCE_BYTES) throw Error('owner Work source exceeds read budget');
  const digest = await sha256Hex(material); await options.directory.assertCurrent(authority, locator); locator.assertCurrent();
  // Authority verification is awaited. Recheck the exact local materialization
  // immediately before returning; no partial or stale list is called complete.
  if (stableJson(options.readUnits(ownerId, subject)) !== material) throw Error('owner Work source changed');
  return ownerWorkProjectionResponseSchema.parse({ version: 'owner-work-read.v1', request_id: request.request_id, directory_owner_id: authority.ownerId,
    canonical_owner_id: ownerId, complete: true, snapshot_digest: digest, units });
}

export function ownerCanonicalWorkUnits(options: Readonly<{
  env: OwnerDirectoryEnv; namespace: DurableObjectNamespace<RunLoopDO> | undefined;
  locator: OwnerRuntimeLocator; directoryOwnerId: string; principalRef: string; assertCurrent(): Promise<void>;
}>) {
  const directory = ownerRuntimeAuthority(options.env);
  return async (): Promise<readonly AppWorkCanonicalUnit[]> => {
    await options.assertCurrent();
    if (!options.namespace || !options.env.WALDO_ROUTER_HMAC_SECRET) throw Error('canonical Work source unavailable');
    const authority = await directory.resolve(options.locator); await options.assertCurrent();
    if (authority.ownerId !== options.directoryOwnerId || options.principalRef !== `prn_${authority.ownerId.replaceAll('-', '')}`) throw Error('canonical Work owner mismatch');
    const request = await signOwnerWorkProjectionRequest(options.env.WALDO_ROUTER_HMAC_SECRET, {
      version: 'owner-work-read.v1', do_name: authority.doName, physical_do_id: options.locator.actualDoId,
      directory_owner_id: authority.ownerId, state_version: authority.stateVersion, admission_revision: authority.admissionRevision,
      request_id: crypto.randomUUID(), at: Math.floor(Date.now() / 1000),
    });
    await options.assertCurrent();
    const rootName = await ownerWorkRootName(authority.authenticatedUserId); await options.assertCurrent();
    const result = ownerWorkProjectionResponseSchema.parse(await options.namespace.get(options.namespace.idFromName(rootName)).readOwnerWorkProjectionFromHost(request));
    await options.assertCurrent(); await directory.assertCurrent(authority, options.locator); await options.assertCurrent();
    const canonicalOwnerId = `owner_${await sha256Hex(authority.authenticatedUserId)}`;
    const digest = await sha256Hex(stableJson(result.units)); await options.assertCurrent();
    if (result.request_id !== request.request_id || result.directory_owner_id !== authority.ownerId || result.canonical_owner_id !== canonicalOwnerId
      || result.snapshot_digest !== digest || result.units.some(row => row.ownerId !== canonicalOwnerId)) throw Error('canonical Work projection rejected');
    // Raw common-domain owner IDs and app principals have distinct encodings. This
    // conversion follows verified directory/route/source checks, never caller text.
    return result.units.map(row => ({ ...row, ownerId: options.principalRef }));
  };
}
