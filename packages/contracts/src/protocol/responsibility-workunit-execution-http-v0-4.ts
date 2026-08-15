import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolIdSchema,
} from './responsibility-handshake-v0-1';
import {
  exactRevisionV04Schema,
  protocolVersionV04Schema,
} from './responsibility-protocol-v0-4';

export const responsibilityExecutionHttpMediaTypeV04 =
  'application/vnd.waldo.responsibility.v0.4+json' as const;

export const responsibilityExecutionHttpRouteManifestV04 = Object.freeze([
  Object.freeze({
    id: 'execution_start',
    method: 'POST',
    path: '/public/responsibilities/work-units/executions',
    protocolVersions: Object.freeze(['0.4'] as const),
  }),
] as const);

export type ResponsibilityExecutionHttpRouteV04 =
  (typeof responsibilityExecutionHttpRouteManifestV04)[number];

export function matchResponsibilityExecutionHttpRouteV04(
  method: string,
  path: string,
): ResponsibilityExecutionHttpRouteV04 | null {
  return responsibilityExecutionHttpRouteManifestV04.find(
    (route) => route.method === method && route.path === path,
  ) ?? null;
}

export const workUnitExecutionStartRequestV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  requestId: protocolIdSchema,
  commandType: z.literal('work_unit.start_execution'),
  presenceRegistrationId: protocolIdSchema,
  aggregate: z.strictObject({
    kind: z.literal('work_unit'),
    id: protocolIdSchema,
    expectedRevision: exactRevisionV04Schema,
  }),
  correlationId: protocolIdSchema.optional(),
  clientIssuedAt: iso8601Schema,
});

export type WorkUnitExecutionStartRequestV04 = z.infer<
  typeof workUnitExecutionStartRequestV04Schema
>;

export function canonicalizeWorkUnitExecutionStartRequestV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(workUnitExecutionStartRequestV04Schema.parse(value));
}

const workUnitExecutionStartResultBaseV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  requestId: protocolIdSchema,
  workUnit: z.strictObject({
    id: protocolIdSchema,
    revision: exactRevisionV04Schema,
  }),
  executionRequestId: protocolIdSchema,
  attemptId: protocolIdSchema,
});

export const workUnitExecutionStartResultV04Schema = z.discriminatedUnion('status', [
  workUnitExecutionStartResultBaseV04Schema.extend({
    status: z.literal('started'),
    observation: z.strictObject({
      id: protocolIdSchema,
      sequence: exactRevisionV04Schema,
      kind: z.literal('started'),
    }),
  }),
  workUnitExecutionStartResultBaseV04Schema.extend({
    status: z.literal('indeterminate'),
    observation: z.null(),
  }),
]);

export type WorkUnitExecutionStartResultV04 = z.infer<
  typeof workUnitExecutionStartResultV04Schema
>;
