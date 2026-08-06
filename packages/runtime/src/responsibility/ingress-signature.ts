import type { ResponsibilityIngressContext } from './worker-adapter';

export type ResponsibilityIngressOperation = 'capture' | 'projection';

export function canonicalizeResponsibilityProjectionIngressForDigest(input: Readonly<{
  protocolVersion?: '0.1' | '0.2';
  fromExclusiveCursor: number;
  limit: number;
  snapshotId?: string;
}>): string {
  return JSON.stringify([
    input.protocolVersion ?? '0.2',
    input.fromExclusiveCursor,
    input.limit,
    input.snapshotId ?? null,
  ]);
}

export type SignedResponsibilityIngressContext = ResponsibilityIngressContext & Readonly<{
  ownerId: string;
  presenceId: string;
  presenceRegistrationId: string;
  ownerRootRoutingVersion: number;
  operation: ResponsibilityIngressOperation;
  requestDigest: `sha256:${string}`;
  operationDigest: `sha256:${string}`;
  issuedAt: number;
  signature: `hmac-sha256:${string}`;
}>;

export async function signResponsibilityIngress(input: Readonly<{
  context: ResponsibilityIngressContext & Readonly<{
    ownerId: string;
    presenceId: string;
    presenceRegistrationId: string;
    ownerRootRoutingVersion: number;
  }>;
  operation: ResponsibilityIngressOperation;
  requestDigest: `sha256:${string}`;
  operationDigest: `sha256:${string}`;
  issuedAt: number;
  secret: string;
}>): Promise<SignedResponsibilityIngressContext> {
  const unsigned = Object.freeze({
    ...input.context,
    operation: input.operation,
    requestDigest: input.requestDigest,
    operationDigest: input.operationDigest,
    issuedAt: input.issuedAt,
  });
  const signature = await hmac(input.secret, canonical(unsigned));
  return Object.freeze({ ...unsigned, signature: `hmac-sha256:${signature}` });
}

export async function verifyResponsibilityIngress(
  input: SignedResponsibilityIngressContext,
  secret: string,
): Promise<boolean> {
  if (!/^hmac-sha256:[a-f0-9]{64}$/.test(input.signature)) return false;
  const { signature, ...unsigned } = input;
  const key = await importHmacKey(secret, ['verify']);
  return crypto.subtle.verify(
    'HMAC',
    key,
    hexBytes(signature.slice('hmac-sha256:'.length)),
    new TextEncoder().encode(canonical(unsigned)),
  );
}

function canonical(input: Omit<SignedResponsibilityIngressContext, 'signature'>): string {
  return JSON.stringify([
    'responsibility-worker-ingress-v1',
    input.operation,
    input.ownerId,
    input.authenticatedSubjectRef,
    input.presenceId,
    input.presenceRegistrationId,
    input.authenticatedSessionId,
    input.authenticatedSessionExpiresAt,
    input.ownerPolicyRevision,
    input.ownerRootRoutingVersion,
    input.requestDigest,
    input.operationDigest,
    input.issuedAt,
  ]);
}

async function hmac(secret: string, value: string): Promise<string> {
  const key = await importHmacKey(secret, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function importHmacKey(secret: string, usages: Array<'sign' | 'verify'>): Promise<CryptoKey> {
  if (secret.length < 32) throw new Error('responsibility ingress signing is unconfigured');
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    usages,
  );
}

function hexBytes(value: string): Uint8Array {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid ingress signature');
  return Uint8Array.from(value.match(/../g)!, (pair) => Number.parseInt(pair, 16));
}
