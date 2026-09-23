import { describe, expect, it } from 'vitest';
import { MESSAGING_BEHAVIOR, messagingSystemPrompt } from '../src/prompt/messaging-behavior';

describe('messagingSystemPrompt', () => {
  it('appends the messaging behavior after the composed prompt without altering it', () => {
    const prompt = messagingSystemPrompt('BASE', []);
    expect(prompt.startsWith('BASE\n\n')).toBe(true);
    expect(prompt).toContain(MESSAGING_BEHAVIOR);
    expect(prompt.endsWith('Tools available in this chat: none.')).toBe(true);
  });

  it('lists only the granted tools in a stable order', () => {
    expect(messagingSystemPrompt('B', ['calendar.read', 'artifact.read']).endsWith('Tools available in this chat: artifact.read, calendar.read.')).toBe(true);
  });
});
