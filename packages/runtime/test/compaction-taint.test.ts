import { describe, expect, it } from 'vitest';
import { COMPACTION_OUTSIDE_NOTE, ConversationTree, compactionMessage, compactionSummaryOpen, type ConversationEntry } from '@waldo/contracts';
import { COMPACTION, compactionPlan, compactionRow } from '../src/conversation/compaction';

// A summary carries what its span carried: when any row it read was not the owner's own words or Waldo's reply to them
// alone, the summary is stored marked as outside text and the model reads it labelled so.
const settings = { ...COMPACTION, budgetTokens: 400 };
const owner = (id: string, parentId: string | null, text: string, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  id, ownerId: 'owner', chatId: 'owner', parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role: 'user', inputOrigin: 'owner', ownerWordsOnly: true, ...extra,
});
const reply = (id: string, parentId: string, text: string, extra: Partial<ConversationEntry> = {}): ConversationEntry => ({
  id, ownerId: 'owner', chatId: 'owner', parentId, threadAnchorId: null, surface: 'app', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role: 'assistant', ...extra,
});
const chain = (first: Readonly<{ ask?: Partial<ConversationEntry>; answer?: Partial<ConversationEntry> }> = {}) => {
  const tree = new ConversationTree();
  let parent: string | null = null;
  for (let round = 1; round <= 8; round += 1) {
    tree.append(owner(`u${round}`, parent, `question ${round} ${'q'.repeat(120)}`, round === 1 ? first.ask : {}));
    tree.append(reply(`a${round}`, `u${round}`, `answer ${round} ${'a'.repeat(120)}`, round === 1 ? first.answer : {}));
    parent = `a${round}`;
  }
  return tree;
};
// The input budget reads every row of the span, so what the summary carries is everything older than its tail.
const summarise = (tree: ConversationTree, leaf = 'a8') => compactionRow(compactionPlan(tree, leaf, null, settings, 10_000)!, 'Owner instructions:\n- keep calls short', 'owner', 99);

describe('a summary of outside text', () => {
  it('of the owner\'s own words and Waldo\'s replies to them is not marked, and reads as before', () => {
    const row = summarise(chain());
    expect(row.readOutside).toBeUndefined();
    expect(compactionMessage(row).content).toBe(`${compactionSummaryOpen(row.covers!.rows)}\nOwner instructions:\n- keep calls short\n[End of summary.]`);
  });

  it.each([
    ['a reply that read outside content', { answer: { readOutside: true as const } }],
    ['a forwarded or quoted owner input', { ask: { ownerWordsOnly: undefined } }],
    ['a machine input', { ask: { inputOrigin: 'machine' as const, ownerWordsOnly: undefined } }],
    ['an input stored before inputs were stamped', { ask: { inputOrigin: undefined, ownerWordsOnly: undefined } }],
  ])('over %s is marked, and the model reads it labelled as outside text', (_case, first) => {
    const row = summarise(chain(first));
    expect(row.readOutside).toBe(true);
    const content = compactionMessage(row).content;
    expect(content.startsWith(`${compactionSummaryOpen(row.covers!.rows)}\n${COMPACTION_OUTSIDE_NOTE}\n`)).toBe(true);
  });

  it('a later summary that carries a marked one forward stays marked', () => {
    const tree = chain({ answer: { readOutside: true } });
    const first = summarise(tree);
    tree.append(first);
    let parent = 'a8';
    for (let round = 9; round <= 16; round += 1) {
      tree.append(owner(`u${round}`, parent, `question ${round} ${'q'.repeat(120)}`));
      tree.append(reply(`a${round}`, `u${round}`, `answer ${round} ${'a'.repeat(120)}`));
      parent = `a${round}`;
    }
    const plan = compactionPlan(tree, 'a16', first, settings, 10_000)!;
    expect(plan.sources[0]!.id).toBe(first.id);
    expect(compactionRow(plan, 'carried', 'owner', 199).readOutside).toBe(true);
  });
});
