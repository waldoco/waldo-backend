import { z } from 'zod';
import {
  protocolDigestSchema,
  protocolIdSchema,
  protocolNameSchema,
} from './responsibility-handshake-v0-1';

export const protocolVersionV04Schema = z.literal('0.4');
export const exactRevisionV04Schema = z.int().positive().max(Number.MAX_SAFE_INTEGER);
export const protocolReferenceV04Schema = z.strictObject({
  id: protocolIdSchema,
  revision: exactRevisionV04Schema,
  digest: protocolDigestSchema,
});
export const versionedManifestReferenceV04Schema = z.strictObject({
  id: protocolIdSchema,
  version: protocolNameSchema,
  digest: protocolDigestSchema,
});

export function isWellFormedUtf16V04(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) return false;
  }
  return true;
}

export const boundedProtocolTextV04 = (maximum: number) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(isWellFormedUtf16V04, { error: 'text must contain well-formed Unicode' })
    .regex(/\S/, { error: 'text must contain non-whitespace content' });
