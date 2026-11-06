// The owner's current message as the authenticated host hands it to the tools (owner-turn memoryContext), never from model
// arguments. Each text is the owner's own message body; quote ranges mark forwarded or provider-authored chunks.
export type MemoryOwnerTurn = Readonly<{ message_ref: string; text: string; sourceQuoteRanges?: readonly Readonly<{ start: number; end: number }>[] }>;

// Split, rather than join, so evidence cannot bridge an excluded quote.
export const ownerParts = (turn: MemoryOwnerTurn): readonly string[] => {
  const ranges = [...(turn.sourceQuoteRanges ?? [])].sort((a, b) => a.start - b.start);
  if (ranges.some(range => !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > turn.text.length)) return [];
  const parts: string[] = []; let end = 0;
  for (const range of ranges) { if (range.start > end) parts.push(turn.text.slice(end, range.start)); end = Math.max(end, range.end); }
  parts.push(turn.text.slice(end)); return parts;
};

// Whether a duration in minutes is a figure the owner typed in their own words: n minutes, n hours, or n hours then m
// minutes (7:30, 7h30, 7 hours 30). Provenance only: it reads numbers, never what the words around them mean.
export const ownerStatedMinutes = (minutes: number, turn: MemoryOwnerTurn): boolean => ownerParts(turn).some((part) => {
  const figures = [...part.matchAll(/\d+(?:\.\d+)?/g)].map((match) => Number(match[0]));
  return figures.some((n, index) => n === minutes || Math.round(n * 60) === minutes
    || (Number.isInteger(n) && index + 1 < figures.length && figures[index + 1]! < 60 && n * 60 + figures[index + 1]! === minutes));
});
