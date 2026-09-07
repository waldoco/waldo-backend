import {
  acceptanceCheckV06Schema,
  acceptanceRecordRequestV06Schema,
  acceptanceRecordResultV06Schema,
  activeAcceptanceCheckSetV06Schema,
  canonicalizeProtocolJson,
  closureRecordRefV06Schema,
  evidenceAdmissionRequestV06Schema,
  evidenceAdmissionResultV06Schema,
  evidenceV06Schema,
  verificationRequestV06Schema,
  verificationResultV06Schema,
  type AcceptanceCheckV06,
  type AcceptanceRecordRequestV06,
  type ActiveAcceptanceCheckSetV06,
  type EvidenceAdmissionRequestV06,
  type EvidenceV06,
  type VerificationRequestV06,
  type VerificationV06,
} from '@waldo/contracts';
import { AcceptanceModule } from './acceptance-module';
import { ClosurePersistenceModule } from './closure-persistence-module';
import {
  EvidenceVerifier,
  type TrustedClosureObservation,
} from './evidence-verifier';

type ProtocolDigest = `sha256:${string}`;
type EvidenceAdmissionResult = ReturnType<typeof evidenceAdmissionResultV06Schema.parse>;
type VerificationResult = ReturnType<typeof verificationResultV06Schema.parse>;
type AcceptanceRecordResult = ReturnType<typeof acceptanceRecordResultV06Schema.parse>;
type OutcomeClosureRef = AcceptanceCheckV06['subject']['outcome'];

export class ClosureCanonicalConflictError extends Error {
  constructor(message = 'canonical closure material changed before commit') {
    super(message);
    this.name = 'ClosureCanonicalConflictError';
  }
}

export type SequencedClosureResult<T> = Readonly<{
  value: T;
  rawJson: string;
  replayed: boolean;
}>;

export type ClosureCommandSequencerDependencies = Readonly<{
  now(): string;
  sha256Hex(value: string): Promise<string>;
  persistence: ClosurePersistenceModule;
  evidenceVerifier: EvidenceVerifier;
  acceptanceModule?: AcceptanceModule;
  readAcceptanceCheckInCurrentTransaction(input: Readonly<{
    ownerId: string;
    id: string;
    expectedRevision: number;
  }>): AcceptanceCheckV06;
  readObservationInCurrentTransaction(input: Readonly<{
    ownerId: string;
    reference: EvidenceAdmissionRequestV06['payload']['observation'];
  }>): TrustedClosureObservation;
  readOutcomeRefInCurrentTransaction?: (input: Readonly<{
    ownerId: string;
    id: string;
    expectedRevision: number;
  }>) => OutcomeClosureRef;
  readActiveAcceptanceChecksInCurrentTransaction?: (input: Readonly<{
    ownerId: string;
    outcomeId: string;
    expectedOutcomeRevision: number;
  }>) => ActiveAcceptanceCheckSetV06 | null;
}>;

type AcceptanceSequencingDependencies = Readonly<{
  acceptanceModule: AcceptanceModule;
  readOutcomeRefInCurrentTransaction: NonNullable<
    ClosureCommandSequencerDependencies['readOutcomeRefInCurrentTransaction']
  >;
  readActiveAcceptanceChecksInCurrentTransaction: NonNullable<
    ClosureCommandSequencerDependencies['readActiveAcceptanceChecksInCurrentTransaction']
  >;
}>;

type AcceptanceCanonicalMaterial = Readonly<{
  subject: AcceptanceCheckV06['subject'];
  activeChecks: ActiveAcceptanceCheckSetV06 | null;
  evidenceByCheck: readonly Readonly<{
    acceptanceCheck: AcceptanceCheckV06;
    evidence: readonly EvidenceV06[];
  }>[];
  verifications: readonly VerificationV06[];
}>;

function sameProtocolValue(left: unknown, right: unknown): boolean {
  return canonicalizeProtocolJson(left) === canonicalizeProtocolJson(right);
}

function assertLowerHex(value: string): ProtocolDigest {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError('trusted SHA-256 implementation must return 64 lowercase hex characters');
  }
  return `sha256:${value}`;
}

export class ClosureCommandSequencer {
  constructor(
    private readonly storage: DurableObjectStorage,
    private readonly deps: ClosureCommandSequencerDependencies,
  ) {}

  async admitEvidence(input: Readonly<{
    ownerId: string;
    request: unknown;
    correlationId: string;
  }>): Promise<SequencedClosureResult<EvidenceAdmissionResult>> {
    const request = evidenceAdmissionRequestV06Schema.parse(input.request);
    const requestJson = canonicalizeProtocolJson(request);
    const requestDigest = assertLowerHex(await this.deps.sha256Hex(requestJson));

    const replay = this.storage.transactionSync(() =>
      this.deps.persistence.readCommandResultInCurrentTransaction({
        ownerId: input.ownerId,
        requestId: request.requestId,
        requestDigest,
      }),
    );
    if (replay !== undefined) {
      return this.replayedEvidenceResult(replay);
    }

    const preflight = this.storage.transactionSync(() =>
      this.readEvidenceCanonicalMaterialInCurrentTransaction(input.ownerId, request),
    );

    const evidence = await this.deps.evidenceVerifier.admitEvidence({
      ownerId: input.ownerId,
      acceptanceCheck: preflight.acceptanceCheck,
      observation: preflight.observation,
    });
    const evidenceDigest = assertLowerHex(await this.deps.sha256Hex(
      canonicalizeProtocolJson(evidence),
    ));

    return this.storage.transactionSync(() => {
      const commitReplay = this.deps.persistence.readCommandResultInCurrentTransaction({
        ownerId: input.ownerId,
        requestId: request.requestId,
        requestDigest,
      });
      if (commitReplay !== undefined) {
        return this.replayedEvidenceResult(commitReplay);
      }

      const current = this.readEvidenceCanonicalMaterialInCurrentTransaction(
        input.ownerId,
        request,
      );
      if (
        !sameProtocolValue(current.acceptanceCheck, preflight.acceptanceCheck) ||
        !sameProtocolValue(current.observation, preflight.observation)
      ) {
        throw new ClosureCanonicalConflictError();
      }

      const result = this.deps.persistence.persistEvidenceInCurrentTransaction({
        evidence,
        evidenceDigest,
        requestId: request.requestId,
        requestDigest,
        requestJson,
        correlationId: input.correlationId,
        recordedAt: this.deps.now(),
      });
      return Object.freeze({
        value: result,
        rawJson: JSON.stringify(result),
        replayed: false,
      });
    });
  }

  async requestVerification(input: Readonly<{
    ownerId: string;
    request: unknown;
    correlationId: string;
  }>): Promise<SequencedClosureResult<VerificationResult>> {
    const request = verificationRequestV06Schema.parse(input.request);
    const requestJson = canonicalizeProtocolJson(request);
    const requestDigest = assertLowerHex(await this.deps.sha256Hex(requestJson));

    const replay = this.storage.transactionSync(() =>
      this.deps.persistence.readCommandResultInCurrentTransaction({
        ownerId: input.ownerId,
        requestId: request.requestId,
        requestDigest,
      }),
    );
    if (replay !== undefined) {
      return this.replayedVerificationResult(replay);
    }

    const preflight = this.storage.transactionSync(() =>
      this.readVerificationCanonicalMaterialInCurrentTransaction(input.ownerId, request),
    );
    const evidenceSet = await this.deps.evidenceVerifier.buildCurrentEvidenceSet({
      ownerId: input.ownerId,
      acceptanceCheck: preflight.acceptanceCheck,
      evidence: preflight.evidence,
    });
    if (!sameProtocolValue(evidenceSet.evidence, request.payload.evidence)) {
      throw new ClosureCanonicalConflictError(
        'Verification request must bind the exact current admitted Evidence set',
      );
    }

    const verification = await this.deps.evidenceVerifier.verify({
      ownerId: input.ownerId,
      acceptanceCheck: preflight.acceptanceCheck,
      evidence: evidenceSet,
    });
    const verificationDigest = assertLowerHex(await this.deps.sha256Hex(
      canonicalizeProtocolJson(verification),
    ));

    return this.storage.transactionSync(() => {
      const commitReplay = this.deps.persistence.readCommandResultInCurrentTransaction({
        ownerId: input.ownerId,
        requestId: request.requestId,
        requestDigest,
      });
      if (commitReplay !== undefined) {
        return this.replayedVerificationResult(commitReplay);
      }

      const current = this.readVerificationCanonicalMaterialInCurrentTransaction(
        input.ownerId,
        request,
      );
      if (
        !sameProtocolValue(current.acceptanceCheck, preflight.acceptanceCheck) ||
        !sameProtocolValue(current.evidence, preflight.evidence)
      ) {
        throw new ClosureCanonicalConflictError();
      }

      const result = this.deps.persistence.persistVerificationInCurrentTransaction({
        verification,
        verificationDigest,
        requestId: request.requestId,
        requestDigest,
        requestJson,
        correlationId: input.correlationId,
        recordedAt: this.deps.now(),
      });
      return Object.freeze({
        value: result,
        rawJson: JSON.stringify(result),
        replayed: false,
      });
    });
  }

  async recordAcceptance(input: Readonly<{
    ownerId: string;
    request: unknown;
    correlationId: string;
  }>): Promise<SequencedClosureResult<AcceptanceRecordResult>> {
    const request = acceptanceRecordRequestV06Schema.parse(input.request);
    const requestJson = canonicalizeProtocolJson(request);
    const requestDigest = assertLowerHex(await this.deps.sha256Hex(requestJson));

    const replay = this.storage.transactionSync(() =>
      this.deps.persistence.readCommandResultInCurrentTransaction({
        ownerId: input.ownerId,
        requestId: request.requestId,
        requestDigest,
      }),
    );
    if (replay !== undefined) {
      return this.replayedAcceptanceResult(replay);
    }

    const preflight = this.storage.transactionSync(() =>
      this.readAcceptanceCanonicalMaterialInCurrentTransaction(input.ownerId, request),
    );
    const evidenceSets = await Promise.all(preflight.evidenceByCheck.map(async (current) =>
      this.deps.evidenceVerifier.buildCurrentEvidenceSet({
        ownerId: input.ownerId,
        acceptanceCheck: current.acceptanceCheck,
        evidence: current.evidence,
      }),
    ));
    const acceptanceDeps = this.requireAcceptanceDependencies();
    const acceptance = await acceptanceDeps.acceptanceModule.record({
      ownerId: input.ownerId,
      authenticatedOwnerId: input.ownerId,
      subject: preflight.subject,
      request,
      activeChecks: preflight.activeChecks,
      evidenceSets,
      verifications: preflight.verifications,
    });
    const acceptanceDigest = assertLowerHex(await this.deps.sha256Hex(
      canonicalizeProtocolJson(acceptance),
    ));

    return this.storage.transactionSync(() => {
      const commitReplay = this.deps.persistence.readCommandResultInCurrentTransaction({
        ownerId: input.ownerId,
        requestId: request.requestId,
        requestDigest,
      });
      if (commitReplay !== undefined) {
        return this.replayedAcceptanceResult(commitReplay);
      }

      const current = this.readAcceptanceCanonicalMaterialInCurrentTransaction(
        input.ownerId,
        request,
      );
      if (!sameProtocolValue(current, preflight)) {
        throw new ClosureCanonicalConflictError();
      }

      const result = this.deps.persistence.persistAcceptanceInCurrentTransaction({
        acceptance,
        acceptanceDigest,
        requestId: request.requestId,
        requestDigest,
        requestJson,
        correlationId: input.correlationId,
        recordedAt: acceptance.recordedAt,
      });
      return Object.freeze({
        value: result,
        rawJson: JSON.stringify(result),
        replayed: false,
      });
    });
  }

  private readEvidenceCanonicalMaterialInCurrentTransaction(
    ownerId: string,
    request: EvidenceAdmissionRequestV06,
  ): Readonly<{
    acceptanceCheck: AcceptanceCheckV06;
    observation: TrustedClosureObservation;
  }> {
    const acceptanceCheck = this.readCurrentAcceptanceCheckInCurrentTransaction(
      ownerId,
      request.aggregate.id,
      request.aggregate.expectedRevision,
    );

    const observation = this.deps.readObservationInCurrentTransaction({
      ownerId,
      reference: request.payload.observation,
    });
    if (
      observation.ownerId !== ownerId ||
      !sameProtocolValue(observation.reference, request.payload.observation) ||
      !sameProtocolValue(observation.subject, acceptanceCheck.subject)
    ) {
      throw new ClosureCanonicalConflictError('canonical observation binding mismatch');
    }

    return Object.freeze({ acceptanceCheck, observation });
  }

  private readVerificationCanonicalMaterialInCurrentTransaction(
    ownerId: string,
    request: VerificationRequestV06,
  ): Readonly<{
    acceptanceCheck: AcceptanceCheckV06;
    evidence: readonly EvidenceV06[];
  }> {
    const acceptanceCheck = this.readCurrentAcceptanceCheckInCurrentTransaction(
      ownerId,
      request.aggregate.id,
      request.aggregate.expectedRevision,
    );
    const evidence = this.readCurrentEvidenceInCurrentTransaction(ownerId, acceptanceCheck);
    if (evidence.length === 0) {
      throw new ClosureCanonicalConflictError('Verification requires current admitted Evidence');
    }
    return Object.freeze({ acceptanceCheck, evidence: Object.freeze(evidence) });
  }

  private readAcceptanceCanonicalMaterialInCurrentTransaction(
    ownerId: string,
    request: AcceptanceRecordRequestV06,
  ): AcceptanceCanonicalMaterial {
    const acceptanceDeps = this.requireAcceptanceDependencies();
    const outcome = closureRecordRefV06Schema.parse(
      acceptanceDeps.readOutcomeRefInCurrentTransaction({
        ownerId,
        id: request.aggregate.id,
        expectedRevision: request.aggregate.expectedRevision,
      }),
    );
    if (
      outcome.id !== request.aggregate.id ||
      outcome.revision !== request.aggregate.expectedRevision
    ) {
      throw new ClosureCanonicalConflictError('canonical Outcome revision mismatch');
    }

    const verifications = this.readReferencedVerificationsInCurrentTransaction(
      ownerId,
      request.payload.verifications,
    );
    if (request.payload.decision === 'release') {
      return Object.freeze({
        subject: Object.freeze({ outcome, workUnit: null }),
        activeChecks: null,
        evidenceByCheck: Object.freeze([]),
        verifications: Object.freeze(verifications),
      });
    }

    const rawActiveChecks = acceptanceDeps.readActiveAcceptanceChecksInCurrentTransaction({
      ownerId,
      outcomeId: outcome.id,
      expectedOutcomeRevision: outcome.revision,
    });
    if (rawActiveChecks === null) {
      throw new ClosureCanonicalConflictError('Acceptance requires current active AcceptanceChecks');
    }
    const activeChecks = activeAcceptanceCheckSetV06Schema.parse(rawActiveChecks);
    if (
      activeChecks.ownerId !== ownerId ||
      !sameProtocolValue(activeChecks.subject.outcome, outcome)
    ) {
      throw new ClosureCanonicalConflictError('active AcceptanceCheck set Outcome mismatch');
    }

    const evidenceByCheck = activeChecks.records.map((acceptanceCheck) => {
      const evidence = this.readCurrentEvidenceInCurrentTransaction(ownerId, acceptanceCheck);
      if (evidence.length === 0) {
        throw new ClosureCanonicalConflictError('Acceptance requires current admitted Evidence');
      }
      return Object.freeze({
        acceptanceCheck,
        evidence: Object.freeze(evidence),
      });
    });
    return Object.freeze({
      subject: activeChecks.subject,
      activeChecks,
      evidenceByCheck: Object.freeze(evidenceByCheck),
      verifications: Object.freeze(verifications),
    });
  }

  private readCurrentAcceptanceCheckInCurrentTransaction(
    ownerId: string,
    id: string,
    expectedRevision: number,
  ): AcceptanceCheckV06 {
    const acceptanceCheck = acceptanceCheckV06Schema.parse(
      this.deps.readAcceptanceCheckInCurrentTransaction({ ownerId, id, expectedRevision }),
    );
    if (
      acceptanceCheck.ownerId !== ownerId ||
      acceptanceCheck.id !== id ||
      acceptanceCheck.revision !== expectedRevision ||
      acceptanceCheck.state !== 'active'
    ) {
      throw new ClosureCanonicalConflictError('AcceptanceCheck is not current and active');
    }
    return acceptanceCheck;
  }

  private readCurrentEvidenceInCurrentTransaction(
    ownerId: string,
    acceptanceCheck: AcceptanceCheckV06,
  ): EvidenceV06[] {
    const rows = this.storage.sql.exec<{ evidence_json: string }>(
      `SELECT evidence_json
         FROM closure_evidence
        WHERE owner_id = ?
          AND acceptance_check_id = ?
          AND acceptance_check_revision = ?
          AND state = 'admitted'
        ORDER BY id ASC`,
      ownerId,
      acceptanceCheck.id,
      acceptanceCheck.revision,
    ).toArray();
    try {
      return rows.map((row) => evidenceV06Schema.parse(JSON.parse(row.evidence_json)));
    } catch {
      throw new ClosureCanonicalConflictError('current Evidence material is malformed');
    }
  }

  private readReferencedVerificationsInCurrentTransaction(
    ownerId: string,
    references: readonly Readonly<{ id: string; revision: number; digest: string }>[],
  ): VerificationV06[] {
    const records: VerificationV06[] = [];
    for (const reference of references) {
      const record = this.deps.persistence.readVerificationInCurrentTransaction(
        ownerId,
        reference.id,
      );
      if (
        record === undefined ||
        record.ownerId !== ownerId ||
        record.revision !== reference.revision
      ) {
        throw new ClosureCanonicalConflictError('referenced Verification is missing or stale');
      }
      records.push(record);
    }
    return records;
  }

  private requireAcceptanceDependencies(): AcceptanceSequencingDependencies {
    const {
      acceptanceModule,
      readOutcomeRefInCurrentTransaction,
      readActiveAcceptanceChecksInCurrentTransaction,
    } = this.deps;
    if (
      acceptanceModule === undefined ||
      readOutcomeRefInCurrentTransaction === undefined ||
      readActiveAcceptanceChecksInCurrentTransaction === undefined
    ) {
      throw new ClosureCanonicalConflictError('Acceptance sequencing dependencies are not configured');
    }
    return Object.freeze({
      acceptanceModule,
      readOutcomeRefInCurrentTransaction,
      readActiveAcceptanceChecksInCurrentTransaction,
    });
  }

  private replayedEvidenceResult(rawJson: string): SequencedClosureResult<EvidenceAdmissionResult> {
    return this.replayedResult(rawJson, evidenceAdmissionResultV06Schema.parse);
  }

  private replayedVerificationResult(rawJson: string): SequencedClosureResult<VerificationResult> {
    return this.replayedResult(rawJson, verificationResultV06Schema.parse);
  }

  private replayedAcceptanceResult(rawJson: string): SequencedClosureResult<AcceptanceRecordResult> {
    return this.replayedResult(rawJson, acceptanceRecordResultV06Schema.parse);
  }

  private replayedResult<T>(
    rawJson: string,
    parse: (value: unknown) => T,
  ): SequencedClosureResult<T> {
    let value: unknown;
    try {
      value = JSON.parse(rawJson);
    } catch {
      throw new ClosureCanonicalConflictError('persisted closure replay result is malformed');
    }
    return Object.freeze({ value: parse(value), rawJson, replayed: true });
  }
}
