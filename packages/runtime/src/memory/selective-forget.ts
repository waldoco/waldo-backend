// Private, ephemeral source selection. The host supplies owner-local source rows;
// the model judges association, while these bounds enforce exact source custody.
// One bounded source set must be coverable without dropping a reviewed ref.
export const MAX_FORGET_SOURCES = 64;
export type ForgetSource = Readonly<{ ref: string; text: string }>;
// Align with SQLite LIKE's ASCII case folding. Unicode compatibility variants
// are outside this literal coverage contract, rather than silently certified.
export const asciiLiteralIncludes = (text: string, topic: string): boolean => {
  const fold = (value: string) => value.replace(/[A-Z]/g, letter => letter.toLowerCase());
  return fold(text).includes(fold(topic));
};
// `more` is ordinary page exhaustion. `incomplete` is an unreadable or
// unprovable source set; it must never be converted into batching progress.
// Diagnostic only: which store held a forget and by which rule. Table names and counts; never row text or ids.
export type ForgetHeldBy = Readonly<{ table: string; rule: string; rows: number }>;
export type ForgetBatch = Readonly<{ sources: readonly ForgetSource[]; incomplete: boolean; more: boolean; held?: readonly string[]; heldBy?: readonly ForgetHeldBy[]; otherIncomplete?: boolean }>;
export const forgetSourceBatch = (topic: string, rows: readonly ForgetSource[], more = false): ForgetBatch => {
  if (topic.length < 3 || topic.length > 512 || /[^\x20-\x7e]/.test(topic)) return { sources: [], incomplete: true, more };
  // A ref seen with two different texts is a conflict whether or not either text carries the topic.
  const seenText = new Map<string, string>();
  let incomplete = false;
  for (const row of rows) {
    const prior = seenText.get(row.ref);
    if (prior === undefined) seenText.set(row.ref, row.text);
    else if (prior !== row.text) incomplete = true;
  }
  const matched = rows.filter(row => asciiLiteralIncludes(row.text, topic));
  const sources: ForgetSource[] = [];
  const refs = new Map<string, string>();
  let full = false;
  for (const row of matched) {
    if (refs.has(row.ref)) {
      if (refs.get(row.ref) !== row.text) incomplete = true;
      continue;
    }
    refs.set(row.ref, row.text);
    if (full) { more = true; continue; }
    if (sources.length === MAX_FORGET_SOURCES || new TextEncoder().encode(JSON.stringify({ topic, sources: [...sources, row], incomplete: false })).byteLength > 8192) {
      // Never skip a source that cannot fit by itself to manufacture coverage.
      if (sources.length === 0) incomplete = true;
      more = true;
      full = true;
      continue;
    }
    sources.push(row);
  }
  return { sources, incomplete, more };
};
