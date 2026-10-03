import { describe, expect, it } from 'vitest';
import { checkClaimsAgainstReceipts, receiptFromToolResult, type DoneClaim, type ToolReceipt } from '../src/hooks/claim-verify-lint';

const receipt = (over: Partial<ToolReceipt> = {}): ToolReceipt => ({ seq: 1, tool: 'create_event', effect: 'calendar_event_created', ok: true, ref: 'evt-1', ...over });
const claim = (over: Partial<DoneClaim> = {}): DoneClaim => ({ seq: 2, effect: 'calendar_event_created', ref: 'evt-1', ...over });

describe('done-claim vs tool-receipt check (advisory, structured, no text parsing)', () => {
  it('a claim with a matching successful receipt earlier in the turn is supported', () => {
    expect(checkClaimsAgainstReceipts([claim()], [receipt()])).toEqual([]);
  });
  it('no receipt at all: unsupported', () => {
    expect(checkClaimsAgainstReceipts([claim()], [])).toEqual([{ claim_seq: 2, effect: 'calendar_event_created', reason: 'no_matching_receipt' }]);
  });
  it('a failed receipt does not support a done claim', () => {
    expect(checkClaimsAgainstReceipts([claim()], [receipt({ ok: false })])).toEqual([{ claim_seq: 2, effect: 'calendar_event_created', reason: 'receipt_failed' }]);
  });
  it('a receipt that comes after the claim does not support it', () => {
    expect(checkClaimsAgainstReceipts([claim({ seq: 1 })], [receipt({ seq: 2 })])).toHaveLength(1);
  });
  it('effect and ref must both match', () => {
    expect(checkClaimsAgainstReceipts([claim()], [receipt({ effect: 'email_sent' })])).toHaveLength(1);
    expect(checkClaimsAgainstReceipts([claim()], [receipt({ ref: 'evt-2' })])).toHaveLength(1);
  });
  it('a claim naming no ref matches any successful receipt of that effect', () => {
    expect(checkClaimsAgainstReceipts([claim({ ref: undefined })], [receipt({ ref: 'anything' })])).toEqual([]);
  });
  it('each receipt supports at most one claim', () => {
    expect(checkClaimsAgainstReceipts([claim({ seq: 2, ref: undefined }), claim({ seq: 3, ref: undefined })], [receipt()])).toEqual([{ claim_seq: 3, effect: 'calendar_event_created', reason: 'no_matching_receipt' }]);
  });
  it('a claim backed only by an unresolved receipt says unresolved, not missing or failed', () => {
    expect(checkClaimsAgainstReceipts([claim()], [receipt({ ok: false, state: 'unresolved' })])).toEqual([{ claim_seq: 2, effect: 'calendar_event_created', reason: 'receipt_unresolved' }]);
  });
  it('unresolved outranks failed when both exist for the claim, and an accepted receipt wins over both', () => {
    const both = [receipt({ seq: 1, ok: false }), receipt({ seq: 2, ok: false, state: 'unresolved' })];
    expect(checkClaimsAgainstReceipts([claim({ seq: 3 })], both)).toEqual([{ claim_seq: 3, effect: 'calendar_event_created', reason: 'receipt_unresolved' }]);
    expect(checkClaimsAgainstReceipts([claim({ seq: 4 })], [...both, receipt({ seq: 3 })])).toEqual([]);
  });
  it('a receipt for a different effect or ref never turns a missing receipt into failed or unresolved', () => {
    expect(checkClaimsAgainstReceipts([claim()], [receipt({ ok: false, effect: 'email_sent' })])).toEqual([{ claim_seq: 2, effect: 'calendar_event_created', reason: 'no_matching_receipt' }]);
    expect(checkClaimsAgainstReceipts([claim()], [receipt({ ok: false, ref: 'evt-9' })])).toEqual([{ claim_seq: 2, effect: 'calendar_event_created', reason: 'no_matching_receipt' }]);
  });
  it('a failed receipt after the claim does not explain it', () => {
    expect(checkClaimsAgainstReceipts([claim({ seq: 1 })], [receipt({ seq: 2, ok: false })])).toEqual([{ claim_seq: 1, effect: 'calendar_event_created', reason: 'no_matching_receipt' }]);
  });
  it('builds the receipt state from the existing tool result types only', () => {
    const base = { seq: 1, tool: 'create_event', effect: 'calendar_event_created', ref: 'evt-1' };
    expect(receiptFromToolResult(base, { ok: true, data: {}, source_taint: 'owner' } as never)).toEqual({ ...base, ok: true, state: 'accepted' });
    expect(receiptFromToolResult(base, { ok: false, error: 'x', code: 'invalid_args' } as never)).toEqual({ ...base, ok: false, state: 'failed' });
    expect(receiptFromToolResult(base, { ok: false, error: 'x', code: 'transient', receipt_status: 'unavailable' } as never)).toEqual({ ...base, ok: false, state: 'unresolved' });
  });
});

