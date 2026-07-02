import { z } from 'zod';

// 12-char md5 truncation: collision space ~2^48 against a per-user scope of 10K-100K blocks —
// negligible risk. md5, not SHA-256: a non-cryptographic ID needs uniqueness within user
// scope, not adversarial resistance (ADR-0037). Lowercase hex is the single canonical form.
export const patternIdSchema = z.string().regex(/^[a-f0-9]{12}$/);

// The hash input is the VALUE-FREE claim key ("user wake time"), never the valued sentence —
// the value lives in content. Left unpinned, every value change mints a new pattern and no
// supersedence chain ever forms; and a pattern_id must never encode a measured physiological
// (Art-9) value that would then travel in logs and supersedence chains (ADR-0037 amendment,
// forced by ADR-0046). Digits are how values enter a key, so any digit fails the guard.
export const claimKeySchema = z
  .string()
  .refine((s) => s.trim().length > 0, { error: 'claim key must be non-empty' })
  .refine((s) => !/\d/.test(s), {
    error: 'claim key must be value-free — values live in content or conditions, never the key',
  });

// The md5-hex digest is injected at this seam so the contracts package runs under both Node
// (contract tests) and workerd (the DO runtime) without a top-level node:crypto import.
// Function-bearing, so a static type rather than a Zod schema, like AdapterResult.
export type Md5Hex = (input: string) => string;

// Deterministic pure function (ADR-0037): identical inputs give identical ids; conditions are
// order-insensitive (sorted before hashing). Distinct basis conditions ('basis:reported' vs
// 'basis:measured') force divergent ids — subjective and measured claims are distinct
// patterns and neither invalidates the other (ADR-0046).
export function generatePatternId(
  claimKey: string,
  conditions: readonly string[],
  md5Hex: Md5Hex,
): string {
  const key = claimKeySchema.parse(claimKey);
  const normalised = key.toLowerCase().trim().replace(/\s+/g, ' ');
  const sortedConditions = [...conditions].sort().join('|');
  // Parsing the output pins the canonical lowercase 12-hex shape at the single minting
  // point, so a non-conforming injected digest fails closed instead of laundering ids.
  return patternIdSchema.parse(md5Hex(`${normalised}::${sortedConditions}`).slice(0, 12));
}
