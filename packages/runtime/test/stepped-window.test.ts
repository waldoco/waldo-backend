import { afterEach, describe, expect, it } from 'vitest';
import { ConversationTree, type ConversationEntry } from '@waldo/contracts';
import { COMPACTION, compactedHistory, compactionPlan, compactionRow, compactionSettings, type CompactionSettings } from '../src/conversation/compaction';
import { windowModelMessages } from '../src/conversation/window';

const defaults = { ...COMPACTION };
afterEach(() => { Object.assign(COMPACTION, defaults); });

const row = (id: string, parentId: string | null, role: 'user' | 'assistant', text: string): ConversationEntry => ({
  id, ownerId: 'owner', chatId: 'owner', parentId, threadAnchorId: null, surface: 'whatsapp', modelPayload: text, appPayload: text,
  modelProjection: { mode: 'include' }, role, ...(role === 'user' ? { inputOrigin: 'owner' as const } : {}),
});
// Rounds of owner message and reply, about 110 tokens a row; ids u1, a1, u2, a2, ...
const grow = (tree: ConversationTree, from: number, to: number) => {
  for (let round = from; round <= to; round += 1) {
    tree.append(row(`u${round}`, round === 1 ? null : `a${round - 1}`, 'user', `question ${round} ${'q'.repeat(400)}`));
    tree.append(row(`a${round}`, `u${round}`, 'assistant', `answer ${round} ${'a'.repeat(400)}`));
  }
  return tree;
};
const stepped: CompactionSettings = { ...COMPACTION, budgetTokens: 1_000, steppedWindow: true };
// A cut keeps the newest row (about 110 tokens here) and the rows before it within half the budget.
const afterCut = stepped.budgetTokens / 2 + 120;
// A turn's view of the chain, reading the start the last turn kept.
const turn = (tree: ConversationTree, leaf: string, from?: string, settings = stepped) => compactedHistory(tree, leaf, undefined, settings, from);

describe('the stepped window', () => {
  it('is off unless WALDO_STEPPED_WINDOW is exactly "1"', () => {
    expect(compactionSettings({}).steppedWindow).toBe(false);
    expect(compactionSettings({ WALDO_STEPPED_WINDOW: 'on' }).steppedWindow).toBe(false);
    expect(compactionSettings({ WALDO_STEPPED_WINDOW: '1' }).steppedWindow).toBe(true);
  });

  it('a cut keeps the share of the budget the stepped target sets', () => {
    const tree = grow(new ConversationTree(), 1, 6);
    const half = turn(tree, 'a6'), most = turn(tree, 'a6', undefined, { ...stepped, steppedTarget: 0.8 });
    expect(half.stats.estimated_tokens).toBeLessThanOrEqual(afterCut);
    expect(most.stats.estimated_tokens).toBeGreaterThan(afterCut);
    expect(most.stats.estimated_tokens).toBeLessThanOrEqual(stepped.budgetTokens * 0.8 + 120);
  });

  it('keeps the whole chain while it fits, and names no start', () => {
    const view = turn(grow(new ConversationTree(), 1, 3), 'a3');
    expect(view.messages).toHaveLength(6);
    expect(view.stats).toMatchObject({ dropped: 0 });
    expect(view.stats.from).toBeUndefined();
  });

  it('past the budget cuts once to half of it beside the newest row, then holds that start while new rounds fit', () => {
    const tree = grow(new ConversationTree(), 1, 6);
    const first = turn(tree, 'a6');
    expect(first.stats.estimated_tokens).toBeLessThanOrEqual(afterCut);
    expect(tree.get(first.stats.from!)).toBeDefined();
    const start = first.stats.from!;
    let previous = first.messages;
    for (let round = 7; ; round += 1) {
      grow(tree, round, round);
      const next = turn(tree, `a${round}`, start);
      if (next.stats.from !== start) break;
      // Every turn between cuts starts with exactly what the turn before it sent.
      expect(next.messages.slice(0, previous.length)).toEqual(previous);
      expect(next.stats.estimated_tokens).toBeLessThanOrEqual(stepped.budgetTokens);
      previous = next.messages;
    }
    expect(previous.length).toBeGreaterThan(first.messages.length);
  });

  it('the cut that follows lands at half the budget again beside the newest row and holds again', () => {
    const tree = grow(new ConversationTree(), 1, 6);
    let start = turn(tree, 'a6').stats.from!;
    const cuts: string[] = [];
    for (let round = 7; round <= 30; round += 1) {
      grow(tree, round, round);
      const view = turn(tree, `a${round}`, start);
      expect(view.stats.estimated_tokens).toBeLessThanOrEqual(stepped.budgetTokens);
      if (view.stats.from !== start) { cuts.push(view.stats.from!); expect(view.stats.estimated_tokens).toBeLessThanOrEqual(afterCut); }
      start = view.stats.from!;
    }
    // 24 rounds of about 220 tokens each cross a 500-token step about ten times, not 24.
    expect(cuts.length).toBeGreaterThan(0);
    expect(cuts.length).toBeLessThan(24 / 2);
  });

  it('a start that is not on the chain, or no longer fits, is cut afresh', () => {
    const tree = grow(new ConversationTree(), 1, 12);
    expect(turn(tree, 'a12', 'gone').stats.from).toBe(turn(tree, 'a12').stats.from);
    const tooOld = turn(tree, 'a12', 'u2');
    expect(tooOld.stats.from).not.toBe('u2');
    expect(tooOld.stats.estimated_tokens).toBeLessThanOrEqual(afterCut);
  });

  it('a newest message over half the budget still keeps the older rows that fit beside it', () => {
    const tree = grow(new ConversationTree(), 1, 6);
    tree.append(row('u7', 'a6', 'user', 'x'.repeat(2_400)));
    const view = turn(tree, 'u7');
    expect(view.messages.length).toBeGreaterThan(1);
    expect(view.stats.estimated_tokens).toBeLessThanOrEqual(stepped.budgetTokens);
    expect(view.messages.at(-1)!.content).toHaveLength(2_400);
  });

  it('names the row its view starts with: the summary when one leads, otherwise the first row kept', () => {
    const tree = grow(new ConversationTree(), 1, 6);
    expect(turn(tree, 'a6').stats.head).toBe(turn(tree, 'a6').stats.from);
    expect(turn(grow(new ConversationTree(), 1, 2), 'a2').stats.head).toBe('u1');
    const settings = { ...stepped, enabled: true };
    const summary = compactionRow(compactionPlan(tree, 'a6', null, settings)!, 'Owner instructions:\n- keep calls short', 'owner', 99);
    tree.append(summary);
    grow(tree, 7, 7);
    expect(turn(tree, 'a7', undefined, settings).stats.head).toBe(summary.id);
  });

  it('always keeps the newest message, even when it alone is over the budget', () => {
    const tree = grow(new ConversationTree(), 1, 3);
    tree.append(row('u4', 'a3', 'user', 'x'.repeat(8_000)));
    const view = turn(tree, 'u4');
    expect(view.messages).toHaveLength(1);
    expect(view.stats.from).toBe('u4');
  });

  it('with a live summary the summary leads and only the rows after it step', () => {
    const settings = { ...stepped, enabled: true };
    const tree = grow(new ConversationTree(), 1, 6);
    tree.append(compactionRow(compactionPlan(tree, 'a6', null, settings)!, 'Owner instructions:\n- keep calls short', 'owner', 99));
    grow(tree, 7, 14);
    const view = turn(tree, 'a14', undefined, settings);
    expect(view.messages[0]!.content).toContain('keep calls short');
    const start = view.stats.from!;
    grow(tree, 15, 15);
    const next = turn(tree, 'a15', start, settings);
    expect(next.stats.from).toBe(start);
    expect(next.messages.slice(0, view.messages.length)).toEqual(view.messages);
  });

  it('with the switch off the view is the plain window, whatever start it is given', () => {
    const tree = grow(new ConversationTree(), 1, 12);
    const off = { ...stepped, steppedWindow: false };
    const plain = windowModelMessages(tree.modelContext('a12'), off.budgetTokens);
    expect(turn(tree, 'a12', 'u6', off)).toEqual({ messages: plain.messages, stats: { ...plain.stats, compacted: 0 } });
  });
});
