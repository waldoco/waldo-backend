import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
  protocolRevisionSchema,
} from './responsibility-handshake-v0-1';
import { exactRevisionV04Schema } from './responsibility-protocol-v0-4';

const unique = <Value>(values: readonly Value[]): boolean => new Set(values).size === values.length;

export const protocolVersionV05Schema = z.literal('0.5');

export const boundedProtocolReferenceV05Schema = z.strictObject({
  ref: protocolIdSchema,
  digest: protocolDigestSchema,
});

export const judgmentSubjectV05Schema = z.strictObject({
  kind: z.enum(['outcome', 'work_unit']),
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
});

export const authorityGranteeV05Schema = z.strictObject({
  kind: z.enum(['service', 'presence', 'person']),
  id: protocolIdSchema,
});

const authorityResourceV05Schema = z.strictObject({
  kind: protocolNameSchema,
  ref: protocolIdSchema,
});

const authorityResourcesV05Schema = z
  .array(authorityResourceV05Schema)
  .min(1)
  .max(16)
  .refine((values) => unique(values.map((value) => `${value.kind}\u0000${value.ref}`)), {
    error: 'authority resources must be unique',
  });

const authorityScopesV05Schema = z
  .array(protocolNameSchema)
  .min(1)
  .max(32)
  .refine(unique, { error: 'authority scopes must be unique' });

const authorityAudiencesV05Schema = z
  .array(protocolNameSchema)
  .min(1)
  .max(16)
  .refine(unique, { error: 'authority audiences must be unique' });

export const requestedAuthorityV05Schema = z.strictObject({
  purpose: protocolNameSchema,
  effectFamily: protocolNameSchema,
  resources: authorityResourcesV05Schema,
  scopes: authorityScopesV05Schema,
  audiences: authorityAudiencesV05Schema,
  argumentDigest: protocolDigestSchema,
  contextDigest: protocolDigestSchema,
  artifactDigest: protocolDigestSchema.nullable(),
  useLimit: z.literal(1),
  validUntil: iso8601Schema,
});

export const authorityAdmissionV05Schema = z.strictObject({
  grantee: authorityGranteeV05Schema,
  ownerPolicyRevision: protocolRevisionSchema,
  admissionContextDigest: protocolDigestSchema,
});

const judgmentOptionV05Schema = z.strictObject({
  id: protocolIdSchema,
  authorityDisposition: z.enum(['grant', 'refuse']),
  content: boundedProtocolReferenceV05Schema,
});

export const judgmentRequestV05Schema = z
  .strictObject({
    protocolVersion: protocolVersionV05Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: exactRevisionV04Schema,
    subject: judgmentSubjectV05Schema,
    question: boundedProtocolReferenceV05Schema,
    options: z
      .array(judgmentOptionV05Schema)
      .min(2)
      .max(8)
      .refine((values) => unique(values.map((value) => value.id)), {
        error: 'judgment option ids must be unique',
      }),
    recommendation: protocolIdSchema.nullable(),
    uncertainty: boundedProtocolReferenceV05Schema,
    evidence: z
      .array(boundedProtocolReferenceV05Schema)
      .max(16)
      .refine((values) => unique(values.map((value) => value.ref)), {
        error: 'judgment evidence refs must be unique',
      }),
    costOfWaiting: boundedProtocolReferenceV05Schema,
    risk: boundedProtocolReferenceV05Schema,
    reversibility: boundedProtocolReferenceV05Schema,
    affectedDigest: protocolDigestSchema,
    requestedAuthority: requestedAuthorityV05Schema.nullable(),
    authorityAdmission: authorityAdmissionV05Schema.nullable(),
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
      if (request.authorityAdmission === null) {
        context.addIssue({
          code: 'custom',
          path: ['authorityAdmission'],
          message: 'requested authority requires server-created admission context',
        });
      }
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
    } else {
      if (request.authorityAdmission !== null) {
        context.addIssue({
          code: 'custom',
          path: ['authorityAdmission'],
          message: 'admission context requires requested authority',
        });
      }
      if (request.options.some((option) => option.authorityDisposition === 'grant')) {
        context.addIssue({
          code: 'custom',
          path: ['options'],
          message: 'a grant option requires requested authority',
        });
      }
    }
  });

export type JudgmentRequestV05 = z.infer<typeof judgmentRequestV05Schema>;

export function canonicalizeJudgmentRequestV05ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(judgmentRequestV05Schema.parse(value));
}

export const judgmentAnswerRequestV05Schema = z.strictObject({
  protocolVersion: protocolVersionV05Schema,
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

export type JudgmentAnswerRequestV05 = z.infer<typeof judgmentAnswerRequestV05Schema>;

export function canonicalizeJudgmentAnswerRequestV05ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(judgmentAnswerRequestV05Schema.parse(value));
}

const ownerAuthorityActorV05Schema = z.strictObject({
  kind: z.literal('owner'),
  id: protocolIdSchema,
});

export const judgmentDecisionV05Schema = z
  .strictObject({
    protocolVersion: protocolVersionV05Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: exactRevisionV04Schema,
    judgmentRequestId: protocolIdSchema,
    judgmentRequestRevision: exactRevisionV04Schema,
    subject: judgmentSubjectV05Schema,
    selectedOptionId: protocolIdSchema,
    displayedRequestDigest: protocolDigestSchema,
    actor: ownerAuthorityActorV05Schema,
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

export type JudgmentDecisionV05 = z.infer<typeof judgmentDecisionV05Schema>;

export function canonicalizeJudgmentDecisionV05ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(judgmentDecisionV05Schema.parse(value));
}

export const authorityGrantV05Schema = z
  .strictObject({
    protocolVersion: protocolVersionV05Schema,
    id: protocolIdSchema,
    ownerId: protocolIdSchema,
    revision: exactRevisionV04Schema,
    judgmentRequestId: protocolIdSchema,
    judgmentRequestRevision: exactRevisionV04Schema,
    judgmentDecisionId: protocolIdSchema,
    grantor: ownerAuthorityActorV05Schema,
    grantee: authorityGranteeV05Schema,
    subject: z.strictObject({
      kind: z.literal('work_unit'),
      id: protocolIdSchema,
      revision: exactRevisionV04Schema,
    }),
    purpose: protocolNameSchema,
    effectFamily: protocolNameSchema,
    resources: authorityResourcesV05Schema,
    scopes: authorityScopesV05Schema,
    audiences: authorityAudiencesV05Schema,
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

export type AuthorityGrantV05 = z.infer<typeof authorityGrantV05Schema>;

export function canonicalizeAuthorityGrantV05ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(authorityGrantV05Schema.parse(value));
}

const judgmentAnswerResultBaseV05Schema = z.strictObject({
  protocolVersion: protocolVersionV05Schema,
  requestId: protocolIdSchema,
  judgmentRequest: z.strictObject({
    id: protocolIdSchema,
    revision: exactRevisionV04Schema,
  }),
  judgmentDecision: z.strictObject({
    id: protocolIdSchema,
    revision: exactRevisionV04Schema,
  }),
  selectedOptionId: protocolIdSchema,
  projectionCursor: exactRevisionV04Schema,
});

const authorityGrantSummaryV05Schema = z.strictObject({
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
  grantee: authorityGranteeV05Schema,
  state: z.literal('active'),
  expiresAt: iso8601Schema,
  revocationGeneration: protocolRevisionSchema,
});

export const judgmentAnswerResultV05Schema = z.discriminatedUnion(
  'authorityDisposition',
  [
    judgmentAnswerResultBaseV05Schema.extend({
      authorityDisposition: z.literal('granted'),
      grant: authorityGrantSummaryV05Schema,
    }),
    judgmentAnswerResultBaseV05Schema.extend({
      authorityDisposition: z.literal('refused'),
    }),
  ],
);

export type JudgmentAnswerResultV05 = z.infer<typeof judgmentAnswerResultV05Schema>;

export const judgmentAnswerRetrySemanticsV05 = Object.freeze({
  identity: 'requestId',
  exactDuplicate: 'return_persisted_result_byte_for_byte',
  changedDuplicate: 'reject_request_conflict',
} as const);

export const MAX_JUDGMENT_PROJECTION_PAGE_UTF8_BYTES_V05 = 262_144;

export function judgmentProjectionPageUtf8ByteLengthV05(value: unknown): number {
  let bytes = 0;
  for (const character of JSON.stringify(value)) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const judgmentProjectionQueryV05Schema = z.strictObject({
  protocolVersion: protocolVersionV05Schema,
  fromExclusiveCursor: protocolRevisionSchema,
  limit: z.int().min(1).max(256),
  snapshotId: protocolIdSchema.optional(),
});

export type JudgmentProjectionQueryV05 = z.infer<typeof judgmentProjectionQueryV05Schema>;

export const judgmentProjectionItemV05Schema = z.strictObject({
  cursor: exactRevisionV04Schema,
  itemType: z.literal('judgment_request'),
  request: judgmentRequestV05Schema,
  displayedRequestDigest: protocolDigestSchema,
});

export const judgmentProjectionPageV05Schema = z
  .strictObject({
    protocolVersion: protocolVersionV05Schema,
    ownerId: protocolIdSchema,
    projectionName: z.literal('judgment.needs_you'),
    snapshotId: protocolIdSchema,
    snapshotBaseCursor: protocolRevisionSchema,
    fromExclusiveCursor: protocolRevisionSchema,
    highWaterCursor: protocolRevisionSchema,
    nextCursor: protocolRevisionSchema,
    items: z.array(judgmentProjectionItemV05Schema).max(256),
    hasMore: z.boolean(),
    generatedAt: iso8601Schema,
  })
  .superRefine((page, context) => {
    if (page.snapshotBaseCursor > page.fromExclusiveCursor) {
      context.addIssue({
        code: 'custom',
        path: ['snapshotBaseCursor'],
        message: 'snapshot base cursor must not exceed the requested cursor',
      });
    }
    let cursor = page.fromExclusiveCursor;
    for (const [index, item] of page.items.entries()) {
      if (item.cursor <= cursor || item.cursor > page.highWaterCursor) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'cursor'],
          message: 'projection items must be strictly ordered within the cursor envelope',
        });
      }
      if (item.request.ownerId !== page.ownerId) {
        context.addIssue({
          code: 'custom',
          path: ['items', index, 'request', 'ownerId'],
          message: 'projection items must belong to the page owner',
        });
      }
      cursor = item.cursor;
    }
    if (
      page.nextCursor !== cursor ||
      page.nextCursor > page.highWaterCursor ||
      page.hasMore !== (page.nextCursor < page.highWaterCursor)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['nextCursor'],
        message: 'projection cursor envelope is inconsistent',
      });
    }
    if (
      judgmentProjectionPageUtf8ByteLengthV05(page) >
      MAX_JUDGMENT_PROJECTION_PAGE_UTF8_BYTES_V05
    ) {
      context.addIssue({
        code: 'custom',
        message: 'judgment projection page exceeds byte limit',
      });
    }
  });

export type JudgmentProjectionPageV05 = z.infer<typeof judgmentProjectionPageV05Schema>;

export class JudgmentProjectionDigestMismatchErrorV05 extends Error {
  constructor() {
    super('displayedRequestDigest must equal SHA-256 of the canonical embedded request');
    this.name = 'JudgmentProjectionDigestMismatchErrorV05';
  }
}

function sameProtocolValue(left: unknown, right: unknown): boolean {
  return canonicalizeProtocolJson(left) === canonicalizeProtocolJson(right);
}

const judgmentAuthorityBindingBaseV05Shape = {
  requestDigest: protocolDigestSchema,
  request: judgmentRequestV05Schema,
  answer: judgmentAnswerRequestV05Schema,
  decision: judgmentDecisionV05Schema,
} as const;

export const judgmentAuthorityBindingV05Schema = z
  .discriminatedUnion('authorityDisposition', [
    z.strictObject({
      ...judgmentAuthorityBindingBaseV05Shape,
      authorityDisposition: z.literal('granted'),
      grant: authorityGrantV05Schema,
    }),
    z.strictObject({
      ...judgmentAuthorityBindingBaseV05Shape,
      authorityDisposition: z.literal('refused'),
    }),
  ])
  .superRefine((binding, context) => {
    const { request, answer, decision } = binding;
    const issue = (path: PropertyKey[], message: string) => context.addIssue({
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
    if (
      request.authorityAdmission !== null &&
      decision.ownerPolicyRevision !== request.authorityAdmission.ownerPolicyRevision
    ) {
      issue(
        ['decision', 'ownerPolicyRevision'],
        'decision must bind the displayed owner policy revision',
      );
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
    const admission = request.authorityAdmission;
    if (requested === null || admission === null) {
      issue(['grant'], 'a grant requires requested authority and admission context');
      return;
    }
    if (!sameProtocolValue(grant.grantee, admission.grantee)) {
      issue(['grant', 'grantee'], 'grant must bind the displayed server-derived grantee');
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

export type JudgmentAuthorityBindingV05 = z.infer<typeof judgmentAuthorityBindingV05Schema>;

export type JudgmentAuthoritySha256HexV05 = (canonicalUtf8: string) => string;

function assertTrustedSha256HexV05(digestHex: string): void {
  if (!/^[a-f0-9]{64}$/.test(digestHex)) {
    throw new TypeError('trusted SHA-256 implementation must return 64 lowercase hex characters');
  }
}

/**
 * Verifies the byte-stable snapshot returned by a projection adapter. Runtime
 * admission must still re-read current owner, presence, session, policy,
 * subject, grantee, revocation, revision, and clock state before deciding.
 */
export function createJudgmentProjectionPageVerifierV05(
  sha256Hex: JudgmentAuthoritySha256HexV05,
): (value: unknown) => JudgmentProjectionPageV05 {
  return (value) => {
    const page = judgmentProjectionPageV05Schema.parse(value);
    for (const item of page.items) {
      const digestHex = sha256Hex(canonicalizeJudgmentRequestV05ForDigest(item.request));
      assertTrustedSha256HexV05(digestHex);
      if (item.displayedRequestDigest !== `sha256:${digestHex}`) {
        throw new JudgmentProjectionDigestMismatchErrorV05();
      }
    }
    return page;
  };
}

export class JudgmentAuthorityBindingDigestMismatchErrorV05 extends Error {
  constructor() {
    super('requestDigest must equal SHA-256 of the canonical embedded request');
    this.name = 'JudgmentAuthorityBindingDigestMismatchErrorV05';
  }
}

/**
 * Verifies coherence of one stored request/answer/decision/grant snapshot.
 * It does not prove current identity, presence, session, policy, subject,
 * grantee, revocation, revision, or clock state; runtime admission must re-read
 * and validate those authoritative values.
 */
export function createJudgmentAuthorityBindingVerifierV05(
  sha256Hex: JudgmentAuthoritySha256HexV05,
): (value: unknown) => JudgmentAuthorityBindingV05 {
  return (value) => {
    const binding = judgmentAuthorityBindingV05Schema.parse(value);
    const digestHex = sha256Hex(canonicalizeJudgmentRequestV05ForDigest(binding.request));
    assertTrustedSha256HexV05(digestHex);
    if (binding.requestDigest !== `sha256:${digestHex}`) {
      throw new JudgmentAuthorityBindingDigestMismatchErrorV05();
    }
    return binding;
  };
}
