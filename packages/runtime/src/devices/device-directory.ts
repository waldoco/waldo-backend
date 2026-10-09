import { signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { sha256Hex } from './signing';
import { capabilities, identifier, record, type RedeemBody } from './wire';
import { REDEEM_THROTTLES, type Capability } from './contract';
export type DeviceAuth = { owner_id: string; pubkey: string; capabilities: Capability[] };
export type ListedDevice = { device_id: string; label: string; capabilities: string; created_at: string; last_seen_at: string | null };
export const deviceDirectory = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch) => {
  const rpc = signedRpc(env, fetcher);
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    if (!rpc) throw new Error('infrastructure_unavailable');
    return rpc(fn, message, args);
  };
  return {
    issuePairingCode: async (owner: string, digest: string): Promise<boolean> => await call('issue_device_pairing_code', `devpair.${owner}.${digest}`, { p_do_name: owner, p_code_hash: digest }) === true,
    async throttle(ip: string, digest: string): Promise<boolean> {
      const hash = await sha256Hex(new TextEncoder().encode(ip));
      // Independent durable windows prevent worker restarts or mixed bucket cleanup bypassing caps.
      for (const { prefix, limit, seconds } of REDEEM_THROTTLES) {
        const key = `${prefix}.${prefix === 'devredeem.code' ? digest : hash}`;
        const result = await call('device_bridge_throttle', `devthrottle.${key}.${limit}.${seconds}`, { p_key: key, p_limit: limit, p_window_seconds: seconds });
        if (result !== true) return false;
      }
      return true;
    },
    async redeemPairing(body: RedeemBody, digest: string): Promise<{ device_id: string; owner_id: string } | null> {
      const labelHex = [...new TextEncoder().encode(body.label)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
      const caps = body.declared_capabilities.join(',');
      const result = await call('redeem_device_pairing', `devredeem.${digest}.${body.device_pubkey}.${labelHex}.${caps}`, { p_code_hash: digest, p_pubkey: body.device_pubkey, p_label: body.label, p_capabilities: caps });
      const row = Array.isArray(result) && result.length === 1 ? result[0] : null;
      return record(row) && identifier(row.device_id) && identifier(row.owner_id) ? { device_id: row.device_id, owner_id: row.owner_id } : null;
    },
    async deviceForAuth(device: string): Promise<DeviceAuth | null> {
      const result = await call('device_for_auth', `devauth.${device}`, { p_device_id: device });
      const row = Array.isArray(result) && result.length === 1 ? result[0] : null;
      const caps = record(row) && typeof row.capabilities === 'string' ? capabilities(row.capabilities.split(',')) : null;
      return record(row) && identifier(row.owner_id) && typeof row.pubkey === 'string' && caps ? { owner_id: row.owner_id, pubkey: row.pubkey, capabilities: caps } : null;
    },
    touchDevice: async (device: string): Promise<boolean> => await call('device_touch', `devtouch.${device}`, { p_device_id: device }) === true,
    async listDevices(owner: string): Promise<ListedDevice[]> {
      const result = await call('list_devices', `devlist.${owner}`, { p_do_name: owner });
      if (!Array.isArray(result)) throw new Error('infrastructure_unavailable');
      return result as ListedDevice[];
    },
    revokeDevice: async (owner: string, device: string): Promise<boolean> => await call('revoke_device', `devrevoke.${owner}.${device}`, { p_do_name: owner, p_device_id: device }) === true,
  };
};
