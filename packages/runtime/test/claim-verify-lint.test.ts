import { describe, expect, it } from 'vitest';
import { checkClaimsAgainstReceipts, type DoneClaim, type ToolReceipt } from '../src/hooks/claim-verify-lint';

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
    expect(checkClaimsAgainstReceipts([claim()], [receipt({ ok: false })])).toEqual([{ claim_seq: 2, effect: 'calendar_event_created', reason: 'no_matching_receipt' }]);
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
});
