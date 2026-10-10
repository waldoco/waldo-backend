const wireSize = (content: string) => JSON.stringify([{ role: 'user', content }]).length;

const omission = (lines: number) => `[${lines} lines omitted from the middle to fit the model's context; look them up if needed]`;

// Keeps the opening and the closing of a prompt, where our builders put the header and the instruction, and cuts the
// data in between. Whole lines when they fit; characters when one line is itself too large.
const cutMiddle = (text: string, budget: number): string => {
  const half = Math.floor(budget / 2);
  const lines = text.split('\n');
  const head: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length + 1 > half) break;
    head.push(line);
    used += line.length + 1;
  }
  const tail: string[] = [];
  used = 0;
  for (let index = lines.length - 1; index >= head.length; index -= 1) {
    if (used + lines[index]!.length + 1 > half) break;
    tail.unshift(lines[index]!);
    used += lines[index]!.length + 1;
  }
  const opening = head.length > 0 ? head.join('\n') : text.slice(0, half);
  const closing = tail.length > 0 ? tail.join('\n') : text.slice(Math.max(text.length - half, 0));
  return `${opening}\n${omission(Math.max(lines.length - head.length - tail.length, 1))}\n${closing}`;
};

// The one size guard for every prompt a scheduled or event-driven job hands the owner agent. A job's data grows with the
// owner (ledger, update backlog, mail), so the guard sits at the seam all of them share and no builder has to remember it.
export const fitPromptToBudget = (text: string, capChars: number): string => {
  if (wireSize(text) <= capChars) return text;
  let budget = capChars;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const fitted = cutMiddle(text, Math.max(budget, 0));
    const excess = wireSize(fitted) - capChars;
    if (excess <= 0) return fitted;
    budget -= excess + 64;
  }
  return cutMiddle(text, 0);
};
