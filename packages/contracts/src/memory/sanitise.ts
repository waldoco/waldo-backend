import { z } from 'zod';
import { canaryTokensSchema } from '../core/trigger';
import { trustClassSchema } from './trust';

// ADR-0024 canonical Scribe sanitiser contract: ONE seam every persistence and egress path
// crosses (per-surface custom sanitisers are a rejected option), deterministic and rule-based
// (LLM judging is a rejected option). The regex set, check order, destination rules, caps,
// and failure codes pinned here ARE the spec; the runtime implements behind this vocabulary,
// at memory_inbox write time AND as the merge-time re-check (ratified ADR-0024 amendment).

// One destination vocabulary covers current persistence and egress owners, including fail-closed
// R2 and outbox policies. Historical aliases remain deliberately absent.
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
  'r2_summary',
  'outbox',
]);
export type SanitiseDestination = z.infer<typeof sanitiseDestinationSchema>;

export const sanitiseDestinationPolicySchema = z.strictObject({
  payload_kind: z.enum(['text', 'structured', 'text_or_structured']),
  max_chars: z.int().positive(),
  max_depth: z.int().nonnegative(),
  max_object_fields: z.int().nonnegative(),
  max_array_items: z.int().nonnegative(),
  max_key_chars: z.int().nonnegative(),
});
export type SanitiseDestinationPolicy = z.infer<typeof sanitiseDestinationPolicySchema>;

export const SANITISE_DESTINATION_POLICIES = {
  memory_block: {
    payload_kind: 'text_or_structured',
    max_chars: 2_048,
    max_depth: 4,
    max_object_fields: 8,
    max_array_items: 10,
    max_key_chars: 64,
  },
  system_prompt: {
    payload_kind: 'text_or_structured',
    max_chars: 32_768,
    max_depth: 4,
    max_object_fields: 9,
    max_array_items: 16,
    max_key_chars: 128,
  },
  internal_context: {
    payload_kind: 'structured',
    max_chars: 32_768,
    max_depth: 16,
    max_object_fields: 64,
    max_array_items: 128,
    max_key_chars: 128,
  },
  draft_document: {
    payload_kind: 'text_or_structured',
    max_chars: 51_200,
    max_depth: 4,
    max_object_fields: 8,
    max_array_items: 16,
    max_key_chars: 128,
  },
  draft_email: {
    payload_kind: 'text_or_structured',
    max_chars: 10_240,
    max_depth: 4,
    max_object_fields: 12,
    max_array_items: 50,
    max_key_chars: 128,
  },
  send_message: {
    payload_kind: 'text_or_structured',
    max_chars: 4_096,
    max_depth: 4,
    max_object_fields: 8,
    max_array_items: 16,
    max_key_chars: 128,
  },
  sandbox_stdout: {
    payload_kind: 'text_or_structured',
    max_chars: 10_240,
    max_depth: 8,
    max_object_fields: 64,
    max_array_items: 128,
    max_key_chars: 128,
  },
  skill_body: {
    payload_kind: 'text_or_structured',
    max_chars: 5_120,
    max_depth: 8,
    max_object_fields: 64,
    max_array_items: 128,
    max_key_chars: 128,
  },
  audit_log: {
    payload_kind: 'structured',
    max_chars: 65_536,
    max_depth: 12,
    max_object_fields: 32,
    max_array_items: 128,
    max_key_chars: 128,
  },
  r2_summary: {
    payload_kind: 'structured',
    max_chars: 16_384,
    max_depth: 8,
    max_object_fields: 32,
    max_array_items: 128,
    max_key_chars: 128,
  },
  outbox: {
    payload_kind: 'text_or_structured',
    max_chars: 4_096,
    max_depth: 4,
    max_object_fields: 16,
    max_array_items: 32,
    max_key_chars: 128,
  },
} as const satisfies Readonly<Record<SanitiseDestination, SanitiseDestinationPolicy>>;

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
  'secret_leak',
  'health_value_leak',
  'oversize',
  'untrusted_instruction',
  'invalid_payload',
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

export const EXTERNAL_SOURCE_TAINT = 'external' as const;
export const sourceTaintSchema = z.literal(EXTERNAL_SOURCE_TAINT).nullable();
export type SourceTaint = z.infer<typeof sourceTaintSchema>;

export const sanitiseInputSchema = z.strictObject({
  payload: z.json(),
  destination: sanitiseDestinationSchema,
  canary_tokens: canaryTokensSchema,
  source_taint: sourceTaintSchema,
});
export type SanitiseInput = z.infer<typeof sanitiseInputSchema>;

export const sanitiseResultSchema = z.discriminatedUnion('ok', [
  z.strictObject({
    ok: z.literal(true),
    payload: z.json(),
    source_taint: sourceTaintSchema,
    redactions: z.array(redactionSchema),
  }),
  z.strictObject({
    ok: z.literal(false),
    check: sanitiseCheckSchema,
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
// PRECISION: specific tokens match on any separator; the ambiguous short tokens are gated so
// whitespace prose is not redacted — hr/weight take a bare number on a colon/equals key but need a
// unit on bare whitespace ("1 hr 30", "edge weight 10"); bp needs a ratio or mmHg (not "bp 3" basis
// points); sleep needs a duration unit (not a "sleep 60" backoff). Structural leakage (a value nested
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
// A STRUCTURED key/value separator — colon or equals only, no bare whitespace. A serialized field (a
// colon/equals key carrying a number) is a health value even without a unit; bare-whitespace prose is not.
const KV_KEY = String.raw`${QUOTE}\s*[:=]\s*${QUOTE}\s*`;
// Units that also appear glued to a key as a suffix (hrv_ms, weight_kg, systolicMmHg, oxygen…Percent).
const UNIT = String.raw`ms|millisec|bpm|beats|breaths?(?:[\s_-]*per[\s_-]*minute)?|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|percent|pct|%|hours?|hrs?|mins?|minutes?|celsius|fahrenheit|mg(?:\/|[\s_-]*per[\s_-]*)dl|mmol(?:\/|[\s_-]*per[\s_-]*)l`;

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
// KEYED-OR-UNIT (hr, weight): a bare number is a health value on a STRUCTURED (colon/equals) key —
// the real wearable-payload shape — but on bare whitespace it needs a unit, so bare-whitespace prose
// (a duration, a graph edge weight, an ML class weight) stays clear. Also matches a glued unit suffix
// or a trailing unit. Art-9 fail-safe: a colon-keyed non-health team reference is over-redacted — a
// rejected write is recoverable, a leaked body weight is not — so recall wins over that rare false
// positive (a bare whitespace team reference still stays clear).
const keyedOrUnit = (token: string, unit: string): RegExp =>
  new RegExp(
    String.raw`\b(?:${token})${KV_KEY}(?:${RAW_NUM})` +
      `|` +
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
  specific(
    String.raw`steps|step[\s_-]?count|motion|circadian|sleep[\s_-]?efficiency|sleep[\s_-]?stages?|body[\s_-]?temperature|respiratory[\s_-]?rate|breathing[\s_-]?rate|blood[\s_-]?glucose|glucose|provider[\s_-]?payload|health[\s_-]?payload|raw[\s_-]?payload`,
  ),
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
  keyedOrUnit(String.raw`hr`, String.raw`bpm|beats`),
  keyedOrUnit(String.raw`weight`, String.raw`kg|kgs|lb|lbs|pounds?`),
  ambiguous(
    String.raw`sleep|slept|rem[\s_-]?sleep|deep[\s_-]?sleep|time[\s_-]?asleep`,
    String.raw`hours?|hrs?|mins?|minutes?`,
  ),
];

// Numeric derived health is forbidden at every generic destination. Allowed nonnumeric health
// context crosses only the strict destination view owned by health/crs.
export const DERIVED_SCORE_PATTERNS: readonly RegExp[] = [
  /\b(crs|form|recovery|load)[:\s]+(\d{1,3})\b/gi,
];

export const rawSensorActionSchema = z.enum(['reject']);
export type RawSensorAction = z.infer<typeof rawSensorActionSchema>;

export const derivedScoreActionSchema = z.enum(['reject']);
export type DerivedScoreAction = z.infer<typeof derivedScoreActionSchema>;

export const healthRuleSchema = z.strictObject({
  raw_sensor: rawSensorActionSchema,
  derived_score: derivedScoreActionSchema,
});
export type HealthRule = z.infer<typeof healthRuleSchema>;

// Generic persistence and egress destinations reject both raw and numeric-derived health.
// Nonnumeric health context requires the strict, explicitly eligible health destination view.
export const HEALTH_DESTINATION_RULES: Readonly<Record<SanitiseDestination, HealthRule>> = {
  memory_block: { raw_sensor: 'reject', derived_score: 'reject' },
  system_prompt: { raw_sensor: 'reject', derived_score: 'reject' },
  internal_context: { raw_sensor: 'reject', derived_score: 'reject' },
  draft_document: { raw_sensor: 'reject', derived_score: 'reject' },
  draft_email: { raw_sensor: 'reject', derived_score: 'reject' },
  send_message: { raw_sensor: 'reject', derived_score: 'reject' },
  sandbox_stdout: { raw_sensor: 'reject', derived_score: 'reject' },
  skill_body: { raw_sensor: 'reject', derived_score: 'reject' },
  audit_log: { raw_sensor: 'reject', derived_score: 'reject' },
  r2_summary: { raw_sensor: 'reject', derived_score: 'reject' },
  outbox: { raw_sensor: 'reject', derived_score: 'reject' },
};

// Check 3 — PII is redacted, never rejected (ADR-0024 false-positive policy: uncertainty
// defaults to redact + allow). Attendee names and street addresses use heuristics owned by
// the runtime; these four are the pinned regex forms.
export const PII_PATTERNS = {
  email: /\b[\w._%+-]+@[\w.-]+\.[a-zA-Z]{2,}\b/g,
  phone: /\b(\+?1?[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g,
  cc: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
  ipv4: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  ipv6: /(?<![0-9a-f:])(?:(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,7}:|(?:[0-9a-f]{1,4}:){1,6}:[0-9a-f]{1,4}|(?:[0-9a-f]{1,4}:){1,5}(?::[0-9a-f]{1,4}){1,2}|(?:[0-9a-f]{1,4}:){1,4}(?::[0-9a-f]{1,4}){1,3}|(?:[0-9a-f]{1,4}:){1,3}(?::[0-9a-f]{1,4}){1,4}|(?:[0-9a-f]{1,4}:){1,2}(?::[0-9a-f]{1,4}){1,5}|[0-9a-f]{1,4}:(?:(?::[0-9a-f]{1,4}){1,6})|:(?:(?::[0-9a-f]{1,4}){1,7}|:))(?![0-9a-f:])/gi,
} as const;

// Check 4 — memory and skill bodies are content, not instructions. The contract owns the
// rule table so runtime scoring cannot drift from the shared vocabulary.
export const injectionRuleIdSchema = z.enum([
  'instruction_override',
  'role_reassignment',
  'privileged_action_bypass',
  'role_boundary',
  'role_tag',
  'jailbreak_marker',
  'protected_instruction_request',
  'encoded_instruction_request',
  'priority_displacement',
  'constraint_evasion',
]);
export type InjectionRuleId = z.infer<typeof injectionRuleIdSchema>;

export const injectionRuleCategorySchema = z.enum([
  'override',
  'exfiltrate',
  'role',
  'jailbreak',
  'data',
]);
export type InjectionRuleCategory = z.infer<typeof injectionRuleCategorySchema>;

export const injectionRuleSchema = z.strictObject({
  id: injectionRuleIdSchema,
  category: injectionRuleCategorySchema,
  weight: z.number().min(0).max(1),
  pattern: z.instanceof(RegExp),
});
export type InjectionRule = z.infer<typeof injectionRuleSchema>;

const INJECTION_RULE_WEIGHTS = {
  instruction_override: 0.45,
  role_reassignment: 0.35,
  privileged_action_bypass: 0.45,
  role_boundary: 0.35,
  role_tag: 0.55,
  jailbreak_marker: 0.45,
  protected_instruction_request: 0.55,
  encoded_instruction_request: 0.55,
  priority_displacement: 0.15,
  constraint_evasion: 0.45,
} as const;

export const INJECTION_RULES = [
  {
    id: 'instruction_override',
    category: 'override',
    weight: INJECTION_RULE_WEIGHTS.instruction_override,
    pattern:
      /\b(?:ignore|disregard|override|bypass)\b(?:\s+(?:all|any|the|prior|previous|earlier|existing)){0,3}\s+\b(?:instructions?|directives?|rules?|constraints?|prompts?|messages?)\b/i,
  },
  {
    id: 'role_reassignment',
    category: 'role',
    weight: INJECTION_RULE_WEIGHTS.role_reassignment,
    pattern:
      /\b(?:you\s+are\s+(?:now|actually)\s+(?!waldo\b)|act\s+as\s+(?:an?\s+)?(?:privileged|unrestricted|system|administrator|operator)|assume\s+(?:the\s+)?(?:privileged|unrestricted|system|administrator|operator)(?:\s+(?:operator|administrator))?\s+role)\b/i,
  },
  {
    id: 'privileged_action_bypass',
    category: 'override',
    weight: INJECTION_RULE_WEIGHTS.privileged_action_bypass,
    pattern:
      /\b(?:send|execute|invoke|call)\b(?:\s+\w+){0,4}\s+\b(?:without|bypassing)\s+(?:approval|confirmation|guardrails?)\b/i,
  },
  {
    id: 'role_boundary',
    category: 'role',
    weight: INJECTION_RULE_WEIGHTS.role_boundary,
    pattern: /\b(?:system|assistant)(?:\s*:\s*|\s+)|\b(?:developer|user)\s*:/i,
  },
  {
    id: 'role_tag',
    category: 'role',
    weight: INJECTION_RULE_WEIGHTS.role_tag,
    pattern: /<\s*\/?(?:system|assistant|developer|user)\s*>/i,
  },
  {
    id: 'jailbreak_marker',
    category: 'jailbreak',
    weight: INJECTION_RULE_WEIGHTS.jailbreak_marker,
    pattern:
      /\b(?:jailbreak|dan|grandma|developer\s+mode|unrestricted\s+mode|do\s+anything\s+now)\b/i,
  },
  {
    id: 'protected_instruction_request',
    category: 'exfiltrate',
    weight: INJECTION_RULE_WEIGHTS.protected_instruction_request,
    pattern:
      /\b(?:reveal|expose|print|dump|return)\b(?:\s+\w+){0,3}\s+\b(?:system\s+prompt|hidden\s+(?:rules?|instructions?)|internal\s+(?:rules?|instructions?))\b/i,
  },
  {
    id: 'encoded_instruction_request',
    category: 'data',
    weight: INJECTION_RULE_WEIGHTS.encoded_instruction_request,
    pattern:
      /\b(?:decode|translate|expand)\b(?:\s+\w+){0,3}\s+\b(?:the\s+)?(?:encoded|hidden)\s+(?:instructions?|directives?)\b/i,
  },
  {
    id: 'priority_displacement',
    category: 'override',
    weight: INJECTION_RULE_WEIGHTS.priority_displacement,
    pattern: /\b(?:new|higher|top)\s+(?:instructions?|priority|directive)\b/i,
  },
  {
    id: 'constraint_evasion',
    category: 'override',
    weight: INJECTION_RULE_WEIGHTS.constraint_evasion,
    pattern:
      /\b(?:do\s+not|don't)\s+(?:follow|obey)\b(?:\s+\w+){0,3}\s+\b(?:rules?|constraints?|guardrails?)\b/i,
  },
] as const satisfies readonly InjectionRule[];

export const injectionGuardThresholdsSchema = z
  .strictObject({
    review: z.number().positive().max(1),
    block: z.number().positive().max(1),
  })
  .refine((thresholds) => thresholds.block > thresholds.review, {
    error: 'block threshold must exceed review threshold',
    path: ['block'],
  });
export type InjectionGuardThresholds = z.infer<typeof injectionGuardThresholdsSchema>;

export const INJECTION_GUARD_THRESHOLDS = {
  review: 0.15,
  block: 0.7,
} as const satisfies InjectionGuardThresholds;

export const guardDecisionSchema = z.enum(['allow', 'review', 'block']);
export type GuardDecision = z.infer<typeof guardDecisionSchema>;

export const injectionRuleMatchSchema = z.strictObject({
  id: injectionRuleIdSchema,
  weight: z.number().min(0).max(1),
});
export type InjectionRuleMatch = z.infer<typeof injectionRuleMatchSchema>;

export const guardVerdictSchema = z
  .strictObject({
    decision: guardDecisionSchema,
    score: z.number().nonnegative(),
    matches: z.array(injectionRuleMatchSchema).max(INJECTION_RULES.length),
    matchCount: z.int().nonnegative().max(INJECTION_RULES.length),
  })
  .superRefine((verdict, ctx) => {
    if (verdict.matchCount !== verdict.matches.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'matchCount must equal matches length',
        path: ['matchCount'],
      });
    }
    if (verdict.score !== verdict.matches.reduce((total, match) => total + match.weight, 0)) {
      ctx.addIssue({
        code: 'custom',
        message: 'score must equal the sum of match weights',
        path: ['score'],
      });
    }
    if (new Set(verdict.matches.map((match) => match.id)).size !== verdict.matches.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'matches must not repeat a rule id',
        path: ['matches'],
      });
    }
    for (const match of verdict.matches) {
      const rule = INJECTION_RULES.find((candidate) => candidate.id === match.id);
      if (rule?.weight !== match.weight) {
        ctx.addIssue({
          code: 'custom',
          message: 'match weight must equal the canonical rule weight',
          path: ['matches'],
        });
      }
    }
    const expected =
      verdict.score >= INJECTION_GUARD_THRESHOLDS.block
        ? 'block'
        : verdict.score >= INJECTION_GUARD_THRESHOLDS.review
          ? 'review'
          : 'allow';
    if (verdict.decision !== expected) {
      ctx.addIssue({
        code: 'custom',
        message: 'decision must match the weighted thresholds',
        path: ['decision'],
      });
    }
  });
export type GuardVerdict = z.infer<typeof guardVerdictSchema>;

// ADR-0024's 2 KB memory-block cap in UTF-16 units — the single owner both the sanitiser
// table below and memoryContentSchema (hall.ts) derive from, so the schema seam and the
// sanitise seam cannot disagree on what fits in a block.
export const MEMORY_BLOCK_CONTENT_MAX = SANITISE_DESTINATION_POLICIES.memory_block.max_chars;

// Check 5 — caps compare UTF-16 length, matching the ADR-0024 length comparison; a
// destination absent here carries no pinned cap. Only sandbox stdout truncates on overflow;
// every other capped destination rejects.
export const SIZE_CAPS = {
  memory_block: SANITISE_DESTINATION_POLICIES.memory_block.max_chars,
  sandbox_stdout: SANITISE_DESTINATION_POLICIES.sandbox_stdout.max_chars,
  draft_document: SANITISE_DESTINATION_POLICIES.draft_document.max_chars,
  draft_email: SANITISE_DESTINATION_POLICIES.draft_email.max_chars,
  skill_body: SANITISE_DESTINATION_POLICIES.skill_body.max_chars,
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
// stamp and the persisted inbox row (hall.ts). This module is the single owner of the taint
// vocabulary: the literal, the schema, and the detection primitive all live here, and every
// consumer — the tool gate (tools/handler) and the trust-escalation refines (this file +
// hall.ts) — routes through them, so a rename of the constant can never leave a stale
// hard-coded literal behind.
// External-taint DETECTION, not a gate decision: it answers only "did this value originate
// outside Waldo's trust boundary?" The privileged-action gate (ADR-0049) is tool-scoped and
// lives in tools/handler; external taint alone never blocks a tool — a tainted read is always
// allowed, only a tainted privileged action is barred from direct execution.
export function isExternalSourceTaint(taint: SourceTaint): boolean {
  return taint === EXTERNAL_SOURCE_TAINT;
}

// Tainted content never escalates trust class (ADR-0049): whatever provenance the text
// asserts, an external-tainted stamp lands 'inferred'. That also makes "always queues"
// structural — 'inferred' never dominates and never refreshes itself, so a tainted proposal
// can only wait in the inbox for the merge.
export const taintStampSchema = z
  .strictObject({
    source_trust: trustClassSchema,
    source_taint: sourceTaintSchema,
  })
  .refine((stamp) => !isExternalSourceTaint(stamp.source_taint) || stamp.source_trust === 'inferred', {
    error: 'tainted content never escalates trust class',
    path: ['source_trust'],
  });
export type TaintStamp = z.infer<typeof taintStampSchema>;
