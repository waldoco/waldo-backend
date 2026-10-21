import { acceptTrustedInvocation, ownerJobSchema, type InvocationIntent, type OwnerJob, type TrustedInvocationAdmissionSource } from '@waldo/contracts';
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
export type OwnerJobAdmissionOptions = Readonly<{
  // The host resolved the owner from the directory for this alarm; lookup answers that binding while it is still current.
  lookup(): Promise<SurfaceOwnerBinding>;
  expectedPhysicalDoId: string;
  job: OwnerJob;
  occurrenceKey: string;
  occurredAt: number;
  now?(): number;
}>;
type BoundAdmission = Readonly<{
  lookup(): Promise<SurfaceOwnerBinding>;
  admit(): void;
  expectedPhysicalDoId: string;
  occurrenceParts: readonly string[];
  admissionSource: TrustedInvocationAdmissionSource;
  intent: InvocationIntent;
  text: string;
  occurredAt: number;
  acceptedAt: number;
  now(): number;
}>;

const OWNER_UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
// How long a matching directory read keeps a turn's admission current for context reads. Effects and published replies
// read afresh, so a revoked session that no fence reached can still shape context for this long, never act.
const VERIFIED_FOR_MS = 1_000;

async function boundAdmission(options: BoundAdmission): Promise<OwnerMessageAdmission> {
  const { admit, expectedPhysicalDoId, text, occurredAt, acceptedAt, now } = options;
  const resolve = async (): Promise<SurfaceOwnerBinding> => {
    admit();
    let binding: SurfaceOwnerBinding;
    try { binding = await options.lookup(); } catch { admit(); throw new OwnerAdmissionError('unavailable'); }
    admit();
    if (!binding || !OWNER_UUID.test(binding.ownerId)
      || !binding.bindingRef || binding.bindingRef.length > 512 || !binding.revision || binding.revision.length > 256
      || binding.physicalDoId !== expectedPhysicalDoId) throw new OwnerAdmissionError('rejected');
    return Object.freeze({ ownerId: binding.ownerId.toLowerCase(), bindingRef: binding.bindingRef, revision: binding.revision, physicalDoId: binding.physicalDoId });
  };
  const binding = await resolve();
  // A turn checks currency around nearly every await, and one directory read per check left each tool round waiting on
  // dozens of serial round trips. assertCurrent reuses a read that matched for VERIFIED_FOR_MS from when it started;
  // assertFresh, the check before an effect or a published reply, always reads. Concurrent checks share one read, and
  // the run scope is checked every time, so a session fence stops the turn at once.
  let verifiedAt = Number.NEGATIVE_INFINITY;
  let reading: Promise<void> | undefined;
  const reread = async () => {
    const startedAt = now();
    const current = await resolve();
    if (current.ownerId !== binding.ownerId || current.bindingRef !== binding.bindingRef || current.revision !== binding.revision
      || current.physicalDoId !== binding.physicalDoId) throw new OwnerAdmissionError('rejected');
    verifiedAt = startedAt;
  };
  const assertFresh = async () => {
    admit();
    reading ??= reread().finally(() => { reading = undefined; });
    await reading;
  };
  const assertCurrent = async () => {
    admit();
    if (now() - verifiedAt >= VERIFIED_FOR_MS) await assertFresh();
  };
  const ownerHex = binding.ownerId.replaceAll('-', '');
  const occurrence = await sha256Hex(JSON.stringify([binding.ownerId, expectedPhysicalDoId, ...options.occurrenceParts]));
  const verification = await sha256Hex(JSON.stringify([binding.ownerId, binding.bindingRef, binding.revision, expectedPhysicalDoId]));
  const contentDigest = await sha256Prefixed(text);
  await assertCurrent();
  const accepted = acceptTrustedInvocation({
    admission_source: options.admissionSource, verified_authority: { principal_ref: `prn_${ownerHex}`, tenant_ref: `ten_${ownerHex}`, verification_ref: `ver_${verification.slice(0, 32)}` },
    input_refs: [{ input_ref: `inp_${occurrence.slice(0, 32)}`, content_digest: contentDigest }], intent: options.intent,
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
    snapshot: Object.freeze({ snapshot_ref: `snp_${crypto.randomUUID().replaceAll('-', '')}`, snapshot_at: Math.max(now(), acceptedAt) }), assertCurrent, assertFresh,
    readInput: async () => { await assertCurrent(); return input; } });
}

const validTimes = (acceptedAt: number, occurredAt: number) =>
  Number.isSafeInteger(acceptedAt) && Number.isSafeInteger(occurredAt) && occurredAt >= 0 && occurredAt <= acceptedAt;

// The surface host verifies its JWT/session/private-DM and physical owner DO before
// supplying lookup. This common adapter never discovers identities or grants access.
export async function surfaceOwnerAdmission(options: SurfaceOwnerAdmissionOptions): Promise<OwnerMessageAdmission> {
  const now = options.now ?? Date.now;
  const acceptedAt = now();
  const { scope, text, occurredAt, surface, subject, occurrenceKey, expectedPhysicalDoId } = options;
  if (!text || text.length > 16_384 || !surface || surface.length > 64 || !subject || subject.length > 512
    || !occurrenceKey || occurrenceKey.length > 512 || !expectedPhysicalDoId || !validTimes(acceptedAt, occurredAt)) throw new OwnerAdmissionError('rejected');
  return boundAdmission({ lookup: options.lookup, admit: () => scope.admit(), expectedPhysicalDoId, occurrenceParts: [surface, subject, occurrenceKey],
    admissionSource: 'authenticated_ingress', intent: { kind: 'respond_to_user' }, text, occurredAt, acceptedAt, now });
}

// A scheduled job carries no owner text: its invocation input names the job, and the job's own prompt arrives as a machine message.
export async function ownerJobAdmission(options: OwnerJobAdmissionOptions): Promise<OwnerMessageAdmission> {
  const now = options.now ?? Date.now;
  const acceptedAt = now();
  const { job, occurrenceKey, occurredAt, expectedPhysicalDoId } = options;
  if (!ownerJobSchema.safeParse(job).success || !occurrenceKey || occurrenceKey.length > 512 || !expectedPhysicalDoId
    || !validTimes(acceptedAt, occurredAt)) throw new OwnerAdmissionError('rejected');
  return boundAdmission({ lookup: options.lookup, admit: () => undefined, expectedPhysicalDoId, occurrenceParts: ['scheduler', job, occurrenceKey],
    admissionSource: 'trusted_scheduler', intent: { kind: 'run_owner_job', job }, text: `The owner's scheduled ${job} job is due.`, occurredAt, acceptedAt, now });
}
