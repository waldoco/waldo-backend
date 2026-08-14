import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  deterministicArtifactVerificationMethodV04Schema,
  deterministicReadBackVerificationMethodV04Schema,
} from './responsibility-acceptance-check-v0-4';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
} from './responsibility-handshake-v0-1';
import { responsibilityCaptureTextV02Schema } from './responsibility-handshake-v0-2';
import { exactRevisionV04Schema, protocolVersionV04Schema } from './responsibility-protocol-v0-4';

export const outcomeObligationBindingV04Schema = z.strictObject({
  ownerId: protocolIdSchema,
  outcome: z.strictObject({
    id: protocolIdSchema,
    revision: exactRevisionV04Schema,
  }),
});
export type OutcomeObligationBindingV04 = z.infer<typeof outcomeObligationBindingV04Schema>;

export const outcomeAcceptanceCriterionV04Schema = z.strictObject({
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
  criterion: responsibilityCaptureTextV02Schema.max(2_048),
  verificationMethod: z.discriminatedUnion('kind', [
    deterministicReadBackVerificationMethodV04Schema,
    deterministicArtifactVerificationMethodV04Schema,
  ]),
});
export type OutcomeAcceptanceCriterionV04 = z.infer<typeof outcomeAcceptanceCriterionV04Schema>;

export const obligationAccountabilityV04Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('self') }),
  z.strictObject({ kind: z.literal('person'), ref: protocolIdSchema }),
  z.strictObject({ kind: z.literal('organization'), ref: protocolIdSchema }),
]);

export const obligationConsequenceV04Schema = z.strictObject({
  kind: z.enum(['commitment_breach', 'missed_opportunity', 'wellbeing_cost', 'other']),
  statementRef: protocolIdSchema,
  statementDigest: protocolDigestSchema,
});

export const obligationTemporalBindingV04Schema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('hard_deadline'), at: iso8601Schema }),
  z
    .strictObject({
      kind: z.literal('soft_window'),
      startsAt: iso8601Schema,
      endsAt: iso8601Schema,
    })
    .refine((value) => Date.parse(value.endsAt) > Date.parse(value.startsAt), {
      path: ['endsAt'],
      error: 'soft window must end after it starts',
    }),
  z.strictObject({ kind: z.literal('open_ended') }),
]);

export const declaredOutcomeAcceptanceCriteriaV04Schema = z.strictObject({
  state: z.literal('declared'),
  revision: exactRevisionV04Schema,
  proposals: z
    .array(
      z.strictObject({
        id: protocolIdSchema,
        revision: exactRevisionV04Schema,
        digest: protocolDigestSchema,
      }),
    )
    .min(1)
    .max(16),
});

export const confirmedOutcomeAcceptanceCriteriaV04Schema = z.strictObject({
  state: z.literal('confirmed'),
  revision: exactRevisionV04Schema,
  digest: protocolDigestSchema,
  checks: z.array(outcomeAcceptanceCriterionV04Schema).min(1).max(16),
});
export type DeclaredOutcomeAcceptanceCriteriaV04 = z.infer<
  typeof declaredOutcomeAcceptanceCriteriaV04Schema
>;

export const absentOutcomeAcceptanceCriteriaV04Schema = z.strictObject({
  state: z.literal('absent_by_owner_choice'),
});

export const declinedOutcomeAcceptanceCriteriaV04Schema = z.strictObject({
  state: z.literal('declined'),
});

export const outcomeAcceptanceCriteriaStateV04Schema = z.discriminatedUnion('state', [
  declaredOutcomeAcceptanceCriteriaV04Schema,
  confirmedOutcomeAcceptanceCriteriaV04Schema,
  absentOutcomeAcceptanceCriteriaV04Schema,
  declinedOutcomeAcceptanceCriteriaV04Schema,
]);
export type OutcomeAcceptanceCriteriaStateV04 = z.infer<
  typeof outcomeAcceptanceCriteriaStateV04Schema
>;

/**
 * OutcomeModule-owned snapshot of owner-stated acceptance criteria disposition.
 * Provider, effect, evidence, verification, acceptance, and closure observations are excluded.
 */
export const outcomeObligationContextV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  outcome: outcomeObligationBindingV04Schema.shape.outcome,
  accountability: obligationAccountabilityV04Schema,
  consequence: obligationConsequenceV04Schema,
  temporalBinding: obligationTemporalBindingV04Schema,
  acceptanceCriteria: outcomeAcceptanceCriteriaStateV04Schema,
  recordedAt: iso8601Schema,
});
export type OutcomeObligationContextV04 = z.infer<typeof outcomeObligationContextV04Schema>;

export function canonicalizeConfirmedOutcomeAcceptanceCriteriaV04ForDigest(value: unknown): string {
  const context = outcomeObligationContextV04Schema.parse(value);
  if (context.acceptanceCriteria.state !== 'confirmed') {
    throw new TypeError('only confirmed acceptance criteria have canonical digest bytes');
  }
  const { digest: _assertedDigest, ...criteria } = context.acceptanceCriteria;
  return canonicalizeProtocolJson({
    protocolVersion: context.protocolVersion,
    ownerId: context.ownerId,
    outcome: context.outcome,
    acceptanceCriteria: criteria,
  });
}

export type OutcomeObligationContextSha256HexV04 = (canonicalUtf8: string) => string;

export class OutcomeObligationContextBindingMismatchError extends Error {
  constructor() {
    super('obligation context must bind canonical owner and exact Outcome id/revision');
    this.name = 'OutcomeObligationContextBindingMismatchError';
  }
}

export class ConfirmedOutcomeAcceptanceCriteriaDigestMismatchError extends Error {
  constructor() {
    super('confirmed acceptance criteria digest must match canonical criteria bytes');
    this.name = 'ConfirmedOutcomeAcceptanceCriteriaDigestMismatchError';
  }
}

/**
 * Verifies snapshot integrity against a canonical Outcome binding. OutcomeModule must still
 * enforce authenticated owner routing, sole-writer admission, and authoritative current revision.
 */
export function createOutcomeObligationContextBindingVerifierV04(
  sha256Hex: OutcomeObligationContextSha256HexV04,
) {
  const verifyContext = (
    contextValue: unknown,
    bindingValue: unknown,
  ): OutcomeObligationContextV04 => {
    const context = outcomeObligationContextV04Schema.parse(contextValue);
    const binding = outcomeObligationBindingV04Schema.parse(bindingValue);
    if (
      context.ownerId !== binding.ownerId ||
      context.outcome.id !== binding.outcome.id ||
      context.outcome.revision !== binding.outcome.revision
    ) {
      throw new OutcomeObligationContextBindingMismatchError();
    }
    if (context.acceptanceCriteria.state === 'confirmed') {
      const digestHex = sha256Hex(
        canonicalizeConfirmedOutcomeAcceptanceCriteriaV04ForDigest(context),
      );
      if (!/^[a-f0-9]{64}$/.test(digestHex)) {
        throw new TypeError(
          'trusted SHA-256 implementation must return 64 lowercase hex characters',
        );
      }
      if (context.acceptanceCriteria.digest !== `sha256:${digestHex}`) {
        throw new ConfirmedOutcomeAcceptanceCriteriaDigestMismatchError();
      }
    }
    return context;
  };

  return { verifyContext };
}
