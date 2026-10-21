// One predicate for "this stored text cannot be proven clean of the forgotten topic", shared by the
// inventory, the readback, the cleanup projections and the tool-output ledger so coverage cannot drift.
// It is a hard safety line, not a parser: nothing here decides a row is clean from a JSON parse.
// A backslash escape can spell a topic character that LIKE, JS JSON.parse and SQLite json_tree each read
// differently (duplicate keys, JSON5 text, nesting limits). A topic without control characters can never be spelled by \b \f \n \r \t (a topic with a tab or newline can, since grounding collapses whitespace, so those hold); \" \\ and \/ can only when the topic itself contains that character. Every other
// escape (\x, an identity escape such as \p, a dangling backslash, a malformed \u) can, so it holds; a well-formed \uXXXX is decoded and judged by carriesTopic.
export const hidesTopic = (value: string, topic: string): boolean => {
  const simple: Record<string, string> = { b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', '"': '"', '\\': '\\', '/': '/' };
  let decoded = ''; let from = 0; let escaped = false; let unicode = false;
  for (let index = value.indexOf('\\'); index !== -1; index = value.indexOf('\\', index + 2)) {
    const next = value[index + 1];
    if (next !== undefined && next in simple) {
      // A simple escape the topic cannot contain is decoded below, not skipped, so case context matches what a JSON parse gives.
      if (/[bfnrt]/.test(next) ? /[\x00-\x1f]/.test(topic) : topic.includes(next)) return true;
      decoded += value.slice(from, index) + simple[next]; from = index + 2; escaped = true; continue;
    }
    // A well-formed \uXXXX is decoded too. Anything else stays held.
    const hex = next === 'u' ? value.slice(index + 2, index + 6) : '';
    if (/^[0-9a-fA-F]{4}$/.test(hex)) { decoded += value.slice(from, index) + String.fromCharCode(parseInt(hex, 16)); from = index + 6; escaped = true; unicode = true; index += 4; continue; }
    return true;
  }
  // The whole decoded string is judged by the same fold the carries check uses, so the two cannot disagree (final sigma, dotted I). A row that already carries the topic raw is handled as a carrying row, except when a unicode escape is present (held as before).
  return escaped && carriesTopic(decoded + value.slice(from), topic) && (unicode || !carriesTopic(value, topic));
};

// Full JS string, NUL-safe (SQLite LIKE can stop at a NUL), case-insensitive literal.
export const carriesTopic = (value: string, topic: string): boolean => value.toLowerCase().includes(topic.toLowerCase());
