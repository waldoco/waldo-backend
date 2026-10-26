import { routerSignature } from './owner-directory';

// A small JSON value the runtime hands a client and later takes back unchanged: readable, not encrypted, signed with the
// router secret under its own purpose so a value sealed for one use is never accepted for another. Every sealed value
// carries `expires` (epoch seconds), and one past it, or further out than maxSeconds, does not open.
const toBase64Url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export const sealValue = async (secret: string, purpose: string, value: Readonly<Record<string, unknown>>): Promise<string> => {
  const payload = toBase64Url(new TextEncoder().encode(JSON.stringify(value)));
  return `${payload}.${await routerSignature(secret, 0, `${purpose}.${payload}`)}`;
};

export const openValue = async (secret: string, purpose: string, raw: string | null | undefined, now: number, maxSeconds: number): Promise<Readonly<Record<string, unknown>> | null> => {
  const [payload, signature, extra] = raw && raw.length <= 2048 ? raw.split('.') : [];
  if (!payload || !signature || extra !== undefined) return null;
  const expected = await routerSignature(secret, 0, `${purpose}.${payload}`);
  let diff = expected.length ^ signature.length;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ signature.charCodeAt(i);
  if (diff !== 0) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(payload.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)))); }
  catch { return null; } // A signed payload sealValue wrote always parses.
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { expires } = value as { expires?: unknown };
  const seconds = Math.floor(now / 1000);
  return typeof expires === 'number' && expires > seconds && expires <= seconds + maxSeconds ? value as Record<string, unknown> : null;
};
