import { describe, expect, it } from 'vitest';
import { MESSAGING_BEHAVIOR, messagingSystemPrompt, WALDO_VOCABULARY } from '../src/prompt/messaging-behavior';

describe('messagingSystemPrompt', () => {
  it('is the chat persona with no scheduled-brief fixture text', () => {
    const prompt = messagingSystemPrompt([]);
    expect(prompt.startsWith(MESSAGING_BEHAVIOR)).toBe(true);
    expect(prompt).not.toMatch(/scheduled brief|Produce a concise brief/i);
    expect(prompt.endsWith('Tools available in this chat: none.')).toBe(true);
  });

  it('lists only the callable tools, sorted', () => {
    expect(messagingSystemPrompt(['get_context', 'calendar_read']).endsWith('Tools available in this chat: calendar_read, get_context.')).toBe(true);
  });

  it('keeps the vocabulary block and the health lines', () => {
    expect(MESSAGING_BEHAVIOR).toContain(WALDO_VOCABULARY);
    expect(MESSAGING_BEHAVIOR).toContain('Health is core');
    expect(MESSAGING_BEHAVIOR).toContain('You are not a clinician.');
    expect(MESSAGING_BEHAVIOR).toContain('Never give medication, supplement or dose instructions.');
    expect(MESSAGING_BEHAVIOR).toContain('point them to a physician');
  });
});
