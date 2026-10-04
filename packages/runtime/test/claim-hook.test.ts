import { describe, expect, it } from 'vitest';
import { toolNameSchema } from '@waldo/contracts';
import { TOOL_CLAIM_EFFECT } from '../src/hooks/claim-verify-effects';
import { evaluateTurnClaims, receiptsFromLoopEvents, type LoopEventLike } from '../src/hooks/claim-hook';

// Advisory claim hook contract: typed done-claims vs receipts built from the turn's tool events.
// Structured data only. No wording of the reply is read. Not wired into any turn.
const ev = (seq: number, name: string, ok: boolean, extra: Partial<LoopEventLike> = {}): LoopEventLike => ({ seq, call: { name, args: {} }, ok, ...extra });

describe('receipts from tool-loop events', () => {
  it('a successful effect tool becomes an accepted receipt with its typed effect', () => {
    expect(receiptsFromLoopEvents([ev(1, 'set_reminder', true)])).toEqual([{ seq: 1, tool: 'set_reminder', effect: 'reminder_set', ok: true, state: 'accepted' }]);
  });
  it('a failed effect tool becomes a failed receipt, and an unavailable receipt status becomes unresolved', () => {
    const [failed, unresolved] = receiptsFromLoopEvents([ev(1, 'set_reminder', false, { code: 'rejected' }), ev(2, 'workspace_write', false, { receiptStatus: 'unavailable' })]);
    expect(failed).toMatchObject({ state: 'failed', ok: false });
    expect(unresolved).toMatchObject({ state: 'unresolved', ok: false });
  });
  it('reads, lookups and null-effect tools never produce receipts', () => {
    const readOnly = toolNameSchema.options.filter(name => TOOL_CLAIM_EFFECT[name] === null);
    expect(readOnly.length).toBeGreaterThan(10);
    expect(receiptsFromLoopEvents(readOnly.map((name, i) => ev(i + 1, name, true)))).toEqual([]);
  });
  it('a tool name outside the registry produces no receipt instead of throwing', () => {
    expect(receiptsFromLoopEvents([ev(1, 'not_a_tool', true)])).toEqual([]);
  });
  it('workspace file receipts carry the written path as their ref', () => {
    const [receipt] = receiptsFromLoopEvents([{ seq: 1, call: { name: 'workspace_write', args: { path: 'Packing list.md' } }, ok: true }]);
    expect(receipt).toMatchObject({ effect: 'workspace_file_written', ref: 'Packing list.md' });
  });
});

describe('turn claim evaluation (advisory)', () => {
  it('a done claim backed by an accepted receipt earlier in the turn has no finding', () => {
    expect(evaluateTurnClaims([{ seq: 2, effect: 'reminder_set' }], [ev(1, 'set_reminder', true)])).toEqual([]);
  });
  it('a done claim with no tool call has a no_matching_receipt finding', () => {
    expect(evaluateTurnClaims([{ seq: 1, effect: 'workspace_file_written' }], [])).toEqual([{ claim_seq: 1, effect: 'workspace_file_written', reason: 'no_matching_receipt' }]);
  });
  it('a failed tool call cannot back a done claim', () => {
    expect(evaluateTurnClaims([{ seq: 2, effect: 'reminder_set' }], [ev(1, 'set_reminder', false)])).toEqual([{ claim_seq: 2, effect: 'reminder_set', reason: 'receipt_failed' }]);
  });
  it('a proposal receipt cannot back a claim that the thing was sent', () => {
    expect(evaluateTurnClaims([{ seq: 2, effect: 'email_sent' }], [ev(1, 'send_email', true)])).toEqual([{ claim_seq: 2, effect: 'email_sent', reason: 'no_matching_receipt' }]);
    expect(evaluateTurnClaims([{ seq: 2, effect: 'email_send_proposed' }], [ev(1, 'send_email', true)])).toEqual([]);
  });
  it('a claim naming a file is not backed by a write to a different file', () => {
    const write = (path: string): LoopEventLike => ({ seq: 1, call: { name: 'workspace_write', args: { path } }, ok: true });
    expect(evaluateTurnClaims([{ seq: 2, effect: 'workspace_file_written', ref: 'v2.md' }], [write('v2b.md')])).toEqual([{ claim_seq: 2, effect: 'workspace_file_written', reason: 'no_matching_receipt' }]);
    expect(evaluateTurnClaims([{ seq: 2, effect: 'workspace_file_written', ref: 'v2b.md' }], [write('v2b.md')])).toEqual([]);
  });
  it('is advisory: it never throws on malformed input and never mutates its inputs', () => {
    const events = Object.freeze([Object.freeze(ev(1, 'set_reminder', true))]);
    const claims = Object.freeze([Object.freeze({ seq: 2, effect: 'reminder_set' })]);
    expect(() => evaluateTurnClaims(claims, events)).not.toThrow();
    expect(() => evaluateTurnClaims([{ seq: Number.NaN, effect: '' }], [{ seq: 1, call: undefined as never, ok: true }])).not.toThrow();
  });
});

describe('evaluateTurnClaims does not swallow failures', () => {
  it('a malformed claims input throws instead of reporting no findings', () => {
    expect(() => evaluateTurnClaims(null as never, [])).toThrow();
  });
});
