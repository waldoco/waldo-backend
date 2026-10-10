import { describe, expect, it } from 'vitest';
import { GoogleTokenError } from '../src/connectors/google';
import { confirmGoogleReadback, GoogleReadbackError, readbackFeature, reauthNoticeTransition } from '../src/connectors/google-reconnect';

const AUTH = 'https://www.googleapis.com/auth/';

describe('reauth notice transition', () => {
  it('a grant that starts failing earns one notice: send on the healthy -> failing transition', () => {
    expect(reauthNoticeTransition({ failing: false, noticed: false }, 'google token failed: invalid_grant')).toEqual({ send: true, noticed: false });
  });
  it('stays silent while the grant keeps failing (the circuit breaker owns retries)', () => {
    expect(reauthNoticeTransition({ failing: true, noticed: false }, 'google token failed: invalid_grant')).toEqual({ send: false, noticed: false });
  });
  it('stays silent when this failure episode was already noticed', () => {
    expect(reauthNoticeTransition({ failing: false, noticed: true }, 'google token failed: invalid_grant')).toEqual({ send: false, noticed: true });
  });
  it('recovery re-arms the episode: the outstanding notice record clears', () => {
    expect(reauthNoticeTransition({ failing: true, noticed: true }, '')).toEqual({ send: false, noticed: false });
  });
  it('a healthy grant staying healthy sends nothing', () => {
    expect(reauthNoticeTransition({ failing: false, noticed: false }, '')).toEqual({ send: false, noticed: false });
  });
});

describe('readback feature', () => {
  it('explicit Calendar discovery requires its own scope even if event reads work', () => {
    expect(readbackFeature([`${AUTH}calendar.events`], 'calendar_list')).toBeNull();
    expect(readbackFeature([`${AUTH}calendar.events`, `${AUTH}calendar.calendarlist.readonly`], 'calendar_list')).toBe('calendar_list');
    expect(readbackFeature(null, 'calendar_list')).toBeNull();
  });
  it('a full consent grant confirms on calendar first', () => {
    expect(readbackFeature([`${AUTH}calendar.events`, `${AUTH}gmail.readonly`, `${AUTH}tasks`])).toBe('calendar');
  });
  it('a mail-only grant confirms on mail', () => {
    expect(readbackFeature([`${AUTH}gmail.readonly`, `${AUTH}gmail.send`, `${AUTH}gmail.compose`])).toBe('mail');
  });
  it('a tasks-only grant confirms on tasks', () => {
    expect(readbackFeature([`${AUTH}tasks`])).toBe('tasks');
  });
  it('a legacy null grant retains the old features and confirms on calendar', () => {
    expect(readbackFeature(null)).toBe('calendar');
  });
  it('a grant without calendar, mail or tasks has no confirmation read', () => {
    expect(readbackFeature([`${AUTH}drive.readonly`])).toBeNull();
  });
});

const client = (overrides: Record<string, unknown>) => overrides as never;

describe('confirmGoogleReadback', () => {
  it('Calendar discovery confirmation reads the actual calendar list on the fresh grant', async () => {
    const calls: unknown[][] = [];
    await confirmGoogleReadback(client({ calendarListsPage: async (...args: unknown[]) => { calls.push(args); return { items: [], next_page_token: null }; } }), 'calendar_list', 0);
    expect(calls).toEqual([[1, false]]);
    await expect(confirmGoogleReadback(client({ events: async () => [] }), 'calendar_list', 0)).rejects.toBeInstanceOf(GoogleReadbackError);
  });
  it('calendar readback lists at most one event in a one-hour window', async () => {
    const calls: unknown[][] = [];
    await confirmGoogleReadback(client({ events: async (...args: unknown[]) => { calls.push(args); return []; } }), 'calendar', Date.parse('2026-10-08T07:00:00Z'));
    expect(calls).toEqual([['2026-10-08T07:00:00.000Z', '2026-10-08T08:00:00.000Z', 1, false]]);
  });
  it('mail readback asks for one recent message', async () => {
    const calls: unknown[][] = [];
    await confirmGoogleReadback(client({ newMail: async (...args: unknown[]) => { calls.push(args); return []; } }), 'mail', 1_000_000);
    expect(calls).toEqual([[1_000_000, 1]]);
  });
  it('tasks readback asks for one open task', async () => {
    const calls: unknown[][] = [];
    await confirmGoogleReadback(client({ tasks: async (...args: unknown[]) => { calls.push(args); return []; } }), 'tasks', 0);
    expect(calls).toEqual([['todo', 1]]);
  });
  it('a dead grant (invalid_grant on the readback) fails the confirmation as auth', async () => {
    const attempt = confirmGoogleReadback(client({ events: async () => { throw new GoogleTokenError('auth'); } }), 'calendar', 0);
    await expect(attempt).rejects.toMatchObject({ name: 'GoogleReadbackError', kind: 'auth' });
  });
  it('a transient provider failure fails the confirmation as transient', async () => {
    const attempt = confirmGoogleReadback(client({ events: async () => { throw new Error('google 503: backendError'); } }), 'calendar', 0);
    await expect(attempt).rejects.toMatchObject({ name: 'GoogleReadbackError', kind: 'transient' });
    await expect(confirmGoogleReadback(client({ events: async () => { throw new Error('x'); } }), 'calendar', 0)).rejects.toBeInstanceOf(GoogleReadbackError);
  });
});
