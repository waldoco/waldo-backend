import { z } from 'zod';
import { appDeviceV1Schema, type AppDeviceRegisterV1, type AppDeviceRevokeV1, type AppDeviceV1 } from '../../../contracts/src/app/rights';
import { signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { rightsDigest } from './capability';
import { RightsError } from './jobs';

export type AppPushDirectory = {
  list(): Promise<AppDeviceV1[]>;
  register(args: AppDeviceRegisterV1): Promise<{ device: AppDeviceV1; result: 'registered' | 'already_recorded' }>;
  revoke(args: AppDeviceRevokeV1): Promise<{ device: AppDeviceV1; result: 'revoked' | 'already_recorded' }>;
  revokeSession(sessionHash: string): Promise<number>;
  revokeAll(): Promise<number>;
};
const mutationSchema = z.strictObject({ device: appDeviceV1Schema, result: z.enum(['registered', 'revoked', 'already_recorded']) });
// Tokens stay in the existing Supabase Vault. Neither the owner DO nor list/export
// DTOs carry a token, and every mutation proves a live directory session.
export const appPushDirectory = (env: OwnerDirectoryEnv, doName: string, sessionHash: string, fetcher: typeof fetch = fetch): AppPushDirectory => {
  const rpc = signedRpc(env, fetcher);
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    if (!rpc) throw new RightsError('unavailable');
    const result = await rpc(fn, message, args);
    if (result === null) throw new RightsError('conflict');
    return result;
  };
  return {
    async list() { return z.array(appDeviceV1Schema).parse(await call('app_push_list', `app.push.list.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash })); },
    async register(args) {
      const tokenHash = await rightsDigest(args.token);
      const signature = `app.push.register.${doName}.${sessionHash}.${args.installation_id}.${args.provider}.${args.environment}.${args.expected_device_epoch}.${args.operation_id}.${tokenHash}`;
      const out = mutationSchema.parse(await call('app_push_register', signature, { p_do_name: doName, p_session_hash: sessionHash, p_installation_id: args.installation_id, p_provider: args.provider, p_environment: args.environment, p_expected_epoch: args.expected_device_epoch, p_operation_id: args.operation_id, p_token: args.token }));
      if (out.result === 'revoked' || out.device.installation_id !== args.installation_id || out.device.provider !== args.provider || out.device.environment !== args.environment || out.device.device_epoch !== args.expected_device_epoch + 1 || out.device.state !== 'active') throw new RightsError('unavailable'); return { device: out.device, result: out.result };
    },
    async revoke(args) {
      const signature = `app.push.revoke.${doName}.${sessionHash}.${args.installation_id}.${args.expected_device_epoch}.${args.operation_id}`;
      const out = mutationSchema.parse(await call('app_push_revoke', signature, { p_do_name: doName, p_session_hash: sessionHash, p_installation_id: args.installation_id, p_expected_epoch: args.expected_device_epoch, p_operation_id: args.operation_id }));
      if (out.result === 'registered' || out.device.installation_id !== args.installation_id || out.device.device_epoch !== args.expected_device_epoch + 1 || out.device.state !== 'revoked') throw new RightsError('unavailable'); return { device: out.device, result: out.result };
    },
    async revokeSession(session) {
      const out = await call('app_push_revoke_session', `app.push.revoke-session.${doName}.${session}`, { p_do_name: doName, p_session_hash: session });
      if (!Number.isSafeInteger(out) || Number(out) < 0) throw new RightsError('unavailable'); return Number(out);
    },
    async revokeAll() {
      const out = await call('app_push_revoke_all', `app.push.revoke-all.${doName}`, { p_do_name: doName });
      if (!Number.isSafeInteger(out) || Number(out) < 0) throw new RightsError('unavailable'); return Number(out);
    },
  };
};

// Push wakes the authenticated inbox. Body, owner ID, health state, artifact URLs,
// and approval payloads must never leave through the native notification payload.
export type AppPushHint = Readonly<{ version: 'push.v1'; kind: 'inbox_changed'; collapse_key: 'waldo_inbox'; destination: '/chat'; delivery: 'provider_accepted' | 'unconfirmed' }>;
export const appPushHint = (): Omit<AppPushHint, 'delivery'> => ({ version: 'push.v1', kind: 'inbox_changed', collapse_key: 'waldo_inbox', destination: '/chat' });
