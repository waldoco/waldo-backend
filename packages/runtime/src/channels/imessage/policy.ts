import { z } from 'zod';
import { opaqueIMessageIdSchema as id } from '@waldo/contracts';

// Every bound the iMessage connector enforces, with its provenance. There are no hidden
// defaults: composition must pass a policy, and a missing policy disables the connector.
export const iMessageConnectorPolicySchema = z.strictObject({
  /** Admission-only signature freshness. Future timestamps are always rejected. */
  signatureMaxAgeMs: z.int().positive(),
  /** A heartbeat or capability report older than this makes the bridge offline/disabled. */
  heartbeatMaxAgeMs: z.int().positive(),
  capabilityMaxAgeMs: z.int().positive(),
  /** Raw UTF-8 request body ceiling, enforced before JSON parsing. */
  maxRequestBytes: z.int().positive(),
  /** Aggregate retained bytes and records per bridge/account DO, all tables included. */
  maxRetainedBytes: z.int().positive(),
  maxRecords: z.int().positive(),
  /** Pull never long-polls in this profile. */
  pullMaxWaitMs: z.int().nonnegative(),
  /** A frozen reply not pulled within this window is withdrawn as not_started. */
  deliveryDeadlineMs: z.int().positive(),
  /** A pulled command without a terminal result after this window quarantines the lane. */
  mutationDeadlineMs: z.int().positive(),
  /** Signed commitment lifetime the host must check immediately before native mutation. */
  commitmentMaxAgeMs: z.int().positive(),
  /** Pairing invitation and verification challenge lifetime. */
  setupLifetimeMs: z.int().positive(),
  /** A frozen reply the bridge could not accept (offline, busy, unverified) within this window is not_started. */
  replyHandoffMaxAgeMs: z.int().positive(),
  /** Source/label of these values; never mistaken for provider capacity. */
  source: id,
}).refine((p) => p.deliveryDeadlineMs < p.mutationDeadlineMs, 'delivery deadline must precede mutation deadline')
  .refine((p) => p.commitmentMaxAgeMs <= p.mutationDeadlineMs, 'commitment must expire within the mutation deadline');

export type IMessageConnectorPolicy = z.infer<typeof iMessageConnectorPolicySchema>;

/**
 * PROPOSED local test profile from the backend handoff (section 2, "Bounds and commitment fence").
 * These are not live defaults and not provider capacity. Live use stays disabled until the owner
 * accepts or replaces them.
 */
export const PROPOSED_LOCAL_TEST_POLICY: IMessageConnectorPolicy = iMessageConnectorPolicySchema.parse({
  signatureMaxAgeMs: 60_000,
  heartbeatMaxAgeMs: 90_000,
  capabilityMaxAgeMs: 90_000,
  maxRequestBytes: 128 * 1024,
  maxRetainedBytes: 16 * 1024 * 1024,
  maxRecords: 4096,
  pullMaxWaitMs: 0,
  deliveryDeadlineMs: 20_000,
  mutationDeadlineMs: 30_000,
  commitmentMaxAgeMs: 30_000,
  setupLifetimeMs: 10 * 60_000,
  replyHandoffMaxAgeMs: 10 * 60_000,
  source: 'handoff-2026-10-10-proposed-local-test-profile',
});

export const parseIMessageConnectorPolicy = (input: unknown): IMessageConnectorPolicy | null => {
  const parsed = iMessageConnectorPolicySchema.safeParse(input);
  return parsed.success ? parsed.data : null;
};
