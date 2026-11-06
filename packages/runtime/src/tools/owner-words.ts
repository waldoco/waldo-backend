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

// Whether a duration in minutes is a figure the owner typed in their own words, with its unit: n hours (7.5 hours, 8h),
// n hours then m minutes (7 hours 30 minutes, 7h30m) or n minutes, converted as the tool takes it. A number without a unit
// (a time, a date, a count) vouches for nothing. Provenance only: it reads a figure and its unit, never what the words around
// them mean.
const STATED_DURATION = /(\d+(?:\.\d+)?)\s*(?:hours?|hrs?|h)(?![a-z])(?:\s*(?:and\s+)?(\d{1,2})\s*(?:minutes?|mins?|m)(?![a-z]))?|(\d+)\s*(?:minutes?|mins?|m)(?![a-z])/gi;
export const ownerStatedMinutes = (minutes: number, turn: MemoryOwnerTurn): boolean => ownerParts(turn).some((part) =>
  [...part.matchAll(STATED_DURATION)].some(([, hours, extra, alone]) =>
    (hours === undefined ? Number(alone) : Math.round(Number(hours) * 60) + Number(extra ?? 0)) === minutes));
