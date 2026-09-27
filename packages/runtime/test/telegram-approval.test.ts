import { describe, expect, it } from 'vitest';
import { PRIVILEGED_ACTION_TOOLS } from '@waldo/contracts';
import { telegramOwnerApproval } from '../src/channels/telegram-turn';

describe('telegramOwnerApproval', () => {
  it('passes first-party privileged tools (owner state only)', () => {
    for (const tool of ['update_memory', 'write_task', 'update_task', 'draft_document', 'propose_schedule', 'write_sheet_cell', 'update_thread_topics', 'archive_thread']) {
      expect(telegramOwnerApproval({ tool })).toBe(true);
    }
  });

  it('halts anything that can reach another person or an outside service without a card flow', () => {
    for (const tool of ['execute_action', 'delete_message', 'restore_message']) {
      expect(telegramOwnerApproval({ tool })).toBe(false);
    }
  });

  it('passes card-flowed external-reach tools (their handlers propose, never execute)', () => {
    // send_message and call_mcp_tool self-gate through the approval desk: approval happens on
    // the card, so the PreToolUse gate lets them reach their proposing handlers.
    for (const tool of ['send_message', 'call_mcp_tool']) {
      expect(telegramOwnerApproval({ tool })).toBe(true);
    }
  });

  it('decides every privileged tool - no privileged name falls through undecided', () => {
    for (const tool of PRIVILEGED_ACTION_TOOLS) {
      expect(typeof telegramOwnerApproval({ tool })).toBe('boolean');
    }
  });
});
