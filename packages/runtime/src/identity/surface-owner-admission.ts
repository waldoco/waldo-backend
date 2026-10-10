import { acceptTrustedInvocation } from '@waldo/contracts';
import type { RunEffectScope } from '../channels/run-effect-scope';
import type { OwnerMessageAdmission } from './owner-message-admission';
import { OwnerAdmissionError } from './owner-message-admission';
import { sha256Hex, sha256Prefixed } from '../context-composer/canonical';

export type SurfaceOwnerBinding = Readonly<{
  ownerId: string;
  // Host-verified session/presence and admission revision. These are evidence,
  // never credentials or model-selectable authority.
  bindingRef: string;
  revision: string;
  physicalDoId: string;
}>;
export type SurfaceOwnerAdmissionOptions = Readonly<{
  scope: RunEffectScope;
  lookup(): Promise<SurfaceOwnerBinding>;
  expectedPhysicalDoId: string;
  surface: string;
  subject: string;
  occurrenceKey: string;
  occurredAt: number;
  text: string;
  now?(): number;
}>;

// The surface host verifies its JWT/session/private-DM and physical owner DO before
// supplying lookup. This common adapter never discovers identities or grants access.
export async function surfaceOwnerAdmission(options: SurfaceOwnerAdmissionOptions): Promise<OwnerMessageAdmission> {
  const now = options.now ?? Date.now;
  const acceptedAt = now();
  const { scope, text, occurredAt, surface, subject, occurrenceKey, expectedPhysicalDoId } = options;
  if (!text || text.length > 16_384 || !surface || surface.length > 64 || !subject || subject.length > 512
    || !occurrenceKey || occurrenceKey.length > 512 || !expectedPhysicalDoId
    || !Number.isSafeInteger(acceptedAt) || !Number.isSafeInteger(occurredAt) || occurredAt < 0 || occurredAt > acceptedAt) throw new OwnerAdmissionError('rejected');
  const resolve = async (): Promise<SurfaceOwnerBinding> => {
    scope.admit();
    let binding: SurfaceOwnerBinding;
    try { binding = await options.lookup(); } catch { scope.admit(); throw new OwnerAdmissionError('unavailable'); }
    scope.admit();
    if (!binding || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.ownerId)
      || !binding.bindingRef || binding.bindingRef.length > 512 || !binding.revision || binding.revision.length > 256
      || binding.physicalDoId !== expectedPhysicalDoId) throw new OwnerAdmissionError('rejected');
    return Object.freeze({ ownerId: binding.ownerId.toLowerCase(), bindingRef: binding.bindingRef, revision: binding.revision, physicalDoId: binding.physicalDoId });
  };
  const binding = await resolve();
  const assertCurrent = async () => {
    const current = await resolve();
    if (current.ownerId !== binding.ownerId || current.bindingRef !== binding.bindingRef || current.revision !== binding.revision
      || current.physicalDoId !== binding.physicalDoId) throw new OwnerAdmissionError('rejected');
  };
  const ownerHex = binding.ownerId.replaceAll('-', '');
  const occurrence = await sha256Hex(JSON.stringify([binding.ownerId, expectedPhysicalDoId, surface, subject, occurrenceKey]));
  const verification = await sha256Hex(JSON.stringify([binding.ownerId, binding.bindingRef, binding.revision, expectedPhysicalDoId]));
  const contentDigest = await sha256Prefixed(text);
  await assertCurrent();
  const accepted = acceptTrustedInvocation({
    admission_source: 'authenticated_ingress', verified_authority: { principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, verification_ref: `ver_${verification.slice(0, 32)}` },
    input_refs: [{ input_ref: `inp_${occurrence.slice(0, 32)}`, content_digest: contentDigest }], intent: { kind: 'respond_to_user' },
    occurrence: { occurrence_ref: `occ_${occurrence.slice(0, 32)}`, occurred_at: occurredAt }, idempotency_ref: `idem_${occurrence.slice(0, 32)}`, accepted_at: acceptedAt,
  });
  if (!accepted.ok) throw new OwnerAdmissionError('rejected');
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object') return;
    Object.values(value).forEach(freeze); Object.freeze(value);
  };
  freeze(accepted.value);
  const input = Object.freeze({ input_ref: accepted.value.input_refs[0]!.input_ref, content_digest: contentDigest,
    principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, text,
    source: Object.freeze({ source_key: `owner-message:${occurrence.slice(0, 32)}`, source_kind: 'invocation_input' as const, scope: 'invocation' as const, source_taint: null, produced_at: occurredAt }) });
  return Object.freeze({ invocation: accepted.value,
    snapshot: Object.freeze({ snapshot_ref: `snp_${crypto.randomUUID().replaceAll('-', '')}`, snapshot_at: Math.max(now(), acceptedAt) }), assertCurrent,
    readInput: async () => { await assertCurrent(); return input; } });
}
