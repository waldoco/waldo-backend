import { describe, expect, it } from 'vitest';
import { ActivityLedgerModule, type ActivityInput } from './activity';

const entry = (overrides: Partial<ActivityInput> = {}): ActivityInput => ({
  entryId: 'e-1', ownerId: 'owner-a', subjectRef: 'ap-1', kind: 'proposed', at: 100,
  summary: 'Proposed focus block', evidenceRef: null, undoable: false, ...overrides,
});

describe('ActivityLedgerModule', () => {
  it('appends an ordered per-owner feed and exposes stop while work is open', () => {
    const ledger = new ActivityLedgerModule();
    ledger.append('owner-a', entry());
    ledger.append('owner-b', entry({ ownerId: 'owner-b' }));
    ledger.append('owner-a', entry({ entryId: 'e-2', kind: 'dispatched', at: 110 }));
    expect(ledger.feed('owner-a').map((item) => [item.seq, item.kind])).toEqual([[1, 'proposed'], [2, 'dispatched']]);
    expect(ledger.controls('owner-a', 'ap-1')).toEqual({ subjectRef: 'ap-1', canStop: true, canUndo: false });
    ledger.append('owner-a', entry({ entryId: 'e-3', kind: 'stopped', at: 120 }));
    expect(ledger.controls('owner-a', 'ap-1')).toMatchObject({ canStop: false, canUndo: false });
    expect(() => ledger.append('owner-a', entry({ entryId: 'e-4', kind: 'completed', at: 130 }))).toThrow('subject closed');
  });

  it('is append-only and idempotent by entry id', () => {
    const ledger = new ActivityLedgerModule();
    const first = ledger.append('owner-a', entry());
    expect(ledger.append('owner-a', entry())).toBe(first);
    expect(() => ledger.append('owner-a', entry({ summary: 'rewritten' }))).toThrow('conflict');
    expect(() => ledger.append('owner-a', entry({ entryId: 'e-2', at: 99 }))).toThrow('out of order');
    expect(() => ledger.append('owner-b', entry())).toThrow('owner mismatch');
    expect(Object.isFrozen(ledger.feed('owner-a'))).toBe(true);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('offers undo only after an undoable completion and records it as a new request', () => {
    const ledger = new ActivityLedgerModule();
    ledger.append('owner-a', entry({ kind: 'completed', evidenceRef: 'receipt-1', undoable: true }));
    ledger.append('owner-a', entry({ entryId: 'e-x', subjectRef: 'ap-2', kind: 'completed', at: 101 }));
    expect(ledger.controls('owner-a', 'ap-1').canUndo).toBe(true);
    expect(() => ledger.append('owner-a', entry({ entryId: 'e-y', subjectRef: 'ap-2', kind: 'undo_requested', at: 102 }))).toThrow('undo not permitted');
    ledger.append('owner-a', entry({ entryId: 'e-2', kind: 'undo_requested', at: 110 }));
    expect(ledger.controls('owner-a', 'ap-1')).toMatchObject({ canStop: true, canUndo: false });
    expect(ledger.controls('owner-b', 'ap-1')).toEqual({ subjectRef: 'ap-1', canStop: false, canUndo: false });
  });
});
