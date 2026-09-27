import { describe, expect, it } from 'vitest';
import { CONVERSATION_INPUT_BUDGET_TOKENS, estimateMessageTokens, windowModelMessages } from '../src/conversation/window';

const msg = (chars: number, role: 'user' | 'assistant' = 'user') => ({ role, content: 'x'.repeat(chars) });

describe('conversation input window (F1)', () => {
  it('estimates tokens from UTF-8 bytes with framing overhead', () => {
    expect(estimateMessageTokens({ role: 'user', content: '' })).toBe(8);
    expect(estimateMessageTokens(msg(400))).toBe(108);
    expect(estimateMessageTokens(msg(100))).toBeLessThan(estimateMessageTokens(msg(400)));
  });

  it('keeps the whole history when it fits the budget', () => {
    const messages = [msg(100), msg(200, 'assistant'), msg(300)];
    const { messages: kept, stats } = windowModelMessages(messages, 10_000);
    expect(kept).toEqual(messages);
    expect(stats).toEqual({ kept: 3, dropped: 0, estimated_tokens: 8 + 25 + 8 + 50 + 8 + 75, budget_tokens: 10_000 });
  });

  it('drops oldest entries first when over budget and reports the drop', () => {
    const messages = [msg(4000), msg(4000, 'assistant'), msg(400)];
    // 4000 chars ~= 1008 tokens each; budget 2100 fits the newest two only.
    const { messages: kept, stats } = windowModelMessages(messages, 2_100);
    expect(kept).toEqual(messages.slice(1));
    expect(stats.dropped).toBe(1);
    expect(stats.kept).toBe(2);
  });

  it('never drops the final message even when it alone exceeds the budget', () => {
    const messages = [msg(400), msg(80_000)];
    const { messages: kept, stats } = windowModelMessages(messages, 1_000);
    expect(kept).toEqual([messages[1]]);
    expect(stats.dropped).toBe(1);
  });

  it('handles empty and single-message histories', () => {
    expect(windowModelMessages([], 100).stats).toMatchObject({ kept: 0, dropped: 0 });
    expect(windowModelMessages([msg(40)], 100).messages).toHaveLength(1);
  });

  it('ships a deliberate default budget far under the chat model window', () => {
    // Policy constant, not a model spec: 100k of 400k verified window (gpt-5-nano) reserved
    // for history; headroom covers system prompt, tool turns and the 4096 output pin.
    expect(CONVERSATION_INPUT_BUDGET_TOKENS).toBe(100_000);
  });
});
