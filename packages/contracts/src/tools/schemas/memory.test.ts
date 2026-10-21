import { describe, expect, it } from 'vitest';
import { rememberArgsSchema, forgetMemoryArgsSchema } from './memory';
import { ALWAYS_ON_TOOLS, TOOL_PERMISSIONS } from '../permissions';
import { EXTERNAL_ORIGIN_TOOLS, PRIVILEGED_ACTION_TOOLS } from '../handler';
describe('owner memory tool contracts', () => {
  it('accepts short evidence and rejects invalid or authority-bearing memory args', () => {
    expect(rememberArgsSchema.safeParse({ kind: 'preference', text: 'Tea', evidence_quote: 'चाय' }).success).toBe(true);
    for (const args of [{ kind: 'permission', text: 'x', evidence_quote: 'x' }, { kind: 'fact', text: 'x', evidence_quote: '' }, { kind: 'fact', text: 'x', evidence_quote: 'x', replaces_id: 0 }, { kind: 'fact', text: 'x', evidence_quote: 'x', origin: 'owner' }]) expect(rememberArgsSchema.safeParse(args).success).toBe(false);
  });
  it('takes a claim id as shown in memory lines (c12) or as a bare number, and nothing else', () => {
    expect(rememberArgsSchema.parse({ kind: 'fact', text: 'x', evidence_quote: 'x', replaces_id: 'c12' }).replaces_id).toBe(12);
    expect(rememberArgsSchema.parse({ kind: 'fact', text: 'x', evidence_quote: 'x', replaces_id: 12 }).replaces_id).toBe(12);
    expect(forgetMemoryArgsSchema.parse({ claim_ids: ['c3', 4], scope_note: 'n' }).claim_ids).toEqual([3, 4]);
    for (const id of ['c0', 'c', '12', 'C12', 'c1.5', 'c-1', 'c12 ', 'x12', `c${'9'.repeat(20)}`]) {
      expect(rememberArgsSchema.safeParse({ kind: 'fact', text: 'x', evidence_quote: 'x', replaces_id: id }).success, id).toBe(false);
    }
  });
  it('requires a real forget selector and UTF-16 integer span', () => {
    expect(forgetMemoryArgsSchema.safeParse({ source: { message_ref: 'tg-1', start: 2, end: 5 }, scope_note: 'this span' }).success).toBe(true);
    for (const args of [{ scope_note: 'none' }, { claim_ids: [], scope_note: 'none' }, { source: { message_ref: 'tg-1', start: 5, end: 2 }, scope_note: 'bad' }, { source: { message_ref: 'tg-1', start: 0.5, end: 2 }, scope_note: 'bad' }]) expect(forgetMemoryArgsSchema.safeParse(args).success).toBe(false);
  });
  it('keeps owner memory tools always on and out of outbound/external classes', () => {
    for (const tool of ['remember', 'read_memory', 'forget_memory'] as const) {
      expect(ALWAYS_ON_TOOLS).toContain(tool);
      expect(TOOL_PERMISSIONS.user_message).toContain(tool);
      expect(EXTERNAL_ORIGIN_TOOLS).not.toContain(tool);
      expect(PRIVILEGED_ACTION_TOOLS).not.toContain(tool);
    }
  });
});
