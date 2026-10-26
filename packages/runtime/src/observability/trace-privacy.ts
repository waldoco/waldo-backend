import { z } from 'zod';
import {
  executionRungSchema, providerSchema, rungBlockedReasonSchema, sanitiseCheckSchema, sanitiseFailureReasonSchema,
  toolSearchRejectionSchema, turnErrorCodeSchema, turnIdentifierSchema, turnOutcomeSchema,
} from '@waldo/contracts';
import type { TurnLogEntry } from '../channels/telegram-listener';
import { scrubTraceHealth } from './trace-health-scrub';

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
  'day_plan', 'nightly_memory', 'memory_flush', 'brief_sweep', 'day_card', 'update_card', 'console_action', 'console_link',
]);

// These receipts are strictly enum/count-only, even if a caller supplies a free-form
// code or detail. Never promote raw claim text or provider payload into a safe hop.
const MEMORY_EVIDENCE = /^(?:admitted:supported|held:(?:same_day|too_few_claims|untrusted_or_missing)):owner_observation_pattern:1$/;
const HEALTH_READ = /^(?:present|absent|read_failed)$/;

// Gates one turn-log entry for every sink that consumes it (the DO trace table, the wrangler
// console JSON line and the OTLP exporter): with capture off, detail survives only for hops
// whose producers are verified content-free, error text is dropped entirely, and a typed
// `code` is what a failure leaves behind. Turn text is unaffected here; each sink already
// handles it (the trace table never stores it, console JSON strips it, OTLP gates it on the
// same switch).
// The verified signup email is personal data: it follows the same switch as free-form text (off in production,
// and wherever capture is off), while owner_id stays. The identity label then says the email is not emitted.
const withholdEmail = (entry: TurnLogEntry): TurnLogEntry => entry.owner_email === undefined ? entry
  : { ...entry, owner_email: 'unknown', owner_identity: entry.owner_identity === 'verified' ? 'email_unavailable' : entry.owner_identity };

// Capture on still keeps health values out: the scrub withholds them from text, detail, error and code. A scrub that
// throws sends the entry through the capture-off gate with no text at all, since a capture-on sink would export it raw.
export const gateTraceEntry = (entry: TurnLogEntry, captureText: boolean): TurnLogEntry => {
  if (captureText) {
    try { return scrubTraceHealth(entry); } catch { return { ...gateWithoutCapture(withholdEmail(typedFieldsOnly(entry))), text: undefined }; }
  }
  return gateWithoutCapture(withholdEmail(typedFieldsOnly(entry)));
};

// The v9 fields are closed vocabularies, identifiers and numbers by contract. The gate re-validates each one here
// so a producer that writes prose into, say, error_code or job_id loses that field before any sink sees it.
const TYPED_FIELDS = {
  rung: executionRungSchema, blocked_reason: rungBlockedReasonSchema, outcome: turnOutcomeSchema, provider: providerSchema,
  error_code: turnErrorCodeSchema, job_id: turnIdentifierSchema, job_profile: turnIdentifierSchema,
  tools_called: z.number().int().min(0), parallel_batches: z.number().int().min(0),
  browser_ms: z.number().finite().min(0), sandbox_ms: z.number().finite().min(0), ttft_ms: z.number().finite().min(0),
  fallback_fired: z.boolean(), tool_search_degraded: z.boolean(),
  tool_search_rejection: toolSearchRejectionSchema,
} as const;
const typedFieldsOnly = (entry: TurnLogEntry): TurnLogEntry => {
  const copy: Record<string, unknown> = { ...entry };
  for (const [field, schema] of Object.entries(TYPED_FIELDS)) {
    if (copy[field] !== undefined && !schema.safeParse(copy[field]).success) delete copy[field];
  }
  return copy as TurnLogEntry;
};

const gateWithoutCapture = (entry: TurnLogEntry): TurnLogEntry => {
  if (entry.hop === 'constellation_evidence' || entry.hop === 'health_context') {
    const detail = entry.hop === 'constellation_evidence'
      ? (typeof entry.detail === 'string' && MEMORY_EVIDENCE.test(entry.detail) ? entry.detail : undefined)
      : (typeof entry.code === 'string' && HEALTH_READ.test(entry.code) ? entry.code : undefined);
    return { ...entry, detail, code: detail, error: undefined, text: undefined, guard: undefined };
  }
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
