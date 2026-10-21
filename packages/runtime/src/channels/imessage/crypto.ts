// Workers WebCrypto implementation of the S2 relay signature and the new pull commitment.
// Byte-for-byte compatible with packages/imessage-relay/src/relay.ts signRelayRequest.

export const HTTP_PROFILE = 'waldo-imessage-http-v1';

export type S2Fields = Readonly<{ version: 1; bridgeId: string; accountId: string; atMs: number; nonce: string }>;
export type S2Headers = S2Fields & Readonly<{ signature: string }>;

const encoder = new TextEncoder();
export const toHex = (bytes: ArrayBuffer | Uint8Array): string =>
  [...(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

export const sha256Hex = async (text: string): Promise<string> =>
  toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));

const hmacKey = (key: string) =>
  crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);

export const hmacHex = async (key: string, message: Uint8Array): Promise<string> =>
  toHex(await crypto.subtle.sign('HMAC', await hmacKey(key), message));

/** S2: JSON.stringify([version,bridgeId,accountId,atMs,nonce]) + "\n" + raw UTF-8 body. */
export const s2SignedBytes = (body: string, h: S2Fields): Uint8Array => {
  const head = encoder.encode(JSON.stringify([h.version, h.bridgeId, h.accountId, h.atMs, h.nonce]) + '\n');
  const raw = encoder.encode(body);
  const out = new Uint8Array(head.length + raw.length);
  out.set(head, 0); out.set(raw, head.length);
  return out;
};

export const signS2 = async (body: string, h: S2Fields, key: string): Promise<S2Headers> => ({
  version: h.version, bridgeId: h.bridgeId, accountId: h.accountId, atMs: h.atMs, nonce: h.nonce,
  signature: await hmacHex(key, s2SignedBytes(body, h)),
});

/** Constant-time over equal-length lowercase hex; length mismatch is a plain refusal. */
export const timingSafeHexEqual = (a: string, b: string): boolean => {
  if (a.length !== b.length || !/^[a-f0-9]*$/.test(a) || !/^[a-f0-9]*$/.test(b)) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

export const verifyS2 = async (body: string, h: S2Headers, key: string): Promise<boolean> =>
  timingSafeHexEqual((await signS2(body, h, key)).signature, h.signature);

export type CommitmentFields = Readonly<{
  bridgeId: string; accountId: string; deliveryId: string; commandId: string; commandDigest: string; expiresAtMs: number;
}>;
export type Commitment = Readonly<{ version: 1; commandDigest: string; expiresAtMs: number; signature: string }>;

/** Exact signed input for the pull commitment; the host verifies these bytes before any native effect. */
export const commitmentSignedText = (c: CommitmentFields): string =>
  JSON.stringify([`${HTTP_PROFILE}:commitment`, 1, c.bridgeId, c.accountId, c.deliveryId, c.commandId, c.commandDigest, c.expiresAtMs]);

export const signCommitment = async (c: CommitmentFields, key: string): Promise<Commitment> => ({
  version: 1, commandDigest: c.commandDigest, expiresAtMs: c.expiresAtMs,
  signature: await hmacHex(key, encoder.encode(commitmentSignedText(c))),
});

export const verifyCommitment = async (c: CommitmentFields, signature: string, key: string): Promise<boolean> =>
  timingSafeHexEqual(await hmacHex(key, encoder.encode(commitmentSignedText(c))), signature);

/** 32 random bytes as lowercase hex; its UTF-8 string bytes are the S2 HMAC key (reference semantics). */
export const mintHostKey = (): string => toHex(crypto.getRandomValues(new Uint8Array(32)));

// Credential wrapping: AES-GCM under a separately configured server key, with associated data
// binding environment/bridge/account/revision so a ciphertext cannot be replayed into another scope.
const wrapKey = async (wrappingKeyHex: string): Promise<CryptoKey> => {
  if (!/^[a-f0-9]{64}$/.test(wrappingKeyHex)) throw new Error('imessage_wrapping_key_invalid');
  const raw = new Uint8Array(wrappingKeyHex.match(/../g)!.map((b) => parseInt(b, 16)));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
};
export type CredentialScope = Readonly<{ environment: string; bridgeId: string; accountId: string; revision: string }>;
const associatedData = (s: CredentialScope) => encoder.encode(JSON.stringify([`${HTTP_PROFILE}:credential`, s.environment, s.bridgeId, s.accountId, s.revision]));

export const wrapCredential = async (hostKey: string, scope: CredentialScope, wrappingKeyHex: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associatedData(scope) }, await wrapKey(wrappingKeyHex), encoder.encode(hostKey));
  return `v1.${toHex(iv)}.${toHex(sealed)}`;
};

export const unwrapCredential = async (wrapped: string, scope: CredentialScope, wrappingKeyHex: string): Promise<string | null> => {
  const match = /^v1\.([a-f0-9]{24})\.([a-f0-9]+)$/.exec(wrapped);
  if (!match) return null;
  const bytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((b) => parseInt(b, 16)));
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(match[1]!), additionalData: associatedData(scope) }, await wrapKey(wrappingKeyHex), bytes(match[2]!));
    const key = new TextDecoder().decode(plain);
    return /^[a-f0-9]{64}$/.test(key) ? key : null;
  } catch { return null; }
};

/** High-entropy one-use setup secrets (invitations, challenges). Never logged. */
export const mintSetupSecret = (prefix: 'wim' | 'wic'): string => `${prefix}_${toHex(crypto.getRandomValues(new Uint8Array(24)))}`;
