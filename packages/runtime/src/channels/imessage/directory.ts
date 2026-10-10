import { signedRpc, type OwnerDirectoryEnv } from '../../identity/owner-directory';
import { sha256Hex } from './crypto';

// Router-signed client for the waldo.imessage_* functions. Each call signs
// `imsg.<op>.<sha256(locator)>` where the locator is the JSON array of the exact arguments,
// and the database re-derives the array from its parameters before trusting the signature.

export type BridgeAuthorityState = 'pending' | 'active' | 'revoked' | 'owner_inactive' | 'expired';
export type BridgeAuthority = Readonly<{
  state: BridgeAuthorityState; bridgeId: string; accountId: string; ownerId: string; doName: string;
  wrappedCredential: string; credentialEpoch: number; revision: string;
  presenceId: string | null; subject: string | null; chatGuid: string | null;
  challengeHash: string | null; expectedSubject: string | null; expectedChatGuid: string | null;
}>;
export type BridgeListing = Readonly<{
  bridge_id: string; account_id: string; state: string; subject: string | null; chat_guid: string | null;
  observed: boolean; host_version: string; created_at: string; activated_at: string | null; revoked_at: string | null;
}>;

export class IMessageDirectoryUnavailable extends Error { constructor() { super('imessage_directory_unavailable'); } }

const str = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
const nullable = (v: unknown): string | null => (typeof v === 'string' && v.length ? v : null);

const parseAuthority = (raw: unknown): BridgeAuthority | null => {
  if (raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new IMessageDirectoryUnavailable();
  const r = raw as Record<string, unknown>;
  if (!['pending', 'active', 'revoked', 'owner_inactive', 'expired'].includes(String(r.state)) || !str(r.bridge_id) || !str(r.account_id)
    || !str(r.owner_id) || !str(r.do_name) || !str(r.wrapped_credential) || !str(r.revision) || typeof r.credential_epoch !== 'number') throw new IMessageDirectoryUnavailable();
  return Object.freeze({
    state: r.state as BridgeAuthorityState, bridgeId: r.bridge_id, accountId: r.account_id, ownerId: r.owner_id, doName: r.do_name,
    wrappedCredential: r.wrapped_credential, credentialEpoch: r.credential_epoch, revision: r.revision,
    presenceId: nullable(r.presence_id), subject: nullable(r.subject), chatGuid: nullable(r.chat_guid),
    challengeHash: nullable(r.challenge_hash), expectedSubject: nullable(r.expected_subject), expectedChatGuid: nullable(r.expected_chat_guid),
  });
};

export const iMessageDirectory = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()) => {
  const rpc = signedRpc(env, fetcher, now);
  const call = async (fn: string, op: string, params: Record<string, string | number>): Promise<unknown> => {
    if (!rpc) throw new IMessageDirectoryUnavailable();
    const locator = JSON.stringify(Object.values(params));
    try { return await rpc(fn, `imsg.${op}.${await sha256Hex(locator)}`, { ...params, p_locator: locator }); }
    catch { throw new IMessageDirectoryUnavailable(); }
  };
  const bool = (value: unknown) => value === true;
  return {
    throttle: async (key: string, limit: number, windowSeconds: number) =>
      bool(await call('imessage_throttle', 'throttle', { p_key: key, p_limit: limit, p_window_seconds: windowSeconds })),
    issueInvitation: async (doName: string, environment: string, codeHash: string, lifetimeSeconds: number) =>
      bool(await call('imessage_issue_invitation', 'invite', { p_do_name: doName, p_environment: environment, p_code_hash: codeHash, p_lifetime_seconds: lifetimeSeconds })),
    async redeemInvitation(input: { codeHash: string; environment: string; bridgeId: string; accountId: string; wrappedCredential: string; hostVersion: string; transportVersion: string; generation: string; pendingSeconds: number }) {
      const r = await call('imessage_redeem_invitation', 'redeem', { p_code_hash: input.codeHash, p_environment: input.environment, p_bridge_id: input.bridgeId,
        p_account_id: input.accountId, p_wrapped_credential: input.wrappedCredential, p_host_version: input.hostVersion, p_transport_version: input.transportVersion, p_generation: input.generation, p_pending_seconds: input.pendingSeconds });
      if (r === null) return null;
      const row = r as Record<string, unknown>;
      return str(row.bridge_id) && str(row.account_id) && str(row.do_name) && row.bridge_id === input.bridgeId && row.account_id === input.accountId && typeof row.expires_at_ms === 'number' ? { doName: row.do_name, expiresAtMs: row.expires_at_ms } : null;
    },
    authority: async (environment: string, bridgeId: string, accountId: string) =>
      parseAuthority(await call('imessage_bridge_authority', 'authority', { p_environment: environment, p_bridge_id: bridgeId, p_account_id: accountId })),
    setExpectedScope: async (doName: string, bridgeId: string, subject: string, chatGuid: string, challengeHash: string, lifetimeSeconds: number) =>
      bool(await call('imessage_set_expected_scope', 'scope', { p_do_name: doName, p_bridge_id: bridgeId, p_subject: subject, p_chat_guid: chatGuid, p_challenge_hash: challengeHash, p_lifetime_seconds: lifetimeSeconds })),
    recordChallenge: async (input: { environment: string; bridgeId: string; accountId: string; challengeHash: string; subject: string; chatGuid: string; generation: string; eventId: string; digest: string }) =>
      bool(await call('imessage_record_challenge', 'challenge', { p_environment: input.environment, p_bridge_id: input.bridgeId, p_account_id: input.accountId, p_challenge_hash: input.challengeHash,
        p_subject: input.subject, p_chat_guid: input.chatGuid, p_generation: input.generation, p_event_id: input.eventId, p_event_digest: input.digest })),
    async activate(doName: string, bridgeId: string, subject: string, chatGuid: string) {
      const r = await call('imessage_activate', 'activate', { p_do_name: doName, p_bridge_id: bridgeId, p_subject: subject, p_chat_guid: chatGuid });
      return r !== null && typeof r === 'object' && (r as Record<string, unknown>).bridge_id === bridgeId;
    },
    revoke: async (doName: string, bridgeId: string) => bool(await call('imessage_revoke', 'revoke', { p_do_name: doName, p_bridge_id: bridgeId })),
    async list(doName: string): Promise<BridgeListing[]> {
      const r = await call('imessage_list', 'list', { p_do_name: doName });
      if (!Array.isArray(r)) throw new IMessageDirectoryUnavailable();
      return r as BridgeListing[];
    },
  };
};
export type IMessageDirectory = ReturnType<typeof iMessageDirectory>;
