import { z } from 'zod';

// Distinct public namespaces prevent runtime/database IDs from being passed through merely because
// they are non-UUID strings. HEY-154 owns the one-way mapping into these namespaces.
export const publicBriefIdSchema = z.string().regex(/^brief_[A-Za-z0-9_-]{16,96}$/);
export const publicBriefCardIdSchema = z.string().regex(/^card_[A-Za-z0-9_-]{16,96}$/);
export const publicEvidenceIdSchema = z.string().regex(/^evref_[A-Za-z0-9_-]{16,96}$/);

export const publicEvidenceRefSchema = z.strictObject({
  ref: publicEvidenceIdSchema,
});
export type PublicEvidenceRef = z.infer<typeof publicEvidenceRefSchema>;

export const publicMorningBriefCardKindSchema = z.enum(['brief_card', 'context_card']);
export type PublicMorningBriefCardKind = z.infer<typeof publicMorningBriefCardKindSchema>;

// title/body are admitted only after HEY-13's Scribe boundary. This public schema constrains the
// egress shape and size; it does not duplicate Scribe's content-policy implementation.
export const publicMorningBriefCardSchema = z.strictObject({
  id: publicBriefCardIdSchema,
  kind: publicMorningBriefCardKindSchema,
  title: z.string().trim().min(1).max(120),
  body: z.string().trim().min(1).max(2_000),
  evidence: z.array(publicEvidenceRefSchema).max(8),
});
export type PublicMorningBriefCard = z.infer<typeof publicMorningBriefCardSchema>;

export const publicMorningBriefReadySchema = z
  .strictObject({
    status: z.literal('ready'),
    brief_id: publicBriefIdSchema,
    revision: z.int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    variant: z.literal('morning'),
    cards: z.array(publicMorningBriefCardSchema).min(1).max(20),
    generated_at: z.iso.datetime(),
    source_updated_at: z.iso.datetime(),
    stale_at: z.iso.datetime(),
    as_of: z.iso.datetime(),
    freshness: z.enum(['fresh', 'stale']),
  })
  .superRefine((value, ctx) => {
    const generatedAt = Date.parse(value.generated_at);
    const sourceUpdatedAt = Date.parse(value.source_updated_at);
    const staleAt = Date.parse(value.stale_at);
    const asOf = Date.parse(value.as_of);
    if (sourceUpdatedAt > generatedAt) {
      ctx.addIssue({ code: 'custom', path: ['source_updated_at'], message: 'must not follow generated_at' });
    }
    if (staleAt <= generatedAt) {
      ctx.addIssue({ code: 'custom', path: ['stale_at'], message: 'must follow generated_at' });
    }
    if (asOf < generatedAt) {
      ctx.addIssue({ code: 'custom', path: ['as_of'], message: 'must not precede generated_at' });
    }
    const expectedFreshness = asOf < staleAt ? 'fresh' : 'stale';
    if (value.freshness !== expectedFreshness) {
      ctx.addIssue({ code: 'custom', path: ['freshness'], message: 'must match stale_at at as_of' });
    }
  });
export type PublicMorningBriefReady = z.infer<typeof publicMorningBriefReadySchema>;

export const publicMorningBriefPendingSchema = z.strictObject({
  status: z.literal('pending'),
  as_of: z.iso.datetime(),
  retry_after_seconds: z.int().min(1).max(300),
});
export type PublicMorningBriefPending = z.infer<typeof publicMorningBriefPendingSchema>;

export const publicMorningBriefEmptyReasonSchema = z.enum([
  'not_generated',
  'no_eligible_content',
]);
export type PublicMorningBriefEmptyReason = z.infer<typeof publicMorningBriefEmptyReasonSchema>;

export const publicMorningBriefEmptySchema = z.strictObject({
  status: z.literal('empty'),
  as_of: z.iso.datetime(),
  reason: publicMorningBriefEmptyReasonSchema,
});
export type PublicMorningBriefEmpty = z.infer<typeof publicMorningBriefEmptySchema>;

export const publicMorningBriefResponseSchema = z.discriminatedUnion('status', [
  publicMorningBriefReadySchema,
  publicMorningBriefPendingSchema,
  publicMorningBriefEmptySchema,
]);
export type PublicMorningBriefResponse = z.infer<typeof publicMorningBriefResponseSchema>;

export const waldoProblemCodeV1Schema = z.enum([
  'unauthorized',
  'forbidden',
  'not_found',
  'not_acceptable',
  'rate_limited',
  'temporarily_unavailable',
  'internal_error',
]);
export type WaldoProblemCodeV1 = z.infer<typeof waldoProblemCodeV1Schema>;

// Content-free by construction: no detail, trace, user, provider, run, journal, or payload field.
const retryAfterSchema = z.int().min(1).max(300);

export const waldoUnauthorizedProblemV1Schema = z.strictObject({
  type: z.literal('https://api.heywaldo.com/problems/unauthorized'),
  title: z.literal('Authentication required'),
  status: z.literal(401),
  code: z.literal('unauthorized'),
});
export const waldoForbiddenProblemV1Schema = z.strictObject({
  type: z.literal('https://api.heywaldo.com/problems/forbidden'),
  title: z.literal('Access forbidden'),
  status: z.literal(403),
  code: z.literal('forbidden'),
});
export const waldoNotFoundProblemV1Schema = z.strictObject({
  type: z.literal('https://api.heywaldo.com/problems/not-found'),
  title: z.literal('Resource not found'),
  status: z.literal(404),
  code: z.literal('not_found'),
});
export const waldoNotAcceptableProblemV1Schema = z.strictObject({
  type: z.literal('https://api.heywaldo.com/problems/not-acceptable'),
  title: z.literal('Unsupported representation'),
  status: z.literal(406),
  code: z.literal('not_acceptable'),
});
export const waldoRateLimitedProblemV1Schema = z.strictObject({
  type: z.literal('https://api.heywaldo.com/problems/rate-limited'),
  title: z.literal('Rate limited'),
  status: z.literal(429),
  code: z.literal('rate_limited'),
  retry_after_seconds: retryAfterSchema,
});
export const waldoInternalErrorProblemV1Schema = z.strictObject({
  type: z.literal('https://api.heywaldo.com/problems/internal-error'),
  title: z.literal('Internal error'),
  status: z.literal(500),
  code: z.literal('internal_error'),
});
export const waldoTemporarilyUnavailableProblemV1Schema = z.strictObject({
  type: z.literal('https://api.heywaldo.com/problems/temporarily-unavailable'),
  title: z.literal('Temporarily unavailable'),
  status: z.literal(503),
  code: z.literal('temporarily_unavailable'),
  retry_after_seconds: retryAfterSchema,
});

export const waldoProblemV1Schema = z.discriminatedUnion('code', [
  waldoUnauthorizedProblemV1Schema,
  waldoForbiddenProblemV1Schema,
  waldoNotFoundProblemV1Schema,
  waldoNotAcceptableProblemV1Schema,
  waldoRateLimitedProblemV1Schema,
  waldoInternalErrorProblemV1Schema,
  waldoTemporarilyUnavailableProblemV1Schema,
]);
export type WaldoProblemV1 = z.infer<typeof waldoProblemV1Schema>;

export const subjectBoundEtagSchema = z.string().regex(/^"[A-Za-z0-9_-]{32,128}"$/);
export type SubjectBoundEtag = z.infer<typeof subjectBoundEtagSchema>;

// HEY-154 owns the runtime issuer and must derive a distinct validator from the verified subject,
// projection identity, and revision. The contract deliberately does not choose an algorithm,
// accept a precomputed unbound ETag, or handle a secret.
export type SubjectBoundMorningBriefValidatorIssuer = (input: Readonly<{
  verified_subject: string;
  projection_identity: string;
  projection_revision: number;
}>) => SubjectBoundEtag;

export type SubjectBoundMorningBriefRevalidation = Readonly<{
  request_subject: string;
  representation_subject: string;
  if_none_match: string | null;
  current_etag: string;
}>;

// HEY-154 supplies verified subjects and the opaque ETag adapter. A 304 is valid only when both
// bindings match; an ETag replayed across accounts therefore behaves as an ordinary cache miss.
export function canReturnMorningBriefNotModified(
  input: SubjectBoundMorningBriefRevalidation,
): boolean {
  const requestValidator = subjectBoundEtagSchema.safeParse(input.if_none_match);
  const currentValidator = subjectBoundEtagSchema.safeParse(input.current_etag);
  return (
    requestValidator.success &&
    currentValidator.success &&
    input.request_subject.length > 0 &&
    input.request_subject === input.representation_subject &&
    requestValidator.data === currentValidator.data
  );
}
