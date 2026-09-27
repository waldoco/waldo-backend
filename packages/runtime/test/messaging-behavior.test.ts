import { describe, expect, it } from 'vitest';
import { MESSAGING_BEHAVIOR, messagingSystemPrompt, ownerClockLine, WALDO_VOCABULARY } from '../src/prompt/messaging-behavior';

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

  it('pins the record-first rule and the proactive never-list (archive adopt #4, owner-approved prompt-only)', () => {
    expect(MESSAGING_BEHAVIOR).toContain('record it through the memory path BEFORE composing your reply');
    expect(MESSAGING_BEHAVIOR).toContain('Never send generic check-ins');
    expect(MESSAGING_BEHAVIOR).toContain('congratulations on normal metrics');
    expect(MESSAGING_BEHAVIOR).toContain('new information or a decision');
    expect(MESSAGING_BEHAVIOR).toContain('not the contents of their Gmail, Calendar or Drive');
    expect(MESSAGING_BEHAVIOR).toContain('read live with its tool when they ask, never recalled from memory');
    expect(MESSAGING_BEHAVIOR).toContain('reading and triage are read-only until the owner decides');
    expect(MESSAGING_BEHAVIOR).toContain('Nothing sends on its own');
  });
});

describe('ownerClockLine', () => {
  it('renders the owner local time and zone from the clock', () => {
    const line = ownerClockLine({ timezone: 'Asia/Calcutta', now: () => new Date('2026-09-27T11:42:00Z') });
    expect(line).toContain('Sunday, 27 September 2026');
    expect(line).toContain('17:12');
    expect(line).toContain('(Asia/Calcutta)');
  });

  it('falls back to UTC instead of throwing on a malformed stored timezone', () => {
    const line = ownerClockLine({ timezone: 'Not/AZone', now: () => new Date('2026-09-27T11:42:00Z') });
    expect(line).toContain('(UTC)');
  });
});
