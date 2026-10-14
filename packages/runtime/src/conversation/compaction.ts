import { compactionMessage, conversationModelMessages, type ConversationCovers, type ConversationEntry, type ConversationModelMessage, type ConversationTree } from '@waldo/contracts';
import { CONVERSATION_INPUT_BUDGET_TOKENS, estimateMessageTokens, windowModelMessages, type ConversationWindowStats } from './window';

// A compaction row summarises the oldest part of a chain so the model's view becomes [summary] + [a verbatim tail]; the
// transcript the owner sees keeps every row. Production never writes this object: the flip changes `enabled` in source
// after the eval meets its bar, and off means no trigger and no view rule, the plain window exactly as before.
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

export const COMPACTION_SUPERSEDED_MARKER = '[superseded summary]';
// One compaction per chain and span: the row's id carries the last row it covers.
export const compactionId = (toId: string): string => `${toId}-compaction`;
export const COMPACTION_INSTRUCTION = [
  'Summarise the earlier part of this conversation between the owner and Waldo for Waldo\'s own later use. The conversation is in the owner\'s language; write in it.',
  'Keep: what the owner asked for and decided, with the owner\'s latest correction superseding any earlier statement; open items and promises Waldo made; facts the owner stated that Waldo should still know, each marked as stated by the owner.',
  'Leave out: tool mechanics, greetings, and anything already superseded. Health: only the owner\'s own qualitative statements, never a number, score or measurement.',
  'Write plain bullets. Never number steps or items. If a summary of earlier messages is already present, carry what still matters from it.',
].join('\n');

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

export type CompactionPlan = Readonly<{ input: readonly ConversationModelMessage[]; covers: ConversationCovers; gap: number; toEntry: ConversationEntry }>;

// What the next compaction covers: every row on the chain older than a verbatim tail of whole rounds at or under the tail
// fraction of the budget, so the tail starts with an owner message. The call's input is the live summary first, then the
// newest span rows that fit the input budget; rows older than those stay dropped, counted as `gap`, and `covers` names the
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
  let used = summary ? estimateMessageTokens(summary) : 0, from = span.length;
  for (let index = span.length - 1; index >= 0; index -= 1) {
    const cost = span[index]!.message ? estimateMessageTokens(span[index]!.message!) : 0;
    if (used + cost > inputBudgetTokens) break;
    used += cost; from = index;
  }
  const fitted = span.slice(from);
  const carried = fitted.filter((row) => row.message !== null);
  if (!carried.length) return null;
  return {
    input: [...(summary ? [summary] : []), ...carried.map((row) => row.message!)],
    covers: { from_id: live ? live.covers!.from_id : fitted[0]!.entry.id, to_id: span[span.length - 1]!.entry.id, rows: (live?.covers?.rows ?? 0) + carried.length },
    gap: from,
    toEntry: span[span.length - 1]!.entry,
  };
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
