import { z } from 'zod';

const claimSchema = z.strictObject({ version: z.literal(1), owner: z.string().min(1).max(256), receipt: z.string().uuid(), kind: z.enum(['submit', 'status']), nonce: z.string().regex(/^[a-f0-9]{64}$/), expires: z.int().nonnegative() });
export type RightsCapabilityClaim = z.infer<typeof claimSchema>;
const bytes = (value: string) => new TextEncoder().encode(value);
const encode = (value: Uint8Array) => btoa(String.fromCharCode(...value)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const decode = (value: string) => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0));
const keyFor = async (secret: string) => {
  if (secret.length < 32) throw new Error('rights_unavailable');
  const base = await crypto.subtle.importKey('raw', bytes(secret), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: bytes('waldo-app-rights-v1'), info: bytes('opaque-owner-routing-capability') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
};
export const rightsDigest = async (value: string) => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes(value)))].map(v => v.toString(16).padStart(2, '0')).join('');
// Authenticated encryption keeps directory identity hidden. These capabilities authorize
// only one deletion submission or metadata-only receipt status, never owner reads.
export const mintRightsCapability = async (secret: string, claim: RightsCapabilityClaim): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = bytes(JSON.stringify(claimSchema.parse(claim)));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: bytes('rights_v1') }, await keyFor(secret), body);
  return `rights_v1.${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
};
export const readRightsCapability = async (secret: string, token: string, kind: RightsCapabilityClaim['kind'], now: number): Promise<RightsCapabilityClaim | null> => {
  if (!/^rights_v1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]{40,2048}$/.test(token)) return null;
  try {
    const [, iv, encrypted] = token.split('.');
    const value = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(iv!), additionalData: bytes('rights_v1') }, await keyFor(secret), decode(encrypted!));
    const claim = claimSchema.parse(JSON.parse(new TextDecoder().decode(value)));
    return claim.kind === kind && claim.expires > now ? claim : null;
  } catch { return null; } // Invalid ciphertext/claims are an expected untrusted-input refusal.
};
