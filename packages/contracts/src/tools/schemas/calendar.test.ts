import { describe, expect, it } from 'vitest';
import { proposeCalendarChangeArgsSchema } from './calendar';

const create = { action: 'create', title: 'Design review', start: '2026-10-14T10:00:00+05:30', end: '2026-10-14T10:30:00+05:30', reason: 'asked for it' } as const;

describe('propose_calendar_change: guests, calendar, place and Meet', () => {
  it.each([
    ['a plain create', create],
    ['a create on another calendar with guests who are emailed, a place, notes and a Meet link', { ...create, calendar_id: 'team@group.calendar.google.com', attendees: ['sam@example.com', 'pat@example.org'], send_updates: 'all', location: 'Room 4', description: 'Agenda: launch', add_meet_link: true }],
    ['guests who are not emailed', { ...create, attendees: ['sam@example.com'], send_updates: 'none' }],
    ['a move that emails the guests already on the event', { action: 'move', event_id: 'e1', start: create.start, end: create.end, send_updates: 'all', reason: 'clash' }],
    ['a cancel on another calendar', { action: 'cancel', event_id: 'e1', calendar_id: 'team@group.calendar.google.com', send_updates: 'none', reason: 'off sick' }],
  ])('accepts %s', (_name, args) => {
    expect(proposeCalendarChangeArgsSchema.safeParse(args).success).toBe(true);
  });

  it.each([
    ['guests with no choice about emailing them', { ...create, attendees: ['sam@example.com'] }],
    ['a guest that is not an email address', { ...create, attendees: ['Sam'], send_updates: 'all' }],
    ['more than 50 guests', { ...create, attendees: Array.from({ length: 51 }, (_, i) => `u${i}@example.com`), send_updates: 'none' }],
    ['guests on a move', { action: 'move', event_id: 'e1', start: create.start, end: create.end, attendees: ['sam@example.com'], send_updates: 'all', reason: 'x' }],
    ['a Meet link on a cancel', { action: 'cancel', event_id: 'e1', add_meet_link: true, reason: 'x' }],
    ['notes on a move', { action: 'move', event_id: 'e1', start: create.start, end: create.end, description: 'x', reason: 'x' }],
    ['an empty calendar id', { ...create, calendar_id: '' }],
    ['an unknown emailing choice', { ...create, send_updates: 'externalOnly' }],
    ['notes over 2000 characters', { ...create, description: 'x'.repeat(2001) }],
  ])('refuses %s', (_name, args) => {
    expect(proposeCalendarChangeArgsSchema.safeParse(args).success).toBe(false);
  });
});
