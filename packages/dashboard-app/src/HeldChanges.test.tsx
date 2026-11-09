import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { HeldChangesView, heldLine } from './HeldChanges';
import { readHeldChanges, type HeldChange } from './held-changes-model';

const AT = '2026-10-20T09:00:00.000Z';
const moved: HeldChange = { source: 'calendar', at: AT, kind: 'changed', title: 'Sync with Krati', start: '2026-10-21T15:00:00Z', end: '2026-10-21T15:30:00Z', all_day: false,
  before: { start: '2026-10-20T10:00:00Z', end: '2026-10-20T10:30:00Z', all_day: false } };

describe('held changes on the console\'s Today view', () => {
  it('says what moved, was added or cancelled, and which mail came, in the owner\'s zone', () => {
    expect(heldLine(moved, 'UTC')).toBe('Sync with Krati: moved from Tue 10:00 AM to Wed 3:00 PM');
    expect(heldLine({ ...moved, kind: 'added', before: undefined }, 'UTC')).toBe('Sync with Krati: added for Wed 3:00 PM');
    expect(heldLine({ ...moved, kind: 'cancelled', start: null, end: null }, 'UTC')).toBe('Sync with Krati: cancelled (was Tue 10:00 AM)');
    expect(heldLine({ source: 'mail', at: AT, kind: 'new', from: 'Asha', subject: 'Quote' }, 'UTC')).toBe('Mail from Asha: Quote');
  });

  it('names a withheld title or subject as withheld, never guesses it', () => {
    expect(heldLine({ ...moved, title: null }, 'UTC')).toMatch(/^An event: moved/);
    expect(heldLine({ source: 'mail', at: AT, kind: 'new', from: 'Asha', subject: null }, 'UTC')).toBe('Mail from Asha: (subject withheld)');
  });

  it('shows nothing when nothing was held, and says so when the read failed', () => {
    expect(renderToStaticMarkup(<HeldChangesView changes={null} zone="UTC"/>)).toContain('Couldn’t read what Waldo held back today.');
    expect(renderToStaticMarkup(<HeldChangesView changes={[]} zone="UTC"/>)).toBe('');
    expect(renderToStaticMarkup(<HeldChangesView changes={[moved]} zone="UTC"/>)).toContain('Seen today, not brought to you');
  });

  it('reads the route\'s shape and refuses any other', () => {
    expect(readHeldChanges({ version: 1, changes: [moved, { source: 'mail', at: AT, kind: 'new', from: null, subject: 'Quote' }] })).toHaveLength(2);
    for (const bad of [{ version: 2, changes: [] }, { version: 1, changes: [{ ...moved, kind: 'moved' }] }, { version: 1, changes: [{ ...moved, before: { start: 1 } }] },
      { version: 1, changes: [{ source: 'mail', at: 'not a time', kind: 'new', from: null, subject: null }] }]) expect(() => readHeldChanges(bad)).toThrow(/unsupported shape/);
  });
});
