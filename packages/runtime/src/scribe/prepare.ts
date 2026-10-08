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
  if (!candidate.success) { console.warn(JSON.stringify({ hop: 'scribe_invalid', branch: 'prepare_L27' })); return { ok: false, reason: 'invalid_payload' }; }
  const input = sanitiseInputSchema.safeParse({
    payload: candidate.data,
    destination,
    canary_tokens: canaryTokens,
    source_taint: sourceTaint,
  });
  if (!input.success) { console.warn(JSON.stringify({ hop: 'scribe_invalid', branch: 'prepare_L34' })); return { ok: false, reason: 'invalid_payload' }; }

  try {
    const result = sanitiseResultSchema.parse(sanitise(input.data));
    if (!result.ok) return { ok: false, reason: result.reason };
    if (result.source_taint !== sourceTaint) {
      { console.warn(JSON.stringify({ hop: 'scribe_invalid', branch: 'prepare_L40' })); return { ok: false, reason: 'invalid_payload' }; }
    }
    const output = schema.safeParse(result.payload);
    return output.success
      ? { ok: true, value: output.data }
      : (console.warn(JSON.stringify({ hop: 'scribe_invalid', branch: 'prepare_L45' })), { ok: false as const, reason: 'invalid_payload' as const });
  } catch {
    { console.warn(JSON.stringify({ hop: 'scribe_invalid', branch: 'prepare_L47' })); return { ok: false, reason: 'invalid_payload' }; }
  }
}
