// One predicate for "this stored text cannot be proven clean of the forgotten topic", shared by the
// inventory, the readback, the cleanup projections and the tool-output ledger so coverage cannot drift.
// It is a hard safety line, not a parser: nothing here decides a row is clean from a JSON parse.
// A backslash escape can spell a topic character that LIKE, JS JSON.parse and SQLite json_tree each read
// differently (duplicate keys, JSON5 text, nesting limits). Topics are printable ASCII, so \b \f \n \r \t can never
// produce a topic character; \" \\ and \/ can only when the topic itself contains that character. Every other
// escape (\u, \x, an identity escape such as \p, or a dangling backslash) can, so it holds.
export const hidesTopic = (value: string, topic: string): boolean => {
  for (let index = value.indexOf('\\'); index !== -1; index = value.indexOf('\\', index + 2)) {
    const next = value[index + 1];
    if (next === 'b' || next === 'f' || next === 'n' || next === 'r' || next === 't') continue;
    if ((next === '"' || next === '\\' || next === '/') && !topic.includes(next)) continue;
    return true;
  }
  return false;
};

// Full JS string, NUL-safe (SQLite LIKE can stop at a NUL), case-insensitive literal.
export const carriesTopic = (value: string, topic: string): boolean => value.toLowerCase().includes(topic.toLowerCase());
