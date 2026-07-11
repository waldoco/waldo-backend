import {
  CANARY_REGEX,
  DERIVED_SCORE_PATTERNS,
  derivedHealthDestinationViewSchema,
  INSTRUCTION_PATTERNS,
  INSTRUCTION_REJECT_THRESHOLD,
  PII_PATTERNS,
  RAW_SENSOR_PATTERNS,
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
const MAX_PREFLIGHT_STRING_CHARS = 262_144;
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
const NUMERIC_VALUE = /^\s*["']?-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:\s*\/\s*\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)?["']?\s*$/;
const HEALTH_MEASUREMENT_KEY = /^(?:measurement|value|reading|amount|score|sample|quantity|duration|minutes?|mins?)$/i;
const FORBIDDEN_HEALTH_PAYLOAD_KEY = /^(?:motion|circadian|provider[\s_-]*payload|health[\s_-]*payload|raw[\s_-]*payload|sleep[\s_-]*stages?)$/i;
const RAW_HEALTH_SERIES_KEY = /^(?:samples?|series)$/i;
const DERIVED_HEALTH_ELIGIBILITIES = new Set([
  'trigger_prompt',
  'volatile_run',
  'runtime_trace',
  'r2_today_summary',
  'r2_baselines_summary',
]);
const HEALTH_UNIT_VALUE = /^(?:ms|bpm|beats|breaths?(?: per minute)?|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|hours?|hrs?|minutes?|mins?|celsius|fahrenheit|mg\/dl|mmol\/l)$/i;
const HEALTH_FREE_TEXT: readonly RegExp[] = [
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|blood[\s_-]*pressure|bp|body[\s_-]*(?:weight|mass)|weight|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy|sleep(?:[\s_-]*(?:hours?|duration|minutes?|mins?))?|rem[\s_-]*sleep|deep[\s_-]*sleep|crs|form(?:[\s_-]*score)?|recovery(?:[\s_-]*score)?|load(?:[\s_-]*score)?)\b\s*,\s*["']?-?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?["']?\s*,\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories|hours?|hrs?|minutes?|mins?)(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate(?:[\s_-]*variability)?|resting[\s_-]*heart[\s_-]*rate|pulse|spo2|oxygen[\s_-]*saturation|blood[\s_-]*oxygen|systolic|diastolic|body[\s_-]*(?:weight|mass)|calorie[\s_-]*burn|calories[\s_-]*burned|active[\s_-]*energy)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:ms|bpm|beats|percent|pct|%|mmhg|kg|kgs|lb|lbs|pounds?|kcal|cal|calories)?(?=$|[^a-z0-9])/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*\/\s*\d+(?:\.\d+)?/i,
  /\b(?:blood[\s_-]*pressure|bp)\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*mmhg\b/i,
  /\b(?:sleep|slept|rem[\s_-]*sleep|deep[\s_-]*sleep|time[\s_-]*asleep)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b/i,
  /\b(?:crs|form|recovery|load)(?:[\s_-]*score)?\b(?:\s+\w+){0,2}?\s*[:=,]?\s*["']?\d{1,3}\b/i,
  /\b(?:steps|step[\s_-]*count|motion|circadian|sleep[\s_-]*efficiency|sleep[\s_-]*stages?|body[\s_-]*temperature|respiratory[\s_-]*rate|breathing[\s_-]*rate|blood[\s_-]*glucose|glucose|provider[\s_-]*payload|health[\s_-]*payload|raw[\s_-]*payload)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*(?:steps|percent|pct|%|minutes?|mins?|celsius|fahrenheit|breaths?(?:\s+per\s+minute)?|mg\/dl|mmol\/l)?(?=$|[^a-z0-9])/i,
  /\b(?:hrv|heart[\s_-]*rate|spo2|blood[\s_-]*pressure|body[\s_-]*weight|steps|sleep[\s_-]*duration|body[\s_-]*temperature|respiratory[\s_-]*rate|glucose|crs|form|recovery|load)\b(?:\s+\w+){0,3}?\s*[:=,]?\s*["']?-?\d+(?:\.\d+)?[eE][+-]?\d+["']?(?=$|[^a-z0-9])/i,
  /\b(?:motion\s*[:=,]\s*(?:active|inactive|still|moving)|circadian\s*[:=,]\s*(?:aligned|misaligned|early|late)|sleep[\s_-]*stage\s*[:=,]\s*(?:awake|asleep|light|deep|rem|core))\b/i,
];

const SECRET_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}\b/i,
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}\b/,
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\b(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|secret|password)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{12,}["']?/i,
];

const ADDRESS_PATTERN = /\b\d{1,6}\s+[A-Za-z0-9.'-]+(?:\s+[A-Za-z0-9.'-]+){0,5}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|lane|ln|drive|dr|court|ct|way)\b/gi;
const ATTENDEE_KEY = /^(?:attendee|attendees|attendee_name|participant|participants|participant_name|contact_name)$/i;
const ADDRESS_KEY = /^(?:address|street_address|mailing_address|home_address|ip|ip_address)$/i;
const PERSON_NAME = /^[\p{L}][\p{L}'-]+(?:\s+[\p{L}][\p{L}'-]+){1,3}$/u;
const BASE64_TOKEN = /(?<![A-Za-z0-9+\/_-])[A-Za-z0-9+\/_-]{4,}={0,2}(?![A-Za-z0-9+\/_=-])/g;
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

function prepareInput(raw: SanitiseInput): PreparedInput | undefined {
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
      if (value.length > MAX_PREFLIGHT_STRING_CHARS) return undefined;
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
      if (key.length > MAX_PREFLIGHT_STRING_CHARS) return undefined;
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
    (!/[A-Z]/.test(token) || !/[a-z]/.test(token) || !/\d/.test(token))
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
    if (decoded.length === 0 || /[^\x09\x0A\x0D\x20-\x7E]/.test(decoded)) return undefined;
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
  if (JSON_ESCAPE.test(text) || PERCENT_ESCAPE.test(text)) return true;
  BASE64_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(BASE64_TOKEN)) {
    if (printableUtf8FromBase64(match[0]) !== undefined) return true;
  }
  return false;
}

function decodedViews(text: string, destination: SanitiseDestination): DecodeBundle {
  const views = [text];
  const known = new Set(views);
  const maxDecodedChars = Math.min(
    SANITISE_DESTINATION_POLICIES[destination].max_chars,
    Math.max(text.length, 1) * 4,
  );
  let frontier = [text];
  let decodedChars = 0;

  for (let pass = 0; pass < MAX_DECODE_PASSES; pass += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      const percent = decodePercent(candidate);
      if (PERCENT_ESCAPE.test(candidate) && typeof percent !== 'string') {
        return { invalid: true, views };
      }
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
      const decoded = decodedViews(value, destination);
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
  let canaryFound = false;
  let secretFound = false;
  const result = visitStrings(payload, input.destination, (text) => {
    if (input.canary_tokens.some((token) => text.includes(token)) || matches(CANARY_REGEX, text)) {
      canaryFound = true;
    }
    if (SECRET_PATTERNS.some((pattern) => matches(pattern, text))) secretFound = true;
    return false;
  });
  if (result.invalid) return 'invalid_payload';
  if (canaryFound) return 'canary_leak';
  return secretFound ? 'secret_leak' : undefined;
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
): { indicator: boolean; measurement: boolean; numeric: boolean; unit: boolean } {
  if (typeof value === 'number') {
    return {
      indicator: false,
      measurement: false,
      numeric: Number.isFinite(value),
      unit: false,
    };
  }
  if (typeof value === 'string') {
    return {
      indicator: isHealthIndicatorText(value),
      measurement: false,
      numeric: isNumeric(value),
      unit: HEALTH_UNIT_VALUE.test(value.trim()),
    };
  }
  if (typeof value !== 'object' || value === null) {
    return { indicator: false, measurement: false, numeric: false, unit: false };
  }
  if (!Array.isArray(value)) {
    const parsedView = derivedHealthDestinationViewSchema.safeParse(value);
    if (parsedView.success) {
      return isEligibleHealthView(value, destination)
        ? { indicator: false, measurement: false, numeric: false, unit: false }
        : { indicator: true, measurement: true, numeric: true, unit: false };
    }
    if (looksLikeDerivedHealthView(value)) {
      return { indicator: true, measurement: true, numeric: false, unit: false };
    }
  }

  let indicator = false;
  let measurement = false;
  let numeric = false;
  let unit = false;
  if (Array.isArray(value)) {
    for (const item of value) {
      const child = subtreeHealthFlags(item, destination);
      indicator ||= child.indicator;
      measurement ||= child.measurement;
      numeric ||= child.numeric;
      unit ||= child.unit;
    }
    measurement ||= numeric;
  } else {
    for (const [key, item] of Object.entries(value)) {
      const healthKey = HEALTH_KEY.test(key) || HEALTH_KEY_COMPACT.test(compactKey(key));
      const child = subtreeHealthFlags(item, destination);
      const rawHealthSeries = RAW_HEALTH_SERIES_KEY.test(key) && child.measurement && child.unit;
      indicator ||= healthKey || rawHealthSeries;
      indicator ||= child.indicator;
      measurement ||=
        FORBIDDEN_HEALTH_PAYLOAD_KEY.test(key) ||
        rawHealthSeries ||
        child.measurement ||
        ((healthKey || HEALTH_MEASUREMENT_KEY.test(key)) && child.numeric);
      numeric ||= child.numeric;
      unit ||= child.unit;
    }
    measurement ||= unit && numeric;
  }
  return { indicator, measurement, numeric, unit };
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
  let nestedInvalid = false;
  const visited = visitStrings(
    input.payload,
    input.destination,
    (text) => {
      if (
        RAW_SENSOR_PATTERNS.some((pattern) => matches(pattern, text)) ||
        DERIVED_SCORE_PATTERNS.some((pattern) => matches(pattern, text)) ||
        HEALTH_FREE_TEXT.some((pattern) => pattern.test(text))
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
        if (prepared === undefined) {
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

function encodedPiiKind(text: string, destination: SanitiseDestination): RedactionKind | undefined {
  const decoded = decodedViews(text, destination);
  if (decoded.invalid) return undefined;
  for (const view of decoded.views.slice(1)) {
    if (matches(PII_PATTERNS.email, view)) return 'email';
    if (matches(PII_PATTERNS.cc, view)) return 'credit_card';
    if (matches(PII_PATTERNS.phone, view)) return 'phone';
    if (matches(PII_PATTERNS.ipv4, view)) return 'address';
    if (matches(PII_PATTERNS.ipv6, view)) return 'address';
  }
  return undefined;
}

function redactEncodedPii(
  text: string,
  destination: SanitiseDestination,
  counts: Map<RedactionKind, number>,
): string {
  let output = text.replace(BASE64_TOKEN, (token) => {
    const kind = encodedPiiKind(token, destination);
    if (kind === undefined) return token;
    increment(counts, kind);
    return `[REDACTED_${kind === 'credit_card' ? 'CREDIT_CARD' : kind.toUpperCase()}]`;
  });
  const candidates = /(?:[A-Za-z0-9._+\/%-]|\\u[0-9a-fA-F]{4}){4,}/g;
  output = output.replace(candidates, (token) => {
    const kind = encodedPiiKind(token, destination);
    if (kind === undefined) return token;
    increment(counts, kind);
    return `[REDACTED_${kind === 'credit_card' ? 'CREDIT_CARD' : kind.toUpperCase()}]`;
  });
  return output;
}

function redactPiiText(
  text: string,
  key: string | undefined,
  destination: SanitiseDestination,
  counts: Map<RedactionKind, number>,
): string {
  let output = redactEncodedPii(text, destination, counts);
  output = replaceAndCount(
    output,
    PII_PATTERNS.cc,
    '[REDACTED_CREDIT_CARD]',
    'credit_card',
    counts,
  );
  output = replaceAndCount(output, PII_PATTERNS.email, '[REDACTED_EMAIL]', 'email', counts);
  output = replaceAndCount(output, PHONE_PATTERN, '[REDACTED_PHONE]', 'phone', counts);
  output = replaceAndCount(output, PII_PATTERNS.ipv4, '[REDACTED_ADDRESS]', 'address', counts);
  output = replaceAndCount(output, PII_PATTERNS.ipv6, '[REDACTED_ADDRESS]', 'address', counts);
  output = replaceAndCount(output, ADDRESS_PATTERN, '[REDACTED_ADDRESS]', 'address', counts);

  if (key !== undefined && ATTENDEE_KEY.test(key) && PERSON_NAME.test(output)) {
    increment(counts, 'attendee_name');
    return '[REDACTED_ATTENDEE_NAME]';
  }
  if (key !== undefined && ADDRESS_KEY.test(key) && output === text && output.trim().length > 0) {
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
): { invalid: boolean; payload: JsonValue; redactions: Redaction[] } {
  const counts = new Map<RedactionKind, number>();
  const transformed = transformJsonStrings(payload, (text, key) =>
    redactPiiText(text, key, destination, counts),
  );
  return {
    ...transformed,
    redactions: REDACTION_ORDER.flatMap((kind) => {
      const count = counts.get(kind);
      return count === undefined ? [] : [{ kind, count }];
    }),
  };
}

function inspectInstructions(
  payload: JsonValue,
  destination: SanitiseDestination,
  redactions: Redaction[],
): SanitiseResult | { payload: JsonValue; redactions: Redaction[] } {
  const matched = new Set<number>();
  const scanned = visitStrings(payload, destination, (text) => {
    INSTRUCTION_PATTERNS.forEach((pattern, index) => {
      if (matches(pattern, text)) matched.add(index);
    });
    return false;
  });
  if (scanned.invalid) return deny('size_cap', 'invalid_payload');
  if (matched.size >= INSTRUCTION_REJECT_THRESHOLD) {
    return deny('instruction_pattern', 'untrusted_instruction');
  }
  if (matched.size === 0) return { payload, redactions };

  const patternIndex = [...matched][0];
  if (patternIndex === undefined) return { payload, redactions };
  const pattern = INSTRUCTION_PATTERNS[patternIndex];
  if (pattern === undefined) return deny('instruction_pattern', 'untrusted_instruction');
  let instructionCount = 0;
  const transformed = transformJsonStrings(payload, (text) => {
    let output = text;
    if (matches(pattern, text)) {
      const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
      const global = new RegExp(pattern.source, flags);
      instructionCount += Array.from(text.matchAll(global)).length;
      output = text.replace(new RegExp(pattern.source, flags), '[REDACTED_INSTRUCTION]');
    }
    const decoded = decodedViews(output, destination);
    if (decoded.views.slice(1).some((view) => matches(pattern, view))) {
      instructionCount += 1;
      return '[REDACTED_INSTRUCTION]';
    }
    return output;
  });
  if (transformed.invalid) return deny('size_cap', 'invalid_payload');
  return {
    payload: transformed.payload,
    redactions: [
      ...redactions,
      { kind: 'instruction_pattern', count: Math.max(instructionCount, 1) },
    ],
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
  if (serialized.length > policy.max_chars) {
    if (input.destination !== 'sandbox_stdout') {
      return deny('size_cap', 'oversize');
    }
    if (isText) {
      boundedPayload = `${payload.slice(0, policy.max_chars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
    } else {
      const truncated = truncateSandboxStructuredStdout(payload, policy.max_chars);
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

export function sanitise(raw: SanitiseInput): SanitiseResult {
  const input = prepareInput(raw);
  if (!input) return deny('size_cap', 'invalid_payload');

  const secret = containsCanaryOrSecret(input.payload, input);
  if (secret === 'invalid_payload') return deny('size_cap', secret);
  if (secret !== undefined) return deny('canary_token', secret);

  const health = containsForbiddenHealth(input);
  if (health.invalid) return deny('size_cap', 'invalid_payload');
  if (health.matched) return deny('health_value', 'health_value_leak');

  const pii = redactPii(input.payload, input.destination);
  if (pii.invalid) return deny('size_cap', 'invalid_payload');

  const instructions = inspectInstructions(pii.payload, input.destination, pii.redactions);
  if ('ok' in instructions) return instructions;
  return applyDestinationPolicy(input, instructions.payload, instructions.redactions);
}
