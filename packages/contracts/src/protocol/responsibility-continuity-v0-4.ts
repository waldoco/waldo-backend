import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
} from './responsibility-handshake-v0-1';
import {
  boundedProtocolTextV04,
  exactRevisionV04Schema,
  protocolVersionV04Schema,
} from './responsibility-protocol-v0-4';

export const reEntryPointV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  subject: z.strictObject({
    kind: z.enum(['outcome', 'work_unit']),
    id: protocolIdSchema,
    revision: exactRevisionV04Schema,
  }),
  mode: z.enum(['judgment', 'execution', 'verification', 'conversation']),
  summary: boundedProtocolTextV04(1_024),
  lastStableEventId: protocolIdSchema,
  nextAction: z.strictObject({ kind: protocolNameSchema, ref: protocolIdSchema }),
  requiredContextRecipeRef: protocolIdSchema,
  requiredContextRecipeDigest: protocolDigestSchema,
  evidenceGapRefs: z.array(protocolIdSchema).max(32),
  artifactRefs: z.array(protocolIdSchema).max(32),
  eventCursor: exactRevisionV04Schema,
  expiresAt: iso8601Schema.nullable(),
});
export const openLoopV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema,
  outcome: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }),
  workUnit: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }).nullable(),
  unresolvedConsequence: z.strictObject({ kind: protocolNameSchema, ref: protocolIdSchema }),
  responsibleParty: z.strictObject({
    kind: z.enum(['owner', 'waldo', 'person', 'organization']),
    ref: protocolIdSchema.nullable(),
  }),
  nextTrigger: z
    .strictObject({ kind: z.enum(['time', 'event', 'judgment', 'manual']), ref: protocolIdSchema })
    .nullable(),
  evidenceGapRefs: z.array(protocolIdSchema).max(32),
  reEntryPointId: protocolIdSchema,
  attentionClass: z.enum(['background', 'normal', 'needs_you']),
  state: z.enum([
    'open',
    'waiting',
    'needs_judgment',
    'ready',
    'resolved',
    'released',
    'superseded',
  ]),
  updatedAt: iso8601Schema,
});
const openLoopDispositionCommandBaseV04Shape = {
  protocolVersion: protocolVersionV04Schema,
  requestId: protocolIdSchema,
  commandType: z.literal('open_loop.disposition'),
  presenceRegistrationId: protocolIdSchema,
  aggregate: z.strictObject({
    kind: z.literal('open_loop'),
    id: protocolIdSchema,
    expectedRevision: exactRevisionV04Schema,
  }),
  clientIssuedAt: iso8601Schema,
} as const;
export const openLoopDispositionCommandV04Schema = z.discriminatedUnion('disposition', [
  z.strictObject({
    ...openLoopDispositionCommandBaseV04Shape,
    disposition: z.literal('resolve'),
    acceptanceId: protocolIdSchema,
    reEntryPointId: z.null(),
  }),
  z.strictObject({
    ...openLoopDispositionCommandBaseV04Shape,
    disposition: z.literal('release'),
    acceptanceId: z.null(),
    reEntryPointId: z.null(),
  }),
  z.strictObject({
    ...openLoopDispositionCommandBaseV04Shape,
    disposition: z.literal('reopen'),
    acceptanceId: z.null(),
    reEntryPointId: protocolIdSchema,
  }),
  z.strictObject({
    ...openLoopDispositionCommandBaseV04Shape,
    disposition: z.literal('defer'),
    acceptanceId: z.null(),
    reEntryPointId: protocolIdSchema,
  }),
  z.strictObject({
    ...openLoopDispositionCommandBaseV04Shape,
    disposition: z.literal('transfer'),
    acceptanceId: z.null(),
    reEntryPointId: protocolIdSchema,
  }),
]);
