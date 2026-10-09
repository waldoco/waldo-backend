import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { CLOCK_SKEW_SECONDS, CONTRACT_VERSION, REDEEM_BYTES, NONCE_BYTES, SIGNATURE_BYTES, TIMESTAMP_MAX } from './contract';
import { parseStrictJson } from './canonical-json';
import { deviceDirectory } from './device-directory';
import { deviceDiagnostic, genericReject } from './generic-reject';
import { devicePairingCodeHash } from './pairing-code';
import { decodeBase64url, httpSignatureBase, sha256Hex, verifyEd25519 } from './signing';
import { redeemBody } from './wire';
export const httpSigningFields = (request: Request): { timestamp: string; nonce: string; signature: string } | null => {
  const timestamp = request.headers.get('x-waldo-timestamp') ?? '', nonce = request.headers.get('x-waldo-nonce') ?? '', signature = request.headers.get('x-waldo-signature') ?? '';
  if (!/^[1-9][0-9]*$/.test(timestamp) || Number(timestamp) > TIMESTAMP_MAX || !decodeBase64url(nonce, NONCE_BYTES) || !decodeBase64url(signature, SIGNATURE_BYTES) || Math.abs(Math.floor(Date.now() / 1000) - Number(timestamp)) > CLOCK_SKEW_SECONDS) return null;
  return { timestamp, nonce, signature };
};
export async function handleDeviceRedeem(request: Request, env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch): Promise<Response> {
  try {
    if (request.method !== 'POST' || new URL(request.url).search !== '' || request.headers.has('x-waldo-device-id')) return genericReject();
    const reader = request.body?.getReader();
    if (!reader) return genericReject();
    const chunks: Uint8Array[] = []; let size = 0;
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > REDEEM_BYTES) { await reader.cancel(); return genericReject(); } chunks.push(value); }
    const raw = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { raw.set(chunk, offset); offset += chunk.length; }
    const body = redeemBody(parseStrictJson(raw));
    if (!body) return genericReject();
    const directory = deviceDirectory(env, fetcher), digest = await devicePairingCodeHash(body.code);
    if (!await directory.throttle(request.headers.get('cf-connecting-ip') ?? 'local', digest)) return genericReject();
    const fields = httpSigningFields(request);
    if (!fields || !await verifyEd25519(body.device_pubkey, fields.signature, httpSignatureBase(fields.timestamp, fields.nonce, 'POST', '/devices/redeem', await sha256Hex(raw)))) return genericReject();
    const result = await directory.redeemPairing(body, digest);
    return result ? Response.json({ ...result, accepted_contract_version: CONTRACT_VERSION }) : genericReject();
  } catch {
    // Infrastructure and malformed inputs share a fail-closed pre-auth boundary without payload logs.
    deviceDiagnostic('infrastructure_unavailable'); return genericReject();
  }
}
