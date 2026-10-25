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
  // A refused attempt the turn then made good (the same tool, the same target, accepted later) is not a failure of the turn:
  // it is superseded. Anything less than that keeps the failure on the line.
  describe('a failed attempt the same turn later made good', () => {
    const forget = (topic: string, scope_note = 'the owner asked') => ({ topic, scope_note });
    it('is left off when the same tool later accepts the same target, even with a reworded scope note', () => {
      const events = [ev(1, 'forget_memory', false, { code: 'invalid_args' }, forget('Asha')), ev(2, 'forget_memory', true, {}, forget('Asha', 'forget Asha'))];
      expect(receiptLine(events)).toBe('Done: memory forgotten');
    });
    it('still shows when the later success was for a different target', () => {
      const events = [ev(1, 'forget_memory', false, { code: 'invalid_args' }, forget('Asha')), ev(2, 'forget_memory', true, {}, forget('Ravi'))];
      expect(receiptLine(events)).toBe('Receipts: memory forgotten (failed); memory forgotten (accepted)');
    });
    it('still shows when it came after the success', () => {
      const events = [ev(1, 'forget_memory', true, {}, forget('Asha')), ev(2, 'forget_memory', false, { code: 'invalid_args' }, forget('Asha'))];
      expect(receiptLine(events)).toBe('Receipts: memory forgotten (accepted); memory forgotten (failed)');
    });
    // A handler that threw may have crossed its effect, and an unconfirmed receipt may have landed: a retry can be a second
    // copy, so neither is hidden behind the retry.
    it('still shows when it may have done something: a transient failure or an unconfirmed receipt', () => {
      const write = { path: 'a.md' };
      expect(receiptLine([ev(1, 'workspace_write', false, { code: 'transient' }, write), ev(2, 'workspace_write', true, {}, write)]))
        .toBe('Receipts: workspace file written a.md (failed); workspace file written a.md (accepted)');
      expect(receiptLine([ev(1, 'workspace_write', false, { receiptStatus: 'unavailable' }, write), ev(2, 'workspace_write', true, {}, write)]))
        .toBe('Receipts: workspace file written a.md (unconfirmed); workspace file written a.md (accepted)');
    });
    // A forget twice forgets once. Any other effect can land before a later step refuses (an oversize result, a post-call
    // halt), so its retry may be a second copy: only a tool whose repeat is harmless may make a refusal good.
    it('still shows for an effect whose repeat is a second copy, whatever the refusal code', () => {
      const reminder = { text: 'call Ravi', at: '2026-10-27T09:00:00Z' };
      expect(receiptLine([ev(1, 'set_reminder', false, { code: 'oversize' }, reminder), ev(2, 'set_reminder', true, {}, reminder)]))
        .toBe('Receipts: reminder set (failed); reminder set (accepted)');
    });
    it('is left off the typed items too, which the line names', async () => {
      const receipt = await turnReceipt([ev(1, 'forget_memory', false, { code: 'invalid_args' }, forget('Asha')), ev(2, 'forget_memory', true, {}, forget('Asha'))]);
      expect(receipt?.items.map(item => item.outcome)).toEqual(['accepted']);
    });
  });
  // A proposal changes nothing until the owner says yes, so it never reads as done.
  it('says a proposal waits on the owner, never that it is done', () => {
    expect(receiptLine([ev(1, 'send_email', true)])).toBe('Needs your yes: email send');
    expect(receiptLine([ev(1, 'propose_calendar_change', true), ev(2, 'propose_google_task_change', true)])).toBe('Needs your yes: calendar change; google task change');
  });
  it('says what was done and what waits on the owner, in one line', () => {
    expect(receiptLine([ev(1, 'propose_calendar_change', true), ev(2, 'workspace_write', true, {}, { path: 'notes.md' })]))
      .toBe('Done: workspace file written notes.md. Needs your yes: calendar change');
  });
  it('keeps a proposal labelled as one once any entry is not accepted', () => {
    expect(receiptLine([ev(1, 'propose_calendar_change', false, { code: 'rejected' })])).toBe('Receipts: calendar change proposed (failed)');
  });
  it('is bounded: at most 5 lines named, the rest counted', () => {
    const many = Array.from({ length: 8 }, (_, i) => ev(i + 1, 'set_reminder', true));
    const line = receiptLine(many)!;
    expect(line.startsWith('Done: ')).toBe(true);
    expect(line.split('; ')).toHaveLength(6);
    expect(line.endsWith('and 3 more')).toBe(true);
  });
  it('counts what it leaves unnamed after both parts', () => {
    const many = [ev(1, 'set_reminder', true), ...Array.from({ length: 6 }, (_, i) => ev(i + 2, 'send_email', true))];
    expect(receiptLine(many)).toBe('Done: reminder set. Needs your yes: email send; email send; email send; email send; and 2 more');
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
