import {
  skillRowSchema,
  skillSchema,
  type CanaryTokens,
  type Skill,
  type SourceTaint,
} from '@waldo/contracts';
import { prepareWithScribe } from '../scribe/prepare';
import { FailClosed } from './faults';

const SOURCE_FENCE_CLOSER = /<\s*\/\s*(?:available-skills|skill|invocation-inputs|memory-context|recall|workspace-context)\s*>/i;
const SOURCE_JSON_ESCAPE = /\\(?:u[0-9a-fA-F]{4}|\/)/;
const SOURCE_PERCENT_ESCAPE = /%[0-9a-fA-F]{2}/;
const SOURCE_BASE64_TOKEN = /(?<![A-Za-z0-9+\/_-])(?:(?:[A-Za-z0-9+\/_-]{4})*(?:[A-Za-z0-9+\/_-]{2}==|[A-Za-z0-9+\/_-]{3}=)|(?:[A-Za-z0-9+\/_-]{4})+(?:[A-Za-z0-9+\/_-]{2,3})?)(?![A-Za-z0-9+\/_=-])/g;
const MAX_SOURCE_FENCE_DECODE_PASSES = 2;

// All untrusted or externally tainted bytes take this one private admission path before they
// can become provider-ready prompt text. It rejects literal and bounded decoded fence closers.
export function preparePromptSourceText(text: string, taint: SourceTaint, canaries: CanaryTokens): string {
  if (containsSourceFenceCloser(text)) throw new FailClosed('sanitisation_failed');
  const prepared = prepareWithScribe(
    text,
    skillSchema.shape.trigger_condition,
    'system_prompt',
    taint,
    canaries,
  );
  if (!prepared.ok) throw new FailClosed('sanitisation_failed');
  return prepared.value;
}

export function prepareSystemSkill(
  row: ReturnType<typeof skillRowSchema.parse>,
  canaries: CanaryTokens,
): Skill {
  const skill = toPromptSkill(row);
  if (containsSourceFenceCloser(skill.trigger_condition) || containsSourceFenceCloser(skill.body_markdown)) {
    throw new FailClosed('sanitisation_failed');
  }
  const triggerCondition = prepareWithScribe(
    skill.trigger_condition,
    skillSchema.shape.trigger_condition,
    'system_prompt',
    null,
    canaries,
  );
  const body = prepareWithScribe(
    skill.body_markdown,
    skillSchema.shape.body_markdown,
    'system_prompt',
    null,
    canaries,
  );
  if (!triggerCondition.ok || !body.ok) throw new FailClosed('sanitisation_failed');
  return skillSchema.parse({
    ...skill,
    trigger_condition: triggerCondition.value,
    body_markdown: body.value,
  });
}

function toPromptSkill(row: ReturnType<typeof skillRowSchema.parse>): Skill {
  return skillSchema.parse({
    name: row.name,
    version: row.version,
    provenance: row.provenance,
    identity_locked: row.identity_locked,
    provisional: row.provisional,
    trigger_types: row.trigger_types,
    trigger_condition: row.trigger_condition,
    required_tools: row.required_tools,
    required_connectors: row.required_connectors,
    effectiveness: row.effectiveness,
    invocations: row.invocations,
    last_used: row.last_used,
    body_markdown: row.body_markdown,
    created_at: row.created_at,
  });
}

function containsSourceFenceCloser(text: string): boolean {
  const known = new Set<string>([text]);
  let frontier = [text];
  let decodedChars = 0;
  const maxDecodedChars = Math.max(text.length, 1) * 4;

  for (let pass = 0; pass < MAX_SOURCE_FENCE_DECODE_PASSES; pass += 1) {
    const next: string[] = [];
    for (const candidate of frontier) {
      if (SOURCE_FENCE_CLOSER.test(candidate)) return true;
      const percent = decodeSourcePercent(candidate);
      if (SOURCE_PERCENT_ESCAPE.test(candidate) && typeof percent !== 'string') return true;
      const decoded = [decodeSourceJsonEscapes(candidate), percent, decodeSourceBase64Tokens(candidate)];
      for (const value of decoded) {
        if (typeof value !== 'string' || value === candidate || known.has(value)) continue;
        decodedChars += value.length;
        if (value.length > maxDecodedChars || decodedChars > maxDecodedChars) return true;
        if (SOURCE_FENCE_CLOSER.test(value)) return true;
        known.add(value);
        next.push(value);
      }
    }
    frontier = next;
    if (frontier.length === 0) return false;
  }

  return frontier.some(canDecodeSourceFenceAgain);
}

function decodeSourceJsonEscapes(text: string): string | undefined {
  if (!SOURCE_JSON_ESCAPE.test(text)) return undefined;
  return text.replace(/\\(?:u([0-9a-fA-F]{4})|\/)/g, (_match, hex: string | undefined) =>
    hex === undefined ? '/' : String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

function decodeSourcePercent(text: string): string | null | undefined {
  if (!SOURCE_PERCENT_ESCAPE.test(text)) return undefined;
  try {
    return decodeURIComponent(text);
  } catch {
    return null;
  }
}

function decodeSourceBase64Tokens(text: string): string | undefined {
  let changed = false;
  const decoded = text.replace(SOURCE_BASE64_TOKEN, (token) => {
    const value = printableSourceBase64(token);
    if (value === undefined) return token;
    changed = true;
    return value;
  });
  return changed ? decoded : undefined;
}

function printableSourceBase64(token: string): string | undefined {
  if (!token.includes('=') && (!/[A-Z]/.test(token) || !/[a-z]/.test(token))) return undefined;
  const normalized = token.replaceAll('-', '+').replaceAll('_', '/');
  if (normalized.length % 4 === 1) return undefined;
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const decoded = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
    return decoded.length > 0 && !/[^\x09\x0A\x0D\x20-\x7E\u00B0]/.test(decoded)
      ? decoded
      : undefined;
  } catch {
    return undefined;
  }
}

function canDecodeSourceFenceAgain(text: string): boolean {
  if (SOURCE_JSON_ESCAPE.test(text) || SOURCE_PERCENT_ESCAPE.test(text)) return true;
  SOURCE_BASE64_TOKEN.lastIndex = 0;
  for (const match of text.matchAll(SOURCE_BASE64_TOKEN)) {
    if (printableSourceBase64(match[0]) !== undefined) return true;
  }
  return false;
}
