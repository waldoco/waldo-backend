import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import { protocolDigestSchema, protocolIdSchema, protocolNameSchema } from './responsibility-handshake-v0-1';
import { boundedProtocolTextV04, exactRevisionV04Schema, protocolVersionV04Schema } from './responsibility-protocol-v0-4';

export const reEntryPointV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema, subject: z.strictObject({ kind: z.enum(['outcome', 'work_unit']), id: protocolIdSchema, revision: exactRevisionV04Schema }),
  mode: z.enum(['judgment', 'execution', 'verification', 'conversation']), summary: boundedProtocolTextV04(1_024),
  lastStableEventId: protocolIdSchema, nextAction: z.strictObject({ kind: protocolNameSchema, ref: protocolIdSchema }),
  requiredContextRecipeRef: protocolIdSchema, requiredContextRecipeDigest: protocolDigestSchema,
  evidenceGapRefs: z.array(protocolIdSchema).max(32), artifactRefs: z.array(protocolIdSchema).max(32),
  eventCursor: exactRevisionV04Schema, expiresAt: iso8601Schema.nullable(),
});
export const openLoopV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, id: protocolIdSchema, ownerId: protocolIdSchema,
  revision: exactRevisionV04Schema, outcome: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }),
  workUnit: z.strictObject({ id: protocolIdSchema, revision: exactRevisionV04Schema }).nullable(),
  unresolvedConsequence: z.strictObject({ kind: protocolNameSchema, ref: protocolIdSchema }),
  responsibleParty: z.strictObject({ kind: z.enum(['owner', 'waldo', 'person', 'organization']), ref: protocolIdSchema.nullable() }),
  nextTrigger: z.strictObject({ kind: z.enum(['time', 'event', 'judgment', 'manual']), ref: protocolIdSchema }).nullable(),
  evidenceGapRefs: z.array(protocolIdSchema).max(32), reEntryPointId: protocolIdSchema,
  attentionClass: z.enum(['background', 'normal', 'needs_you']),
  state: z.enum(['open', 'waiting', 'needs_judgment', 'ready', 'resolved', 'released', 'superseded']),
  updatedAt: iso8601Schema,
});
export const openLoopDispositionCommandV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema, requestId: protocolIdSchema, commandType: z.literal('open_loop.disposition'),
  presenceRegistrationId: protocolIdSchema, aggregate: z.strictObject({ kind: z.literal('open_loop'), id: protocolIdSchema, expectedRevision: exactRevisionV04Schema }),
  disposition: z.enum(['resolve', 'release', 'reopen', 'defer', 'transfer']),
  acceptanceId: protocolIdSchema.nullable(), reEntryPointId: protocolIdSchema.nullable(), clientIssuedAt: iso8601Schema,
}).superRefine((value, context) => {
  if ((value.disposition === 'resolve') !== (value.acceptanceId !== null)) context.addIssue({ code: 'custom', path: ['acceptanceId'], message: 'resolution requires explicit Acceptance' });
  if (['reopen', 'defer', 'transfer'].includes(value.disposition) && value.reEntryPointId === null) context.addIssue({ code: 'custom', path: ['reEntryPointId'], message: 'nonterminal disposition requires re-entry' });
});
