// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DayControls } from './Controls';
import { readControls, submitControl, type DayRecord, type ScheduleControl } from './controls-model';

const rows: ScheduleControl[] = [
  { id: 'daily_brief', on: true, accepts: 'on_off', time: null, no_later_than: false }, { id: 'followups', on: false, accepts: 'on_off', time: null, no_later_than: false },
  { id: 'event_briefs', on: true, accepts: 'on_off', time: null, no_later_than: false }, { id: 'nightly', on: true, accepts: 'on_off', time: null, no_later_than: false },
  { id: 'heartbeat', on: true, accepts: 'on_off', time: null, no_later_than: false },
  { id: 'card:brief', on: true, accepts: 'time', time: '07:10', no_later_than: true }, { id: 'card:close', on: true, accepts: 'time', time: '21:30', no_later_than: false },
];
const day = (schedules?: unknown): DayRecord => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  date: '2026-11-06', timezone: 'Asia/Kolkata', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, ...(schedules === undefined ? {} : { schedule_controls: schedules as ScheduleControl[] }),
} });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('reading what Waldo sends', () => {
  const read = (schedules: unknown) => readControls(day(schedules), 'day');
  it('keeps each schedule as the Worker lists it, and drops anything else in a row', () => {
    expect(read(rows.map(row => ({ ...row, owner_id: 'other' }))).data.schedule_controls).toEqual(rows);
  });
  it('refuses a schedule it does not know, a time that is not HH:MM and an on that is not a yes or no', () => {
    for (const bad of [[{ ...rows[0], id: 'card:midday' }], [{ ...rows[5], time: '7:10' }], [{ ...rows[0], on: 'yes' }], [{ ...rows[0], accepts: 'both' }], 'all', [null]]) expect(() => read(bad)).toThrow('Refresh the records');
  });
  it('reads a Worker that does not say as having no control', () => expect(readControls(day(), 'day').data).not.toHaveProperty('schedule_controls'));
  it('sends schedule.set with the read\'s CSRF value, revision and a stable request id, and no owner', async () => {
    const fetch = vi.fn(async () => Response.json({ receipt: { state: 'recorded', message: 'Saved. Your Brief comes at 7:10am.' }, duplicate: false }));
    vi.stubGlobal('fetch', fetch);
    await submitControl(day(rows), 'schedule.set', { id: 'card:brief', value: '07:10' }, 'schedule-request-1');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ csrf: 'c'.repeat(64), revision: 'a'.repeat(64), view: 'day', request_id: 'schedule-request-1', action: 'schedule.set', id: 'card:brief', value: '07:10' });
  });
});

describe('the what Waldo sends control', () => {
  const setting = (shown: string) => shown.slice(shown.indexOf('What Waldo sends'));
  it('names each schedule in plain words, with its state, and the Brief as no later than its time', () => {
    const shown = setting(renderToStaticMarkup(<DayControls record={day(rows)} busy={false} onAction={() => {}}/>));
    for (const words of ['Day cards', 'Follow-ups', 'Prep before events', 'Overnight memory pass', 'Check-backs', 'Brief time', 'Close time', 'By 7:10 AM, earlier when you wake', '9:30 PM']) expect(shown).toContain(words);
  });
  it('is absent when the Worker does not list it', () => expect(renderToStaticMarkup(<DayControls record={day()} busy={false} onAction={() => {}}/>)).not.toContain('What Waldo sends'));
  it('turns one schedule off or on, and saves a new time, each as one schedule.set', async () => {
    const onAction = vi.fn();
    const root = document.createElement('div'); document.body.append(root);
    await act(async () => createRoot(root).render(<DayControls record={day(rows)} busy={false} onAction={onAction}/>));
    const button = (label: string) => [...root.querySelectorAll('button')].find(item => item.textContent === label)!;
    await act(async () => button('Turn off Day cards').click());
    await act(async () => button('Turn on Follow-ups').click());
    const input = root.querySelector<HTMLInputElement>('input[aria-label="Close time"]')!;
    await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '22:15'); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => button('Save Close time').click());
    expect(onAction.mock.calls).toEqual([['schedule.set', { id: 'daily_brief', value: 'off' }], ['schedule.set', { id: 'followups', value: 'on' }], ['schedule.set', { id: 'card:close', value: '22:15' }]]);
  });
});
