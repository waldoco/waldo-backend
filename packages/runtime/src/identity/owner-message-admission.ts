import { acceptTrustedInvocation, type TrustedInvocationEnvelope } from '@waldo/contracts';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { ResolvedInvocationInput } from '../context-composer/types';

type PresenceBinding = Readonly<{
  owner_id: string; do_name: string; state_version: number; admission_revision: string;
  presence_id: string; provider: 'telegram'; subject: string;
}>;
type Locator = Readonly<{ environment: string; namespace: string; doName: string; doId: string }>;
type Options = Readonly<{
  // Private authenticated host capability. A message or model cannot supply this lookup.
  lookup(provider: 'telegram', subject: string): Promise<unknown>;
  scope: RunEffectScope;
  locator: Locator;
  actualDoId: string;
  expectedDoId(doName: string): string;
  allowedDoNames: readonly string[];
  provider: 'telegram'; subject: string; text: string;
  occurrenceKey: string; occurredAt: number; now(): number;
}>;
export type OwnerMessageAdmission = Readonly<{
  invocation: TrustedInvocationEnvelope;
  snapshot: Readonly<{ snapshot_ref: string; snapshot_at: number }>;
  assertCurrent(): Promise<void>;
  readInput(): Promise<ResolvedInvocationInput>;
}>;

export class OwnerAdmissionError extends Error {
  constructor(readonly code: 'rejected' | 'unavailable') { super(`owner admission ${code}`); }
}
const digest = async (text: string): Promise<string> =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map(b => b.toString(16).padStart(2, '0')).join('');
const ref = () => crypto.randomUUID().replaceAll('-', '');
const freezeEnvelope = (value: TrustedInvocationEnvelope): TrustedInvocationEnvelope => {
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return;
    for (const child of Object.values(item)) freeze(child);
    Object.freeze(item);
  };
  freeze(value);
  return value;
};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const binding = (value: unknown): PresenceBinding => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new OwnerAdmissionError('rejected');
  const r = value as Record<string, unknown>;
  if (Object.getPrototypeOf(r) !== Object.prototype || Object.getOwnPropertySymbols(r).length
    || Object.values(Object.getOwnPropertyDescriptors(r)).some(d => !('value' in d))
    || Object.getOwnPropertyNames(r).sort().join(',') !== 'admission_revision,do_name,owner_id,presence_id,provider,state_version,subject'
    || typeof r.owner_id !== 'string' || !uuid.test(r.owner_id) || typeof r.presence_id !== 'string' || !uuid.test(r.presence_id)
    || typeof r.do_name !== 'string' || !r.do_name || r.provider !== 'telegram' || typeof r.subject !== 'string' || !/^\d+$/.test(r.subject)
    || typeof r.admission_revision !== 'string' || !/^[1-9][0-9]{0,18}$/.test(r.admission_revision) || BigInt(r.admission_revision) > 9223372036854775807n
    || typeof r.state_version !== 'number' || !Number.isSafeInteger(r.state_version) || r.state_version < 0) throw new OwnerAdmissionError('rejected');
  return Object.freeze({ owner_id: r.owner_id.toLowerCase(), do_name: r.do_name, state_version: r.state_version, admission_revision: r.admission_revision,
    presence_id: r.presence_id.toLowerCase(), provider: r.provider, subject: r.subject });
};

// Builds admission only; callers still own ingress authentication, capability ACL and storage.
export async function ownerMessageAdmission(options: Options): Promise<OwnerMessageAdmission> {
  const { scope, lookup, expectedDoId, now } = options;
  const locator = Object.freeze({ ...options.locator });
  const { provider, subject, text, occurrenceKey, occurredAt, actualDoId } = options;
  const allowed = [...options.allowedDoNames];
  scope.admit();
  const acceptedAt = now();
  if (locator.environment !== 'staging' || !locator.namespace || !locator.doName || !locator.doId
    || actualDoId !== locator.doId || expectedDoId(locator.doName) !== actualDoId || !allowed.includes(locator.doName)
    || provider !== 'telegram' || !/^\d{1,32}$/.test(subject) || !text || text.length > 8_192 || !occurrenceKey || occurrenceKey.length > 512
    || !Number.isSafeInteger(acceptedAt) || !Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > acceptedAt) throw new OwnerAdmissionError('rejected');
  const resolve = async (): Promise<PresenceBinding> => {
    scope.admit();
    let value: unknown;
    try { value = await lookup(provider, subject); }
    catch { scope.admit(); throw new OwnerAdmissionError('unavailable'); }
    scope.admit();
    const result = binding(value);
    if (result.do_name !== locator.doName || result.provider !== provider || result.subject !== subject
      || expectedDoId(locator.doName) !== actualDoId) throw new OwnerAdmissionError('rejected');
    return result;
  };
  const initial = await resolve();
  const ownerHex = initial.owner_id.replaceAll('-', '').toLowerCase();
  // Non-secret stable evidence identifier; current lookup remains the authority check.
  const verification = await digest(`owner-verification:v1:${initial.owner_id}:${initial.admission_revision}`);
  const contentDigest = `sha256:${await digest(text)}`;
  const occurrence = await digest(JSON.stringify([locator.environment, locator.namespace, locator.doName, initial.owner_id, provider, subject, occurrenceKey]));
  scope.admit();
  const accepted = acceptTrustedInvocation({
    admission_source: 'authenticated_ingress',
    verified_authority: { principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, verification_ref: `ver_${verification.slice(0, 32)}` },
    input_refs: [{ input_ref: `inp_${occurrence.slice(0, 32)}`, content_digest: contentDigest }],
    intent: { kind: 'respond_to_user' },
    occurrence: { occurrence_ref: `occ_${occurrence.slice(0, 32)}`, occurred_at: occurredAt },
    idempotency_ref: `idem_${occurrence.slice(0, 32)}`, accepted_at: acceptedAt,
  });
  if (!accepted.ok) throw new OwnerAdmissionError('rejected');
  const invocation = freezeEnvelope(accepted.value);
  const snapshotAt = now();
  if (!Number.isSafeInteger(snapshotAt) || snapshotAt < acceptedAt) throw new OwnerAdmissionError('rejected');
  const snapshot = Object.freeze({ snapshot_ref: `snp_${ref()}`, snapshot_at: snapshotAt });
  const input: ResolvedInvocationInput = Object.freeze({
    input_ref: invocation.input_refs[0]!.input_ref, content_digest: contentDigest,
    principal_ref: invocation.verified_authority.principal_ref, tenant_ref: invocation.verified_authority.tenant_ref,
    text, source: Object.freeze({ source_key: `owner-message:${occurrence.slice(0, 32)}`, source_kind: 'invocation_input', scope: 'principal', source_taint: null, produced_at: occurredAt }),
  });
  const assertCurrent = async () => {
    const current = await resolve();
    if (Object.keys(initial).some(key => current[key as keyof PresenceBinding] !== initial[key as keyof PresenceBinding])) throw new OwnerAdmissionError('rejected');
  };
  return Object.freeze({ invocation, snapshot, assertCurrent, readInput: async () => { await assertCurrent(); return input; } });
}
