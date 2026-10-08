import { validId } from '@waldo/workspace';
import {
  DERIVED_SCORE_PATTERNS,
  MODEL_CONTEXT_MAX_CHARS,
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

interface DecodeBundle {
  invalid: boolean;
  views: string[];
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
const HEALTH_FREE_TEXT: readonly RegExp[] = [
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|blood[\s_-]*pressure|bp|body[\s_-]*(?:weight|mass)|weight|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy|sleep(?:[\s_-]*(?:hours?|duration|minutes?|mins?))?|rem[\s_-]*sleep|deep[\s_-]*sleep|crs|form(?:[\s_-]*score)?|recovery(?:[\s_-]*score)?|load(?:[\s_-]*score)?)\b\s*,\s*["']?-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?["']?\s*,\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|hours?|hrs?|minutes?|mins?)(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|body[\s_-]*(?:weight|mass)|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories)?(?=$|[^a-z0-9])/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*mmhg\b/i,
  /\b(?:sleep|slept|rem[\s_-]*sleep|deep[\s_-]*sleep|time[\s_-]*asleep)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/i,
  /\b(?:crs|form|recovery|load)(?:[\s_-]*score)?\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d{1,3}\b/i,
  /\b(?:steps|step[\s_-]*count|motion|circadian|sleep[\s_-]*efficiency|sleep[\s_-]*stages?|body[\s_-]*temperature|respiratory[\s_-]*rate|breathing[\s_-]*rate|blood[\s_-]*glucose|glucose|provider[\s_-]*payload|health[\s_-]*payload|raw[\s_-]*payload)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:steps|percent|pct|%|minutes?|mins?|celsius|fahrenheit|breaths?(?:\s+per\s+minute)?|mg\/dl|mmol\/l)?(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate|spo2|blood[\s_-]*pressure|body[\s_-]*weight|steps|sleep[\s_-]*duration|body[\s_-]*temperature|respiratory[\s_-]*rate|glucose|crs|form|recovery|load)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?[+-]?(?:\d+(?:\.\d*)?|\.\d+)[eE][+-]?\d+["']?(?=$|[^a-z0-9])/i,
  /\b(?:motion|circadian(?:\s+rhythm)?|sleep[\s_-]*stage)\b\s*(?::|=|,|\bis\b|\bwas\b)\s*["']?[a-z][a-z\s_-]{0,32}["']?(?=$|[;,.])/i,
  /\b(?:hrv|heart[\s_-]*rate|spo2|blood[\s_-]*pressure|body[\s_-]*(?:weight|temperature)|steps|sleep[\s_-]*(?:duration|efficiency)|respiratory[\s_-]*rate|glucose|crs|form|recovery|load)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?-?\d+(?:\.\d+)?["']?(?:\s*,?\s*)(?:°[cf]|degrees?\s*[cf])(?=$|[^a-z0-9])/i,
];

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
const PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;

function deny(check: SanitiseCheck, reason: SanitiseFailureReason): SanitiseResult {
  return { ok: false, check, reason };
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

function decodedViews(text: string): DecodeBundle {
  const views = [text];
  const known = new Set(views);
  // Uniform 4x decode budget (live RCA 2026-09-28: brief card failed internal_context
  // invalid_payload at 08:46 and 14:01). The old min(destination.max_chars, 4x) formula let
  // the budget SHRINK below 4x for strings over max_chars/4, so a legal 17k+ card prompt
  // carrying ordinary nested encodings (a redirect-wrapped URL, an encoded token) generated
  // two full-length decode views and died on a shape false positive - while the identical
  // content in a shorter string passed. The payload itself is already capped at
  // destination.max_chars by applyDestinationPolicy, so total decode work stays bounded at
  // 4x that cap either way; the recursion defense (MAX_DECODE_PASSES + canDecodeAgain) is
  // unchanged and still denies genuinely deeper nesting. The context-composer fence scan
  // (source-sanitisation.ts) has always used this uniform 4x form.
  const maxDecodedChars = Math.max(text.length, 1) * 4;
  let frontier = [text];
  let decodedChars = 0;

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      // A percent sequence the strict decoder rejects is not an encoding - the model cannot
      // decode it either, so no obfuscation channel exists. The raw string stays in views[0]
      // and is scanned as-is; ordinary text like "20%DEALS" must not deny the payload (#152).
      const percent = decodePercent(candidate) ?? undefined;
      const generated = [decodeJsonEscapes(candidate), percent, decodeBase64Tokens(candidate)];
      for (const value of generated) {
        if (typeof value !== 'string' || value === candidate || known.has(value)) continue;
        decodedChars += value.length;
        if (value.length > maxDecodedChars || decodedChars > maxDecodedChars) {
          return { invalid: true, views };
        }
        known.add(value);
        views.push(value);
        next.push(value);
      }
    }
    frontier = next;
    if (frontier.length === 0) break;
  }

  if (frontier.some(canDecodeAgain)) return { invalid: true, views };
  return { invalid: false, views };
}

function hasDecodedHealthIndicator(
  text: string,
  destination: SanitiseDestination,
): boolean {
  const decoded = decodedViews(text);
  return decoded.views.some(isHealthIndicatorText);
}

function visitStrings(
  payload: JsonValue,
  destination: SanitiseDestination,
  visitor: (text: string, key: boolean) => boolean,
  skipEligibleHealthViews = false,
): { invalid: boolean; matched: boolean } {
  const pending: Array<{ value: JsonValue; key: boolean }> = [{ value: payload, key: false }];
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current) continue;
    const { value } = current;
    if (typeof value === 'string') {
      const decoded = decodedViews(value);
      if (decoded.invalid) return { invalid: true, matched: false };
      if (decoded.views.some((view) => visitor(view, current.key))) {
        return { invalid: false, matched: true };
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
  return { invalid: false, matched: false };
}

function containsCanaryOrSecret(
  payload: JsonValue,
  input: PreparedInput,
): SanitiseFailureReason | undefined {
  // Only this session's three canaries are tripwires. A regex for any 16-hex run
  // rejected ordinary provider IDs and tracking codes in mail/card context.
  // visitStrings also checks decoded views and object keys at every taint and destination.
  const canaries = input.canary_tokens.map((token) => token.toLowerCase());
  let canaryFound = false;
  let secretFound = containsStructuredSecret(payload, input.destination);
  const result = visitStrings(payload, input.destination, (text) => {
    if (canaries.some((token) => text.toLowerCase().includes(token))) {
      canaryFound = true;
    }
    if (SECRET_PATTERNS.some((pattern) => matches(pattern, text))) secretFound = true;
    return false;
  });
  if (result.invalid) return 'invalid_payload';
  if (canaryFound) return 'canary_leak';
  return secretFound ? 'secret_leak' : undefined;
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
    Object.hasOwn(value, 'missing_components') ||
    Object.hasOwn(value, 'confidence_band') ||
    Object.hasOwn(value, 'provenance_refs')
  ) {
    return true;
  }
  if (
    typeof value.algorithm_version === 'string' &&
    value.algorithm_version.startsWith('form.')
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

function isHealthIndicatorText(value: string): boolean {
  return (
    HEALTH_INDICATOR_VALUE.test(value.trim()) ||
    HEALTH_KEY_COMPACT.test(compactKey(value))
  );
}

function subtreeHealthFlags(
  value: JsonValue,
  destination: SanitiseDestination,
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
    const indicator = isHealthIndicatorText(value);
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
      const child = subtreeHealthFlags(item, destination);
      indicator ||= child.indicator;
      strongIndicator ||= child.strongIndicator;
      measurement ||= child.measurement;
      numeric ||= child.numeric;
      unit ||= child.unit;
    }
    measurement ||= numeric;
  } else {
    for (const [key, item] of Object.entries(value)) {
      const healthKey = HEALTH_KEY.test(key) || hasDecodedHealthIndicator(key, destination);
      const strongHealthKey = isStrongHealthKey(key) || hasDecodedHealthIndicator(key, destination);
      const encodedHealthIndicator =
        typeof item === 'string' &&
        HEALTH_DISCRIMINATOR_KEY.test(key) &&
        hasDecodedHealthIndicator(item, destination);
      const child = subtreeHealthFlags(item, destination);
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

function objectHasHealthCorrelation(value: JsonValue, destination: SanitiseDestination): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const flags = subtreeHealthFlags(value, destination);
  return flags.indicator && flags.measurement;
}

function containsForbiddenHealth(
  input: PreparedInput,
  jsonPass = 0,
): { invalid: boolean; matched: boolean } {
  if (objectHasHealthCorrelation(input.payload, input.destination)) {
    return { invalid: false, matched: true };
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
  let nestedInvalid = false;
  const visited = visitStrings(
    input.payload,
    input.destination,
    (text) => {
      if (
        freeTextScan &&
        (RAW_SENSOR_PATTERNS.some((pattern) => matches(pattern, text)) ||
          DERIVED_SCORE_PATTERNS.some((pattern) => matches(pattern, text)) ||
          HEALTH_FREE_TEXT.some((pattern) => pattern.test(text)))
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
        nestedInvalid = true;
        return false;
      }
      try {
        const payload = JSON.parse(trimmed) as unknown;
        if (typeof payload !== 'string' && (typeof payload !== 'object' || payload === null)) {
          return false;
        }
        const prepared = prepareInput({ ...input, payload } as SanitiseInput);
        if (prepared === undefined || 'reason' in prepared) {
          nestedInvalid = true;
          return false;
        }
        const nested = containsForbiddenHealth(prepared, jsonPass + 1);
        nestedInvalid ||= nested.invalid;
        return nested.matched;
      } catch {
        return false;
      }
    },
    true,
  );
  return { invalid: visited.invalid || nestedInvalid, matched: visited.matched };
}

const HEALTH_SPAN_MARKER = '[health value withheld]';

// ADR-0081 free-text scan on external content headed to the model (internal_context): the span
// is withheld and the read continues. Every other destination still denies in containsForbiddenHealth.
function redactExternalHealthSpans(
  payload: JsonValue,
  redactions: Redaction[],
): { invalid: boolean; payload: JsonValue; redactions: Redaction[] } {
  const counts = new Map<RedactionKind, number>();
  const patterns = [...RAW_SENSOR_PATTERNS, ...DERIVED_SCORE_PATTERNS, ...HEALTH_FREE_TEXT];
  const transformed = transformJsonStrings(payload, (text) => {
    // JSON-encoded structured health still belongs to the correlation check below.
    // Rewriting its tokens first could destroy the structure and hide the measurement.
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed === 'object' && parsed !== null) return text;
    } catch { /* Ordinary free text is scanned for spans. */ }
    return patterns.reduce((output, pattern) => replaceAndCount(output, pattern, HEALTH_SPAN_MARKER, 'health_value', counts), text);
  });
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
): string {
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
  if (transformed.invalid) return deny('size_cap', 'invalid_payload');
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
    return deny('size_cap', 'invalid_payload');
  }
  if (
    (policy.payload_kind === 'text' && !isText) ||
    (policy.payload_kind === 'structured' && !isStructured) ||
    (policy.payload_kind === 'text_or_structured' && !isText && !isStructured)
  ) {
    return deny('size_cap', 'invalid_payload');
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
  if (!input) return deny('size_cap', 'invalid_payload');
  if ('reason' in input) return deny('size_cap', input.reason);

  const secret = containsCanaryOrSecret(input.payload, input);
  if (secret === 'invalid_payload') return deny('size_cap', secret);
  if (secret !== undefined) return deny('canary_token', secret);

  const health = containsForbiddenHealth(input);
  if (health.invalid) return deny('size_cap', 'invalid_payload');
  if (health.matched) return deny('health_value', 'health_value_leak');

  // The offload store persists, so it never gets the model/owner readable seam: redact as memory_block.
  const pii = redactPii(input.payload, 'memory_block', input.source_taint, input.canary_tokens);
  if (pii.invalid) return deny('size_cap', 'invalid_payload');

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
export function sanitiseVerifyOnly(raw: SanitiseInput): SanitiseResult {
  const input = prepareInput(raw);
  if (!input) return deny('size_cap', 'invalid_payload');
  if ('reason' in input) return deny('size_cap', input.reason);

  const secret = containsCanaryOrSecret(input.payload, input);
  if (secret === 'invalid_payload') return deny('size_cap', secret);
  if (secret !== undefined) return deny('canary_token', secret);

  const health = containsForbiddenHealth(input);
  if (health.invalid) return deny('size_cap', 'invalid_payload');
  if (health.matched) return deny('health_value', 'health_value_leak');

  return applyDestinationPolicy(input, input.payload, []);
}

export function sanitise(raw: SanitiseInput): SanitiseResult {
  const input = prepareInput(raw);
  if (!input) return deny('size_cap', 'invalid_payload');
  if ('reason' in input) return deny('size_cap', input.reason);

  const secret = containsCanaryOrSecret(input.payload, input);
  if (secret === 'invalid_payload') return deny('size_cap', secret);
  if (secret !== undefined) return deny('canary_token', secret);

  // External content to the model: withhold matched health spans, then the unchanged scan below
  // still denies structured health correlation.
  const withheld =
    input.source_taint === 'external' && input.destination === 'internal_context'
      ? redactExternalHealthSpans(input.payload, [])
      : { invalid: false, payload: input.payload, redactions: [] as Redaction[] };
  if (withheld.invalid) return deny('size_cap', 'invalid_payload');
  const scanned = { ...input, payload: withheld.payload };

  const health = containsForbiddenHealth(scanned);
  if (health.invalid) return deny('size_cap', 'invalid_payload');
  if (health.matched) return deny('health_value', 'health_value_leak');

  const pii = redactPii(scanned.payload, input.destination, input.source_taint, input.canary_tokens);
  if (pii.invalid) return deny('size_cap', 'invalid_payload');
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

function isStrongHealthKey(key: string): boolean {
  const base = compactKey(key).replace(HEALTH_MEASUREMENT_SUFFIX, '');
  return HEALTH_KEY_COMPACT.test(base);
}
