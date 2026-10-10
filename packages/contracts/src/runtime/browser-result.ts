import { z } from 'zod';

export const browserFailureCodeV1Schema = z.enum(['rejected', 'session_lost', 'provider_unavailable', 'page_unavailable', 'empty_content', 'image_oversize', 'observation_oversize', 'cleanup_unconfirmed', 'stale_observation', 'outcome_uncertain']);
const protocolToken = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
export const browserRetainedStateV1Schema = z.strictObject({
  session_handle: z.uuid(), generation: z.int().positive(), expires_at: z.int().nonnegative(),
  state: z.enum(['unobserved', 'observed', 'allocation_uncertain', 'cleanup_pending', 'cleanup_failed', 'closed']),
  observation_revision: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
});
// Contains host custody and bounded protocol identifiers, never provider prose, credentials or page contents.
export const browserFailureV1Schema = z.strictObject({
  version: z.literal(1), provider: z.literal('cloudflare_playwright'),
  stage: z.enum(['admission', 'allocation', 'navigation', 'observation', 'action', 'cleanup']), code: browserFailureCodeV1Schema,
  retained: browserRetainedStateV1Schema.optional(),
  diagnostic: z.strictObject({ status: z.int().min(0).max(599), code: protocolToken.optional(), request_id: protocolToken.optional() }).optional(),
  cleanup_failed: z.literal(true).optional(), release_failed: z.literal(true).optional(),
  recovery: z.strictObject({ can_cancel: z.boolean(), can_inspect: z.boolean(), can_navigate: z.boolean(), requires_same_session: z.literal(true) }),
});
export type BrowserFailureV1 = z.infer<typeof browserFailureV1Schema>;
export type BrowserFailureCodeV1 = z.infer<typeof browserFailureCodeV1Schema>;
export type BrowserRetainedStateV1 = z.infer<typeof browserRetainedStateV1Schema>;
