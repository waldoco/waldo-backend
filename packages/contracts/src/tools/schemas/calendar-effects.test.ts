import { describe, expect, it } from 'vitest';
import { proposeCalendarChangeArgsSchema } from './calendar';
const create = { action: 'create', title: 'Team review', start: '2026-10-11T10:00:00Z', end: '2026-10-11T11:00:00Z', reason: 'Owner request' };
describe('selected Calendar approval contract', () => {
  it('preserves legacy defaults without adding notification or target options', () => {
    expect(proposeCalendarChangeArgsSchema.parse(create)).toEqual(create);
  });
  it('names the selected calendar, invited addresses and explicit notification audience', () => {
    const args = { ...create, calendar_id: 'team@example.test', attendees: ['peer@example.test'], send_updates: 'all', description: 'Exact agenda', location: 'Room 1' };
    expect(proposeCalendarChangeArgsSchema.parse(args)).toEqual(args);
  });
  it('supports exact all-day calendar dates with exclusive end date', () => {
    expect(proposeCalendarChangeArgsSchema.safeParse({ ...create, start: '2026-10-11', end: '2026-10-12' }).success).toBe(true);
  });
  it.each([
    { ...create, calendar_id: '' }, { ...create, attendees: ['peer@example.test'] },
    { ...create, attendees: ['bad-address'], send_updates: 'all' },
    { ...create, attendees: ['Peer@example.test', 'peer@example.test'], send_updates: 'all' },
    { ...create, send_updates: 'maybe' }, { ...create, start: '2026-10-12', end: '2026-10-11' },
    { ...create, start: '2026-10-11', end: '2026-10-12T00:00:00Z' },
    { ...create, action: 'move', event_id: 'existing', attendees: ['peer@example.test'], send_updates: 'all' },
    { ...create, action: 'cancel', event_id: 'existing', description: 'Changed body' },
  ])('rejects ambiguous target, time or audience %j', args => {
    expect(proposeCalendarChangeArgsSchema.safeParse(args).success).toBe(false);
  });
});
