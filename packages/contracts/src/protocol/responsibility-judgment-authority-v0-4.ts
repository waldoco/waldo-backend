import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
  protocolRevisionSchema,
} from './responsibility-handshake-v0-1';
import { protocolVersionV04Schema } from './responsibility-acceptance-check-v0-4';

const unique = <Value>(values: readonly Value[]): boolean => new Set(values).size === values.length;
const MAX_AUTHORITY_USES = Number.MAX_SAFE_INTEGER - 1;

export const boundedProtocolReferenceV04Schema = z.strictObject({
  ref: protocolIdSchema,
  digest: protocolDigestSchema,
});

export const judgmentSubjectV04Schema = z.strictObject({
  kind: z.enum(['outcome', 'work_unit']),
  id: protocolIdSchema,
  revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
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

export const authorityResourcesV04Schema = z.array(authorityResourceV04Schema).min(1).max(16)
  .refine((values) => unique(values.map((value) => `${value.kind}\u0000${value.ref}`)), {
    error: 'authority resources must be unique',
  });

export const authorityScopesV04Schema = z.array(protocolNameSchema).min(1).max(32)
  .refine(unique, { error: 'authority scopes must be unique' });

export const authorityAudiencesV04Schema = z.array(protocolNameSchema).min(1).max(16)
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
});

const judgmentOptionV04Schema = z.strictObject({
  id: protocolIdSchema,
  content: boundedProtocolReferenceV04Schema,
});

export const judgmentRequestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  subject: judgmentSubjectV04Schema,
  question: boundedProtocolReferenceV04Schema,
  options: z.array(judgmentOptionV04Schema).min(2).max(8)
    .refine((values) => unique(values.map((value) => value.id)), {
      error: 'judgment option ids must be unique',
    }),
  recommendation: protocolIdSchema.nullable(),
  evidence: z.array(boundedProtocolReferenceV04Schema).max(16)
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
}).superRefine((request, context) => {
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
});
export type JudgmentRequestV04 = z.infer<typeof judgmentRequestV04Schema>;

export function canonicalizeJudgmentRequestV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(judgmentRequestV04Schema.parse(value));
}

export const judgmentDecisionV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  judgmentRequestId: protocolIdSchema,
  judgmentRequestRevision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
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
}).superRefine((decision, context) => {
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

export const authorityGrantV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  judgmentRequestId: protocolIdSchema,
  judgmentRequestRevision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  judgmentDecisionId: protocolIdSchema,
  grantor: ownerAuthorityActorV04Schema,
  grantee: authorityGranteeV04Schema,
  subject: z.strictObject({
    kind: z.literal('work_unit'),
    id: protocolIdSchema,
    revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  }),
  purpose: protocolNameSchema,
  effectFamily: protocolNameSchema,
  resources: authorityResourcesV04Schema,
  scopes: authorityScopesV04Schema,
  audiences: authorityAudiencesV04Schema,
  argumentDigest: protocolDigestSchema,
  contextDigest: protocolDigestSchema,
  artifactDigest: protocolDigestSchema.nullable(),
  useLimit: z.int().positive().max(MAX_AUTHORITY_USES),
  usesConsumed: z.int().nonnegative().max(MAX_AUTHORITY_USES),
  nextUseIndex: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  validFrom: iso8601Schema,
  expiresAt: iso8601Schema,
  revocationGeneration: protocolRevisionSchema,
  state: z.enum(['active', 'exhausted', 'expired', 'revoked', 'superseded']),
  createdAt: iso8601Schema,
  updatedAt: iso8601Schema,
}).superRefine((grant, context) => {
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
  if ((grant.state === 'active' && grant.usesConsumed >= grant.useLimit) ||
      (grant.state === 'exhausted' && grant.usesConsumed !== grant.useLimit)) {
    context.addIssue({
      code: 'custom',
      path: ['state'],
      message: 'AuthorityGrant state does not match its use counters',
    });
  }
  const createdAt = Date.parse(grant.createdAt);
  if (Date.parse(grant.updatedAt) < createdAt ||
      Date.parse(grant.validFrom) < createdAt ||
      Date.parse(grant.expiresAt) <= Date.parse(grant.validFrom)) {
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
    expectedRevision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
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
