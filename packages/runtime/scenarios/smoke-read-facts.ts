// Narrow deterministic fact extraction oracle. This is not a general usefulness grader.
// The expected values come from the fictional source, never from the model response.
export type SmokeMailFacts = Readonly<{ subject: string; from: string; snippet: string }>;
export const matchesSmokeMailFacts = (reply: unknown, source: SmokeMailFacts): boolean => {
  if (typeof reply !== 'string') return false;
  try {
    const parsed: unknown = JSON.parse(reply);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const row = parsed as Record<string, unknown>;
    const keys = Object.keys(row).sort();
    if (keys.join(',') !== 'from,snippet,subject') return false;
    return row.subject === source.subject && row.from === source.from && row.snippet === source.snippet;
  } catch { return false; }
};
