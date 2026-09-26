import { sanitiseCheckSchema, sanitiseFailureReasonSchema } from '@waldo/contracts';
import type { TurnLogEntry } from '../channels/telegram-listener';

// The sink boundary validates the guard diagnostic itself: only a finite check:reason enum
// pair survives capture-off. A malformed caller cannot smuggle free-form provider text past
// the error/detail gate by writing it into guard (owner security review, #203 round 2).
const GUARD_DIAGNOSTIC = new RegExp(
  `^(?:${sanitiseCheckSchema.options.join('|')}):(?:${sanitiseFailureReasonSchema.options.join('|')})$`,
);
// typeof first: RegExp.test coerces non-strings, so an object whose toString() yields a valid
// enum pair could otherwise pass the gate and serialize private fields into the sinks.
const validGuard = (guard: unknown): string | undefined =>
  typeof guard === 'string' && GUARD_DIAGNOSTIC.test(guard) ? guard : undefined;

// Hops whose detail strings are verified content-free: fixed strings, enums, counts and
// integer ids only (console ids pass through consoleActionTraceDetail first). Everything else (model reasons, provider error messages, payloads) is free-form
// content and must not reach the trace sinks while the capture switch is off.
const SAFE_DETAIL_HOPS = new Set([
  'stop', 'steer', 'connect_offer', 'google_token_migrated', 'memory_backup',
  'egress_scrub', 'egress_redacted', 'oauth_exchange', 'oauth_callback', 'google_linked',
  'day_plan', 'nightly_memory', 'brief_sweep', 'day_card', 'update_card', 'console_action',
]);

// Gates one turn-log entry for every sink that consumes it (the DO trace table, the wrangler
// console JSON line and the OTLP exporter): with capture off, detail survives only for hops
// whose producers are verified content-free, error text is dropped entirely, and a typed
// `code` is what a failure leaves behind. Turn text is unaffected here; each sink already
// handles it (the trace table never stores it, console JSON strips it, OTLP gates it on the
// same switch).
export const gateTraceEntry = (entry: TurnLogEntry, captureText: boolean): TurnLogEntry => {
  if (captureText) return entry;
  return {
    ...entry,
    detail: SAFE_DETAIL_HOPS.has(entry.hop) ? entry.detail : entry.code,
    error: undefined,
    // The guard diagnostic is enum-only and validated HERE at the gate, not trusted from the
    // producer: an invalid value is dropped before any sink sees it.
    guard: validGuard(entry.guard),
  };
};

// The staging release gate, in code: free-form text may be exported ONLY outside production.
// WALDO_ENVIRONMENT 'production' disables text capture no matter what LANGFUSE_CAPTURE_TEXT
// says, so a misconfigured prod deploy fails safe (types/counts only), never open.
export const resolveCaptureText = (env: Readonly<{ LANGFUSE_CAPTURE_TEXT?: string; WALDO_ENVIRONMENT?: string }>): boolean =>
  env.LANGFUSE_CAPTURE_TEXT === 'true' && (env.WALDO_ENVIRONMENT ?? 'development') !== 'production';
