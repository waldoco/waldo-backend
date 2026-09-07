import {
  acceptanceCheckV06Schema,
  canonicalizeProtocolJson,
  evidenceAdmissionRequestV06Schema,
  evidenceAdmissionResultV06Schema,
  type AcceptanceCheckV06,
  type EvidenceAdmissionRequestV06,
} from '@waldo/contracts';
import { ClosurePersistenceModule } from './closure-persistence-module';
import {
  EvidenceVerifier,
  type TrustedClosureObservation,
} from './evidence-verifier';

type ProtocolDigest = `sha256:${string}`;
type EvidenceAdmissionResult = ReturnType<typeof evidenceAdmissionResultV06Schema.parse>;

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
  readAcceptanceCheckInCurrentTransaction(input: Readonly<{
    ownerId: string;
    id: string;
    expectedRevision: number;
  }>): AcceptanceCheckV06;
  readObservationInCurrentTransaction(input: Readonly<{
    ownerId: string;
    reference: EvidenceAdmissionRequestV06['payload']['observation'];
  }>): TrustedClosureObservation;
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

  private readEvidenceCanonicalMaterialInCurrentTransaction(
    ownerId: string,
    request: EvidenceAdmissionRequestV06,
  ): Readonly<{
    acceptanceCheck: AcceptanceCheckV06;
    observation: TrustedClosureObservation;
  }> {
    const acceptanceCheck = acceptanceCheckV06Schema.parse(
      this.deps.readAcceptanceCheckInCurrentTransaction({
        ownerId,
        id: request.aggregate.id,
        expectedRevision: request.aggregate.expectedRevision,
      }),
    );
    if (
      acceptanceCheck.ownerId !== ownerId ||
      acceptanceCheck.id !== request.aggregate.id ||
      acceptanceCheck.revision !== request.aggregate.expectedRevision ||
      acceptanceCheck.state !== 'active'
    ) {
      throw new ClosureCanonicalConflictError('AcceptanceCheck is not current and active');
    }

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

  private replayedEvidenceResult(rawJson: string): SequencedClosureResult<EvidenceAdmissionResult> {
    let value: unknown;
    try {
      value = JSON.parse(rawJson);
    } catch {
      throw new ClosureCanonicalConflictError('persisted closure replay result is malformed');
    }
    return Object.freeze({
      value: evidenceAdmissionResultV06Schema.parse(value),
      rawJson,
      replayed: true,
    });
  }
}
