import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS, toolNameSchema } from '../permissions';
import { PROGRESS_NOTE_MAX_CHARS, sendProgressNoteArgsSchema, sendProgressNoteResultSchema } from './progress-note';

// ADR-0029 valid + invalid pair per schema. The note goes to the chat the owner's turn came from, so the arguments carry
// only the words; the result tells the model what happened and never echoes the note back.
describe('send_progress_note arguments', () => {
  it('accepts a note', () => {
    expect(sendProgressNoteArgsSchema.safeParse({ text: 'Two hotels so far; checking a third near the station.' }).success).toBe(true);
  });

  it('rejects an empty note, a missing note and any field naming a destination', () => {
    const rejected = [{}, { text: '' }, { text: 42 }, { text: 'ok', chat_id: 7 }, { text: 'ok', surface: 'telegram' }, null];
    for (const value of rejected) expect(sendProgressNoteArgsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('send_progress_note result', () => {
  it('accepts a send and every typed reason a note was not sent', () => {
    const accepted = [
      { sent: true, notes_left: 5 },
      { sent: false, reason: 'too_long', max_chars: PROGRESS_NOTE_MAX_CHARS },
      { sent: false, reason: 'too_soon', wait_seconds: 30 },
      { sent: false, reason: 'limit_reached', max_per_turn: 6 },
      { sent: false, reason: 'not_owner_turn' },
      { sent: false, reason: 'send_failed' },
    ];
    for (const value of accepted) expect(sendProgressNoteResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
  });

  it('rejects an echoed note, a free-text reason and a reason without its bound', () => {
    const rejected = [
      { sent: true, notes_left: 5, text: 'Two hotels so far.' },
      { sent: true },
      { sent: false, reason: 'it seemed like filler' },
      { sent: false, reason: 'too_long' },
      { sent: false, reason: 'too_soon' },
      { sent: false, reason: 'limit_reached' },
      { sent: false, reason: 'send_failed', text: 'Two hotels so far.' },
      { sent: false },
    ];
    for (const value of rejected) expect(sendProgressNoteResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('send_progress_note permission', () => {
  it('is a named tool granted on the owner message trigger only', () => {
    expect(toolNameSchema.options).toContain('send_progress_note');
    const granting = Object.entries(TOOL_PERMISSIONS).filter(([, tools]) => tools.includes('send_progress_note')).map(([trigger]) => trigger);
    expect(granting).toEqual(['user_message']);
  });
});
