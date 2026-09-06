import {
  acceptanceRecordRequestV06Schema,
  acceptanceV06Schema,
  activeAcceptanceCheckSetV06Schema,
  canonicalizeAcceptanceCheckV06ForDigest,
  canonicalizeActiveAcceptanceCheckSetV06ForDigest,
  canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest,
  canonicalizeEvidenceSetV06ForDigest,
  canonicalizeProtocolJson,
  currentEvidenceSetEnvelopeV06Schema,
  verificationV06Schema,
  verifiedAcceptanceBindingV06Schema,
  type AcceptanceRecordRequestV06,
  type AcceptanceV06,
  type ActiveAcceptanceCheckSetV06,
  type CurrentEvidenceSetEnvelopeV06,
  type VerificationV06,
} from '@waldo/contracts';
import { ResponsibilityClosureInvariantError } from './evidence-verifier';

export type AcceptanceModuleDependencies = Readonly<{
  now(): string;
  newId(): string;
  sha256Hex(value: string): Promise<string>;
}>;

export type AcceptanceRecordInput = Readonly<{
  /** Canonical owner reread from the Outcome owner root in the current transaction. */
  ownerId: string;
  /** Authenticated owner derived from the admitted presence/session, never request payload. */
  authenticatedOwnerId: string;
  /** Exact current Outcome subject material reread from OutcomeModule. */
  subject: ActiveAcceptanceCheckSetV06['subject'];
  request: AcceptanceRecordRequestV06;
  activeChecks: ActiveAcceptanceCheckSetV06 | null;
  evidenceSets: readonly CurrentEvidenceSetEnvelopeV06[];
  verifications: readonly VerificationV06[];
}>;

function sameProtocolValue(left: unknown, right: unknown): boolean {
  return canonicalizeProtocolJson(left) === canonicalizeProtocolJson(right);
}

function compareProtocolIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertLowerHex(value: string): `sha256:${string}` {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ResponsibilityClosureInvariantError('trusted SHA-256 must return lowercase hex');
  }
  return `sha256:${value}`;
}

function sameRef(
  left: Readonly<{ id: string; revision: number; digest: string }>,
  right: Readonly<{ id: string; revision: number; digest: string }>,
): boolean {
  return left.id === right.id && left.revision === right.revision && left.digest === right.digest;
}

export class AcceptanceModule {
  constructor(private readonly deps: AcceptanceModuleDependencies) {}

  async record(input: AcceptanceRecordInput): Promise<AcceptanceV06> {
    const request = acceptanceRecordRequestV06Schema.parse(input.request);
    this.assertOwnerAndSubject(input, request);

    if (request.payload.decision === 'release') {
      const verifications = input.verifications.map((value) => verificationV06Schema.parse(value));
      const releaseSubject = await this.resolveReleaseSubject(input, request, verifications);
      return Object.freeze(acceptanceV06Schema.parse({
        protocolVersion: '0.6',
        id: this.deps.newId(),
        ownerId: input.ownerId,
        revision: 1,
        subject: releaseSubject,
        actor: { kind: 'owner', id: input.authenticatedOwnerId },
        mode: 'explicit_owner',
        verifications: request.payload.verifications,
        decision: 'released',
        reasonRef: request.payload.reasonRef,
        recordedAt: this.deps.now(),
      }));
    }

    if (input.activeChecks === null) {
      throw new ResponsibilityClosureInvariantError('Acceptance requires active AcceptanceChecks');
    }

    const activeChecks = activeAcceptanceCheckSetV06Schema.parse(input.activeChecks);
    if (
      activeChecks.ownerId !== input.ownerId ||
      !sameProtocolValue(activeChecks.subject, input.subject)
    ) {
      throw new ResponsibilityClosureInvariantError('active AcceptanceCheck owner/subject mismatch');
    }
    await this.assertActiveCheckDigests(activeChecks);

    const evidenceSets = input.evidenceSets
      .map((value) => currentEvidenceSetEnvelopeV06Schema.parse(value))
      .sort((left, right) => compareProtocolIds(left.acceptanceCheck.id, right.acceptanceCheck.id));
    if (evidenceSets.length !== activeChecks.records.length) {
      throw new ResponsibilityClosureInvariantError('Acceptance requires one Evidence set per active check');
    }
    for (const evidenceSet of evidenceSets) {
      await this.assertEvidenceSet(activeChecks, evidenceSet);
    }

    const verifications = input.verifications
      .map((value) => verificationV06Schema.parse(value))
      .sort((left, right) => compareProtocolIds(left.id, right.id));
    await this.assertVerificationReferences(
      request.payload.verifications,
      verifications,
      true,
    );
    if (verifications.length !== activeChecks.records.length) {
      throw new ResponsibilityClosureInvariantError('Acceptance requires one Verification per active check');
    }

    const seenCheckIds = new Set<string>();
    for (const verification of verifications) {
      if (
        verification.ownerId !== input.ownerId ||
        verification.state !== 'passed' ||
        verification.verifier.availability !== 'available' ||
        verification.verifier.independentFromProducer !== true ||
        !sameProtocolValue(verification.subject, input.subject)
      ) {
        throw new ResponsibilityClosureInvariantError('Acceptance requires current passed independent Verification');
      }
      const check = activeChecks.records.find((candidate) => candidate.id === verification.acceptanceCheck.id);
      const evidenceSet = evidenceSets.find(
        (candidate) => candidate.acceptanceCheck.id === verification.acceptanceCheck.id,
      );
      if (
        check === undefined ||
        evidenceSet === undefined ||
        seenCheckIds.has(check.id) ||
        !sameRef(verification.acceptanceCheck, {
          id: check.id,
          revision: check.revision,
          digest: check.digest,
        }) ||
        verification.method.kind !== check.verificationMethod.kind ||
        verification.method.version !== check.verificationMethod.version ||
        verification.evidenceSetDigest !== evidenceSet.evidenceSetDigest ||
        !sameProtocolValue(verification.evidence, evidenceSet.evidence) ||
        evidenceSet.records.some(
          (evidence) => evidence.provenance.producer.id === verification.verifier.id,
        )
      ) {
        throw new ResponsibilityClosureInvariantError('Verification does not exactly cover current check Evidence');
      }
      seenCheckIds.add(check.id);
    }

    const acceptance = acceptanceV06Schema.parse({
      protocolVersion: '0.6',
      id: this.deps.newId(),
      ownerId: input.ownerId,
      revision: 1,
      subject: input.subject,
      actor: { kind: 'owner', id: input.authenticatedOwnerId },
      mode: 'explicit_owner',
      activeAcceptanceChecks: {
        revision: activeChecks.revision,
        count: activeChecks.count,
        digest: activeChecks.digest,
      },
      evidenceSets: evidenceSets.map((evidenceSet) => ({
        acceptanceCheck: evidenceSet.acceptanceCheck,
        revision: evidenceSet.revision,
        count: evidenceSet.count,
        evidenceSetDigest: evidenceSet.evidenceSetDigest,
        digest: evidenceSet.digest,
      })),
      verifications: request.payload.verifications,
      decision: 'accepted',
      reasonRef: request.payload.reasonRef,
      recordedAt: this.deps.now(),
    });

    verifiedAcceptanceBindingV06Schema.parse({
      acceptance,
      activeAcceptanceChecks: activeChecks,
      evidenceSets,
      verifications,
    });
    return Object.freeze(acceptance);
  }

  private assertOwnerAndSubject(
    input: AcceptanceRecordInput,
    request: AcceptanceRecordRequestV06,
  ): void {
    if (
      input.ownerId !== input.authenticatedOwnerId ||
      request.aggregate.id !== input.subject.outcome.id ||
      request.aggregate.expectedRevision !== input.subject.outcome.revision
    ) {
      throw new ResponsibilityClosureInvariantError('authenticated owner or Outcome revision mismatch');
    }
  }

  private async resolveReleaseSubject(
    input: AcceptanceRecordInput,
    request: AcceptanceRecordRequestV06,
    verifications: readonly VerificationV06[],
  ): Promise<ActiveAcceptanceCheckSetV06['subject']> {
    await this.assertVerificationReferences(
      request.payload.verifications,
      verifications,
      false,
    );

    if (request.payload.verifications.length === 0) {
      return Object.freeze({
        outcome: input.subject.outcome,
        workUnit: null,
      });
    }

    const first = verifications[0];
    if (
      first === undefined ||
      first.ownerId !== input.ownerId ||
      !sameProtocolValue(first.subject.outcome, input.subject.outcome)
    ) {
      throw new ResponsibilityClosureInvariantError('Release Verification owner/Outcome mismatch');
    }

    for (const verification of verifications) {
      if (
        verification.ownerId !== input.ownerId ||
        !sameProtocolValue(verification.subject, first.subject)
      ) {
        throw new ResponsibilityClosureInvariantError(
          'Release Verifications must share one canonical owner and subject',
        );
      }
    }

    return first.subject;
  }

  private async assertActiveCheckDigests(activeChecks: ActiveAcceptanceCheckSetV06): Promise<void> {
    for (const check of activeChecks.records) {
      const digest = assertLowerHex(
        await this.deps.sha256Hex(canonicalizeAcceptanceCheckV06ForDigest(check)),
      );
      if (check.digest !== digest) {
        throw new ResponsibilityClosureInvariantError('AcceptanceCheck digest mismatch');
      }
    }
    const setDigest = assertLowerHex(
      await this.deps.sha256Hex(canonicalizeActiveAcceptanceCheckSetV06ForDigest(activeChecks)),
    );
    if (activeChecks.digest !== setDigest) {
      throw new ResponsibilityClosureInvariantError('active AcceptanceCheck set digest mismatch');
    }
  }

  private async assertEvidenceSet(
    activeChecks: ActiveAcceptanceCheckSetV06,
    evidenceSet: CurrentEvidenceSetEnvelopeV06,
  ): Promise<void> {
    const check = activeChecks.records.find((candidate) => candidate.id === evidenceSet.acceptanceCheck.id);
    if (
      check === undefined ||
      evidenceSet.ownerId !== activeChecks.ownerId ||
      !sameProtocolValue(evidenceSet.subject, activeChecks.subject) ||
      !sameRef(evidenceSet.acceptanceCheck, {
        id: check.id,
        revision: check.revision,
        digest: check.digest,
      })
    ) {
      throw new ResponsibilityClosureInvariantError('Evidence set is not current for active AcceptanceCheck');
    }

    if (evidenceSet.records.length !== evidenceSet.evidence.length) {
      throw new ResponsibilityClosureInvariantError('Evidence set record/reference count mismatch');
    }
    for (const [index, record] of evidenceSet.records.entries()) {
      const reference = evidenceSet.evidence[index];
      if (reference === undefined || record.state !== 'admitted') {
        throw new ResponsibilityClosureInvariantError('Evidence set contains non-current Evidence');
      }
      const recordDigest = assertLowerHex(
        await this.deps.sha256Hex(canonicalizeProtocolJson(record)),
      );
      if (!sameRef(reference, { id: record.id, revision: record.revision, digest: recordDigest })) {
        throw new ResponsibilityClosureInvariantError('Evidence reference digest mismatch');
      }
    }

    const evidenceSetDigest = assertLowerHex(
      await this.deps.sha256Hex(canonicalizeEvidenceSetV06ForDigest(evidenceSet.evidence)),
    );
    if (evidenceSet.evidenceSetDigest !== evidenceSetDigest) {
      throw new ResponsibilityClosureInvariantError('Evidence-set digest mismatch');
    }
    const envelopeDigest = assertLowerHex(
      await this.deps.sha256Hex(canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest(evidenceSet)),
    );
    if (evidenceSet.digest !== envelopeDigest) {
      throw new ResponsibilityClosureInvariantError('Evidence envelope digest mismatch');
    }
  }

  private async assertVerificationReferences(
    requested: readonly Readonly<{ id: string; revision: number; digest: string }>[],
    records: readonly VerificationV06[],
    requirePassed: boolean,
  ): Promise<void> {
    if (requested.length !== records.length) {
      throw new ResponsibilityClosureInvariantError('Verification reference coverage mismatch');
    }
    const byId = new Map(records.map((record) => [record.id, record]));
    if (byId.size !== records.length) {
      throw new ResponsibilityClosureInvariantError('duplicate Verification records');
    }
    for (const reference of requested) {
      const record = byId.get(reference.id);
      if (record === undefined || record.revision !== reference.revision) {
        throw new ResponsibilityClosureInvariantError('Verification reference is stale or missing');
      }
      if (requirePassed && record.state !== 'passed') {
        throw new ResponsibilityClosureInvariantError('Acceptance cannot use non-passed Verification');
      }
      const digest = assertLowerHex(await this.deps.sha256Hex(canonicalizeProtocolJson(record)));
      if (reference.digest !== digest) {
        throw new ResponsibilityClosureInvariantError('Verification reference digest mismatch');
      }
    }
  }
}
