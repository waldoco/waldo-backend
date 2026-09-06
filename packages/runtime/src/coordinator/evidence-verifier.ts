import {
  acceptanceCheckV06Schema,
  canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest,
  canonicalizeEvidenceSetV06ForDigest,
  canonicalizeProtocolJson,
  currentEvidenceSetEnvelopeV06Schema,
  evidenceV06Schema,
  verificationV06Schema,
  type AcceptanceCheckV06,
  type CurrentEvidenceSetEnvelopeV06,
  type EvidenceV06,
  type VerificationV06,
} from '@waldo/contracts';

export class ResponsibilityClosureInvariantError extends Error {
  constructor(message = 'responsibility closure invariant violated') {
    super(message);
    this.name = 'ResponsibilityClosureInvariantError';
  }
}

export type TrustedClosureObservation = Readonly<{
  ownerId: string;
  subject: AcceptanceCheckV06['subject'];
  reference: EvidenceV06['observation'];
  producer: EvidenceV06['provenance']['producer'];
  observedAt: string;
}>;

export type ClosureVerifierDecision = Readonly<{
  state: 'passed' | 'failed' | 'indeterminate';
  verifier: Readonly<{
    id: string;
    version: string;
    availability: 'available' | 'unavailable' | 'unsupported';
    independentFromProducer: boolean;
    disclosure: Readonly<{ ref: string; digest: `sha256:${string}` }>;
  }>;
  findings: Readonly<{ ref: string; digest: `sha256:${string}` }> | null;
}>;

export type ClosureVerifierPort = (
  input: Readonly<{
    ownerId: string;
    acceptanceCheck: AcceptanceCheckV06;
    evidence: CurrentEvidenceSetEnvelopeV06;
  }>,
) => Promise<ClosureVerifierDecision>;

export type EvidenceVerifierDependencies = Readonly<{
  now(): string;
  newId(kind: 'evidence' | 'verification'): string;
  sha256Hex(value: string): Promise<string>;
  admitter: EvidenceV06['provenance']['admittedBy'];
  verifier: ClosureVerifierPort;
}>;

const producerKindByObservationKind = {
  provider_observation: 'provider',
  execution_observation: 'execution_environment',
  effect_receipt: 'effect_adapter',
  person_statement: 'person',
} as const;

function sameProtocolValue(left: unknown, right: unknown): boolean {
  return canonicalizeProtocolJson(left) === canonicalizeProtocolJson(right);
}

function assertDigestHex(value: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ResponsibilityClosureInvariantError('trusted SHA-256 must return lowercase hex');
  }
  return `sha256:${value}`;
}

function checkRef(check: AcceptanceCheckV06) {
  return Object.freeze({
    id: check.id,
    revision: check.revision,
    digest: check.digest,
  });
}

export class EvidenceVerifier {
  constructor(private readonly deps: EvidenceVerifierDependencies) {}

  async admitEvidence(input: Readonly<{
    ownerId: string;
    acceptanceCheck: AcceptanceCheckV06;
    observation: TrustedClosureObservation;
  }>): Promise<EvidenceV06> {
    const check = acceptanceCheckV06Schema.parse(input.acceptanceCheck);
    if (
      check.state !== 'active' ||
      check.ownerId !== input.ownerId ||
      input.observation.ownerId !== input.ownerId ||
      !sameProtocolValue(check.subject, input.observation.subject)
    ) {
      throw new ResponsibilityClosureInvariantError();
    }

    const expectedProducerKind = producerKindByObservationKind[input.observation.reference.kind];
    if (input.observation.producer.kind !== expectedProducerKind) {
      throw new ResponsibilityClosureInvariantError('observation producer category mismatch');
    }
    if (
      input.observation.producer.kind === 'person' &&
      input.observation.producer.id !== input.ownerId
    ) {
      throw new ResponsibilityClosureInvariantError('person Evidence producer must be owner');
    }
    if (
      this.deps.admitter.kind === 'owner' &&
      this.deps.admitter.id !== input.ownerId
    ) {
      throw new ResponsibilityClosureInvariantError('owner Evidence admitter must be owner');
    }

    return Object.freeze(evidenceV06Schema.parse({
      protocolVersion: '0.6',
      id: this.deps.newId('evidence'),
      ownerId: input.ownerId,
      revision: 1,
      subject: check.subject,
      acceptanceCheck: checkRef(check),
      observation: input.observation.reference,
      provenance: {
        producer: input.observation.producer,
        admittedBy: this.deps.admitter,
      },
      state: 'admitted',
      observedAt: input.observation.observedAt,
      admittedAt: this.deps.now(),
    }));
  }

  async buildCurrentEvidenceSet(input: Readonly<{
    ownerId: string;
    acceptanceCheck: AcceptanceCheckV06;
    evidence: readonly EvidenceV06[];
    revision?: number;
  }>): Promise<CurrentEvidenceSetEnvelopeV06> {
    const check = acceptanceCheckV06Schema.parse(input.acceptanceCheck);
    if (check.state !== 'active' || check.ownerId !== input.ownerId || input.evidence.length === 0) {
      throw new ResponsibilityClosureInvariantError();
    }

    const records = input.evidence
      .map((record) => evidenceV06Schema.parse(record))
      .sort((left, right) => left.id.localeCompare(right.id));

    const seenIds = new Set<string>();
    const seenObservations = new Set<string>();
    const refs: Array<{ id: string; revision: number; digest: string }> = [];
    for (const record of records) {
      const observationKey = canonicalizeProtocolJson(record.observation);
      if (
        seenIds.has(record.id) ||
        seenObservations.has(observationKey) ||
        record.state !== 'admitted' ||
        record.ownerId !== input.ownerId ||
        !sameProtocolValue(record.subject, check.subject) ||
        !sameProtocolValue(record.acceptanceCheck, checkRef(check))
      ) {
        throw new ResponsibilityClosureInvariantError('Evidence set contains stale or duplicate material');
      }
      seenIds.add(record.id);
      seenObservations.add(observationKey);
      refs.push({
        id: record.id,
        revision: record.revision,
        digest: assertDigestHex(await this.deps.sha256Hex(canonicalizeProtocolJson(record))),
      });
    }

    const evidenceSetDigest = assertDigestHex(
      await this.deps.sha256Hex(canonicalizeEvidenceSetV06ForDigest(refs)),
    );
    const provisional = currentEvidenceSetEnvelopeV06Schema.parse({
      protocolVersion: '0.6',
      ownerId: input.ownerId,
      subject: check.subject,
      acceptanceCheck: checkRef(check),
      revision: input.revision ?? 1,
      count: refs.length,
      evidenceSetDigest,
      digest: `sha256:${'0'.repeat(64)}`,
      evidence: refs,
      records,
    });
    const digest = assertDigestHex(
      await this.deps.sha256Hex(canonicalizeCurrentEvidenceSetEnvelopeV06ForDigest(provisional)),
    );

    return Object.freeze(currentEvidenceSetEnvelopeV06Schema.parse({
      ...provisional,
      digest,
    }));
  }

  async verify(input: Readonly<{
    ownerId: string;
    acceptanceCheck: AcceptanceCheckV06;
    evidence: CurrentEvidenceSetEnvelopeV06;
  }>): Promise<VerificationV06> {
    const check = acceptanceCheckV06Schema.parse(input.acceptanceCheck);
    const evidence = currentEvidenceSetEnvelopeV06Schema.parse(input.evidence);
    if (
      check.state !== 'active' ||
      check.ownerId !== input.ownerId ||
      evidence.ownerId !== input.ownerId ||
      !sameProtocolValue(check.subject, evidence.subject) ||
      !sameProtocolValue(evidence.acceptanceCheck, checkRef(check))
    ) {
      throw new ResponsibilityClosureInvariantError();
    }

    const decision = await this.deps.verifier(Object.freeze({
      ownerId: input.ownerId,
      acceptanceCheck: check,
      evidence,
    }));
    const producerIds = new Set(evidence.records.map((record) => record.provenance.producer.id));
    const independent =
      decision.verifier.independentFromProducer && !producerIds.has(decision.verifier.id);
    const available = decision.verifier.availability === 'available';
    const state = available && independent
      ? decision.state
      : 'indeterminate';

    const verifier = {
      ...decision.verifier,
      independentFromProducer: independent,
    };

    return Object.freeze(verificationV06Schema.parse({
      protocolVersion: '0.6',
      id: this.deps.newId('verification'),
      ownerId: input.ownerId,
      revision: 1,
      subject: check.subject,
      acceptanceCheck: checkRef(check),
      evidence: evidence.evidence,
      evidenceSetDigest: evidence.evidenceSetDigest,
      method: {
        kind: check.verificationMethod.kind,
        version: check.verificationMethod.version,
      },
      verifier,
      state,
      findings: decision.findings,
      verifiedAt: this.deps.now(),
    }));
  }
}
