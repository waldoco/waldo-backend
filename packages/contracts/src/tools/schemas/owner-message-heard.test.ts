import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS, toolNameSchema } from '../permissions';
import { ownerMessageHeardArgsSchema, ownerMessageHeardResultSchema } from './owner-message-heard';

// ADR-0029 valid + invalid pair per schema.
describe('owner_message_heard arguments', () => {
  it('accepts each choice for a message id', () => {
    for (const choice of ['fold', 'queue', 'stop_current']) expect(ownerMessageHeardArgsSchema.safeParse({ message_id: 'app-8000000000002', choice }).success, choice).toBe(true);
  });

  it('rejects a missing id or choice, an unknown choice and any extra field', () => {
    const rejected = [{}, { message_id: 'app-1' }, { choice: 'fold' }, { message_id: '', choice: 'fold' }, { message_id: 'app-1', choice: 'merge' },
      { message_id: 'app-1', choice: 'fold', reply: 'Done.' }, { message_id: 'x'.repeat(65), choice: 'queue' }, null];
    for (const value of rejected) expect(ownerMessageHeardArgsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('owner_message_heard result', () => {
  it('accepts a heard choice and each typed reason it was not heard', () => {
    for (const value of [{ heard: true, choice: 'fold' }, { heard: false, reason: 'not_waiting' }, { heard: false, reason: 'not_owner_turn' }]) {
      expect(ownerMessageHeardResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
    }
  });

  it('rejects an echoed message, a free-text reason and a heard result without its choice', () => {
    const rejected = [{ heard: true }, { heard: true, choice: 'fold', text: 'also Friday' }, { heard: false, reason: 'seemed separate' }, { heard: false }];
    for (const value of rejected) expect(ownerMessageHeardResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('owner_message_heard permission', () => {
  it('is a named tool granted on the owner message trigger only', () => {
    expect(toolNameSchema.options).toContain('owner_message_heard');
    expect(Object.entries(TOOL_PERMISSIONS).filter(([, tools]) => tools.includes('owner_message_heard')).map(([trigger]) => trigger)).toEqual(['user_message']);
  });
});
