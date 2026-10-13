import { describe, expect, it } from 'vitest';
import { receiptLine, turnReceipt } from '../src/hooks/receipt-line';
import { sha256Hex, stableJson } from '../src/context-composer/canonical';
import type { LoopEventLike } from '../src/hooks/claim-hook';

// Receipt-first design (option B): the system states what the tools actually did, from typed receipts.
// No reply wording is read and the model produces no claim field.
const ev = (seq: number, name: string, ok: boolean, extra: Partial<LoopEventLike> = {}, args: unknown = {}): LoopEventLike => ({ seq, call: { name, args }, ok, ...extra });

describe('receiptLine', () => {
  it('is null when the turn made no effect call (reads and lookups say nothing)', () => {
    expect(receiptLine([ev(1, 'workspace_read', true), ev(2, 'web_search', true)])).toBeNull();
    expect(receiptLine([])).toBeNull();
    expect(receiptLine([ev(1, 'skills_load', true), ev(2, 'browse_act', false)])).toBeNull();
    expect(receiptLine([ev(1, 'browse_act', false), ev(2, 'workspace_write', true, {}, { path: 'a.md' })])).toBe('Done: workspace file written a.md');
  });
  it('states an all-accepted turn in plain words with its ref', () => {
    expect(receiptLine([ev(1, 'workspace_write', true, {}, { path: 'notes.md' })])).toBe('Done: workspace file written notes.md');
  });
  it('states a failed effect as failed and an unavailable receipt as unconfirmed', () => {
    expect(receiptLine([ev(1, 'set_reminder', false, { code: 'rejected' }), ev(2, 'workspace_write', false, { receiptStatus: 'unavailable' }, { path: 'a.md' })]))
      .toBe('Receipts: reminder set (failed); workspace file written a.md (unconfirmed)');
  });
  it('keeps the explicit state words on every entry once any entry is not accepted', () => {
    expect(receiptLine([ev(1, 'set_reminder', false, { code: 'rejected' }), ev(2, 'workspace_write', true, {}, { path: 'a.md' })]))
      .toBe('Receipts: reminder set (failed); workspace file written a.md (accepted)');
  });
  it('keeps proposals labelled as proposals', () => {
    expect(receiptLine([ev(1, 'send_email', true)])).toBe('Done: email send proposed');
  });
  it('is bounded: at most 5 lines named, the rest counted', () => {
    const many = Array.from({ length: 8 }, (_, i) => ev(i + 1, 'set_reminder', true));
    const line = receiptLine(many)!;
    expect(line.startsWith('Done: ')).toBe(true);
    expect(line.split('; ')).toHaveLength(6);
    expect(line.endsWith('and 3 more')).toBe(true);
  });
});

describe('turnReceipt', () => {
  it('is the line plus each shown receipt typed: kind, target, outcome, task, time and the digest of its arguments', async () => {
    const args = { path: 'notes.md', content: 'x' };
    const receipt = await turnReceipt([ev(1, 'skills_load', true, { at: 1 }), ev(2, 'workspace_write', true, { at: 1_790_000_000_000 }, args),
      ev(3, 'set_reminder', false, { at: 1_790_000_000_500, delegated: true }), { seq: 4, call: { name: 'set_proactivity' }, ok: false, at: 1_790_000_001_000, receiptStatus: 'unavailable' }]);
    expect(receipt).toEqual({ line: receiptLine([ev(2, 'workspace_write', true, {}, args), ev(3, 'set_reminder', false, { delegated: true }), { seq: 4, call: { name: 'set_proactivity' }, ok: false, receiptStatus: 'unavailable' }]), more: 0, items: [
      { kind: 'workspace_file_written', target: 'notes.md', outcome: 'accepted', via_task: false, at: 1_790_000_000_000, digest: `sha256:${await sha256Hex(stableJson(args))}` },
      { kind: 'reminder_set', target: null, outcome: 'failed', via_task: true, at: 1_790_000_000_500, digest: `sha256:${await sha256Hex(stableJson({}))}` },
      { kind: 'proactivity_set', target: null, outcome: 'unconfirmed', via_task: false, at: 1_790_000_001_000, digest: null },
    ] });
  });
  it('is null without an effect, keeps twenty items and counts the rest, and leaves out a target too long to show', async () => {
    expect(await turnReceipt([ev(1, 'web_search', true)])).toBeNull();
    const many = await turnReceipt(Array.from({ length: 23 }, (_, i) => ev(i + 1, 'set_reminder', true, { at: 1_790_000_000_000 })));
    expect([many!.items.length, many!.more]).toEqual([20, 3]);
    const long = await turnReceipt([ev(1, 'workspace_write', true, { at: 1_790_000_000_000 }, { path: `${'a'.repeat(201)}.md` })]);
    expect(long!.items[0]!.target).toBeNull();
    expect(long!.line).toContain('a'.repeat(201));
  });
});
