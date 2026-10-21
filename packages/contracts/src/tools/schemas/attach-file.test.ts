import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS, toolNameSchema } from '../permissions';
import { ATTACH_FILE_MAX_PER_TURN, attachFileArgsSchema, attachFileResultSchema } from './attach-file';

// ADR-0029 valid + invalid pair per schema. The file goes with the reply to the chat the owner's turn came from, so the
// arguments name only the workspace file; the result says whether it was queued, never that it was sent.
describe('attach_file arguments', () => {
  it('accepts a workspace file and revision', () => {
    expect(attachFileArgsSchema.safeParse({ file_id: 'abcdefab-cdef-4abc-8abc-00000000000a', revision: 1 }).success).toBe(true);
  });

  it('rejects a missing or malformed file, a non-positive revision and any field naming a destination or bytes', () => {
    const rejected = [{}, { file_id: '' , revision: 1 }, { file_id: 'f', revision: 0 }, { file_id: 'f', revision: 1.5 }, { file_id: 'x'.repeat(101), revision: 1 },
      { file_id: 'f', revision: 1, chat_id: 7 }, { file_id: 'f', revision: 1, surface: 'whatsapp' }, { file_id: 'f', revision: 1, url: 'https://x.invalid/a.pdf' }, null];
    for (const value of rejected) expect(attachFileArgsSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

describe('attach_file result', () => {
  it('accepts a queued file and every typed reason a file was not queued', () => {
    const accepted = [
      { queued: true, filename: 'plan.pdf', attachments_left: ATTACH_FILE_MAX_PER_TURN - 1 },
      { queued: false, reason: 'not_owner_turn' },
      { queued: false, reason: 'not_found' },
      { queued: false, reason: 'revision_changed', current_revision: 3 },
      { queued: false, reason: 'limit_reached', max_per_turn: ATTACH_FILE_MAX_PER_TURN },
      { queued: false, reason: 'unavailable' },
    ];
    for (const value of accepted) expect(attachFileResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(true);
  });

  it('has no sent state and rejects untyped reasons', () => {
    const rejected = [{ sent: true }, { queued: true }, { queued: false, reason: 'sent' }, { queued: false, reason: 'revision_changed' }, { queued: true, filename: '', attachments_left: 1 }];
    for (const value of rejected) expect(attachFileResultSchema.safeParse(value).success, JSON.stringify(value)).toBe(false);
  });
});

it('is a tool name only owner messages may call', () => {
  expect(toolNameSchema.safeParse('attach_file').success).toBe(true);
  expect(Object.entries(TOOL_PERMISSIONS).filter(([, tools]) => tools.includes('attach_file')).map(([trigger]) => trigger)).toEqual(['user_message']);
});
