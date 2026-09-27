import { describe, expect, it } from 'vitest';
import { PRIVILEGED_ACTION_TOOLS } from '@waldo/contracts';
import { telegramOwnerApproval } from '../src/channels/telegram-turn';

describe('telegramOwnerApproval', () => {
  it('passes first-party privileged tools (owner state only)', () => {
    for (const tool of ['update_memory', 'write_task', 'update_task', 'draft_document', 'propose_schedule', 'write_sheet_cell', 'update_thread_topics', 'archive_thread']) {
      expect(telegramOwnerApproval({ tool })).toBe(true);
    }
  });

  it('halts anything that can reach another person or an outside service', () => {
    for (const tool of ['send_message', 'execute_action', 'call_mcp_tool', 'delete_message', 'restore_message']) {
      expect(telegramOwnerApproval({ tool })).toBe(false);
    }
  });

  it('decides every privileged tool - no privileged name falls through undecided', () => {
    for (const tool of PRIVILEGED_ACTION_TOOLS) {
      expect(typeof telegramOwnerApproval({ tool })).toBe('boolean');
    }
  });
});
