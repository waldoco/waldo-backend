import { literalTextIndex } from '@waldo/contracts';
import type { ClaimStore } from './claims';

// One predicate for "this stored text cannot be proven clean of the forgotten topic", shared by the
// inventory, the readback, the cleanup projections and the tool-output ledger so coverage cannot drift.
// It is a hard safety line, not a parser: nothing here decides a row is clean from a JSON parse.
// A backslash escape can spell a topic character that LIKE, JS JSON.parse and SQLite json_tree each read
// differently (duplicate keys, JSON5 text, nesting limits). A topic without control characters can never be spelled by \b \f \n \r \t (a topic with a tab or newline can, since grounding collapses whitespace, so those hold); \" \\ and \/ can only when the topic itself contains that character.
// Every other escape is read the most permissive way any reader takes it: \uXXXX and \xHH as the character they name, \0 and \v
// as theirs, a backslash before a line break as nothing, a dangling backslash as nothing, and any other escaped character as
// itself (JSON5). The row holds when that reading carries the topic; a backslash that only sits in prose (C:\Users\Nina) reads
// as letters that carry nothing, so it holds nothing, while one that spells the topic (\x74ea, t\ea) holds.
export const hidesTopic = (value: string, topic: string): boolean => {
  const simple: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/' };
  const control: Record<string, string> = { '0': '\0', v: '\v' };
  let decoded = ''; let from = 0; let escaped = false; let lenient = false;
  for (let index = value.indexOf('\\'); index !== -1; index = value.indexOf('\\', from)) {
    const next = value[index + 1];
    if (next !== undefined && next in simple) {
      // A simple escape the topic cannot contain is decoded below, not skipped, so case context matches what a JSON parse gives.
      if (/[bfnrt]/.test(next) ? /[\x00-\x1f]/.test(topic) : topic.includes(next)) return true;
      decoded += value.slice(from, index) + simple[next]; from = index + 2; escaped = true; continue;
    }
    escaped = true; lenient = true;
    const width = next === 'u' ? 4 : next === 'x' ? 2 : 0, hex = value.slice(index + 2, index + 2 + width);
    if (width && hex.length === width && /^[0-9a-fA-F]+$/.test(hex)) { decoded += value.slice(from, index) + String.fromCharCode(parseInt(hex, 16)); from = index + 2 + width; continue; }
    if (next !== undefined && next in control) { if (/[\x00-\x1f]/.test(topic)) return true; decoded += value.slice(from, index) + control[next]; from = index + 2; continue; }
    const line = /^(?:\r\n|[\n\r\u2028\u2029])/.exec(value.slice(index + 1, index + 3))?.[0];
    if (next === undefined || line) { decoded += value.slice(from, index); from = index + 1 + (line?.length ?? 0); continue; }
    const character = String.fromCodePoint(value.codePointAt(index + 1)!);
    decoded += value.slice(from, index) + character; from = index + 1 + character.length;
  }
  // The whole decoded string is judged by the same fold the carries check uses, so the two cannot disagree (final sigma, dotted I). A row that already carries the topic raw is handled as a carrying row, except when an escape beyond JSON's simple ones is present (held as before).
  return escaped && carriesTopic(decoded + value.slice(from), topic) && (lenient || !carriesTopic(value, topic));
};

// Full JS string, NUL-safe (SQLite LIKE can stop at a NUL), the topic as a whole word in any case: the same pattern every
// forget redactor rewrites by, so redaction and readback cannot disagree.
export const carriesTopic = (value: string, topic: string): boolean => literalTextIndex(value, topic) !== -1;
// The topic's first characters as the start of a word, for a check that only sees a cut prefix: its end stays open
// unless the prefix is the whole topic.
export const startsTopic = (value: string, prefix: string, topic: string): boolean => literalTextIndex(value, prefix, prefix.length < topic.length) !== -1;

// What an unfinished forget still holds: the words of claims mid-purge and the topics whose purge has not settled. Recall,
// the nightly pass and promotion withhold whatever carries one of them, and nothing else.
export const heldTopicsOf = (store: Pick<ClaimStore, 'claims' | 'pendingTopics'>): string[] =>
  [...store.claims('purging').flatMap(claim => [claim.text, claim.evidence]), ...store.pendingTopics()];
export const holdsIn = (held: readonly string[]) => (...values: readonly (string | null | undefined)[]): boolean =>
  values.some(value => typeof value === 'string' && held.some(topic => carriesTopic(value, topic) || hidesTopic(value, topic)));
