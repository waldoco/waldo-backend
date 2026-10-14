import { describe, expect, it } from 'vitest';
import { rememberArgsSchema, forgetMemoryArgsSchema } from './memory';
import { ALWAYS_ON_TOOLS, TOOL_PERMISSIONS } from '../permissions';
import { EXTERNAL_ORIGIN_TOOLS, PRIVILEGED_ACTION_TOOLS } from '../handler';
describe('owner memory tool contracts', () => {
  it('accepts short evidence and rejects invalid or authority-bearing memory args', () => {
    expect(rememberArgsSchema.safeParse({ kind: 'preference', text: 'Tea', evidence_quote: 'चाय' }).success).toBe(true);
    for (const args of [{ kind: 'permission', text: 'x', evidence_quote: 'x' }, { kind: 'fact', text: 'x', evidence_quote: '' }, { kind: 'fact', text: 'x', evidence_quote: 'x', replaces_id: 0 }, { kind: 'fact', text: 'x', evidence_quote: 'x', origin: 'owner' }]) expect(rememberArgsSchema.safeParse(args).success).toBe(false);
  });
  it('requires a real forget selector and UTF-16 integer span', () => {
    expect(forgetMemoryArgsSchema.safeParse({ source: { message_ref: 'tg-1', start: 2, end: 5 }, scope_note: 'this span' }).success).toBe(true);
    for (const args of [{ scope_note: 'none' }, { claim_ids: [], scope_note: 'none' }, { source: { message_ref: 'tg-1', start: 5, end: 2 }, scope_note: 'bad' }, { source: { message_ref: 'tg-1', start: 0.5, end: 2 }, scope_note: 'bad' }]) expect(forgetMemoryArgsSchema.safeParse(args).success).toBe(false);
  });
  it('takes the owner\'s provider name or phone as a forget selector, and only those fields', () => {
    for (const args of [{ provider_fields: ['name'], scope_note: 'their name' }, { provider_fields: ['name', 'phone'], scope_note: 'name and number' }, { topic: 'Zoë', provider_fields: ['phone'], scope_note: 'both' }]) expect(forgetMemoryArgsSchema.safeParse(args).success).toBe(true);
    for (const args of [{ provider_fields: [], scope_note: 'none' }, { provider_fields: ['email'], scope_note: 'not a field' }, { provider_fields: 'name', scope_note: 'not a list' }, { provider_fields: ['name', 'phone', 'name'], scope_note: 'too many' }]) expect(forgetMemoryArgsSchema.safeParse(args).success).toBe(false);
  });
  it('keeps owner memory tools always on and out of outbound/external classes', () => {
    for (const tool of ['remember', 'read_memory', 'forget_memory'] as const) {
      expect(ALWAYS_ON_TOOLS).toContain(tool);
      expect(TOOL_PERMISSIONS.user_message).toContain(tool);
      expect(EXTERNAL_ORIGIN_TOOLS).not.toContain(tool);
      expect(PRIVILEGED_ACTION_TOOLS).not.toContain(tool);
    }
    expect(PRIVILEGED_ACTION_TOOLS).not.toContain('update_memory');
  });
});
