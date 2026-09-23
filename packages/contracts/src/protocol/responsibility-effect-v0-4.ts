import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
  protocolRevisionSchema,
} from './responsibility-handshake-v0-1';
import { exactRevisionV04Schema, protocolVersionV04Schema } from './responsibility-protocol-v0-4';

const exactAggregateV04Schema = z.strictObject({
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
});

const effectCapabilityV04Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  manifestDigest: protocolDigestSchema,
  eligibilityRevision: exactRevisionV04Schema,
});

const effectAdapterV04Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  manifestDigest: protocolDigestSchema,
});

export const effectIntentV04Schema = z
  .strictObject({
    protocolVersion: protocolVersionV04Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: z.literal(1),
    outcome: exactAggregateV04Schema,
    workUnit: exactAggregateV04Schema,
    judgment: z.strictObject({
      requestId: protocolIdSchema,
      requestRevision: exactRevisionV04Schema,
      decisionId: protocolIdSchema,
      decisionRevision: exactRevisionV04Schema,
    }),
    authority: z.strictObject({
      grantId: protocolIdSchema,
      grantRevision: exactRevisionV04Schema,
      useIndex: z.literal(1),
      revocationGeneration: protocolRevisionSchema,
    }),
    purpose: protocolNameSchema,
    effectFamily: protocolNameSchema,
    argumentDigest: protocolDigestSchema,
    contextDigest: protocolDigestSchema,
    artifactDigest: protocolDigestSchema.nullable(),
    capability: effectCapabilityV04Schema,
    adapter: effectAdapterV04Schema,
    reconciliationKey: protocolIdSchema,
    lease: z.strictObject({
      id: protocolIdSchema,
      fencingGeneration: exactRevisionV04Schema,
    }),
    cancellationGeneration: protocolRevisionSchema,
    expiresAt: iso8601Schema,
    frozenAt: iso8601Schema,
    state: z.literal('frozen'),
    intentDigest: protocolDigestSchema,
  })
  .superRefine((intent, context) => {
    if (Date.parse(intent.expiresAt) <= Date.parse(intent.frozenAt)) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'EffectIntent must expire after it is frozen',
      });
    }
  });
export type EffectIntentV04 = z.infer<typeof effectIntentV04Schema>;

export function canonicalizeEffectIntentV04ForDigest(value: unknown): string {
  const { intentDigest: _intentDigest, ...canonicalBody } = effectIntentV04Schema.parse(value);
  return canonicalizeProtocolJson(canonicalBody);
}

export const effectReceiptV04Schema = z
  .strictObject({
    protocolVersion: protocolVersionV04Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    intentId: protocolIdSchema,
    intentDigest: protocolDigestSchema,
    reconciliationKey: protocolIdSchema,
    adapter: effectAdapterV04Schema,
    attempt: z.int().min(1).max(2),
    adapterOutcome: z.enum([
      'reported_applied',
      'reported_not_applied',
      'rejected',
      'failed',
      'timed_out',
    ]),
    externalEffectRef: protocolIdSchema.nullable(),
    observation: z.strictObject({
      ref: protocolIdSchema,
      digest: protocolDigestSchema,
    }),
    issuedAt: iso8601Schema,
    observedAt: iso8601Schema,
    state: z.literal('observed'),
  })
  .superRefine((receipt, context) => {
    if (Date.parse(receipt.observedAt) < Date.parse(receipt.issuedAt)) {
      context.addIssue({
        code: 'custom',
        path: ['observedAt'],
        message: 'EffectReceipt observation cannot predate issue',
      });
    }
    if (receipt.adapterOutcome === 'reported_applied' && receipt.externalEffectRef === null) {
      context.addIssue({
        code: 'custom',
        path: ['externalEffectRef'],
        message: 'reported applied receipt requires a bounded external effect reference',
      });
    }
  });
export type EffectReceiptV04 = z.infer<typeof effectReceiptV04Schema>;

const reconciliationCommonV04Shape = {
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  intentId: protocolIdSchema,
  intentDigest: protocolDigestSchema,
  reconciliationKey: protocolIdSchema,
  revision: exactRevisionV04Schema,
  attempt: z.int().min(1).max(2),
  checkedAt: iso8601Schema,
} as const;

const reconciliationObservationV04Shape = {
  ref: protocolIdSchema,
  digest: protocolDigestSchema,
} as const;

export const effectReconciliationV04Schema = z.discriminatedUnion('state', [
  z.strictObject({
    ...reconciliationCommonV04Shape,
    state: z.literal('issue'),
    attempt: z.literal(1),
    basis: z.literal('no_prior_issue'),
  }),
  z.strictObject({
    ...reconciliationCommonV04Shape,
    state: z.literal('authoritative_not_applied'),
    receiptId: protocolIdSchema,
    observation: z.strictObject({
      ...reconciliationObservationV04Shape,
      kind: z.literal('authoritative_read_back'),
    }),
  }),
  z.strictObject({
    ...reconciliationCommonV04Shape,
    state: z.literal('applied'),
    receiptId: protocolIdSchema,
    externalEffectRef: protocolIdSchema,
    observation: z.strictObject({
      ...reconciliationObservationV04Shape,
      kind: z.literal('applied_found'),
    }),
  }),
  z.strictObject({
    ...reconciliationCommonV04Shape,
    state: z.literal('unavailable'),
    receiptId: protocolIdSchema,
    observation: z.strictObject({
      ...reconciliationObservationV04Shape,
      kind: z.literal('read_back_unavailable'),
    }),
  }),
  z.strictObject({
    ...reconciliationCommonV04Shape,
    state: z.literal('unknown'),
    receiptId: protocolIdSchema,
    observation: z.strictObject({
      ...reconciliationObservationV04Shape,
      kind: z.literal('application_unknown'),
    }),
  }),
  z.strictObject({
    ...reconciliationCommonV04Shape,
    state: z.literal('retry_admitted'),
    attempt: z.literal(1),
    basis: z.strictObject({
      kind: z.literal('authoritative_not_applied'),
      reconciliationId: protocolIdSchema,
      digest: protocolDigestSchema,
    }),
    retryOwner: z.literal('effect_engine'),
    nextAttempt: z.literal(2),
    remainingAttempts: z.literal(0),
  }),
  z.strictObject({
    ...reconciliationCommonV04Shape,
    state: z.literal('terminal_ambiguity'),
    basis: z.strictObject({
      kind: z.enum(['unavailable', 'unknown']),
      reconciliationId: protocolIdSchema,
      digest: protocolDigestSchema,
    }),
  }),
]);
export type EffectReconciliationV04 = z.infer<typeof effectReconciliationV04Schema>;

export function canonicalizeEffectReconciliationV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(effectReconciliationV04Schema.parse(value));
}

export type ResponsibilityEffectSha256HexV04 = (canonicalUtf8: string) => string;

export class EffectIntentDigestMismatchError extends Error {
  constructor() {
    super('intentDigest must equal SHA-256 of the canonical frozen EffectIntent');
    this.name = 'EffectIntentDigestMismatchError';
  }
}

export class EffectIntentBindingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectIntentBindingConflictError';
  }
}

export class EffectReceiptBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectReceiptBindingMismatchError';
  }
}

export class EffectReconciliationBindingMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EffectReconciliationBindingMismatchError';
  }
}

/**
 * Verifies snapshot integrity and cross-record binding only. EffectEngine must still revalidate
 * authoritative live authority, lease, fence, cancellation, capability eligibility, and clock
 * state when admitting an operation.
 */
export function createResponsibilityEffectBindingVerifierV04(
  sha256Hex: ResponsibilityEffectSha256HexV04,
) {
  const verifyIntent = (value: unknown): EffectIntentV04 => {
    const intent = effectIntentV04Schema.parse(value);
    const digestHex = sha256Hex(canonicalizeEffectIntentV04ForDigest(intent));
    if (!/^[a-f0-9]{64}$/.test(digestHex)) {
      throw new TypeError('trusted SHA-256 implementation must return 64 lowercase hex characters');
    }
    if (intent.intentDigest !== `sha256:${digestHex}`) {
      throw new EffectIntentDigestMismatchError();
    }
    return intent;
  };

  const admitIntentReplay = (existingValue: unknown, candidateValue: unknown) => {
    const existing = verifyIntent(existingValue);
    const candidate = verifyIntent(candidateValue);
    const existingCanonical = canonicalizeProtocolJson(existing);
    const candidateCanonical = canonicalizeProtocolJson(candidate);
    if (existingCanonical === candidateCanonical) {
      return { disposition: 'exact_replay' as const, intent: existing };
    }
    if (
      existing.ownerId === candidate.ownerId &&
      existing.authority.grantId === candidate.authority.grantId &&
      existing.authority.useIndex === candidate.authority.useIndex
    ) {
      throw new EffectIntentBindingConflictError(
        'grant/use binding already belongs to a different EffectIntent digest',
      );
    }
    if (
      existing.ownerId === candidate.ownerId &&
      existing.reconciliationKey === candidate.reconciliationKey
    ) {
      throw new EffectIntentBindingConflictError(
        'reconciliation key already belongs to a different EffectIntent digest',
      );
    }
    return { disposition: 'new_intent' as const, intent: candidate };
  };

  const verifyReceiptBinding = (intentValue: unknown, receiptValue: unknown): EffectReceiptV04 => {
    const intent = verifyIntent(intentValue);
    const receipt = effectReceiptV04Schema.parse(receiptValue);
    if (receipt.ownerId !== intent.ownerId) {
      throw new EffectReceiptBindingMismatchError(
        'EffectReceipt owner must match its EffectIntent',
      );
    }
    if (receipt.intentId !== intent.id || receipt.intentDigest !== intent.intentDigest) {
      throw new EffectReceiptBindingMismatchError(
        'EffectReceipt must bind the exact EffectIntent digest',
      );
    }
    if (receipt.reconciliationKey !== intent.reconciliationKey) {
      throw new EffectReceiptBindingMismatchError(
        'EffectReceipt reconciliation key must match its EffectIntent',
      );
    }
    if (canonicalizeProtocolJson(receipt.adapter) !== canonicalizeProtocolJson(intent.adapter)) {
      throw new EffectReceiptBindingMismatchError(
        'EffectReceipt adapter identity must match its EffectIntent',
      );
    }
    if (
      Date.parse(receipt.issuedAt) < Date.parse(intent.frozenAt) ||
      Date.parse(receipt.issuedAt) >= Date.parse(intent.expiresAt)
    ) {
      throw new EffectReceiptBindingMismatchError(
        'EffectReceipt issue must occur after intent freeze and before expiry',
      );
    }
    return receipt;
  };

  const verifyReconciliationIntentBinding = (
    intentValue: unknown,
    reconciliationValue: unknown,
  ): EffectReconciliationV04 => {
    const intent = verifyIntent(intentValue);
    const reconciliation = effectReconciliationV04Schema.parse(reconciliationValue);
    if (reconciliation.ownerId !== intent.ownerId) {
      throw new EffectReconciliationBindingMismatchError(
        'effect reconciliation owner must match its EffectIntent',
      );
    }
    if (
      reconciliation.intentId !== intent.id ||
      reconciliation.intentDigest !== intent.intentDigest
    ) {
      throw new EffectReconciliationBindingMismatchError(
        'effect reconciliation must bind the exact EffectIntent digest',
      );
    }
    if (reconciliation.reconciliationKey !== intent.reconciliationKey) {
      throw new EffectReconciliationBindingMismatchError(
        'effect reconciliation key must match its EffectIntent',
      );
    }
    return reconciliation;
  };

  const verifyReconciliationBinding = (
    intentValue: unknown,
    reconciliationValue: unknown,
    referencedValue?: unknown,
  ): EffectReconciliationV04 => {
    const reconciliation = verifyReconciliationIntentBinding(intentValue, reconciliationValue);
    if (
      reconciliation.state !== 'retry_admitted' &&
      reconciliation.state !== 'terminal_ambiguity'
    ) {
      return reconciliation;
    }
    if (referencedValue === undefined) {
      throw new EffectReconciliationBindingMismatchError(
        'reconciliation transition requires its referenced prior record',
      );
    }
    const referenced = verifyReconciliationIntentBinding(intentValue, referencedValue);
    const referencedDigest = `sha256:${sha256Hex(
      canonicalizeEffectReconciliationV04ForDigest(referenced),
    )}`;
    if (
      reconciliation.basis.reconciliationId !== referenced.id ||
      reconciliation.basis.digest !== referencedDigest
    ) {
      throw new EffectReconciliationBindingMismatchError(
        'reconciliation basis must bind the exact referenced record ID and digest',
      );
    }
    if (
      reconciliation.state === 'retry_admitted' &&
      referenced.state !== 'authoritative_not_applied'
    ) {
      throw new EffectReconciliationBindingMismatchError(
        'retry requires the referenced authoritative_not_applied reconciliation record',
      );
    }
    if (
      reconciliation.state === 'terminal_ambiguity' &&
      referenced.state !== reconciliation.basis.kind
    ) {
      throw new EffectReconciliationBindingMismatchError(
        'terminal ambiguity basis must match the referenced unavailable or unknown record',
      );
    }
    return reconciliation;
  };

  return {
    verifyIntent,
    admitIntentReplay,
    verifyReceiptBinding,
    verifyReconciliationBinding,
  };
}
