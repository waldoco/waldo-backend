import { describe, expect, it } from 'vitest';
import { iMessageCommandSchema } from '../../channels/imessage-v1';
import { TOOL_PERMISSIONS, toolNameSchema } from '../permissions';
import { reactToMessageArgsSchema, reactToMessageResultSchema } from './reactions';

// ADR-0029 valid + invalid pair per schema. The host picks the message a reaction goes on (the owner's message the turn
// answers), so the model names only the reaction: a standard tapback or one emoji, never a message, chat or longer text.
describe('react_to_message arguments', () => {
  it('accepts each standard tapback the iMessage contract sends', () => {
    for (const reaction of ['love', 'like', 'dislike', 'laugh', 'emphasis', 'question']) {
      expect(reactToMessageArgsSchema.safeParse({ reaction }).success, reaction).toBe(true);
      const command = { version: 1, commandId: 'c1', ownerId: 'o1', service: 'iMessage', allowSMSFallback: false, operation: 'react', action: 'add', reaction: { kind: 'standard', type: reaction },
        binding: { ownerId: 'o1', presenceId: 'p1', subject: 's1', bridgeId: 'b1', accountId: 'a1', chatGuid: 'c', verified: true, conversationKind: 'direct', service: 'iMessage' },
        target: { bridgeId: 'b1', accountId: 'a1', chatGuid: 'c', messageGuid: 'm1', partIndex: 0 } };
      expect(iMessageCommandSchema.safeParse(command).success, reaction).toBe(true);
    }
  });

  it('accepts one emoji: with its variation selector, a skin tone, a joined sequence, a flag or a keycap', () => {
    for (const reaction of ['🔥', '❤️', '‼️', '👍🏽', '👩‍💻', '❤️‍🔥', '🇮🇳', '1️⃣']) expect(reactToMessageArgsSchema.safeParse({ reaction }).success, reaction).toBe(true);
  });

  it('rejects text, two emoji, an unknown tapback, a custom emoji object and any field naming a target', () => {
    const rejected = [{}, { reaction: '' }, { reaction: 'heart' }, { reaction: '🔥🔥' }, { reaction: 'nice 👍' }, { reaction: '🇮' }, { reaction: { kind: 'custom', emoji: '🔥' } }, { reaction: 'love', messageGuid: 'm1' },
      { reaction: 'love', chatGuid: 'iMessage;-;someone' }, { reaction: 'love', action: 'remove' }, null];
    for (const value of rejected) expect(reactToMessageArgsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('react_to_message result', () => {
  it('accepts queued and each typed reason it was not', () => {
    for (const value of [{ queued: true }, { queued: false, reason: 'unavailable' }, { queued: false, reason: 'not_owner_turn' }, { queued: false, reason: 'already_reacted' }]) {
      expect(reactToMessageResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects a delivery claim, a free-text reason and an unqueued result without its reason', () => {
    for (const value of [{ queued: true, delivered: true }, { queued: false }, { queued: false, reason: 'host said no' }, { sent: true }]) {
      expect(reactToMessageResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
    }
  });
});

describe('react_to_message permission', () => {
  it('is a named tool granted on the owner message trigger only', () => {
    expect(toolNameSchema.options).toContain('react_to_message');
    expect(Object.entries(TOOL_PERMISSIONS).filter(([, tools]) => tools.includes('react_to_message')).map(([trigger]) => trigger)).toEqual(['user_message']);
  });
});
