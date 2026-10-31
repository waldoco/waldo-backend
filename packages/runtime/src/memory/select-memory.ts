import { LIFE_AREAS } from '@waldo/contracts';
import { CONSTELLATION_BLOCK_MAX_CHARS, constellationBlock, FACTS_BLOCK_MAX_CHARS, fittingLines, MEMORY_HEADER, pinnedIn, PROFILE_BLOCK_MAX_CHARS, profileClaims, profileLine, statedReading, type Claim, type ClaimStore } from './claims';
import { RECALL_MAX_CHARS, recallForTurn, type RecallEpisodes, type RecallLeg, type RecallNear } from './turn-recall';

// What the model sees of the owner's memory, chosen by the model rather than by age (memory redesign option B). The core holds
// the nightly's pins, what the owner said since that review, and a count by area of what is left out; recall offers this
// message's candidates as full lines, then as stubs the model can open with read_memory({ ids }). Code only searches and
// counts: which note matters is the model's call, at the nightly (pins) and in the turn (which stub to open).
export const CORE_ROOM = PROFILE_BLOCK_MAX_CHARS + FACTS_BLOCK_MAX_CHARS + CONSTELLATION_BLOCK_MAX_CHARS;
export const RECALLED_ROOM = RECALL_MAX_CHARS;
const HEADER = `${MEMORY_HEADER} <owner_new> is what the owner said since Waldo last reviewed memory, oldest first.`;

const leftOutLine = (claims: readonly Claim[]): string => {
  const counts = new Map<string, number>();
  for (const claim of claims) counts.set(claim.area ?? 'unsorted', (counts.get(claim.area ?? 'unsorted') ?? 0) + 1);
  const named = LIFE_AREAS.flatMap((area) => (counts.get(area) ? [`${area} ${counts.get(area)}`] : []));
  return named.length ? `(More the owner told Waldo, not shown here: ${named.join(', ')}. Recall brings what a message needs; read_memory by area or query reaches the rest.)` : '';
};

// The core within room and CORE_ROOM, whichever is less. reviewedThrough is when memory was last reviewed (ms); a claim told
// after it is new, and with no review yet every claim is. New claims are the newest that fit, shown oldest first, so the
// fact the owner just gave is always there. A health note or a stated reading is never in the core: recall and get_health
// carry those. Nothing is cut mid-line; what does not fit is counted.
export const coreMemory = (store: ClaimStore, room: number, reviewedThrough: number | undefined): string => {
  const eligible = profileClaims(store);
  const pinned = (claim: Claim) => claim.pinned === 'profile' || claim.pinned === 'facts';
  const fresh = eligible.filter((claim) => !pinned(claim) && claim.kind !== 'health' && !statedReading(claim)
    && (reviewedThrough === undefined || Date.parse(claim.created_at) > reviewedThrough)).sort((a, b) => a.id - b.id);
  const parts: string[] = [];
  let left = Math.min(room, CORE_ROOM);
  const push = (text: string): boolean => {
    const size = text.length + (parts.length ? 1 : 0);
    if (!text || size > left) return false;
    parts.push(text); left -= size;
    return true;
  };
  if (!push(HEADER)) return '';
  const shown = new Set<number>();
  // The claims of one block that fit within budget, taken from the end when newest win.
  const block = (tag: string, claims: readonly Claim[], budget: number, newestWin = false): number => {
    const open = `<${tag}>`, close = `</${tag}>`;
    const space = Math.min(budget, left - 1 - open.length - close.length - 2);
    if (!claims.length || space <= 0) return 0;
    const order = newestWin ? [...claims].reverse() : claims;
    const kept = order.slice(0, fittingLines(order.map(profileLine), space).length);
    const lines = (newestWin ? [...kept].reverse() : kept);
    if (!lines.length || !push([open, ...lines.map(profileLine), close].join('\n'))) return 0;
    for (const claim of lines) shown.add(claim.id);
    return lines.map(profileLine).join('\n').length;
  };
  const profileUsed = block('owner_profile', pinnedIn(eligible, 'profile'), PROFILE_BLOCK_MAX_CHARS);
  const factsUsed = block('owner_facts', pinnedIn(eligible, 'facts'), FACTS_BLOCK_MAX_CHARS);
  block('owner_new', fresh, PROFILE_BLOCK_MAX_CHARS + FACTS_BLOCK_MAX_CHARS - profileUsed - factsUsed, true);
  push(leftOutLine(eligible.filter((claim) => !shown.has(claim.id))));
  const constellation = constellationBlock(store, left - 1);
  if (constellation) push(constellation);
  return parts.join('\n');
};

export type MemoryTurn = 'owner' | 'machine' | 'outside';
type Holds = (...values: readonly (string | null | undefined)[]) => boolean;
const ids = (text: string, prefix: 'c' | 'n') => [...text.matchAll(new RegExp(`\\b${prefix}(\\d+) · `, 'g'))].map((match) => Number(match[1]));

// The memory-selection interface the harness consumes. view is already filtered by the caller (forget barrier, outside view,
// owner-only) and never widened here. Past messages join only the owner's own turn. Recall that misses deadlineMs is left
// out, and its legs are named in failed; the core never waits on it. shown lists the ids shown in full, never a stub.
export const selectMemory = async (input: Readonly<{
  view: ClaimStore; text: string; previous?: string; turn: MemoryTurn;
  room: Readonly<{ core: number; recalled: number }>; deadlineMs: number; reviewedThrough: number | undefined;
  holds: Holds; episodes?: RecallEpisodes; current?: string; semantic?: RecallNear;
}>): Promise<Readonly<{ core: string; recalled: string; shown: Readonly<{ claims: readonly number[]; nodes: readonly number[] }>; failed: readonly RecallLeg[]; revision: number }>> => {
  const core = coreMemory(input.view, input.room.core, input.reviewedThrough);
  const episodes = input.turn === 'owner' ? input.episodes : undefined;
  const pending: RecallLeg[] = [...(input.semantic ? ['semantic' as const] : []), ...(episodes ? ['episodes' as const] : [])];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), input.deadlineMs); });
  const recalled = await Promise.race([recallForTurn({
    claims: input.view, question: input.text, room: input.room.recalled, holds: input.holds, stubs: true,
    ...(input.previous === undefined ? {} : { previous: input.previous }),
    ...(episodes ? { episodes, ...(input.current === undefined ? {} : { current: input.current }) } : {}),
    ...(input.semantic ? { semantic: input.semantic } : {}),
  }), late]).finally(() => clearTimeout(timer));
  const text = recalled?.text ?? '';
  return {
    core, recalled: text,
    shown: { claims: [...new Set([...ids(core, 'c'), ...ids(text, 'c')])], nodes: ids(core, 'n') },
    failed: recalled ? recalled.failed : pending.length ? pending : ['claims'],
    revision: input.view.revision(),
  };
};
