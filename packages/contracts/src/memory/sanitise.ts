import { z } from 'zod';
import { trustClassSchema } from './trust';

// ADR-0024 canonical Scribe sanitiser contract: ONE seam every persistence and egress path
// crosses (per-surface custom sanitisers are a rejected option), deterministic and rule-based
// (LLM judging is a rejected option). The regex set, check order, destination rules, caps,
// and failure codes pinned here ARE the spec; the runtime implements behind this vocabulary,
// at memory_inbox write time AND as the merge-time re-check (ratified ADR-0024 amendment).

// The nine destinations of the ADR-0024 destination-rule table, normalised to the singular
// 'memory_block' the same ADR's seam signature uses — one concept, one representation.
// 'sheet_cell' (seam-signature-only) and 'workspace_file' (legacy enum only) are deliberately
// absent: neither appears in the rule table this contract encodes.
export const sanitiseDestinationSchema = z.enum([
  'memory_block',
  'system_prompt',
  'internal_context',
  'draft_document',
  'draft_email',
  'send_message',
  'sandbox_stdout',
  'skill_body',
  'audit_log',
]);
export type SanitiseDestination = z.infer<typeof sanitiseDestinationSchema>;

// Enum order is execution order (ADR-0024): the five checks run 1 through 5, fail closed,
// canary fail-fast first. 'pii' redacts and allows — it is the only check that never rejects.
export const sanitiseCheckSchema = z.enum([
  'canary_token',
  'health_value',
  'pii',
  'instruction_pattern',
  'size_cap',
]);
export type SanitiseCheck = z.infer<typeof sanitiseCheckSchema>;

export const sanitiseFailureReasonSchema = z.enum([
  'canary_leak',
  'health_value_leak',
  'oversize',
  'untrusted_instruction',
]);
export type SanitiseFailureReason = z.infer<typeof sanitiseFailureReasonSchema>;

export const redactionKindSchema = z.enum([
  'email',
  'phone',
  'attendee_name',
  'address',
  'credit_card',
  'instruction_pattern',
]);
export type RedactionKind = z.infer<typeof redactionKindSchema>;

// Redactions travel as counts only, never the redacted text (ADR-0024); a redaction record
// that redacted nothing is unrepresentable.
export const redactionSchema = z.strictObject({
  kind: redactionKindSchema,
  count: z.int().positive(),
});
export type Redaction = z.infer<typeof redactionSchema>;

export const sanitiseResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    output: z.string(),
    redactions: z.array(redactionSchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    reason: sanitiseFailureReasonSchema,
  }),
]);
export type SanitiseResult = z.infer<typeof sanitiseResultSchema>;

// Check 1 — the embedded-scan form of a canary token; the anchored single-token shape is
// canaryTokenSchema in core/trigger. Any session canary inside candidate text means the
// system prompt leaked: terminate the session, never write (ADR-0024).
export const CANARY_REGEX = /\b[a-f0-9]{16}\b/gi;

// Check 2 — raw sensor readings never persist outside Supabase and never reach ANY sanitise
// destination, internal ones included; they have no continuity exception (ADR-0024). Targeted
// lockout, not blanket number rejection — that was a rejected option.
//
// ADR-0024's canonical §Check-2 block enumerates only four families in a prose shape. Two
// forward-compatible tightenings (both sanctioned by ADR-0024 §Consequences; the canonical block
// should be amended to match — cross-repo follow-up, FOUNDATION-HANDOVER §6.1):
//   (1) the pinned Art-9 forbidden set is broader (guard-health-leak HEALTH_TOKENS + the security-
//       checklist): body weight/mass, blood pressure incl. systolic/diastolic, and energy expenditure;
//   (2) health data travels as STRUCTURED payloads — snake_case / kebab / camelCase keys, a unit glued
//       to the key (hrv_ms, weightKg, systolicMmHg), and quoted numeric or BP-ratio values.
// PRECISION: specific tokens match on any separator, but ambiguous short tokens (hr, bp, weight,
// sleep) REQUIRE a family unit, so ordinary prose — a team's ticket count, a finance basis-points
// delta, a graph edge weight, a retry backoff — is never redacted. Structural leakage (a value nested
// under an inner key, a word between key and number, CSV commas) and metrics outside these families
// are the ADR-0074 §Move1.4 grader's job, not this deterministic floor. Single-source vocabulary: the
// ADR-0074 DELIVER egress floor reuses these patterns rather than declaring a second copy.
const QUOTE = String.raw`["']?`;
// The number tail, and (separately) a ratio tail (140/90) used only where a ratio is a real reading
// (blood pressure) — never grafted onto a bare weight or count.
const RAW_NUM = String.raw`${QUOTE}\s*\d+(?:\.\d+)?`;
const RAW_RATIO = String.raw`${QUOTE}\s*\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?`;
// Key/value separator: one colon, equals, or whitespace char, with an optional quote on either side
// so a quoted key and a quoted value in a serialized payload are both caught, not only prose.
const KV = String.raw`${QUOTE}\s*[:=\s]\s*${QUOTE}\s*`;
// Units that also appear glued to a key as a suffix (hrv_ms, weight_kg, systolicMmHg, oxygen…Percent).
const UNIT = String.raw`ms|millisec|bpm|beats|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|percent|pct|%|hours?|hrs?|mins?|minutes?`;

// SPECIFIC token: `\b(?:token)` anchors the WHOLE (possibly multi-word / snake_case) token so an
// underscore inside `body_weight` cannot defeat it; an optional glued unit suffix follows, then the
// separator and a number or ratio. These tokens are unambiguous enough to need no unit. `[\s_-]?`
// under the case-insensitive flag also covers camelCase (`bloodPressure`) and the concatenated form.
const specific = (token: string): RegExp =>
  new RegExp(String.raw`\b(?:${token})(?:[\s_-]?(?:${UNIT}))?${KV}(?:${RAW_RATIO}|${RAW_NUM})`, 'gi');
// AMBIGUOUS short token: a family unit is REQUIRED — glued as a key suffix or trailing the number —
// so a bare short token plus an unrelated number (an HR-team count, a basis-points delta, an ML edge
// weight, a backoff duration) never matches.
const ambiguous = (token: string, unit: string): RegExp =>
  new RegExp(
    String.raw`\b(?:${token})(?:[\s_-]?(?:${unit}))${KV}(?:${RAW_NUM})` +
      `|` +
      String.raw`\b(?:${token})${KV}(?:${RAW_NUM})\s*(?:${unit})\b`,
    'gi',
  );

export const RAW_SENSOR_PATTERNS: readonly RegExp[] = [
  specific(String.raw`hrv|heart[\s_-]?rate[\s_-]?variability`),
  specific(String.raw`resting[\s_-]?heart[\s_-]?rate|heart[\s_-]?rate|pulse`),
  specific(String.raw`spo2|oxygen[\s_-]?saturation|blood[\s_-]?oxygen|o2[\s_-]?sat(?:uration)?`),
  specific(String.raw`systolic|diastolic|body[\s_-]?weight|body[\s_-]?mass`),
  specific(String.raw`calorie[\s_-]?burn|calories[\s_-]?burned|active[\s_-]?energy`),
  specific(String.raw`sleep[\s_-]?(?:hours?|duration|mins?|minutes?)`),
  // Blood pressure reads as a ratio (140/90) or a number with an mmHg unit; a bare `bp` plus an
  // integer (finance basis points) must not match, so `bp` alone requires the ratio or the unit.
  new RegExp(
    String.raw`\b(?:blood[\s_-]?pressure|bp[\s_-]?sys(?:tolic)?|bp[\s_-]?dia(?:stolic)?|sys[\s_-]?\/[\s_-]?dia)${KV}(?:${RAW_RATIO}|${RAW_NUM})`,
    'gi',
  ),
  new RegExp(
    String.raw`\bbp${KV}(?:${RAW_RATIO})` + `|` + String.raw`\bbp${KV}(?:${RAW_NUM})\s*mmhg\b`,
    'gi',
  ),
  ambiguous(String.raw`hr`, String.raw`bpm|beats`),
  ambiguous(String.raw`weight`, String.raw`kg|kgs|lb|lbs|pounds?`),
  ambiguous(
    String.raw`sleep|slept|rem[\s_-]?sleep|deep[\s_-]?sleep|time[\s_-]?asleep`,
    String.raw`hours?|hrs?|mins?|minutes?`,
  ),
];

// Derived CRS/Form/Recovery/Load scores stay raw on internal destinations because CRS is the
// agent's biological-context signal (ADR-0011); external surfaces get zone words instead.
export const DERIVED_SCORE_PATTERNS: readonly RegExp[] = [
  /\b(crs|form|recovery|load)[:\s]+(\d{1,3})\b/gi,
];

export const rawSensorActionSchema = z.enum(['reject', 'redact']);
export type RawSensorAction = z.infer<typeof rawSensorActionSchema>;

export const derivedScoreActionSchema = z.enum(['keep_raw', 'redact_to_zone', 'redact']);
export type DerivedScoreAction = z.infer<typeof derivedScoreActionSchema>;

export const healthRuleSchema = z.strictObject({
  raw_sensor: rawSensorActionSchema,
  derived_score: derivedScoreActionSchema,
});
export type HealthRule = z.infer<typeof healthRuleSchema>;

// The ADR-0024 destination-rule table, verbatim. audit_log redacts BOTH classes — an audit
// row must never become the exfiltration channel it exists to police.
export const HEALTH_DESTINATION_RULES: Readonly<Record<SanitiseDestination, HealthRule>> = {
  memory_block: { raw_sensor: 'reject', derived_score: 'keep_raw' },
  system_prompt: { raw_sensor: 'reject', derived_score: 'keep_raw' },
  internal_context: { raw_sensor: 'reject', derived_score: 'keep_raw' },
  draft_document: { raw_sensor: 'redact', derived_score: 'redact_to_zone' },
  draft_email: { raw_sensor: 'redact', derived_score: 'redact_to_zone' },
  send_message: { raw_sensor: 'redact', derived_score: 'redact_to_zone' },
  sandbox_stdout: { raw_sensor: 'redact', derived_score: 'redact_to_zone' },
  skill_body: { raw_sensor: 'redact', derived_score: 'redact_to_zone' },
  audit_log: { raw_sensor: 'redact', derived_score: 'redact' },
};

// Check 3 — PII is redacted, never rejected (ADR-0024 false-positive policy: uncertainty
// defaults to redact + allow). Attendee names and street addresses use heuristics owned by
// the runtime; these four are the pinned regex forms.
export const PII_PATTERNS = {
  email: /\b[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/g,
  phone: /\b(\+?1?[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  cc: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
} as const;

// Check 4 — memory and skill bodies are content, not instructions (ADR-0024). The
// you-are-now pattern excludes Waldo naming itself.
export const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /ignore\s+(previous|all|prior)\s+(instruction|prompt|message)/i,
  /you\s+are\s+(now|actually)\s+(?!waldo)/i,
  /system\s*[:\s]+/i,
  /assistant\s*[:\s]+/i,
  /<\s*\/?(system|assistant|user)\s*>/i,
  /jailbreak|dan|grandma|developer mode/i,
];

// Two or more distinct pattern hits reject; exactly one is treated as a low-confidence false
// positive — redact and allow (ADR-0024).
export const INSTRUCTION_REJECT_THRESHOLD = 2;

// ADR-0024's 2 KB memory-block cap in UTF-16 units — the single owner both the sanitiser
// table below and memoryContentSchema (hall.ts) derive from, so the schema seam and the
// sanitise seam cannot disagree on what fits in a block.
export const MEMORY_BLOCK_CONTENT_MAX = 2_048;

// Check 5 — caps compare UTF-16 length, matching the ADR-0024 length comparison; a
// destination absent here carries no pinned cap. Only sandbox stdout truncates on overflow;
// every other capped destination rejects.
export const SIZE_CAPS = {
  memory_block: MEMORY_BLOCK_CONTENT_MAX,
  sandbox_stdout: 10_240,
  draft_document: 51_200,
  draft_email: 10_240,
  skill_body: 5_120,
} as const satisfies Partial<Record<SanitiseDestination, number>>;

export const SIZE_CAPS_TRUNCATE: readonly SanitiseDestination[] = ['sandbox_stdout'];

export const TRUNCATION_MARKER = '[truncated, full output at sandbox-output/{trace_id}]';

// Per-surface failure handling (ADR-0024): a memory_block rejection drops the write, marks
// the inbox entry rejected, and is never retried; sandbox stdout is replaced with the failure
// text; the rest reject through their tools. The three internal destinations carry no pinned
// audit code — they are not write surfaces in the failure table.
export const SANITISE_AUDIT_CODES = {
  memory_block: 'memory_write_rejected',
  sandbox_stdout: 'sandbox_sanitise_failed',
  draft_document: 'draft_doc_rejected',
  draft_email: 'draft_email_rejected',
  skill_body: 'skill_authoring_rejected',
  send_message: 'message_sanitise_failed',
} as const satisfies Partial<Record<SanitiseDestination, string>>;

export const SANDBOX_SANITISE_FAILURE_TEXT = '[output sanitisation failed: <reason>]';

// ADR-0049: external-origin text (web, document, MCP, connector, calendar/email body) is
// stamped tainted at the tool/adapter seam and stays tainted end-to-end. 'external' is the
// only pinned taint; null = no external origin — one representation, composed by both this
// stamp and the persisted inbox row (hall.ts).
export const sourceTaintSchema = z.literal('external').nullable();
export type SourceTaint = z.infer<typeof sourceTaintSchema>;

// Tainted content never escalates trust class (ADR-0049): whatever provenance the text
// asserts, an external-tainted stamp lands 'inferred'. That also makes "always queues"
// structural — 'inferred' never dominates and never refreshes itself, so a tainted proposal
// can only wait in the inbox for the merge.
export const taintStampSchema = z
  .strictObject({
    source_trust: trustClassSchema,
    source_taint: sourceTaintSchema,
  })
  .refine((stamp) => stamp.source_taint !== 'external' || stamp.source_trust === 'inferred', {
    error: 'tainted content never escalates trust class',
    path: ['source_trust'],
  });
export type TaintStamp = z.infer<typeof taintStampSchema>;
