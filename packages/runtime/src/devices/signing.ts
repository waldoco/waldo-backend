const encode = new TextEncoder();

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function httpSignatureBase(timestamp: string, nonce: string, method: string, path: string, bodyDigest: string): string {
  return [timestamp, nonce, method, path, bodyDigest].join('\n');
}

export function decodeBase64url(value: string, byteLength: number): Uint8Array | null {
  // Exact canonical encoding prevents alternate spellings of authenticated key/signature bytes.
  if (value.length !== Math.ceil(byteLength * 8 / 6) || !/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - value.length % 4) % 4));
  const bytes = Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  const encoded = btoa(decoded).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return bytes.length === byteLength && encoded === value ? bytes : null;
}

export const base64url = (bytes: Uint8Array): string => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const frameSignatureBase = (timestamp: number, type: string, messageId: string, nonce: string, digest: string): string => [timestamp, type, messageId, nonce, digest].join('\n');

export async function verifyEd25519(publicKey: string, signature: string, message: string): Promise<boolean> {
  const keyBytes = decodeBase64url(publicKey, KEY_BYTES);
  const signatureBytes = decodeBase64url(signature, SIGNATURE_BYTES);
  if (!keyBytes || !signatureBytes) return false;
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'Ed25519' }, false, ['verify']);
  return crypto.subtle.verify('Ed25519', key, signatureBytes, encode.encode(message));
}
import { KEY_BYTES, SIGNATURE_BYTES } from './contract';
