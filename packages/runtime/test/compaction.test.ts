import { afterEach, describe, expect, it } from 'vitest';
import { COMPACTION_SUMMARY_CLOSE, ConversationTree, compactionSummaryOpen, type ConversationEntry } from '@waldo/contracts';
import { COMPACTION, COMPACTION_SUPERSEDED_MARKER, compactedHistory, compactionDue, compactionId, compactionPlan, compactionRow, liveCompaction, ownerRowsSince, supersededCompaction } from '../src/conversation/compaction';
import { estimateMessageTokens, windowModelMessages } from '../src/conversation/window';
import { numericHealthIn } from '../src/scribe/sanitiser';

const defaults = { ...COMPACTION };
afterEach(() => { Object.assign(COMPACTION, defaults); });

const row = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string, createdAt = 0): ConversationEntry => ({
  id, ownerId: 'owner', chatId: 'owner', parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}), createdAt,
});
// n rounds of owner question and reply, each side `chars` long; ids u1, a1, u2, a2, ...
const chain = (rounds: number, chars = 100): ConversationTree => {
  const tree = new ConversationTree();
  let parent: string | null = null;
  for (let round = 1; round <= rounds; round += 1) {
    tree.append(row(`u${round}`, parent, 'user', `question ${round} ${'q'.repeat(chars)}`, round * 10));
    tree.append(row(`a${round}`, `u${round}`, 'assistant', `answer ${round} ${'a'.repeat(chars)}`, round * 10 + 1));
    parent = `a${round}`;
  }
  return tree;
};
const leafOf = (rounds: number) => `a${rounds}`;

describe('compaction', () => {
  it('renders a compaction row as one user message that names itself as a summary', () => {
    const tree = chain(3);
    const plan = compactionPlan(tree, leafOf(3), null, { ...COMPACTION, budgetTokens: 120 })!;
    const summary = compactionRow(plan, 'The owner prefers tea.', 'owner', 99);
    tree.append(summary);
    expect(summary).toMatchObject({ id: compactionId(plan.covers.to_id), parentId: plan.covers.to_id, role: 'compaction', appPayload: '', covers: plan.covers });
    expect(tree.modelContext(summary.id).at(-1)).toEqual({ role: 'user', content: `${compactionSummaryOpen(plan.covers.rows)}\nThe owner prefers tea.\n${COMPACTION_SUMMARY_CLOSE}` });
    expect(tree.appContext(summary.id)).not.toContain('');
  });

  it('with the switch off the view is the plain window, whatever rows exist', () => {
    const tree = chain(4);
    tree.append(compactionRow(compactionPlan(tree, leafOf(4), null, { ...COMPACTION, budgetTokens: 120 })!, 'summary', 'owner', 99));
    const plain = windowModelMessages(tree.modelContext(leafOf(4)), COMPACTION.budgetTokens);
    expect(compactedHistory(tree, leafOf(4))).toEqual({ messages: plain.messages, stats: { ...plain.stats, compacted: 0 } });
  });

  it('with the switch on the summary is always kept and only the rows after its span are windowed', () => {
    Object.assign(COMPACTION, { enabled: true, budgetTokens: 120 });
    const tree = chain(6);
    const plan = compactionPlan(tree, leafOf(6), null)!;
    tree.append(compactionRow(plan, 'summary', 'owner', 99));
    for (const budget of [20, 120, 100_000]) {
      const view = compactedHistory(tree, leafOf(6), undefined, { ...COMPACTION, budgetTokens: budget });
      expect(view.messages[0]!.content).toContain(compactionSummaryOpen(plan.covers.rows));
      expect(view.stats.compacted).toBe(1);
      expect(view.messages.slice(1).every((message) => !message.content.includes(COMPACTION_SUMMARY_CLOSE))).toBe(true);
      expect(view.messages.some((message) => message.content.startsWith('question 1 '))).toBe(false);
    }
    // the tail is whole rounds and starts with the owner's message
    const tail = compactedHistory(tree, leafOf(6), undefined, { ...COMPACTION, budgetTokens: 100_000 }).messages.slice(1);
    expect(tail.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(tail[0]!.content.startsWith('question 6 ')).toBe(true);
    expect(liveCompaction(tree, leafOf(6))!.covers).toEqual(plan.covers);
  });

  it('plans the span as everything older than the tail, bounded to the input budget, with covers naming original rows', () => {
    const settings = { ...COMPACTION, budgetTokens: 120 };
    const tree = chain(8);
    const first = compactionPlan(tree, leafOf(8), null, settings)!;
    // the tail holds at most half the budget: the newest round (about 72 tokens) is always kept, a second round does not fit
    expect(first.covers.to_id).toBe('a7');
    expect(first.gap).toBeGreaterThan(0);
    expect(first.covers.rows).toBe(first.input.length);
    expect(first.covers.from_id).toBe(tree.path('a7').at(-first.covers.rows)!.id);
    expect(first.input.reduce((sum, message) => sum + estimateMessageTokens(message), 0)).toBeLessThanOrEqual(120);
    // a later compaction carries the live summary first and its coverage forward
    const live = compactionRow(first, 'earlier summary', 'owner', 99);
    tree.append(live);
    tree.append(row('u9', 'a8', 'user', `question 9 ${'q'.repeat(100)}`, 90));
    tree.append(row('a9', 'u9', 'assistant', `answer 9 ${'a'.repeat(100)}`, 91));
    const second = compactionPlan(tree, 'a9', live, settings)!;
    expect(second.input[0]!.content).toContain('earlier summary');
    expect(second.covers).toEqual({ from_id: first.covers.from_id, to_id: 'a8', rows: first.covers.rows + 2 });
    expect(compactionId(second.covers.to_id)).not.toBe(live.id);
    // nothing to cover: a chain of one round, or one that fits the tail
    expect(compactionPlan(chain(1), 'a1', null, settings)).toBeNull();
    expect(compactionPlan(chain(3), 'a3', null, { ...COMPACTION, budgetTokens: 100_000 })).toBeNull();
    // the whole span fits a larger input budget: coverage starts at the chain's first row, with no gap
    const whole = compactionPlan(tree, leafOf(8), null, settings, 10_000)!;
    expect(whole).toMatchObject({ gap: 0, covers: { from_id: 'u1', to_id: 'a7', rows: 14 } });
  });

  it('is due only when the window dropped or ran near the budget, enough owner rows arrived, and the last attempt is old', () => {
    const settings = { ...COMPACTION, minOwnerRows: 3, minIntervalMs: 1_000 };
    const stats = { dropped: 0, estimated_tokens: 71, budget_tokens: 100 };
    expect(compactionDue({ stats, ownerRows: 3, lastAttemptAt: null, now: 10_000 }, settings)).toBe(true);
    expect(compactionDue({ stats: { ...stats, estimated_tokens: 70 }, ownerRows: 3, lastAttemptAt: null, now: 10_000 }, settings)).toBe(false);
    expect(compactionDue({ stats: { ...stats, estimated_tokens: 1, dropped: 1 }, ownerRows: 3, lastAttemptAt: null, now: 10_000 }, settings)).toBe(true);
    expect(compactionDue({ stats, ownerRows: 2, lastAttemptAt: null, now: 10_000 }, settings)).toBe(false);
    expect(compactionDue({ stats, ownerRows: 3, lastAttemptAt: 9_001, now: 10_000 }, settings)).toBe(false);
    expect(compactionDue({ stats, ownerRows: 3, lastAttemptAt: 9_000, now: 10_000 }, settings)).toBe(true);
    const tree = chain(4);
    expect(ownerRowsSince(tree, leafOf(4), null)).toBe(4);
    expect(ownerRowsSince(tree, leafOf(4), 20)).toBe(2);
  });

  it('a superseded summary keeps its id and covers and none of its text, and stops being live', () => {
    Object.assign(COMPACTION, { enabled: true, budgetTokens: 120 });
    const tree = chain(6);
    const live = compactionRow(compactionPlan(tree, leafOf(6), null)!, 'the summary', 'owner', 99);
    tree.append(live);
    tree.replace(supersededCompaction(live));
    expect(tree.get(live.id)).toMatchObject({ modelPayload: COMPACTION_SUPERSEDED_MARKER, modelProjection: { mode: 'omit' }, covers: live.covers });
    expect(liveCompaction(tree, leafOf(6))).toBeNull();
    expect(compactedHistory(tree, leafOf(6)).stats.compacted).toBe(0);
  });

  it('the numeric health floor rejects numbers and lets qualitative lines through, on repeated calls', () => {
    expect(numericHealthIn('The owner said they slept 5 hours and felt rough.')).toBe(true);
    expect(numericHealthIn('The owner said they slept 5 hours and felt rough.')).toBe(true);
    expect(numericHealthIn('HRV 48 ms this morning')).toBe(true);
    expect(numericHealthIn('HRV 48 ms this morning')).toBe(true);
    expect(numericHealthIn('recovery score 71')).toBe(true);
    expect(numericHealthIn('The owner has been sleeping badly this week and wants quieter mornings.')).toBe(false);
    expect(numericHealthIn('circadian rhythm is off')).toBe(false);
    // the floor also rejects an ordinary numbered list, which is why the instruction asks for plain bullets
    expect(numericHealthIn('Next steps: 1. Book the flights')).toBe(true);
  });
});
