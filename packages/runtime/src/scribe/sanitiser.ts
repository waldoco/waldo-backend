import { validId } from '@waldo/workspace';
import {
  DERIVED_SCORE_PATTERNS,
  HEALTH_DESTINATION_RULES,
  MODEL_CONTEXT_MAX_CHARS,
  PLAIN_WORD_DERIVED_SCORES,
  derivedHealthDestinationViewSchema,
  PII_PATTERNS,
  RAW_SENSOR_PATTERNS,
  ROLE_TAG_PATTERN,
  SANITISE_DESTINATION_POLICIES,
  TRUNCATION_MARKER,
  sanitiseInputSchema,
  type Redaction,
  type RedactionKind,
  type SanitiseCheck,
  type SanitiseDecodeFailure,
  type SanitiseDenialDiagnostic,
  type SanitiseDestination,
  type SanitiseDestinationPolicy,
  type SanitiseFailureReason,
  type SanitiseInput,
  type SourceTaint,
  type SanitiseResult,
} from '@waldo/contracts';

type JsonValue = SanitiseInput['payload'];

interface PreparedInput extends Omit<SanitiseInput, 'payload'> {
  payload: JsonValue;
}

// An invalid bundle says why decoding stopped short.
type DecodeBundle = { views: string[] } & (
  | { invalid: false }
  | { invalid: true; failure: SanitiseDecodeFailure }
);

interface EncodedSpan {
  key: string;
  start: number;
  end: number;
  decoded: string;
}

interface DecodeNode {
  text: string;
  spans: EncodedSpan[];
}

interface TransformResult {
  invalid: boolean;
  payload: JsonValue;
}

const MAX_PREFLIGHT_DEPTH = 128;
const MAX_PREFLIGHT_NODES = 20_000;
// One string may be as long as the model's own context allows; the destination policy then enforces its own cap.
const MAX_PREFLIGHT_STRING_CHARS = MODEL_CONTEXT_MAX_CHARS;
const MAX_DECODE_PASSES = 2;
// The most views decodedViews can generate. Each frontier node yields at most DECODE_VIEW_KINDS new views per pass
// (all spans, JSON escapes, percent, base64), and each of those may join the next frontier, so pass p yields at most
// DECODE_VIEW_KINDS^p views and all passes together sum(DECODE_VIEW_KINDS^p, p = 1..MAX_DECODE_PASSES) = 4 + 16 = 20.
// Every decoder only shortens text (a JSON escape is 6 characters to 1, a percent byte 3 to at most 1, base64 4 to 3),
// so no view is longer than the text, and the decoded total is at most MAX_DECODE_VIEWS times the text length. A
// decoder that ever lengthened text, or a wider fan-out, would trip this cap and fail closed as decode:budget.
const DECODE_VIEW_KINDS = 4;
const MAX_DECODE_VIEWS = Array.from({ length: MAX_DECODE_PASSES }, (_, pass) => DECODE_VIEW_KINDS ** (pass + 1)).reduce((sum, views) => sum + views, 0);
const REDACTION_ORDER: readonly RedactionKind[] = [
  'email',
  'phone',
  'attendee_name',
  'address',
  'credit_card',
  'instruction_pattern',
];

const HEALTH_KEY = /(?:^|[^a-z0-9])(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|blood[\s_-]*pressure|bp|body[\s_-]*(?:weight|mass|temperature)|weight|respiratory[\s_-]*rate|breathing[\s_-]*rate|blood[\s_-]*glucose|glucose|steps|step[\s_-]*count|motion|circadian|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy|sleep(?:[\s_-]*(?:hours?|duration|minutes?|mins?|efficiency|stages?))?|rem[\s_-]*sleep|deep[\s_-]*sleep|provider[\s_-]*payload|health[\s_-]*payload|raw[\s_-]*payload|crs|form(?:[\s_-]*score)?|recovery(?:[\s_-]*score)?|load(?:[\s_-]*score)?)(?:[^a-z0-9]|$)/i;
const HEALTH_KEY_COMPACT = /^(?:hrv(?:ms)?|heartratevariability(?:ms)?|restingheartrate(?:bpm)?|heartrate(?:bpm)?|pulse(?:bpm)?|spo2|oxygensaturation(?:percent|pct)?|bloodoxygen(?:percent|pct)?|systolic(?:mmhg)?|diastolic(?:mmhg)?|bloodpressure|bp|bodyweight(?:kg|lb|lbs)?|bodymass(?:kg|lb|lbs)?|weight(?:kg|lb|lbs)?|bodytemperature|respiratoryrate|breathingrate|bloodglucose|glucose|steps|stepcount|motion|circadian|calorieburn(?:kcal)?|caloriesburned(?:kcal)?|activeenergy(?:kcal)?|sleep(?:hours|duration|minutes|mins|efficiency|stages?)?|remsleep(?:minutes|mins)?|deepsleep(?:minutes|mins)?|providerpayload|healthpayload|rawpayload|crs|form(?:score)?|recovery(?:score)?|load(?:score)?)$/i;
const HEALTH_INDICATOR_VALUE = /^(?:hrv|heart rate(?: variability)?|resting heart rate|pulse|spo2|oxygen saturation|blood oxygen|systolic|diastolic|blood pressure|bp|body weight|body mass|weight|body temperature|respiratory rate|breathing rate|blood glucose|glucose|steps|step count|motion|circadian|sleep|sleep efficiency|sleep stage|sleep stages|rem sleep|deep sleep|active energy|calorie burn|provider payload|health payload|raw payload|crs|form|recovery|load)$/i;
const NUMERIC_VALUE = /^\s*["']?[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?(?:\s*\/\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)?["']?\s*$/;
const HEALTH_DISCRIMINATOR_KEY = /^(?:metric|measure|measurement|indicator|signal|type|kind|name)$/i;
const FORBIDDEN_HEALTH_PAYLOAD_KEY = /^(?:motion|circadian|provider[\s_-]*payload|health[\s_-]*payload|raw[\s_-]*payload|sleep[\s_-]*stages?)$/i;
const RAW_HEALTH_SERIES_KEY = /^(?:samples?|series)$/i;
const DERIVED_HEALTH_ELIGIBILITIES = new Set([
  'trigger_prompt',
  'volatile_run',
  'runtime_trace',
  'r2_today_summary',
  'r2_baselines_summary',
]);
const HEALTH_UNIT_VALUE = /^(?:ms|bpm|beats|breaths?(?: per minute)?|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|steps?|hours?|hrs?|minutes?|mins?|celsius|fahrenheit|°c|°f|degrees?\s*[cf]|mg\/dl|mmol\/l)$/i;
// Health phrases with a number: the free-text floor for destinations the structured checks do not cover.
const HEALTH_FREE_TEXT_NUMERIC: readonly RegExp[] = [
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|blood[\s_-]*pressure|bp|body[\s_-]*(?:weight|mass)|weight|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy|sleep(?:[\s_-]*(?:hours?|duration|minutes?|mins?))?|rem[\s_-]*sleep|deep[\s_-]*sleep|crs|form(?:[\s_-]*score)?|recovery(?:[\s_-]*score)?|load(?:[\s_-]*score)?)\b\s*,\s*["']?-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?["']?\s*,\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|hours?|hrs?|minutes?|mins?)(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|body[\s_-]*(?:weight|mass)|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories)?(?=$|[^a-z0-9])/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*mmhg\b/i,
  /\b(?:sleep|slept|rem[\s_-]*sleep|deep[\s_-]*sleep|time[\s_-]*asleep)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/i,
  /\b(?:crs|form|recovery|load)(?:[\s_-]*score)?\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d{1,3}\b/i,
  /\b(?:steps|step[\s_-]*count|motion|circadian|sleep[\s_-]*efficiency|sleep[\s_-]*stages?|body[\s_-]*temperature|respiratory[\s_-]*rate|breathing[\s_-]*rate|blood[\s_-]*glucose|glucose|provider[\s_-]*payload|health[\s_-]*payload|raw[\s_-]*payload)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:steps|percent|pct|%|minutes?|mins?|celsius|fahrenheit|breaths?(?:\s+per\s+minute)?|mg\/dl|mmol\/l)?(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate|spo2|blood[\s_-]*pressure|body[\s_-]*weight|steps|sleep[\s_-]*duration|body[\s_-]*temperature|respiratory[\s_-]*rate|glucose|crs|form|recovery|load)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+["']?(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate|spo2|blood[\s_-]*pressure|body[\s_-]*(?:weight|temperature)|steps|sleep[\s_-]*(?:duration|efficiency)|respiratory[\s_-]*rate|glucose|crs|form|recovery|load)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?-?\d+(?:\.\d+)?["']?(?:\s*,?\s*)(?:°[cf]|degrees?\s*[cf])(?=$|[^a-z0-9])/i,
];
// Health phrases without a number (a state named in words). Kept apart so a later qualitative entry can never join the
// numeric floor by accident.
const HEALTH_FREE_TEXT_QUALITATIVE: readonly RegExp[] = [
  /\b(?:motion|circadian(?:\s+rhythm)?|sleep[\s_-]*stage)\b\s*(?::|=|,|\bis\b|\bwas\b)\s*["']?[a-z][a-z\s_-]{0,32}["']?(?=$|[;,.])/i,
];
const HEALTH_FREE_TEXT: readonly RegExp[] = [...HEALTH_FREE_TEXT_NUMERIC, ...HEALTH_FREE_TEXT_QUALITATIVE];

// What may sit between a metric and its number in a reading: a separator or a reading word ("was", "about", "of").
// Anything else ("check meeting at", "week") means the number is not that metric's value.
const READING_GAP = String.raw`(?:\s*(?:[:=~]|\b(?:is|was|were|are|of|at|about|around|roughly|approx(?:imately)?|averag(?:e|es|ed|ing)|avg|only|just|under|over|below|above|nearly|almost|hit|reads?|reading|down\s+to|up\s+to)\b))*\s*`;
const READING_NUMBER = String.raw`\d+(?:[.,]\d+)?`;
const reading = (source: string): RegExp => new RegExp(source, 'i');
// Readings in an owner's own words: a metric tied to its number through READING_GAP, or a number carrying a unit only a
// health measurement uses. Words a metric shares with ordinary life (form, load, recovery, steps, pulse) count only with
// a score, a unit or a reading word, so "Form 16", "Laundry load at 6" or "Pulse check meeting at 7" are not readings.
const OWNER_HEALTH_READINGS: readonly RegExp[] = [
  reading(String.raw`\b${READING_NUMBER}\s*(?:bpm|beats\s+per\s+minute)\b`),
  reading(String.raw`\b${READING_NUMBER}\s*mm\s*hg\b`),
  reading(String.raw`\b${READING_NUMBER}\s*(?:mg\s*\/\s*dl|mmol\s*\/\s*l)\b`),
  reading(String.raw`\b(?:resting\s+(?:hr|heart\s+rate|pulse)|heart\s+rate|rhr)\b${READING_GAP}\d`),
  reading(String.raw`\b(?:hr|pulse)\b${READING_GAP}\d{2,3}\b(?!\s*(?:people|staff|employees|members|%))`),
  reading(String.raw`\b(?:hrv|heart\s+rate\s+variability)\b${READING_GAP}\d`),
  reading(String.raw`\b(?:spo2|sp\s*o2|o2\s+sat(?:uration)?|oxygen\s+(?:saturation|level|sat)|blood\s+oxygen)\b${READING_GAP}\d`),
  reading(String.raw`\b(?:bp|blood\s+pressure)\b${READING_GAP}\d{2,3}\s*(?:\/|over)\s*\d{2,3}\b`),
  reading(String.raw`\bblood\s+pressure\b${READING_GAP}\d`),
  reading(String.raw`\b(?:weigh(?:s|ed|ing)?|weight|body\s+weight)\b${READING_GAP}${READING_NUMBER}\s*(?:kg|kgs|kilos?|kilograms?|lbs?|pounds?|st|stone)\b`),
  reading(String.raw`\b(?:slept|sleeps?|sleeping|asleep|deep\s+sleep|rem\s+sleep)\b(?:${READING_GAP}|\s*\b(?:for|a|an|less\s+than|more\s+than)\b\s*)*${READING_NUMBER}\s*(?:h|hr|hrs|hours?|m|min|mins|minutes?)\b`),
  reading(String.raw`\b${READING_NUMBER}\s*(?:h|hrs?|hours?)\s+(?:of\s+)?(?:sleep|asleep)\b`),
  reading(String.raw`\b(?:\d{1,3}(?:,\d{3})+|\d{4,}|${READING_NUMBER}\s*k)\s*steps\b`),
  reading(String.raw`\bsteps\b${READING_GAP}(?:\d{1,3}(?:,\d{3})+|\d{4,})\b`),
  reading(String.raw`\b(?:fever|temp(?:erature)?|body\s+temp(?:erature)?)\b${READING_GAP}${READING_NUMBER}\s*(?:°\s*[cf]?|degrees?|[cf]\b|celsius|fahrenheit)`),
  reading(String.raw`\b(?:3[5-9]|4[0-2])[.,]\d\s*°?\s*c\b|\b(?:9[5-9]|10[0-8])[.,]\d\s*°?\s*f\b`),
  reading(String.raw`\b(?:glucose|blood\s+sugar|fasting\s+sugar|a1c|hba1c|cholesterol|ldl|hdl|triglycerides?)\b${READING_GAP}\d`),
  reading(String.raw`\b(?:respiratory|breathing)\s+rate\b${READING_GAP}\d`),
  reading(String.raw`\b(?:calories\s+burned|calorie\s+burn|active\s+energy)\b${READING_GAP}\d`),
  reading(String.raw`\bburn(?:ed|t)?\b${READING_GAP}${READING_NUMBER}\s*(?:kcal|cal|calories)\b`),
  reading(String.raw`\bcrs\b${READING_GAP}\d`),
  reading(String.raw`\b(?:form|recovery|load|strain|readiness|sleep|hrv)\s+score\b${READING_GAP}\d`),
  reading(String.raw`\b(?:recovery|readiness|strain)\b${READING_GAP}${READING_NUMBER}\s*%`),
];

// The numeric health floor for long-term memory and stored summaries, where a match refuses the write: the structured
// sensor shapes the contracts own (an `hrv_ms` or `weightKg` key with its number) and the owner-prose readings above. It is narrower than
// the egress scans, which may over-redact; here a false match loses an ordinary fact. Through the non-global matcher, so a
// shared `g` pattern never carries lastIndex from one call into the next.
export const numericHealthIn = (text: string): boolean =>
  [...RAW_SENSOR_PATTERNS, ...OWNER_HEALTH_READINGS].some((pattern) => matches(pattern, text));

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bsb_secret_[A-Za-z0-9_-]{16,}\b/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}["']?/i,
];
const SECRET_FIELD_KEY = /^(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|sb[_-]?secret|secret|password)$/i;

const ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/gi;
const ATTENDEE_KEY = /^(?:attendee|attendees|attendee_name|participant|participants|participant_name|contact_name)$/i;
const ADDRESS_KEY = /^(?:address|street_address|mailing_address|home_address|ip|ip_address)$/i;
const PERSON_NAME = /^[\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){1,3}$/u;
const BASE64_TOKEN = /(?<![A-Za-z0-9+\/_-])(?:(?:[A-Za-z0-9+\/_-]{4})*(?:[A-Za-z0-9+\/_-]{2}==|[A-Za-z0-9+\/_-]{3}=)|(?:[A-Za-z0-9+\/_-]{4})+(?:[A-Za-z0-9+\/_-]{2,3})?)(?![A-Za-z0-9+\/_=-])/g;
const PHONE_PATTERN = /\+?\b(?:1?[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const JSON_ESCAPE = /\\u[0-9a-fA-F]{4}/;
const JSON_ESCAPES = /\\u[0-9a-fA-F]{4}/g;
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;
const PERCENT_RUNS = /(?:%[0-9a-fA-F]{2})+/g;

function deny(check: SanitiseCheck, reason: SanitiseFailureReason): SanitiseResult {
  return { ok: false, check, reason };
}

// Every structural denial names the stage that produced it, so a trace says which check fired without any content.
function denyInvalid(diagnostic: SanitiseDenialDiagnostic): SanitiseResult {
  return { ok: false, check: 'size_cap', reason: 'invalid_payload', diagnostic };
}

function cloneRegex(pattern: RegExp): RegExp {
  return new RegExp(pattern.source, pattern.flags.replaceAll('g', ''));
}

function matches(pattern: RegExp, text: string): boolean {
  return cloneRegex(pattern).test(text);
}

function compactKey(key: string): string {
  return key.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// Core build plan H-3, by the contracts health rule `reject_scored_on_external_read`: where external content is read
// into the owner's turn, form/recovery/load with a bare number ("Form 16", "load 3 trucks", "recovery 2 days") is
// ordinary text. A "score", a %, a health unit or a ratio after it makes it a reading again, and crs, the sensor
// families and structured readings are never spared. Persistence and egress destinations keep the whole floor.
const PLAIN_WORDS = PLAIN_WORD_DERIVED_SCORES.join('|');
const PLAIN_WORD_SPAN = new RegExp(String.raw`^["'\s]*(?:${PLAIN_WORDS})\b(?![\s_-]*score)(?:\s+[a-z]+){0,3}?[\s:=,"']*[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?["']?$`, 'i');
const READING_TAIL = /^["']?\s*(?:%|\/\s*\d|(?:percent|pct|ms|bpm|mmhg|kg|kgs|lbs?|kcal|cal|calories|score)\b)/i;
const PLAIN_WORD_KEY = new RegExp(String.raw`(^|[^a-z0-9])(?:${PLAIN_WORDS})(?![\s_-]*score)(?=[^a-z0-9]|$)`, 'gi');
const PLAIN_WORD_COMPACT = new RegExp(String.raw`^(?:${PLAIN_WORDS})$`, 'i');

function sparesPlainWords(input: Readonly<{ destination: SanitiseDestination; source_taint: SourceTaint }>): boolean {
  return input.source_taint === 'external' && HEALTH_DESTINATION_RULES[input.destination].derived_score === 'reject_scored_on_external_read';
}

function plainWordSpan(match: string, rest: string): boolean {
  return PLAIN_WORD_SPAN.test(match) && !READING_TAIL.test(rest);
}

// Whether text holds a match of pattern that is health in this scope: with plain words spared, a match that is only a
// plain word and a bare number does not count, and the scan moves on to the next match.
function healthMatchIn(pattern: RegExp, text: string, plainWords: boolean): boolean {
  if (!plainWords) return matches(pattern, text);
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  for (const match of text.matchAll(global)) {
    if (!plainWordSpan(match[0], text.slice(match.index + match[0].length))) return true;
  }
  return false;
}

function healthKeyIn(key: string, plainWords: boolean): boolean {
  return HEALTH_KEY.test(plainWords ? key.replace(PLAIN_WORD_KEY, '$1') : key);
}

function isNumeric(value: unknown): boolean {
  return (
    (typeof value === 'number' && Number.isFinite(value)) ||
    (typeof value === 'string' && NUMERIC_VALUE.test(value))
  );
}

type PreparationFailure = { reason: 'oversize' };

function prepareInput(raw: SanitiseInput): PreparedInput | PreparationFailure | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;

  const payload = (raw as { payload?: unknown }).payload;
  const seen = new WeakSet<object>();
  const pending: Array<{ value: unknown; depth: number }> = [{ value: payload, depth: 0 }];
  let nodes = 0;

  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || current.depth > MAX_PREFLIGHT_DEPTH) return undefined;
    nodes += 1;
    if (nodes > MAX_PREFLIGHT_NODES) return undefined;

    const value = current.value;
    if (value === null || typeof value === 'boolean') continue;
    if (typeof value === 'string') {
      if (value.length > MAX_PREFLIGHT_STRING_CHARS) return { reason: 'oversize' };
      continue;
    }
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return undefined;
      continue;
    }
    if (typeof value !== 'object' || seen.has(value)) return undefined;
    seen.add(value);

    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index], depth: current.depth + 1 });
      }
      continue;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) return undefined;
    if (Object.getOwnPropertySymbols(value).length > 0) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (descriptor.get !== undefined || descriptor.set !== undefined) return undefined;
      if (key.length > MAX_PREFLIGHT_STRING_CHARS) return { reason: 'oversize' };
      pending.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }

  try {
    const parsed = sanitiseInputSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

function decodeJsonEscapes(text: string): string | undefined {
  if (!JSON_ESCAPE.test(text)) return undefined;
  return text.replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodePercent(text: string): string | null | undefined {
  if (!PERCENT_ESCAPE.test(text)) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function printableUtf8FromBase64(token: string): string | undefined {
  if (
    !token.includes('=') &&
    (!/[A-Z]/.test(token) || !/[a-z]/.test(token))
  ) {
    return undefined;
  }
  const normalized = token.replaceAll('-', '+').replaceAll('_', '/');
  if (normalized.length % 4 === 1) return undefined;
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    if (decoded.length === 0 || /[^\x09\x0A\x0D\x20-\x7E\u00B0]/.test(decoded)) return undefined;
    return decoded;
  } catch {
    return undefined;
  }
}

function decodeBase64Tokens(text: string): string | undefined {
  let changed = false;
  const decoded = text.replace(BASE64_TOKEN, (token) => {
    const value = printableUtf8FromBase64(token);
    if (value === undefined) return token;
    changed = true;
    return value;
  });
  return changed ? decoded : undefined;
}

function canDecodeAgain(text: string): boolean {
  // Percent is only "decodable again" when the strict decoder actually accepts it - a malformed
  // escape (issue #152) is plain text, not a pending decode layer.
  if (JSON_ESCAPE.test(text) || (PERCENT_ESCAPE.test(text) && typeof decodePercent(text) === 'string')) return true;
  BASE64_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(BASE64_TOKEN)) {
    if (printableUtf8FromBase64(match[0]) !== undefined) return true;
  }
  return false;
}

function encodedSpans(text: string): EncodedSpan[] {
  const spans: EncodedSpan[] = [];
  for (const match of text.matchAll(JSON_ESCAPES)) {
    const decoded = String.fromCharCode(Number.parseInt(match[0].slice(2), 16));
    spans.push({ key: `json:${match[0]}`, start: match.index, end: match.index + match[0].length, decoded });
  }
  if (typeof decodePercent(text) === 'string') {
    for (const match of text.matchAll(PERCENT_RUNS)) {
      const decoded = decodePercent(match[0]);
      if (typeof decoded !== 'string') continue;
      spans.push({ key: `percent:${match[0]}`, start: match.index, end: match.index + match[0].length, decoded });
    }
  }
  for (const match of text.matchAll(BASE64_TOKEN)) {
    const decoded = printableUtf8FromBase64(match[0]);
    if (decoded === undefined) continue;
    spans.push({ key: `base64:${match[0]}`, start: match.index, end: match.index + match[0].length, decoded });
  }
  return spans.sort((left, right) => left.start - right.start);
}

// Decodes every span the text carries at once: independent encodings side by side are one layer.
// Where two kinds claim overlapping characters the earlier span wins; the single-kind views keep
// the other reading.
function decodeLayer(node: DecodeNode): string {
  let output = '';
  let cursor = 0;
  for (const span of node.spans) {
    if (span.start < cursor) continue;
    output += node.text.slice(cursor, span.start) + span.decoded;
    cursor = span.end;
  }
  return output + node.text.slice(cursor);
}

function exposesNewSpan(child: EncodedSpan[], parent: EncodedSpan[]): boolean {
  const remaining = new Map<string, number>();
  for (const span of parent) remaining.set(span.key, (remaining.get(span.key) ?? 0) + 1);
  for (const span of child) {
    const count = remaining.get(span.key) ?? 0;
    if (count === 0) return true;
    remaining.set(span.key, count - 1);
  }
  return false;
}

function decodedViews(text: string): DecodeBundle {
  const views = [text];
  const known = new Set(views);
  // The budget bounds work; it is not the security boundary (MAX_DECODE_PASSES + canDecodeAgain is). It is the
  // algorithm's own maximum, so ordinary sibling encodings cannot use it up and deny a legitimate token beside them:
  // a fixed 4x of the text did exactly that to every day card (decode:budget:mixed:2). See MAX_DECODE_VIEWS.
  const maxDecodedChars = Math.max(text.length, 1) * MAX_DECODE_VIEWS;
  let frontier: DecodeNode[] = [{ text, spans: encodedSpans(text) }];
  let decodedChars = 0;

  // Depth is counted per lineage: a view sits one layer below the view it was decoded from.
  // The all-spans view goes deeper while anything stays decodable. A single-kind view goes
  // deeper only when its decode exposed a span its parent did not carry (a nested encoding,
  // or characters that joined a neighbour into a new token); its parent's sibling spans are
  // already decoded together in the all-spans view, so they are not counted as nesting.
  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next: DecodeNode[] = [];
    for (const node of frontier) {
      // A percent sequence the strict decoder rejects is not an encoding - the model cannot
      // decode it either, so no obfuscation channel exists. The raw string stays in views[0]
      // and is scanned as-is; ordinary text like "20%DEALS" must not deny the payload (#152).
      const percent = decodePercent(node.text) ?? undefined;
      const generated = [
        { value: decodeLayer(node), allSpans: true, kind: 'mixed' },
        { value: decodeJsonEscapes(node.text), allSpans: false, kind: 'json' },
        { value: percent, allSpans: false, kind: 'percent' },
        { value: decodeBase64Tokens(node.text), allSpans: false, kind: 'base64' },
      ] as const;
      for (const { value, allSpans, kind } of generated) {
        if (typeof value !== 'string' || value === node.text || known.has(value)) continue;
        decodedChars += value.length;
        if (value.length > maxDecodedChars || decodedChars > maxDecodedChars) {
          return { invalid: true, views, failure: { cause: 'budget', kind, depth: pass + 1 } };
        }
        known.add(value);
        views.push(value);
        const spans = encodedSpans(value);
        if (allSpans ? spans.length > 0 : exposesNewSpan(spans, node.spans)) next.push({ text: value, spans });
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  const pending = frontier.find((node) => canDecodeAgain(node.text));
  if (pending !== undefined) {
    return { invalid: true, views, failure: { cause: 'nesting', kind: pendingKind(pending.text), depth: MAX_DECODE_PASSES + 1 } };
  }
  return { invalid: false, views };
}

// The encoding still decodable after the last pass, named in canDecodeAgain's order.
function pendingKind(text: string): SanitiseDecodeFailure['kind'] {
  if (JSON_ESCAPE.test(text)) return 'json';
  if (PERCENT_ESCAPE.test(text) && typeof decodePercent(text) === 'string') return 'percent';
  return 'base64';
}

function hasDecodedHealthIndicator(
  text: string,
  destination: SanitiseDestination,
  plainWords = false,
): boolean {
  const decoded = decodedViews(text);
  return decoded.views.some((view) => isHealthIndicatorText(view, plainWords));
}

function visitStrings(
  payload: JsonValue,
  destination: SanitiseDestination,
  visitor: (text: string, key: boolean) => boolean,
  skipEligibleHealthViews = false,
): { invalid?: SanitiseDenialDiagnostic; matched: boolean } {
  const pending: Array<{ value: JsonValue; key: boolean }> = [{ value: payload, key: false }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const { value } = current;
    if (typeof value === 'string') {
      const decoded = decodedViews(value);
      if (decoded.invalid) return { invalid: { stage: 'decode', decode: decoded.failure }, matched: false };
      if (decoded.views.some((view) => visitor(view, current.key))) {
        return { matched: true };
      }
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;
    if (
      skipEligibleHealthViews &&
      !Array.isArray(value) &&
      isEligibleHealthView(value, destination)
    ) {
      continue;
    }
    if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index -= 1) {
        pending.push({ value: value[index] as JsonValue, key: false });
      }
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      pending.push({ value: key, key: true });
      pending.push({ value: item, key: false });
    }
  }
  return { matched: false };
}

// What the canary and secret check finds in one string view: this session's canary first, then a secret pattern.
const canaryOrSecretIn = (text: string, canaries: readonly string[]): 'canary' | 'secret' | null => {
  if (canaries.some((token) => text.toLowerCase().includes(token))) return 'canary';
  return SECRET_PATTERNS.some((pattern) => matches(pattern, text)) ? 'secret' : null;
};

// Whether the scribe would refuse this text for a canary or a secret, in any decoded view. A caller that builds a payload
// from material it does not control uses it to leave that piece out, so one hidden token cannot make the scribe refuse the
// whole result. Text the decoder cannot read counts as refused, because the scribe refuses it too.
export const carriesSecretOrCanary = (text: string, canaries: readonly string[] = []): boolean => {
  const tokens = canaries.map((token) => token.toLowerCase());
  let found = false;
  const result = visitStrings(text, 'internal_context', (view) => { found = canaryOrSecretIn(view, tokens) !== null; return found; });
  return found || result.invalid !== undefined;
};

function containsCanaryOrSecret(
  payload: JsonValue,
  input: PreparedInput,
): SanitiseResult | undefined {
  // Only this session's three canaries are tripwires. A regex for any 16-hex run
  // rejected ordinary provider IDs and tracking codes in mail/card context.
  // visitStrings also checks decoded views and object keys at every taint and destination.
  const canaries = input.canary_tokens.map((token) => token.toLowerCase());
  let canaryFound = false;
  let secretFound = containsStructuredSecret(payload, input.destination);
  const result = visitStrings(payload, input.destination, (text) => {
    const hit = canaryOrSecretIn(text, canaries);
    if (hit === 'canary') canaryFound = true;
    else if (hit === 'secret') secretFound = true;
    return false;
  });
  if (result.invalid !== undefined) return denyInvalid(result.invalid);
  if (canaryFound) return deny('canary_token', 'canary_leak');
  return secretFound ? deny('canary_token', 'secret_leak') : undefined;
}

function containsStructuredSecret(
  payload: JsonValue,
  destination: SanitiseDestination,
): boolean {
  const pending = [payload];
  while (pending.length > 0) {
    const value = pending.pop();
    if (typeof value !== 'object' || value === null) continue;
    if (Array.isArray(value)) {
      pending.push(...value);
      continue;
    }
    for (const [key, item] of Object.entries(value)) {
      const keyViews = decodedViews(key);
      if (
        typeof item === 'string' &&
        item.trim().length >= 12 &&
        keyViews.views.some((view) => SECRET_FIELD_KEY.test(view.trim()))
      ) {
        return true;
      }
      pending.push(item);
    }
  }
  return false;
}

function destinationEligibility(destination: SanitiseDestination): readonly string[] {
  switch (destination) {
    case 'system_prompt':
      return ['trigger_prompt'];
    case 'internal_context':
      return ['volatile_run'];
    case 'audit_log':
      return ['runtime_trace'];
    case 'r2_summary':
      return ['r2_today_summary', 'r2_baselines_summary'];
    default:
      return [];
  }
}

function isEligibleHealthView(value: object, destination: SanitiseDestination): boolean {
  const parsed = derivedHealthDestinationViewSchema.safeParse(value);
  if (!parsed.success) return false;
  const allowed = destinationEligibility(destination);
  return parsed.data.destination_eligibility.some((eligibility) => allowed.includes(eligibility));
}

function looksLikeDerivedHealthView(value: Record<string, JsonValue>): boolean {
  if (
    Object.hasOwn(value, 'form_zone') ||
    Object.hasOwn(value, 'recovery_zone') ||
    Object.hasOwn(value, 'missing_components') ||
    Object.hasOwn(value, 'confidence_band') ||
    Object.hasOwn(value, 'provenance_refs')
  ) {
    return true;
  }
  if (
    typeof value.algorithm_version === 'string' &&
    (value.algorithm_version.startsWith('form.') || value.algorithm_version.startsWith('recovery.'))
  ) {
    return true;
  }
  return (
    Array.isArray(value.destination_eligibility) &&
    value.destination_eligibility.some(
      (eligibility) => DERIVED_HEALTH_ELIGIBILITIES.has(eligibility as string),
    )
  );
}

function isHealthIndicatorText(value: string, plainWords = false): boolean {
  if (plainWords && PLAIN_WORD_COMPACT.test(compactKey(value))) return false;
  return (
    HEALTH_INDICATOR_VALUE.test(value.trim()) ||
    HEALTH_KEY_COMPACT.test(compactKey(value))
  );
}

function subtreeHealthFlags(
  value: JsonValue,
  destination: SanitiseDestination,
  plainWords = false,
): {
  indicator: boolean;
  strongIndicator: boolean;
  measurement: boolean;
  numeric: boolean;
  unit: boolean;
} {
  if (typeof value === 'number') {
    return {
      indicator: false,
      strongIndicator: false,
      measurement: false,
      numeric: Number.isFinite(value),
      unit: false,
    };
  }
  if (typeof value === 'string') {
    const indicator = isHealthIndicatorText(value, plainWords);
    return {
      indicator,
      strongIndicator: indicator,
      measurement: false,
      numeric: decodedViews(value).views.some(isNumeric) || numericFromBase64(value) !== undefined,
      unit: decodedViews(value).views.some((view) => HEALTH_UNIT_VALUE.test(view.trim())),
    };
  }
  if (typeof value !== 'object' || value === null) {
    return {
      indicator: false,
      strongIndicator: false,
      measurement: false,
      numeric: false,
      unit: false,
    };
  }
  if (!Array.isArray(value)) {
    const parsedView = derivedHealthDestinationViewSchema.safeParse(value);
    if (parsedView.success) {
      return isEligibleHealthView(value, destination)
        ? {
            indicator: false,
            strongIndicator: false,
            measurement: false,
            numeric: false,
            unit: false,
          }
        : {
            indicator: true,
            strongIndicator: true,
            measurement: true,
            numeric: true,
            unit: false,
          };
    }
    if (looksLikeDerivedHealthView(value)) {
      return {
        indicator: true,
        strongIndicator: true,
        measurement: true,
        numeric: false,
        unit: false,
      };
    }
  }

  let indicator = false;
  let strongIndicator = false;
  let measurement = false;
  let numeric = false;
  let unit = false;
  if (Array.isArray(value)) {
    for (const item of value) {
      const child = subtreeHealthFlags(item, destination, plainWords);
      indicator ||= child.indicator;
      strongIndicator ||= child.strongIndicator;
      measurement ||= child.measurement;
      numeric ||= child.numeric;
      unit ||= child.unit;
    }
    measurement ||= numeric;
  } else {
    for (const [key, item] of Object.entries(value)) {
      const healthKey = healthKeyIn(key, plainWords) || hasDecodedHealthIndicator(key, destination, plainWords);
      const strongHealthKey = isStrongHealthKey(key, plainWords) || hasDecodedHealthIndicator(key, destination, plainWords);
      const encodedHealthIndicator =
        typeof item === 'string' &&
        HEALTH_DISCRIMINATOR_KEY.test(key) &&
        hasDecodedHealthIndicator(item, destination, plainWords);
      const child = subtreeHealthFlags(item, destination, plainWords);
      const rawHealthSeries = RAW_HEALTH_SERIES_KEY.test(key) && child.numeric && child.unit;
      indicator ||= healthKey || rawHealthSeries || encodedHealthIndicator;
      indicator ||= child.indicator;
      strongIndicator ||= strongHealthKey || encodedHealthIndicator || child.strongIndicator;
      measurement ||=
        FORBIDDEN_HEALTH_PAYLOAD_KEY.test(key) ||
        rawHealthSeries ||
        child.measurement;
      numeric ||= child.numeric;
      unit ||= child.unit;
    }
    measurement ||= strongIndicator && numeric;
  }
  return { indicator, strongIndicator, measurement, numeric, unit };
}

function objectHasHealthCorrelation(value: JsonValue, destination: SanitiseDestination, plainWords = false): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const flags = subtreeHealthFlags(value, destination, plainWords);
  return flags.indicator && flags.measurement;
}

function containsForbiddenHealth(
  input: PreparedInput,
  jsonPass = 0,
): { invalid?: SanitiseDenialDiagnostic; matched: boolean } {
  const plainWords = sparesPlainWords(input);
  if (objectHasHealthCorrelation(input.payload, input.destination, plainWords)) {
    return { matched: true };
  }
  // Free-text scan scope (owner decision 2026-09-28, direction A): the scan exists to keep raw
  // PROVIDER payloads out of the model's context. Owner/model conversation is null-taint, and at
  // the two conversation destinations - internal_context persistence and the system_prompt
  // admission/verify passes - it is conversation, not a payload: Waldo's health-awareness promise
  // is that the owner can discuss sleep, form, recovery and weight, and that curated aggregated
  // metrics reach the model (eval case clinical-general-health failed closed before this change:
  // "is it bad that I only sleep 5 hours most nights?" never reached the model). The free-text
  // scan still applies to EVERY external-tainted payload at EVERY destination, and to every taint
  // at every third-party egress/storage destination (send_message, audit_log, r2_summary,
  // memory_block, offload, ...) - nothing about what leaves the system changes. Direction A
  // completion (owner ruling 2026-09-28, relayed via main; merge held for his explicit
  // confirmation): the owner_reply destination -
  // the reply on the owner's OWN channel - is conversation too, so null-taint health values the
  // owner told Waldo may be spoken back to him; otherwise the agent could know his sleep but
  // never answer a question about it (live incident 2026-09-28: reply denied
  // send_message: health_value_leak). Third-party sends keep the send_message destination and
  // stay fully blocked (send_message/draft_email tool args cross their own pre-tool scribe pass).
  // Structured health correlation (indicator + measurement objects, above) and curated-view
  // eligibility are unaffected.
  const freeTextScan = !(
    input.source_taint === null &&
    (input.destination === 'internal_context' ||
      input.destination === 'system_prompt' ||
      input.destination === 'owner_reply')
  );
  let nestedInvalid: SanitiseDenialDiagnostic | undefined;
  const visited = visitStrings(
    input.payload,
    input.destination,
    (text) => {
      if (
        freeTextScan &&
        (RAW_SENSOR_PATTERNS.some((pattern) => matches(pattern, text)) ||
          DERIVED_SCORE_PATTERNS.some((pattern) => healthMatchIn(pattern, text, plainWords)) ||
          HEALTH_FREE_TEXT.some((pattern) => healthMatchIn(pattern, text, plainWords)))
      ) {
        return true;
      }
      const trimmed = text.trim();
      const looksJson =
        trimmed.startsWith('{') || trimmed.startsWith('[') || trimmed.startsWith('"');
      if (!looksJson) {
        return false;
      }
      if (jsonPass >= MAX_DECODE_PASSES) {
        nestedInvalid ??= { stage: 'health' };
        return false;
      }
      try {
        const payload = JSON.parse(trimmed) as unknown;
        if (typeof payload !== 'string' && (typeof payload !== 'object' || payload === null)) {
          return false;
        }
        const prepared = prepareInput({ ...input, payload } as SanitiseInput);
        if (prepared === undefined || 'reason' in prepared) {
          nestedInvalid ??= { stage: 'health' };
          return false;
        }
        const nested = containsForbiddenHealth(prepared, jsonPass + 1);
        nestedInvalid ??= nested.invalid;
        return nested.matched;
      } catch {
        return false;
      }
    },
    true,
  );
  const invalid = visited.invalid ?? nestedInvalid;
  return invalid === undefined ? { matched: visited.matched } : { invalid, matched: visited.matched };
}

const HEALTH_SPAN_MARKER = '[health value withheld]';

// ADR-0081 free-text scan on external content headed to the model (internal_context): the span
// is withheld and the read continues. Every other destination still denies in containsForbiddenHealth.
function redactExternalHealthSpans(
  payload: JsonValue,
  redactions: Redaction[],
  plainWords = false,
): { invalid: boolean; payload: JsonValue; redactions: Redaction[] } {
  const counts = new Map<RedactionKind, number>();
  const patterns = [...RAW_SENSOR_PATTERNS, ...DERIVED_SCORE_PATTERNS, ...HEALTH_FREE_TEXT];
  // A tool result reaches the model as a JSON-encoded string, so the page text sits inside it. Its string values are
  // redacted in place; keys, numbers and nesting are kept, so structured health still reaches the correlation check below.
  const redact = (text: string): string => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) {
        const inner = transformJsonStrings(parsed as JsonValue, (value, field) => field === undefined ? value : redact(value));
        return inner.invalid ? text : JSON.stringify(inner.payload);
      }
    } catch { /* Ordinary free text is scanned for spans. */ }
    return patterns.reduce((output, pattern) => replaceAndCount(output, pattern, HEALTH_SPAN_MARKER, 'health_value', counts, plainWords ? plainWordSpan : undefined), text);
  };
  const transformed = transformJsonStrings(payload, (text) => redact(text));
  if (transformed.invalid) return { invalid: true, payload, redactions };
  const count = counts.get('health_value') ?? 0;
  return {
    invalid: false,
    payload: transformed.payload,
    redactions: count === 0 ? redactions : [...redactions, { kind: 'health_value', count }],
  };
}

function increment(counts: Map<RedactionKind, number>, kind: RedactionKind, count = 1): void {
  counts.set(kind, (counts.get(kind) ?? 0) + count);
}

function replacementCount(text: string, pattern: RegExp): number {
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return Array.from(text.matchAll(global)).length;
}

function replaceAndCount(
  text: string,
  pattern: RegExp,
  replacement: string,
  kind: RedactionKind,
  counts: Map<RedactionKind, number>,
  // A match it returns true for (given the text after it) is left as it is and not counted.
  keep?: (match: string, rest: string) => boolean,
): string {
  if (keep !== undefined) {
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    let output = '';
    let last = 0;
    let replaced = 0;
    for (const match of text.matchAll(global)) {
      const end = match.index + match[0].length;
      if (keep(match[0], text.slice(end))) continue;
      output += text.slice(last, match.index) + replacement;
      last = end;
      replaced += 1;
    }
    if (replaced === 0) return text;
    increment(counts, kind, replaced);
    return output + text.slice(last);
  }
  const count = replacementCount(text, pattern);
  if (count === 0) return text;
  increment(counts, kind, count);
  const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
  return text.replace(global, replacement);
}

function isShortUnpaddedBase64Ipv6(text: string): boolean {
  if (!/^[A-Za-z0-9+\/_-]{3}$/.test(text)) return false;
  const decoded = printableUtf8FromBase64(text);
  if (decoded === undefined) return false;
  return matches(PII_PATTERNS.ipv6, decoded);
}

function encodedPiiKind(text: string, destination: SanitiseDestination): RedactionKind | undefined {
  const decoded = decodedViews(text);
  if (decoded.invalid) return undefined;
  for (const view of decoded.views.slice(1)) {
    if (matches(PII_PATTERNS.email, view)) return 'email';
    if (matches(PII_PATTERNS.cc, view)) return 'credit_card';
    if (matches(PII_PATTERNS.phone, view)) return 'phone';
    if (matches(PII_PATTERNS.ipv4, view)) return 'address';
    if (matches(PII_PATTERNS.ipv6, view)) return 'address';
  }
  return isShortUnpaddedBase64Ipv6(text) ? 'address' : undefined;
}

function redactEncodedPii(
  text: string,
  destination: SanitiseDestination,
  taint: SourceTaint,
  counts: Map<RedactionKind, number>,
): string {
  let output = text.replace(BASE64_TOKEN, (token) => {
    const kind = encodedPiiKind(token, destination);
    if (kind === undefined || ownerReadable(destination, taint, kind)) return token;
    increment(counts, kind);
    return `[REDACTED_${kind === 'credit_card' ? 'CREDIT_CARD' : kind.toUpperCase()}]`;
  });
  const candidates = /(?:[A-Za-z0-9._+\/%-]|\\u[0-9a-fA-F]{4}){3,}/g;
  output = output.replace(candidates, (token) => {
    const kind = encodedPiiKind(token, destination);
    if (kind === undefined || ownerReadable(destination, taint, kind)) return token;
    increment(counts, kind);
    return `[REDACTED_${kind === 'credit_card' ? 'CREDIT_CARD' : kind.toUpperCase()}]`;
  });
  return output;
}

// Owner seam split. Two readable cases:
// 1. Owner-authored payload (source_taint null) headed to the model or the owner's own channel
//    (OWNER_READABLE_DESTINATIONS): contact details stay readable; redacting them broke draft_email.
// 2. Any taint (mail, calendar, files, web results) headed to the model or the owner reply
//    (MODEL_AND_OWNER_DESTINATIONS): email/phone/address and attendee names stay readable, because
//    redaction made the agent dumber. Accepted trade-off: internal_context also carries web_search
//    third-party content.
// Persistence and outbound destinations (memory_block, draft_document, skill_body, audit_log,
// r2_summary, outbox, sandbox_stdout, the offload store) keep full redaction. credit_card never skips.
const OWNER_READABLE_DESTINATIONS: ReadonlySet<SanitiseDestination> = new Set([
  'system_prompt',
  'internal_context',
  'draft_email',
  'send_message',
  'owner_reply',
]);
const OWNER_SKIPPABLE_KINDS: ReadonlySet<RedactionKind> = new Set(['email', 'phone', 'address']);

// Owner direction 2026-10-04: the model and the owner's own reply see the owner's connected data
// (mail, calendar, files) unredacted whatever its taint. Why this is safe: these destinations stay
// inside this owner's own context; persistence and outbound destinations keep full redaction.
const MODEL_AND_OWNER_DESTINATIONS: ReadonlySet<SanitiseDestination> = new Set(['system_prompt', 'internal_context', 'owner_reply']);

function ownerReadable(destination: SanitiseDestination, taint: SourceTaint, kind: RedactionKind): boolean {
  if (!OWNER_SKIPPABLE_KINDS.has(kind)) return false;
  if (MODEL_AND_OWNER_DESTINATIONS.has(destination)) return true;
  return taint === null && OWNER_READABLE_DESTINATIONS.has(destination);
}

const WORKSPACE_ID_KEYS: ReadonlySet<string> = new Set(['file_id', 'blob_id', 'operation_id', 'source_file_id']);
const WORKSPACE_URL_KEYS: ReadonlySet<string> = new Set(['url', 'download_url']);

// Exactly what workspace-delivery.ts emits: https origin, the file path, id (uuid) then a numeric revision.
function isWorkspaceFileUrl(text: string): boolean {
  let parsed: URL;
  try { parsed = new URL(text); } catch { return false; }
  if (parsed.protocol !== 'https:' || parsed.username !== '' || parsed.password !== '' || parsed.hash !== '') return false;
  if (parsed.pathname !== '/console/workspace/file') return false;
  const id = parsed.searchParams.get('id');
  const revision = parsed.searchParams.get('revision');
  if (id === null || revision === null || !validId(id) || !/^[0-9]{1,9}$/.test(revision)) return false;
  return text === `${parsed.origin}/console/workspace/file?id=${id}&revision=${revision}`;
}

// Everything outside the uuid slot gets the same redaction as free text; any change means it carried PII.
function urlOutsideIdIsClean(text: string, destination: SanitiseDestination, taint: SourceTaint): boolean {
  const id = new URL(text).searchParams.get('id') ?? '';
  const template = text.replace(id, 'ID');
  return redactPiiText(template, undefined, destination, taint, new Map()) === template;
}

function redactPiiText(
  text: string,
  key: string | undefined,
  destination: SanitiseDestination,
  taint: SourceTaint,
  counts: Map<RedactionKind, number>,
): string {
  // Model/owner-bound workspace references keep their exact bytes for later calls, only under an
  // allowlisted key and in the exact shape the producer emits; a URL must also be clean outside
  // its uuid slot. Taint is not checked (the provider pass taints a whole batch). Known residual:
  // content under an allowlisted id key that is a valid uuid with a card-looking tail survives.
  // Everything else (free text, other keys, other URL shapes) is still redacted below.
  if (key !== undefined && MODEL_AND_OWNER_DESTINATIONS.has(destination)) {
    if (WORKSPACE_ID_KEYS.has(key) && validId(text)) return text;
    if (WORKSPACE_URL_KEYS.has(key) && isWorkspaceFileUrl(text) && urlOutsideIdIsClean(text, destination, taint)) return text;
  }
  let output = redactEncodedPii(text, destination, taint, counts);
  output = replaceAndCount(
    output,
    PII_PATTERNS.cc,
    '[REDACTED_CREDIT_CARD]',
    'credit_card',
    counts,
  );
  if (!ownerReadable(destination, taint, 'email'))
    output = replaceAndCount(output, PII_PATTERNS.email, '[REDACTED_EMAIL]', 'email', counts);
  if (!ownerReadable(destination, taint, 'phone'))
    output = replaceAndCount(output, PHONE_PATTERN, '[REDACTED_PHONE]', 'phone', counts);
  if (!ownerReadable(destination, taint, 'address')) {
    output = replaceAndCount(output, PII_PATTERNS.ipv4, '[REDACTED_ADDRESS]', 'address', counts);
    output = replaceAndCount(output, PII_PATTERNS.ipv6, '[REDACTED_ADDRESS]', 'address', counts);
    output = replaceAndCount(output, ADDRESS_PATTERN, '[REDACTED_ADDRESS]', 'address', counts);
  }

  if (key !== undefined && !MODEL_AND_OWNER_DESTINATIONS.has(destination) && ATTENDEE_KEY.test(key) && PERSON_NAME.test(output)) {
    increment(counts, 'attendee_name');
    return '[REDACTED_ATTENDEE_NAME]';
  }
  if (key !== undefined && ADDRESS_KEY.test(key) && !ownerReadable(destination, taint, 'address') && output === text && output.trim().length > 0) {
    increment(counts, 'address');
    return '[REDACTED_ADDRESS]';
  }
  return output;
}

function transformJsonStrings(
  payload: JsonValue,
  transform: (text: string, key: string | undefined) => string,
  parentKey?: string,
): TransformResult {
  if (typeof payload === 'string') {
    return { invalid: false, payload: transform(payload, parentKey) };
  }
  if (typeof payload !== 'object' || payload === null) return { invalid: false, payload };
  if (Array.isArray(payload)) {
    const output: JsonValue[] = [];
    for (const item of payload) {
      const transformed = transformJsonStrings(item, transform, parentKey);
      if (transformed.invalid) return transformed;
      output.push(transformed.payload);
    }
    return { invalid: false, payload: output };
  }

  const output: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(payload)) {
    const transformedKey = transform(key, undefined);
    if (Object.hasOwn(output, transformedKey)) return { invalid: true, payload: null };
    const transformedValue =
      typeof item === 'string'
        ? { invalid: false, payload: transform(item, key) as JsonValue }
        : transformJsonStrings(item, transform, key);
    if (transformedValue.invalid) return transformedValue;
    output[transformedKey] = transformedValue.payload;
  }
  return { invalid: false, payload: output };
}

function redactPii(
  payload: JsonValue,
  destination: SanitiseDestination,
  taint: SourceTaint,
  canaryTokens: SanitiseInput['canary_tokens'],
): { invalid: boolean; payload: JsonValue; redactions: Redaction[] } {
  const counts = new Map<RedactionKind, number>();
  const transformed = transformJsonStrings(payload, (text, key) => {
    // Provider tool turns encode their structured arguments/results as JSON strings.
    // Preserve the same field semantics there instead of treating the receipt as prose.
    if (MODEL_AND_OWNER_DESTINATIONS.has(destination) && (key === 'output' || key === 'arguments')) {
      let parsed: JsonValue | undefined;
      try { parsed = JSON.parse(text); } catch { /* Plain output keeps free-text redaction. */ }
      if (parsed !== null && typeof parsed === 'object') {
        const prepared = prepareInput({ payload: parsed, destination, source_taint: taint, canary_tokens: canaryTokens });
        if (prepared !== undefined && !('reason' in prepared)) {
          const structured = transformJsonStrings(parsed, (value, field) => redactPiiText(value, field, destination, taint, counts));
          if (!structured.invalid) {
            const rewritten = JSON.stringify(structured.payload);
            return rewritten === JSON.stringify(parsed) ? text : rewritten;
          }
        }
      }
    }
    return redactPiiText(text, key, destination, taint, counts);
  });
  return {
    ...transformed,
    redactions: REDACTION_ORDER.flatMap((kind) => {
      const count = counts.get(kind);
      return count === undefined ? [] : [{ kind, count }];
    }),
  };
}

// Only external-tainted text is inspected. Owner, Waldo and history text (null taint) is never
// scored or rewritten at any destination. External text is never denied for what it says; its
// role tags are escaped so it cannot open a system/user turn. Fence closers are handled by the
// composer's source admission.
const inspectsInstructions = (input: Readonly<{ source_taint: unknown }>): boolean =>
  input.source_taint === 'external';

function inspectInstructions(
  payload: JsonValue,
  redactions: Redaction[],
): SanitiseResult | { payload: JsonValue; redactions: Redaction[] } {
  let tagCount = 0;
  const escapeTags = (text: string): string =>
    text.replace(ROLE_TAG_PATTERN, (tag) => {
      tagCount += 1;
      return tag.replace('<', '&lt;').replace('>', '&gt;');
    });
  const transformed = transformJsonStrings(payload, escapeTags);
  if (transformed.invalid) return denyInvalid({ stage: 'policy' });
  if (tagCount === 0) return { payload, redactions };
  return {
    payload: transformed.payload,
    redactions: [...redactions, { kind: 'instruction_pattern', count: tagCount }],
  };
}

function truncateSandboxStructuredStdout(
  payload: JsonValue,
  maxChars: number,
): JsonValue | undefined {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return undefined;

  const root = payload as Record<string, JsonValue>;
  const nestedData = root.data;
  const data =
    typeof nestedData === 'object' && nestedData !== null && !Array.isArray(nestedData)
      ? (nestedData as Record<string, JsonValue>)
      : undefined;
  const stdout = typeof root.stdout === 'string' ? root.stdout : data?.stdout;
  if (typeof stdout !== 'string') return undefined;

  const replaceStdout = (value: string): JsonValue =>
    typeof root.stdout === 'string'
      ? { ...root, stdout: value }
      : { ...root, data: { ...data, stdout: value } };

  let low = 0;
  let high = stdout.length;
  let bounded: JsonValue | undefined;
  while (low <= high) {
    const midpoint = Math.floor((low + high) / 2);
    const candidate = replaceStdout(`${stdout.slice(0, midpoint)}${TRUNCATION_MARKER}`);
    if (JSON.stringify(candidate).length <= maxChars) {
      bounded = candidate;
      low = midpoint + 1;
    } else {
      high = midpoint - 1;
    }
  }
  return bounded;
}

function applyDestinationPolicy(
  input: PreparedInput,
  payload: JsonValue,
  redactions: Redaction[],
): SanitiseResult {
  const policy: SanitiseDestinationPolicy = SANITISE_DESTINATION_POLICIES[input.destination];
  // Dynamic per-model budget (owner-ratified 2026-09-26): an optional caller override shrinks the
  // char budget below the pinned wire ceiling - never above it (min() here IS the tighten-only
  // rule). Only max_chars is overridable; depth/field/item structure limits stay pinned.
  const maxChars = Math.min(policy.max_chars, input.max_chars_override ?? policy.max_chars);
  const isText = typeof payload === 'string';
  const isStructured = typeof payload === 'object' && payload !== null;
  if (
    input.destination === 'system_prompt' &&
    isStructured &&
    !isEligibleHealthView(payload, input.destination)
  ) {
    return denyInvalid({ stage: 'policy' });
  }
  if (
    (policy.payload_kind === 'text' && !isText) ||
    (policy.payload_kind === 'structured' && !isStructured) ||
    (policy.payload_kind === 'text_or_structured' && !isText && !isStructured)
  ) {
    return denyInvalid({ stage: 'policy' });
  }

  const serialized = isText ? payload : JSON.stringify(payload);
  let boundedPayload = payload;
  if (serialized.length > maxChars) {
    if (input.destination !== 'sandbox_stdout') {
      return deny('size_cap', 'oversize');
    }
    if (isText) {
      boundedPayload = `${payload.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
    } else {
      const truncated = truncateSandboxStructuredStdout(payload, maxChars);
      if (truncated === undefined) return deny('size_cap', 'oversize');
      boundedPayload = truncated;
    }
  }
  if (isStructured) {
    const pending: Array<{ value: JsonValue; depth: number }> = [
      { value: boundedPayload, depth: 1 },
    ];
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) continue;
      if (current.depth > policy.max_depth) return deny('size_cap', 'oversize');
      if (Array.isArray(current.value)) {
        if (current.value.length > policy.max_array_items) return deny('size_cap', 'oversize');
        for (let index = current.value.length - 1; index >= 0; index -= 1) {
          const item = current.value[index];
          if (typeof item === 'object' && item !== null) {
            pending.push({ value: item, depth: current.depth + 1 });
          }
        }
      } else if (typeof current.value === 'object' && current.value !== null) {
        const entries = Object.entries(current.value);
        if (entries.length > policy.max_object_fields) return deny('size_cap', 'oversize');
        for (const [key, item] of entries) {
          if (key.length > policy.max_key_chars) return deny('size_cap', 'oversize');
          if (typeof item === 'object' && item !== null) {
            pending.push({ value: item, depth: current.depth + 1 });
          }
        }
      }
    }
  }

  return {
    ok: true,
    payload: boundedPayload,
    source_taint: input.source_taint,
    redactions,
  };
}

// Offload store guard (release blocker, populated-reads slice): raw external tool output is
// never stored. Storage is not a sanitise destination, so the destination size/structure caps
// do not apply - but every content check does. Only guarded (redacted) text reaches the store,
// so a read-back slice can never expose unguarded content, including a secret that would span
// read chunks.
export function guardForOffload(raw: SanitiseInput): SanitiseResult {
  const input = prepareInput(raw);
  if (!input) return denyInvalid({ stage: 'prepare' });
  if ('reason' in input) return deny('size_cap', input.reason);

  const secret = containsCanaryOrSecret(input.payload, input);
  if (secret !== undefined) return secret;

  const health = containsForbiddenHealth(input);
  if (health.invalid !== undefined) return denyInvalid(health.invalid);
  if (health.matched) return deny('health_value', 'health_value_leak');

  // The offload store persists, so it never gets the model/owner readable seam: redact as memory_block.
  const pii = redactPii(input.payload, 'memory_block', input.source_taint, input.canary_tokens);
  if (pii.invalid) return denyInvalid({ stage: 'pii' });

  const instructions = inspectsInstructions(input) ? inspectInstructions(pii.payload, pii.redactions) : { payload: pii.payload, redactions: pii.redactions };
  if ('ok' in instructions) return instructions;
  return {
    ok: true,
    payload: instructions.payload,
    source_taint: input.source_taint,
    redactions: instructions.redactions,
  };
}

// Verify-only pass for the final assembled provider prompt (renderProviderPrompt). Every fragment
// was already sanitised at its own source taint during composition, so the final pass must not
// rewrite: a rewrite here fails the byte-identical check and fails the turn closed. Live incident
// 2026-09-27: the owner-readable seam passed an owner email at null taint (per owner direction),
// the final pass re-redacted it at 'external', the assembled prompt no longer matched, and every
// turn failed with sanitisation_failed until the fragment left the window. Deny-level guards stay:
// canary/secret, health leak and destination policy all still fail closed.
// Owner-ruled scope: the owner's own wearable readings and health context may reach the model and
// owner-channel replies. Third-party sends, drafts, memory, audit, R2 and the outbox keep the
// health denial, and so does anything of external provenance.
function ownerHealthAllowed(input: { destination: SanitiseDestination; source_taint: 'external' | null }): boolean {
  return (
    input.source_taint === null &&
    (input.destination === 'system_prompt' ||
      input.destination === 'internal_context' ||
      input.destination === 'owner_reply')
  );
}

export function sanitiseVerifyOnly(raw: SanitiseInput): SanitiseResult {
  const input = prepareInput(raw);
  if (!input) return denyInvalid({ stage: 'prepare' });
  if ('reason' in input) return deny('size_cap', input.reason);

  const secret = containsCanaryOrSecret(input.payload, input);
  if (secret !== undefined) return secret;

  const health = containsForbiddenHealth(input);
  if (health.invalid !== undefined) return denyInvalid(health.invalid);
  if (health.matched && !ownerHealthAllowed(input)) return deny('health_value', 'health_value_leak');

  return applyDestinationPolicy(input, input.payload, []);
}

export function sanitise(raw: SanitiseInput): SanitiseResult {
  const input = prepareInput(raw);
  if (!input) return denyInvalid({ stage: 'prepare' });
  if ('reason' in input) return deny('size_cap', input.reason);

  const secret = containsCanaryOrSecret(input.payload, input);
  if (secret !== undefined) return secret;

  // External content to the model: withhold matched health spans, then the unchanged scan below
  // still denies structured health correlation.
  const withheld =
    input.source_taint === 'external' && input.destination === 'internal_context'
      ? redactExternalHealthSpans(input.payload, [], sparesPlainWords(input))
      : { invalid: false, payload: input.payload, redactions: [] as Redaction[] };
  if (withheld.invalid) return denyInvalid({ stage: 'external_health' });
  const scanned = { ...input, payload: withheld.payload };

  const health = containsForbiddenHealth(scanned);
  if (health.invalid !== undefined) return denyInvalid(health.invalid);
  if (health.matched && !ownerHealthAllowed(input)) return deny('health_value', 'health_value_leak');

  const pii = redactPii(scanned.payload, input.destination, input.source_taint, input.canary_tokens);
  if (pii.invalid) return denyInvalid({ stage: 'pii' });
  pii.redactions.unshift(...withheld.redactions);

  const instructions = inspectsInstructions(input) ? inspectInstructions(pii.payload, pii.redactions) : { payload: pii.payload, redactions: pii.redactions };
  if ('ok' in instructions) return instructions;
  return applyDestinationPolicy(input, instructions.payload, instructions.redactions);
}

const HEALTH_MEASUREMENT_SUFFIX = /(?:datum|measurement|value|reading|amount|score|sample|quantity|duration|minutes?|mins?)$/i;

function numericFromBase64(token: string): string | undefined {
  const trimmed = token.trim();
  if (!/^[A-Za-z0-9+\/_-]{2,}={0,2}$/.test(trimmed)) return undefined;
  const normalized = trimmed.replaceAll('-', '+').replaceAll('_', '/');
  if (normalized.length % 4 === 1) return undefined;
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  try {
    const binary = atob(padded);
    const canonical = btoa(binary).replace(/=+$/, '');
    if (canonical !== normalized.replace(/=+$/, '')) return undefined;
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
      Uint8Array.from(binary, (character) => character.charCodeAt(0)),
    );
    return isNumeric(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

function isStrongHealthKey(key: string, plainWords = false): boolean {
  if (plainWords && PLAIN_WORD_COMPACT.test(compactKey(key))) return false;
  const base = compactKey(key).replace(HEALTH_MEASUREMENT_SUFFIX, '');
  return HEALTH_KEY_COMPACT.test(base);
}
