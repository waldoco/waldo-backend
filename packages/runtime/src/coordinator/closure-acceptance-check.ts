import {
  acceptanceCheckV06Schema,
  acceptanceCriterionRefV06Schema,
  acceptanceVerificationMethodV06Schema,
  activeAcceptanceCheckSetV06Schema,
  canonicalizeAcceptanceCheckV06ForDigest,
  canonicalizeActiveAcceptanceCheckSetV06ForDigest,
  canonicalizeProtocolJson,
  closureSubjectV06Schema,
  type AcceptanceCheckV06,
  type ActiveAcceptanceCheckSetV06,
} from '@waldo/contracts';
import { ResponsibilityClosureInvariantError } from './evidence-verifier';

export type TrustedClosureSubject = Readonly<{
  ownerId: string;
  subject: ReturnType<typeof closureSubjectV06Schema.parse>;
}>;

export type ClosureAcceptanceCheckBuilderDependencies = Readonly<{
  now(): string;
  newId(): string;
  sha256Hex(value: string): Promise<string>;
}>;

function compareProtocolIds(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameProtocolValue(left: unknown, right: unknown): boolean {
  return canonicalizeProtocolJson(left) === canonicalizeProtocolJson(right);
}

function assertLowerHex(value: string): `sha256:${string}` {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new ResponsibilityClosureInvariantError('trusted SHA-256 must return lowercase hex');
  }
  return `sha256:${value}`;
}

export class ClosureAcceptanceCheckBuilder {
  constructor(private readonly deps: ClosureAcceptanceCheckBuilderDependencies) {}

  async build(input: Readonly<{
    canonical: TrustedClosureSubject;
    criterion: unknown;
    resolvedMethod: unknown;
  }>): Promise<AcceptanceCheckV06> {
    const subject = closureSubjectV06Schema.parse(input.canonical.subject);
    const criterion = acceptanceCriterionRefV06Schema.parse(input.criterion);
    const verificationMethod = acceptanceVerificationMethodV06Schema.parse(input.resolvedMethod);
    const at = this.deps.now();
    const provisional = acceptanceCheckV06Schema.parse({
      protocolVersion: '0.6',
      id: this.deps.newId(),
      ownerId: input.canonical.ownerId,
      revision: 1,
      digest: `sha256:${'0'.repeat(64)}`,
      subject,
      criterion,
      verificationMethod,
      state: 'active',
      createdAt: at,
      updatedAt: at,
    });
    const digest = assertLowerHex(
      await this.deps.sha256Hex(canonicalizeAcceptanceCheckV06ForDigest(provisional)),
    );
    return Object.freeze(acceptanceCheckV06Schema.parse({ ...provisional, digest }));
  }

  async buildActiveSet(input: Readonly<{
    canonical: TrustedClosureSubject;
    revision: number;
    records: readonly AcceptanceCheckV06[];
  }>): Promise<ActiveAcceptanceCheckSetV06> {
    if (input.records.length === 0) {
      throw new ResponsibilityClosureInvariantError('active AcceptanceCheck set cannot be empty');
    }
    const subject = closureSubjectV06Schema.parse(input.canonical.subject);
    const records = input.records
      .map((record) => acceptanceCheckV06Schema.parse(record))
      .sort((left, right) => compareProtocolIds(left.id, right.id));
    const seen = new Set<string>();
    for (const record of records) {
      if (
        seen.has(record.id) ||
        record.state !== 'active' ||
        record.ownerId !== input.canonical.ownerId ||
        !sameProtocolValue(record.subject, subject)
      ) {
        throw new ResponsibilityClosureInvariantError('active AcceptanceCheck set contains conflicting material');
      }
      const digest = assertLowerHex(
        await this.deps.sha256Hex(canonicalizeAcceptanceCheckV06ForDigest(record)),
      );
      if (record.digest !== digest) {
        throw new ResponsibilityClosureInvariantError('AcceptanceCheck digest mismatch');
      }
      seen.add(record.id);
    }

    const provisional = activeAcceptanceCheckSetV06Schema.parse({
      protocolVersion: '0.6',
      ownerId: input.canonical.ownerId,
      subject,
      revision: input.revision,
      count: records.length,
      digest: `sha256:${'0'.repeat(64)}`,
      acceptanceChecks: records.map((record) => ({
        id: record.id,
        revision: record.revision,
        digest: record.digest,
      })),
      records,
    });
    const digest = assertLowerHex(
      await this.deps.sha256Hex(canonicalizeActiveAcceptanceCheckSetV06ForDigest(provisional)),
    );
    return Object.freeze(activeAcceptanceCheckSetV06Schema.parse({ ...provisional, digest }));
  }
}
