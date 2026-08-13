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

const unique = <Value>(values: readonly Value[]): boolean => new Set(values).size === values.length;

export const boundedProtocolReferenceV04Schema = z.strictObject({
  ref: protocolIdSchema,
  digest: protocolDigestSchema,
});

export const judgmentSubjectV04Schema = z.strictObject({
  kind: z.enum(['outcome', 'work_unit']),
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
});

export const authorityResourceV04Schema = z.strictObject({
  kind: protocolNameSchema,
  ref: protocolIdSchema,
});

export const ownerAuthorityActorV04Schema = z.strictObject({
  kind: z.literal('owner'),
  id: protocolIdSchema,
});

export const authorityGranteeV04Schema = z.strictObject({
  kind: z.enum(['service', 'presence', 'person']),
  id: protocolIdSchema,
});

export const authorityResourcesV04Schema = z
  .array(authorityResourceV04Schema)
  .min(1)
  .max(16)
  .refine((values) => unique(values.map((value) => `${value.kind}\u0000${value.ref}`)), {
    error: 'authority resources must be unique',
  });

export const authorityScopesV04Schema = z
  .array(protocolNameSchema)
  .min(1)
  .max(32)
  .refine(unique, { error: 'authority scopes must be unique' });

export const authorityAudiencesV04Schema = z
  .array(protocolNameSchema)
  .min(1)
  .max(16)
  .refine(unique, { error: 'authority audiences must be unique' });

export const requestedAuthorityV04Schema = z.strictObject({
  purpose: protocolNameSchema,
  effectFamily: protocolNameSchema,
  resources: authorityResourcesV04Schema,
  scopes: authorityScopesV04Schema,
  audiences: authorityAudiencesV04Schema,
  argumentDigest: protocolDigestSchema,
  contextDigest: protocolDigestSchema,
  artifactDigest: protocolDigestSchema.nullable(),
  useLimit: z.literal(1),
  validUntil: iso8601Schema,
});

const judgmentOptionV04Schema = z.strictObject({
  id: protocolIdSchema,
  authorityDisposition: z.enum(['grant', 'refuse']),
  content: boundedProtocolReferenceV04Schema,
});

export const judgmentRequestV04Schema = z
  .strictObject({
    protocolVersion: protocolVersionV04Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: exactRevisionV04Schema,
    subject: judgmentSubjectV04Schema,
    question: boundedProtocolReferenceV04Schema,
    options: z
      .array(judgmentOptionV04Schema)
      .min(2)
      .max(8)
      .refine((values) => unique(values.map((value) => value.id)), {
        error: 'judgment option ids must be unique',
      }),
    recommendation: protocolIdSchema.nullable(),
    evidence: z
      .array(boundedProtocolReferenceV04Schema)
      .max(16)
      .refine((values) => unique(values.map((value) => value.ref)), {
        error: 'judgment evidence refs must be unique',
      }),
    risk: boundedProtocolReferenceV04Schema,
    reversibility: boundedProtocolReferenceV04Schema,
    affectedDigest: protocolDigestSchema,
    requestedAuthority: requestedAuthorityV04Schema.nullable(),
    reEntryPointId: protocolIdSchema.nullable(),
    expiresAt: iso8601Schema,
    decisionId: protocolIdSchema.nullable(),
    state: z.enum(['open', 'answered', 'expired', 'withdrawn', 'superseded']),
    createdAt: iso8601Schema,
    updatedAt: iso8601Schema,
  })
  .superRefine((request, context) => {
    const optionIds = new Set(request.options.map((option) => option.id));
    if (request.recommendation !== null && !optionIds.has(request.recommendation)) {
      context.addIssue({
        code: 'custom',
        path: ['recommendation'],
        message: 'recommendation must reference a displayed option',
      });
    }
    if ((request.state === 'answered') !== (request.decisionId !== null)) {
      context.addIssue({
        code: 'custom',
        path: ['decisionId'],
        message: 'only an answered JudgmentRequest carries a decision',
      });
    }
    const createdAt = Date.parse(request.createdAt);
    if (Date.parse(request.updatedAt) < createdAt || Date.parse(request.expiresAt) <= createdAt) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'JudgmentRequest timestamps are inconsistent',
      });
    }
    if (request.requestedAuthority !== null) {
      if (request.subject.kind !== 'work_unit') {
        context.addIssue({
          code: 'custom',
          path: ['subject', 'kind'],
          message: 'requested authority must target an exact WorkUnit revision',
        });
      }
      if (!request.options.some((option) => option.authorityDisposition === 'grant')) {
        context.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'requested authority requires at least one grant option',
        });
      }
      const validUntil = Date.parse(request.requestedAuthority.validUntil);
      if (validUntil <= createdAt || validUntil > Date.parse(request.expiresAt)) {
        context.addIssue({
          code: 'custom',
          path: ['requestedAuthority', 'validUntil'],
          message: 'requested authority validity must fit within its JudgmentRequest',
        });
      }
    } else if (request.options.some((option) => option.authorityDisposition === 'grant')) {
      context.addIssue({
        code: 'custom',
        path: ['options'],
        message: 'a grant option requires requested authority',
      });
    }
  });
export type JudgmentRequestV04 = z.infer<typeof judgmentRequestV04Schema>;

export function canonicalizeJudgmentRequestV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(judgmentRequestV04Schema.parse(value));
}

export const judgmentDecisionV04Schema = z
  .strictObject({
    protocolVersion: protocolVersionV04Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: exactRevisionV04Schema,
    judgmentRequestId: protocolIdSchema,
    judgmentRequestRevision: exactRevisionV04Schema,
    subject: judgmentSubjectV04Schema,
    selectedOptionId: protocolIdSchema,
    displayedRequestDigest: protocolDigestSchema,
    actor: ownerAuthorityActorV04Schema,
    presenceId: protocolIdSchema,
    authenticatedSessionId: protocolIdSchema,
    ownerPolicyRevision: protocolRevisionSchema,
    authAssurance: protocolNameSchema,
    state: z.literal('recorded'),
    decidedAt: iso8601Schema,
  })
  .superRefine((decision, context) => {
    if (decision.actor.id !== decision.ownerId) {
      context.addIssue({
        code: 'custom',
        path: ['actor', 'id'],
        message: 'JudgmentDecision actor must match its authenticated owner',
      });
    }
  });
export type JudgmentDecisionV04 = z.infer<typeof judgmentDecisionV04Schema>;

export function canonicalizeJudgmentDecisionV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(judgmentDecisionV04Schema.parse(value));
}

export const authorityGrantV04Schema = z
  .strictObject({
    protocolVersion: protocolVersionV04Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: exactRevisionV04Schema,
    judgmentRequestId: protocolIdSchema,
    judgmentRequestRevision: exactRevisionV04Schema,
    judgmentDecisionId: protocolIdSchema,
    grantor: ownerAuthorityActorV04Schema,
    grantee: authorityGranteeV04Schema,
    subject: z.strictObject({
      kind: z.literal('work_unit'),
      id: protocolIdSchema,
      revision: exactRevisionV04Schema,
    }),
    purpose: protocolNameSchema,
    effectFamily: protocolNameSchema,
    resources: authorityResourcesV04Schema,
    scopes: authorityScopesV04Schema,
    audiences: authorityAudiencesV04Schema,
    argumentDigest: protocolDigestSchema,
    contextDigest: protocolDigestSchema,
    artifactDigest: protocolDigestSchema.nullable(),
    useLimit: z.literal(1),
    usesConsumed: z.int().min(0).max(1),
    nextUseIndex: z.int().min(1).max(2),
    validFrom: iso8601Schema,
    expiresAt: iso8601Schema,
    revocationGeneration: protocolRevisionSchema,
    state: z.enum(['active', 'exhausted', 'expired', 'revoked', 'superseded']),
    createdAt: iso8601Schema,
    updatedAt: iso8601Schema,
  })
  .superRefine((grant, context) => {
    if (grant.grantor.id !== grant.ownerId) {
      context.addIssue({
        code: 'custom',
        path: ['grantor', 'id'],
        message: 'owner grantor must match AuthorityGrant owner',
      });
    }
    if (grant.usesConsumed > grant.useLimit || grant.nextUseIndex !== grant.usesConsumed + 1) {
      context.addIssue({
        code: 'custom',
        path: ['usesConsumed'],
        message: 'AuthorityGrant use counters are inconsistent',
      });
    }
    if (
      (grant.state === 'active' && grant.usesConsumed >= grant.useLimit) ||
      (grant.state === 'exhausted' && grant.usesConsumed !== grant.useLimit)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['state'],
        message: 'AuthorityGrant state does not match its use counters',
      });
    }
    const createdAt = Date.parse(grant.createdAt);
    if (
      Date.parse(grant.updatedAt) < createdAt ||
      Date.parse(grant.validFrom) < createdAt ||
      Date.parse(grant.expiresAt) <= Date.parse(grant.validFrom)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['expiresAt'],
        message: 'AuthorityGrant validity window is inconsistent',
      });
    }
  });
export type AuthorityGrantV04 = z.infer<typeof authorityGrantV04Schema>;

export function canonicalizeAuthorityGrantV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(authorityGrantV04Schema.parse(value));
}

export const judgmentAnswerRequestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  requestId: protocolIdSchema,
  commandType: z.literal('judgment.answer'),
  presenceRegistrationId: protocolIdSchema,
  aggregate: z.strictObject({
    kind: z.literal('judgment_request'),
    id: protocolIdSchema,
    expectedRevision: exactRevisionV04Schema,
  }),
  correlationId: protocolIdSchema.optional(),
  clientIssuedAt: iso8601Schema,
  payload: z.strictObject({
    selectedOptionId: protocolIdSchema,
    displayedRequestDigest: protocolDigestSchema,
  }),
});
export type JudgmentAnswerRequestV04 = z.infer<typeof judgmentAnswerRequestV04Schema>;

export function canonicalizeJudgmentAnswerRequestV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(judgmentAnswerRequestV04Schema.parse(value));
}

function sameProtocolValue(left: unknown, right: unknown): boolean {
  return canonicalizeProtocolJson(left) === canonicalizeProtocolJson(right);
}

const judgmentAuthorityBindingBaseV04Shape = {
  requestDigest: protocolDigestSchema,
  request: judgmentRequestV04Schema,
  answer: judgmentAnswerRequestV04Schema,
  decision: judgmentDecisionV04Schema,
} as const;

export const judgmentAuthorityBindingV04Schema = z
  .discriminatedUnion('authorityDisposition', [
    z.strictObject({
      ...judgmentAuthorityBindingBaseV04Shape,
      authorityDisposition: z.literal('granted'),
      grant: authorityGrantV04Schema,
    }),
    z.strictObject({
      ...judgmentAuthorityBindingBaseV04Shape,
      authorityDisposition: z.literal('refused'),
    }),
  ])
  .superRefine((binding, context) => {
    const { request, answer, decision } = binding;
    const issue = (path: PropertyKey[], message: string) =>
      context.addIssue({
        code: 'custom',
        path,
        message,
      });

    if (
      answer.aggregate.id !== request.id ||
      answer.aggregate.expectedRevision !== request.revision
    ) {
      issue(['answer', 'aggregate'], 'answer must bind the exact JudgmentRequest revision');
    }
    if (!request.options.some((option) => option.id === answer.payload.selectedOptionId)) {
      issue(['answer', 'payload', 'selectedOptionId'], 'answer must select a displayed option');
    }
    if (answer.payload.displayedRequestDigest !== binding.requestDigest) {
      issue(
        ['answer', 'payload', 'displayedRequestDigest'],
        'answer must bind the displayed request',
      );
    }
    if (decision.ownerId !== request.ownerId || decision.actor.id !== request.ownerId) {
      issue(['decision', 'ownerId'], 'decision must bind the JudgmentRequest owner');
    }
    if (
      decision.judgmentRequestId !== request.id ||
      decision.judgmentRequestRevision !== request.revision
    ) {
      issue(
        ['decision', 'judgmentRequestId'],
        'decision must bind the exact JudgmentRequest revision',
      );
    }
    if (!sameProtocolValue(decision.subject, request.subject)) {
      issue(['decision', 'subject'], 'decision must bind the JudgmentRequest subject');
    }
    if (decision.selectedOptionId !== answer.payload.selectedOptionId) {
      issue(['decision', 'selectedOptionId'], 'decision must record the authenticated answer');
    }
    if (decision.displayedRequestDigest !== binding.requestDigest) {
      issue(['decision', 'displayedRequestDigest'], 'decision must bind the displayed request');
    }
    if (request.state !== 'open' || request.decisionId !== null) {
      issue(
        ['request', 'state'],
        'authority decisions require the exact open, unanswered JudgmentRequest snapshot',
      );
    }
    const decisionAt = Date.parse(decision.decidedAt);
    if (
      decisionAt < Date.parse(request.createdAt) ||
      decisionAt < Date.parse(request.updatedAt) ||
      decisionAt >= Date.parse(request.expiresAt)
    ) {
      issue(
        ['decision', 'decidedAt'],
        'decision must occur after the current request snapshot and before its expiry',
      );
    }
    const selectedOption = request.options.find(
      (option) => option.id === decision.selectedOptionId,
    );
    if (binding.authorityDisposition === 'refused') {
      if (selectedOption?.authorityDisposition !== 'refuse') {
        issue(
          ['authorityDisposition'],
          'refusal requires a selected option that explicitly refuses authority',
        );
      }
      return;
    }

    if (selectedOption?.authorityDisposition !== 'grant') {
      issue(
        ['grant'],
        'AuthorityGrant requires a selected option that explicitly grants authority',
      );
    }

    const { grant } = binding;
    if (grant.ownerId !== request.ownerId || grant.grantor.id !== request.ownerId) {
      issue(['grant', 'ownerId'], 'grant must bind the JudgmentRequest owner');
    }
    if (
      grant.judgmentRequestId !== request.id ||
      grant.judgmentRequestRevision !== request.revision ||
      grant.judgmentDecisionId !== decision.id
    ) {
      issue(['grant', 'judgmentRequestId'], 'grant must bind the exact request and decision');
    }
    if (!sameProtocolValue(grant.subject, request.subject)) {
      issue(['grant', 'subject'], 'grant must bind the JudgmentRequest work unit');
    }

    const requested = request.requestedAuthority;
    if (requested === null) {
      issue(['grant'], 'a grant requires requested authority');
      return;
    }
    for (const field of [
      'purpose',
      'effectFamily',
      'resources',
      'scopes',
      'audiences',
      'argumentDigest',
      'contextDigest',
      'artifactDigest',
      'useLimit',
    ] as const) {
      if (!sameProtocolValue(grant[field], requested[field])) {
        issue(['grant', field], `grant ${field} must not widen or replace requested authority`);
      }
    }
    if (
      Date.parse(grant.expiresAt) > Date.parse(request.expiresAt) ||
      Date.parse(grant.expiresAt) > Date.parse(requested.validUntil)
    ) {
      issue(
        ['grant', 'expiresAt'],
        'grant validity must not outlive its JudgmentRequest authority',
      );
    }
    const grantCreatedAt = Date.parse(grant.createdAt);
    const grantValidFrom = Date.parse(grant.validFrom);
    const grantExpiresAt = Date.parse(grant.expiresAt);
    if (grantCreatedAt < decisionAt) {
      issue(['grant', 'createdAt'], 'grant creation cannot predate its authenticated decision');
    }
    if (grantValidFrom < grantCreatedAt || grantExpiresAt <= grantValidFrom) {
      issue(
        ['grant', 'validFrom'],
        'grant authority must satisfy decision <= createdAt <= validFrom < expiresAt',
      );
    }
  });
export type JudgmentAuthorityBindingV04 = z.infer<typeof judgmentAuthorityBindingV04Schema>;

export type JudgmentAuthoritySha256HexV04 = (canonicalUtf8: string) => string;

export class JudgmentAuthorityBindingDigestMismatchError extends Error {
  constructor() {
    super('requestDigest must equal SHA-256 of the canonical embedded request');
    this.name = 'JudgmentAuthorityBindingDigestMismatchError';
  }
}

/**
 * Creates a snapshot-integrity and binding verifier. The supplied implementation must compute
 * lowercase SHA-256 hex over the canonical UTF-8 request. This is insufficient for final live
 * authority admission; JudgmentAuthorityModule must supply authoritative current-state and clock
 * checks at admission time.
 */
export function createJudgmentAuthorityBindingVerifierV04(
  sha256Hex: JudgmentAuthoritySha256HexV04,
): (value: unknown) => JudgmentAuthorityBindingV04 {
  return (value) => {
    const binding = judgmentAuthorityBindingV04Schema.parse(value);
    const digestHex = sha256Hex(canonicalizeJudgmentRequestV04ForDigest(binding.request));
    if (!/^[a-f0-9]{64}$/.test(digestHex)) {
      throw new TypeError('trusted SHA-256 implementation must return 64 lowercase hex characters');
    }
    if (binding.requestDigest !== `sha256:${digestHex}`) {
      throw new JudgmentAuthorityBindingDigestMismatchError();
    }
    return binding;
  };
}
