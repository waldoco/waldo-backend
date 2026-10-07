import { z } from 'zod';
import { canonicalWorkUnitRecordV03Schema } from './responsibility-planning-turn-v0-3';
import { protocolIdSchema } from './responsibility-handshake-v0-1';
import { workUnitRecordV02Schema } from './responsibility-handshake-v0-2';
import { executionAuthorityCeilingV04Schema } from './responsibility-execution-v0-4';

// Execution authorization is a host capability ceiling, not a provider plan or owner approval.
// External effects remain independently judgment-bound at their existing approval desks.
export const workUnitExecutionAuthorizedRecordV04Schema = workUnitRecordV02Schema.omit({
  revision: true, authorityCeiling: true, budget: true, isolation: true,
  assignee: true, sessionIds: true, state: true,
}).extend({
  revision: z.int().min(2),
  authorityCeiling: executionAuthorityCeilingV04Schema,
  budget: z.strictObject({
    maxProviderTurns: z.int().positive(), maxExternalEffects: z.literal(0),
    maxDurationMs: z.int().positive().max(600_000),
  }),
  isolation: z.strictObject({
    mode: z.literal('owner_responder'), egress: z.literal('host_governed'),
    credentials: z.literal('runtime_managed'),
  }),
  assignee: protocolIdSchema,
  sessionIds: z.array(protocolIdSchema).max(0),
  state: z.literal('execution_authorized'),
});
export type WorkUnitExecutionAuthorizedRecordV04 = z.infer<typeof workUnitExecutionAuthorizedRecordV04Schema>;

// Runtime composition is new; released v0.3/v0.4 wire schemas remain byte-for-byte pinned.
export const commonCanonicalWorkUnitRecordSchema = z.union([canonicalWorkUnitRecordV03Schema, workUnitExecutionAuthorizedRecordV04Schema]);
export type CommonCanonicalWorkUnitRecord = z.infer<typeof commonCanonicalWorkUnitRecordSchema>;
