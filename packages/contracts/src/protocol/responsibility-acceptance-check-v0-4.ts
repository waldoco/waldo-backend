import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
} from './responsibility-handshake-v0-1';
import { responsibilityCaptureTextV02Schema } from './responsibility-handshake-v0-2';
import { protocolVersionV04Schema } from './responsibility-protocol-v0-4';

const MAX_ACCEPTANCE_CHECK_BYTES = 4_096;
export { protocolVersionV04Schema } from './responsibility-protocol-v0-4';

function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    bytes += codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
  }
  return bytes;
}

export const acceptanceCheckSubjectV04Schema = z.strictObject({
  kind: z.enum(['outcome', 'work_unit']),
  id: protocolIdSchema,
  revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
});

export const deterministicReadBackVerificationMethodV04Schema = z.strictObject({
  kind: z.literal('deterministic_read_back'),
  capability: protocolNameSchema,
  targetRef: protocolIdSchema,
  assertion: z.strictObject({
    operator: z.literal('digest_equals'),
    expectedDigest: protocolDigestSchema,
  }),
});

export const deterministicArtifactVerificationMethodV04Schema = z.strictObject({
  kind: z.literal('deterministic_artifact_check'),
  capability: protocolNameSchema,
  artifactRef: protocolIdSchema,
  assertion: z.strictObject({
    operator: z.literal('digest_equals'),
    expectedDigest: protocolDigestSchema,
  }),
});

const versionedVerificationComponentV04Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
});

export const declaredSemanticVerificationMethodV04Schema = z.strictObject({
  kind: z.literal('declared_semantic_check'),
  capability: protocolNameSchema,
  targetRef: protocolIdSchema,
  model: versionedVerificationComponentV04Schema,
  harness: versionedVerificationComponentV04Schema,
  grader: versionedVerificationComponentV04Schema,
  evidence: z.strictObject({
    ref: protocolIdSchema,
    version: protocolNameSchema,
    digest: protocolDigestSchema,
  }),
  independenceDisclosure: z.strictObject({
    independentFromProducer: z.boolean(),
    disclosure: z.strictObject({
      ref: protocolIdSchema,
      digest: protocolDigestSchema,
    }),
  }),
});

export const acceptanceVerificationMethodV04Schema = z.discriminatedUnion('kind', [
  deterministicReadBackVerificationMethodV04Schema,
  deterministicArtifactVerificationMethodV04Schema,
  declaredSemanticVerificationMethodV04Schema,
]);

export const acceptanceCheckV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  subject: acceptanceCheckSubjectV04Schema,
  /** Owner-readable meaning: the condition the owner recognizes as satisfied. */
  criterion: responsibilityCaptureTextV02Schema.max(2_048),
  /** Executable method: the exact procedure used to gather and judge verification evidence. */
  verificationMethod: acceptanceVerificationMethodV04Schema,
  createdAt: iso8601Schema,
}).refine(
  (value) => utf8ByteLength(JSON.stringify(value)) <= MAX_ACCEPTANCE_CHECK_BYTES,
  { error: `acceptance check must not exceed ${MAX_ACCEPTANCE_CHECK_BYTES} UTF-8 bytes` },
);
export type AcceptanceCheckV04 = z.infer<typeof acceptanceCheckV04Schema>;

export function canonicalizeAcceptanceCheckV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(acceptanceCheckV04Schema.parse(value));
}
