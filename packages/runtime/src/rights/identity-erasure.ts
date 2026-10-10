import { z } from 'zod';
import { signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { RightsError } from './jobs';

export const identityErasureReceiptSchema = z.strictObject({ version: z.literal('identity-erasure.v1'), receipt_id: z.uuid(), state: z.literal('completed'), auth_absent: z.literal(true), directory_absent: z.literal(true), public_identities_deleted: z.int().nonnegative(), auth_sessions_deleted: z.int().nonnegative(), retained: z.literal('receipt_and_workspace_custody_only') });
// Called only by the deletion job after managed custody has settled. The signed
// server identity selects Auth/public rows; there is no caller user UUID or token.
export const appIdentityErasure = (env: OwnerDirectoryEnv, doName: string, fetcher: typeof fetch = fetch) => {
  const rpc = signedRpc(env, fetcher);
  return { async erase(receiptId: string) {
    if (!rpc || !z.uuid().safeParse(receiptId).success) throw new RightsError('unavailable');
    const result = identityErasureReceiptSchema.safeParse(await rpc('app_identity_erase', `app.identity.erase.${doName}.${receiptId}`, { p_do_name: doName, p_receipt_id: receiptId }));
    if (!result.success || result.data.receipt_id !== receiptId) throw new RightsError('unavailable');
    return result.data;
  } };
};
