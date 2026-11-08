import { describe, expect, it } from 'vitest';
import { forgetMemoryArgsSchema } from './memory';
import { importMemoriesArgsSchema, readImportArgsSchema } from './imports';
import { ALWAYS_ON_TOOLS, TOOL_PERMISSIONS } from '../permissions';
import { EXTERNAL_ORIGIN_TOOLS, PRIVILEGED_ACTION_TOOLS } from '../handler';

const file = { source: 'chatgpt', file_id: 'f1', revision: 1 };
const claim = { kind: 'goal', text: 'Running the Pune half marathon in December', evidence_quote: 'training for the Pune half', conversation_id: 'conv-1' };

describe('import from other agents: tool arguments', () => {
  it('reads an export as the conversation index or as the owner\'s messages in named conversations', () => {
    expect(readImportArgsSchema.safeParse(file).success).toBe(true);
    expect(readImportArgsSchema.safeParse({ ...file, source: 'claude', conversation_ids: ['a', 'b'], cursor: 40 }).success).toBe(true);
    for (const bad of [
      { ...file, source: 'gemini' }, { ...file, source: 'owner' }, { ...file, revision: 0 }, { ...file, file_id: '' },
      { ...file, conversation_ids: [] }, { ...file, conversation_ids: Array.from({ length: 11 }, (_, i) => `c${i}`) }, { ...file, cursor: -1 }, { ...file, path: 'x' },
    ]) expect(readImportArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('imports a bounded batch of claims, each with a quote and the conversation it came from, and no authority-bearing field', () => {
    expect(importMemoriesArgsSchema.safeParse({ ...file, claims: [claim] }).success).toBe(true);
    expect(importMemoriesArgsSchema.safeParse({ ...file, claims: [{ ...claim, kind: 'followup', area: 'work' }] }).success).toBe(true);
    expect(importMemoriesArgsSchema.safeParse({ ...file, claims: [{ ...claim, kind: 'health', text: 'Has asthma', area: 'body' }] }).success).toBe(true);
    for (const bad of [
      { ...file, claims: [] }, { ...file, claims: Array.from({ length: 21 }, () => claim) },
      { ...file, claims: [{ ...claim, kind: 'permission' }] }, { ...file, claims: [{ ...claim, kind: 'pattern' }] },
      { ...file, claims: [{ ...claim, evidence_quote: 'my half' }] }, { ...file, claims: [{ ...claim, text: ' ' }] }, { ...file, claims: [{ ...claim, conversation_id: '' }] },
      { ...file, claims: [{ ...claim, origin: 'owner' }] }, { ...file, claims: [{ ...claim, source: 'stated' }] }, { ...file, claims: [claim], source_ref: 'owner, m1' },
      (({ claims: _c, ...rest }) => rest)({ ...file, claims: [claim] }),
    ]) expect(importMemoriesArgsSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
  });

  it('forgets one import source as a forget selector of its own', () => {
    expect(forgetMemoryArgsSchema.safeParse({ import_source: 'claude', scope_note: 'everything from my Claude export' }).success).toBe(true);
    expect(forgetMemoryArgsSchema.safeParse({ import_source: 'gemini', scope_note: 'n' }).success).toBe(false);
  });

  it('is offered to the owner\'s own chat turn only, loaded on demand, and never as an outbound or privileged action', () => {
    for (const tool of ['read_import', 'import_memories'] as const) {
      expect(TOOL_PERMISSIONS.user_message).toContain(tool);
      for (const [trigger, tools] of Object.entries(TOOL_PERMISSIONS)) if (trigger !== 'user_message') expect(tools, trigger).not.toContain(tool);
      expect(ALWAYS_ON_TOOLS).not.toContain(tool);
      expect(PRIVILEGED_ACTION_TOOLS).not.toContain(tool);
    }
    expect(EXTERNAL_ORIGIN_TOOLS).toContain('read_import');
    expect(EXTERNAL_ORIGIN_TOOLS).not.toContain('import_memories');
  });
});
