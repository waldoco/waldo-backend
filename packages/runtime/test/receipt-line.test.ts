import { describe, expect, it } from 'vitest';
import { receiptLine } from '../src/hooks/receipt-line';
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
