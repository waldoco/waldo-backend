import { signedRpc, type OwnerDirectoryEnv } from './owner-directory';

export class AppSessionAuthorityError extends Error {
  constructor(readonly kind: 'revoked' | 'unavailable' | 'rejected') { super(`app session ${kind}`); }
}

export type AppSessionAuthority = Readonly<{ ownerId: string; doName: string; sessionHash: string; revision: string; expires: number }>;
// The signed directory read reuses the existing owner/session row. A header, app
// account_ref or model argument is never an owner witness.
export const appSessionAuthority = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch) => {
  const call = signedRpc(env, fetcher);
  return async (doName: string, hash: string): Promise<AppSessionAuthority> => {
    if (!call || !doName || doName.length > 240 || !/^[a-f0-9]{64}$/.test(hash)) throw new AppSessionAuthorityError('unavailable');
    let raw: unknown;
    try { raw = await call('app_session_authority', `app.session.${doName}.${hash}`, { p_do_name: doName, p_session_hash: hash }); }
    catch { throw new AppSessionAuthorityError('unavailable'); }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new AppSessionAuthorityError('revoked');
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'admission_revision,do_name,expires_at,owner_id,session_hash,state_version'
      || typeof row.owner_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.owner_id)
      || row.do_name !== doName || row.session_hash !== hash || typeof row.expires_at !== 'number' || !Number.isFinite(row.expires_at) || row.expires_at <= Date.now()
      || typeof row.state_version !== 'number' || !Number.isSafeInteger(row.state_version) || row.state_version < 0
      || typeof row.admission_revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(row.admission_revision)) throw new AppSessionAuthorityError('rejected');
    return Object.freeze({ ownerId: row.owner_id.toLowerCase(), doName, sessionHash: hash, revision: `${row.state_version}:${row.admission_revision}`, expires: row.expires_at });
  };
};
