import { compactionMessage, conversationModelMessages, type ConversationCovers, type ConversationEntry, type ConversationModelMessage, type ConversationTree } from '@waldo/contracts';
import type { ClaimGrounding } from '../memory/claims';
import { CONVERSATION_INPUT_BUDGET_TOKENS, estimateMessageTokens, windowModelMessages, type ConversationWindowStats } from './window';

// A compaction row summarises the oldest part of a chain so the model's view becomes [summary] + [a verbatim tail]; the
// transcript the owner sees keeps every row. These are the defaults, off: a deploy turns compaction on with
// WALDO_COMPACTION=on, and off means no trigger and no view rule, the plain window exactly as before.
export const COMPACTION = {
  enabled: false,
  budgetTokens: CONVERSATION_INPUT_BUDGET_TOKENS,
  triggerFraction: 0.7,
  tailFraction: 0.5,
  minOwnerRows: 10,
  minIntervalMs: 3_600_000,
  maxOutputTokens: 2_000,
};
export type CompactionSettings = typeof COMPACTION;
// Only the exact value "on" turns it on, so an unset or mistyped deploy var keeps the plain window.
export const compactionSettings = (env: Readonly<{ WALDO_COMPACTION?: string }>): CompactionSettings => ({ ...COMPACTION, enabled: env.WALDO_COMPACTION === 'on' });

export const COMPACTION_SUPERSEDED_MARKER = '[superseded summary]';
// One compaction per chain and span: the row's id carries the last row it covers.
export const compactionId = (toId: string): string => `${toId}-compaction`;
// The summary has fixed sections, so what the owner asked for survives each re-compaction in the same place instead of
// thinning out of free prose.
export const COMPACTION_INSTRUCTION = [
  'Summarise the earlier part of this conversation between the owner and Waldo for Waldo\'s own later use. The conversation is in the owner\'s language; write in it.',
  'Write these sections, in this order, each a heading line followed by plain bullets, and leave a section with no bullets out:',
  'Owner instructions: every standing instruction or preference the owner gave that still applies, in the owner\'s own words where short. A later correction replaces the earlier one; never drop an instruction the owner did not take back.',
  'Decisions: what the owner decided or approved.',
  'Open items: what is still to do, and every promise Waldo made that is not yet kept.',
  'Facts: facts the owner stated that Waldo should still know, each marked as stated by the owner.',
  'Leave out: tool mechanics, greetings, and anything already superseded. Health: only the owner\'s own qualitative statements, never a number, score or measurement.',
  'Never number steps or items. If a summary of earlier messages is already present, carry every section of it forward with what still matters.',
].join('\n');

// A span about to leave the model's window, handed to the memory flush before its summary replaces it. The flush may
// keep what the owner said as memory; it writes nothing to the chain. A flush that throws defers the compaction, so no
// span leaves the window before its flush has run.
// entryIds names every row leaving the window, oldest first, including rows the summary had no room for.
export type CompactionSpan = Readonly<{ conversationRef: string; covers: ConversationCovers; messages: readonly ConversationModelMessage[]; entryIds: readonly string[] }>;
// What the flush can keep: save writes, through memory's admission gate in the compacting turn's scope, what the owner said
// in this transcript of the span (the sides say whose words are whose), and returns the claims it wrote. policy.health
// false keeps no health notes.
export type SpanMemory = Readonly<{
  save(span: string, sides: ClaimGrounding, policy: Readonly<{ health: boolean }>): Promise<readonly Readonly<{ id: number; kind: string }>[]>;
}>;
// It returns the owner's own words in the span as it read them (none when it read no rows), so the summary floor can tell
// a reading the owner wrote from one Waldo relayed or someone else sent.
export type CompactionFlush = (span: CompactionSpan, memory: SpanMemory) => Promise<Readonly<{ owner: string }> | void>;

export type CompactedStats = ConversationWindowStats & Readonly<{ compacted: 0 | 1 }>;

const chainFrom = (tree: ConversationTree, leafId: string, startRef?: string): readonly ConversationEntry[] => {
  const path = tree.path(leafId);
  if (!startRef) return path;
  const first = path.findIndex((entry) => entry.id === startRef);
  return first < 0 ? path.slice(-1) : path.slice(first);
};
const summaryText = (entry: ConversationEntry): string => entry.modelProjection.mode === 'replace' ? entry.modelProjection.payload : entry.modelPayload;

// The chain's live compaction row: not omitted, and covering a row on the leaf's path (after startRef when one is given).
// Two live rows cannot be written for one chain; if two exist, the one covering the later row wins.
export const liveCompaction = (tree: ConversationTree, leafId: string, startRef?: string): ConversationEntry | null => {
  const onPath = new Map(chainFrom(tree, leafId, startRef).map((entry, index) => [entry.id, index]));
  let live: ConversationEntry | null = null;
  for (const entry of tree.values()) {
    if (entry.role !== 'compaction' || !entry.covers || entry.modelProjection.mode === 'omit' || !onPath.has(entry.covers.to_id)) continue;
    if (!live || onPath.get(entry.covers.to_id)! > onPath.get(live.covers!.to_id)!) live = entry;
  }
  return live;
};

// The model's view of a chain. Without a live compaction row, or with the switch off, this is the plain window. With one,
// the summary is always kept and the rows after the span are windowed against what the summary leaves of the budget.
export const compactedHistory = (tree: ConversationTree, leafId: string, startRef?: string, settings: CompactionSettings = COMPACTION): Readonly<{ messages: readonly ConversationModelMessage[]; stats: CompactedStats }> => {
  const entries = chainFrom(tree, leafId, startRef);
  const live = settings.enabled ? liveCompaction(tree, leafId, startRef) : null;
  if (!live) {
    const plain = windowModelMessages(conversationModelMessages(entries), settings.budgetTokens);
    return { messages: plain.messages, stats: { ...plain.stats, compacted: 0 } };
  }
  const summary = compactionMessage(live, summaryText(live));
  const after = entries.slice(entries.findIndex((entry) => entry.id === live.covers!.to_id) + 1);
  const tail = windowModelMessages(conversationModelMessages(after), Math.max(settings.budgetTokens - estimateMessageTokens(summary), 0));
  return { messages: [summary, ...tail.messages], stats: { ...tail.stats, estimated_tokens: tail.stats.estimated_tokens + estimateMessageTokens(summary), compacted: 1 } };
};

// Owner rows on the chain written after the live compaction row (all of them when there is none).
export const ownerRowsSince = (tree: ConversationTree, leafId: string, since: number | null): number =>
  tree.path(leafId).filter((entry) => entry.role === 'user' && entry.inputOrigin === 'owner' && (since === null || (entry.createdAt ?? 0) > since)).length;

// Whether a chain should compact now: the last turn dropped rows or crossed the trigger fraction, enough owner rows have
// arrived since the live summary, and the last attempt, success or failure, is older than the interval.
export const compactionDue = (input: Readonly<{ stats: Pick<ConversationWindowStats, 'dropped' | 'estimated_tokens' | 'budget_tokens'>; ownerRows: number; lastAttemptAt: number | null; now: number }>, settings: CompactionSettings = COMPACTION): boolean =>
  (input.stats.dropped > 0 || input.stats.estimated_tokens > settings.triggerFraction * input.stats.budget_tokens)
  && input.ownerRows >= settings.minOwnerRows
  && (input.lastAttemptAt === null || input.now - input.lastAttemptAt >= settings.minIntervalMs);

// sources[i] is the row input[i] was made from: the live summary's row first when there is one, then the span rows carried.
// entryIds names every row leaving the window, whether or not the summary reads it.
export type CompactionPlan = Readonly<{ input: readonly ConversationModelMessage[]; sources: readonly ConversationEntry[]; covers: ConversationCovers; gap: number; toEntry: ConversationEntry; entryIds: readonly string[] }>;

// What the next compaction covers: every row on the chain older than a verbatim tail of whole rounds at or under the tail
// fraction of the budget, so the tail starts with an owner message. The call's input is the live summary first, then the
// span rows that fit the input budget, in chain order; rows that do not fit are counted as `gap`, and `covers` names the
// first original row the summary carries, through the previous summary when there is one.
export const compactionPlan = (tree: ConversationTree, leafId: string, live: ConversationEntry | null, settings: CompactionSettings = COMPACTION, inputBudgetTokens: number = settings.budgetTokens): CompactionPlan | null => {
  const path = tree.path(leafId);
  const rows = (live ? path.slice(path.findIndex((entry) => entry.id === live.covers!.to_id) + 1) : path)
    .map((entry) => ({ entry, message: conversationModelMessages([entry])[0] ?? null }));
  const isRoundStart = (entry: ConversationEntry) => (entry.role ?? (entry.id.endsWith('-reply') ? 'assistant' : 'user')) === 'user';
  // The tail: whole rounds from the newest back while they fit the tail fraction; the newest round stays whatever its size,
  // as the window itself always keeps the current turn.
  let tailStart = rows.length, tokens = 0, newest = true;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    tokens += rows[index]!.message ? estimateMessageTokens(rows[index]!.message!) : 0;
    if (!isRoundStart(rows[index]!.entry)) continue;
    if (!newest && tokens > settings.tailFraction * settings.budgetTokens) break;
    tailStart = index; newest = false;
  }
  const span = rows.slice(0, tailStart);
  if (!span.length) return null;
  const summary = live ? compactionMessage(live, summaryText(live)) : null;
  // When the span outgrows the input budget, the owner's own messages go in first, newest first, and Waldo's replies fill
  // what room is left: a reply can be read again from the transcript the owner sees, an instruction the summary never saw is lost.
  const isOwnerRow = (entry: ConversationEntry) => entry.role === 'user' && entry.inputOrigin === 'owner';
  const kept = new Set<number>();
  let used = summary ? estimateMessageTokens(summary) : 0;
  for (const owner of [true, false]) {
    for (let index = span.length - 1; index >= 0; index -= 1) {
      const row = span[index]!;
      if (!row.message || isOwnerRow(row.entry) !== owner) continue;
      const cost = estimateMessageTokens(row.message);
      if (used + cost > inputBudgetTokens) break;
      used += cost; kept.add(index);
    }
  }
  const carried = span.filter((row, index) => kept.has(index));
  if (!carried.length) return null;
  const first = Math.min(...kept);
  return {
    input: [...(summary ? [summary] : []), ...carried.map((row) => row.message!)],
    sources: [...(live ? [live] : []), ...carried.map((row) => row.entry)],
    covers:{ from_id: live ? live.covers!.from_id : span[first]!.entry.id, to_id: span[span.length - 1]!.entry.id, rows: (live?.covers?.rows ?? 0) + carried.length },
    gap: span.filter((row) => row.message !== null).length - carried.length,
    toEntry: span[span.length - 1]!.entry,
    entryIds: span.map((row) => row.entry.id),
  };
};

// What a summary was made from, checked again in the commit that writes it, after the model call: each source row must
// still be stored as the summary read it, and admits() must pass, reading what is held at that moment. A forget that
// landed while the summary was being written rewrites a source row or holds a topic, and the summary is not written.
export type CompactionFence = Readonly<{ sources: readonly ConversationEntry[]; admits: () => boolean }>;

// The plan without the inputs `drop` selects, as a held topic's rows are left out: covers.rows counts only the original
// rows the summary is still made from, the previous summary's count among them only while that summary is kept. Null when
// nothing is left.
export const planWithout = (plan: CompactionPlan, drop: (message: ConversationModelMessage) => boolean): CompactionPlan | null => {
  const kept = plan.input.flatMap((message, index) => (drop(message) ? [] : [{ message, source: plan.sources[index]! }]));
  if (!kept.length) return null;
  const rows = kept.reduce((count, { source }) => count + (source.role === 'compaction' ? source.covers!.rows : 1), 0);
  return { ...plan, input: kept.map(({ message }) => message), sources: kept.map(({ source }) => source), covers: { ...plan.covers, rows } };
};

// The row itself: a child of the last row it covers, beside the first row it does not, on the same thread, so no stored
// row changes and the chain's leaf stays where the last turn left it.
export const compactionRow = (plan: CompactionPlan, summary: string, ownerId: string, now: number): ConversationEntry => ({
  id: compactionId(plan.covers.to_id), ownerId, chatId: plan.toEntry.chatId, parentId: plan.toEntry.id, threadAnchorId: plan.toEntry.threadAnchorId,
  surface: plan.toEntry.surface, modelPayload: summary, appPayload: '', modelProjection: { mode: 'include' }, role: 'compaction', covers: plan.covers, createdAt: now,
});

// A superseded or forgotten summary keeps its id and covers for audit and nothing of its text.
export const supersededCompaction = (entry: ConversationEntry): ConversationEntry =>
  ({ ...entry, modelPayload: COMPACTION_SUPERSEDED_MARKER, modelProjection: { mode: 'omit' } });
