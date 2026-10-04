import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import type { DeviceBridgeDO } from './device-bridge-do';
import { genericReject, deviceDiagnostic } from './generic-reject';
import { connectDeclaration, identifier } from './wire';
import { CONNECT_RATE_KEY_PREFIX } from './contract';
import { deviceDirectory } from './device-directory';
import { httpSigningFields } from './redeem-route';
import { httpSignatureBase, sha256Hex, verifyEd25519 } from './signing';
export type DeviceBridgeEnv = OwnerDirectoryEnv & { DEVICE_BRIDGE_DO?: DurableObjectNamespace<DeviceBridgeDO>; RESPONSIBILITY_RATE_LIMITER?: RateLimit };
export async function handleDeviceConnect(request: Request, env: DeviceBridgeEnv): Promise<Response> {
  const device = request.headers.get('x-waldo-device-id');
  if (request.method !== 'GET' || !identifier(device) || !env.DEVICE_BRIDGE_DO) return genericReject();
  try {
    // Anonymous IDs must not allocate durable storage before bounded, authenticated admission.
    if (!env.RESPONSIBILITY_RATE_LIMITER) return genericReject();
    const ip = await sha256Hex(new TextEncoder().encode(request.headers.get('cf-connecting-ip') ?? 'local'));
    const budget = await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `${CONNECT_RATE_KEY_PREFIX}.${ip}` });
    if (!budget.success) return genericReject();
    const url = new URL(request.url), path = url.pathname + url.search, declared = connectDeclaration(path), fields = httpSigningFields(request);
    if (request.body || request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !declared || !fields) return genericReject();
    const auth = await deviceDirectory(env).deviceForAuth(device);
    if (!auth || declared.some((capability) => !auth.capabilities.includes(capability)) || !await verifyEd25519(auth.pubkey, fields.signature, httpSignatureBase(fields.timestamp, fields.nonce, 'GET', path, await sha256Hex(new Uint8Array())))) return genericReject();
    return await env.DEVICE_BRIDGE_DO.get(env.DEVICE_BRIDGE_DO.idFromName(device)).fetch(request);
  }
  catch { deviceDiagnostic('infrastructure_unavailable'); return genericReject(); }
}
