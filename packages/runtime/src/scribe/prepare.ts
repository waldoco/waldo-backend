import {
  sanitiseInputSchema,
  sanitiseResultSchema,
  type CanaryTokens,
  type SanitiseDestination,
  type SanitiseFailureReason,
  type SourceTaint,
} from '@waldo/contracts';
import { sanitise } from './sanitiser';

export type StrictSchema<T> = {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
};

export type ScribePrepared<T> =
  | { ok: true; value: T }
  | { ok: false; reason: SanitiseFailureReason };

export function prepareWithScribe<T>(
  value: unknown,
  schema: StrictSchema<T>,
  destination: SanitiseDestination,
  sourceTaint: SourceTaint,
  canaryTokens: CanaryTokens,
): ScribePrepared<T> {
  const candidate = schema.safeParse(value);
  if (!candidate.success) return { ok: false, reason: 'invalid_payload' };
  const input = sanitiseInputSchema.safeParse({
    payload: candidate.data,
    destination,
    canary_tokens: canaryTokens,
    source_taint: sourceTaint,
  });
  if (!input.success) return { ok: false, reason: 'invalid_payload' };

  try {
    const result = sanitiseResultSchema.parse(sanitise(input.data));
    if (!result.ok) return { ok: false, reason: result.reason };
    if (result.source_taint !== sourceTaint) {
      return { ok: false, reason: 'invalid_payload' };
    }
    const output = schema.safeParse(result.payload);
    return output.success
      ? { ok: true, value: output.data }
      : { ok: false, reason: 'invalid_payload' };
  } catch {
    return { ok: false, reason: 'invalid_payload' };
  }
}
