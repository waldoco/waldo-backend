import { z } from 'zod';
import { iso8601Schema } from '../core/error';
import {
  canonicalizeProtocolJson,
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
} from './responsibility-handshake-v0-1';
import { responsibilityCaptureTextV02Schema } from './responsibility-handshake-v0-2';

const MAX_ACCEPTANCE_CHECK_BYTES = 4_096;
export const protocolVersionV04Schema = z.literal('0.4');

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

export const acceptanceCheckV04Schema = z.strictObject({
  protocolVersion: protocolVersionV04Schema,
  id: protocolIdSchema,
  ownerId: protocolIdSchema,
  revision: z.int().positive().max(Number.MAX_SAFE_INTEGER),
  subject: acceptanceCheckSubjectV04Schema,
  criterion: responsibilityCaptureTextV02Schema.max(2_048),
  verificationMethod: deterministicReadBackVerificationMethodV04Schema,
  createdAt: iso8601Schema,
}).refine(
  (value) => utf8ByteLength(JSON.stringify(value)) <= MAX_ACCEPTANCE_CHECK_BYTES,
  { error: `acceptance check must not exceed ${MAX_ACCEPTANCE_CHECK_BYTES} UTF-8 bytes` },
);
export type AcceptanceCheckV04 = z.infer<typeof acceptanceCheckV04Schema>;

export function canonicalizeAcceptanceCheckV04ForDigest(value: unknown): string {
  return canonicalizeProtocolJson(acceptanceCheckV04Schema.parse(value));
}
