// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { APP_ACT_WITHOUT_ASKING_STILL_ASKS_V1 } from '../../contracts/src/app/controls';
import { DayControls, STILL_ASKS } from './Controls';
import { readControls, type DayRecord } from './controls-model';

const day = (choice?: unknown): DayRecord => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  date: '2026-11-14', timezone: 'Europe/London', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, ...(choice === undefined ? {} : { act_without_asking: choice as DayRecord['data']['act_without_asking'] }),
} });
const html = (record: DayRecord) => renderToStaticMarkup(<DayControls record={record} busy={false} onAction={() => {}}/>);
afterEach(() => { document.body.innerHTML = ''; });

describe('reading "Just do it"', () => {
  it('keeps the choice and whether it is active, reads a Worker that does not say as no setting, and refuses anything else', () => {
    expect(readControls(day({ on: false, available: true }), 'day').data.act_without_asking).toEqual({ on: false, available: true });
    expect(readControls(day(), 'day').data).not.toHaveProperty('act_without_asking');
    for (const bad of [true, { on: true }, { on: 'on', available: true }, null]) expect(() => readControls(day(bad), 'day')).toThrow('Refresh the records');
  });
});

describe('the "Just do it" control', () => {
  it('turns it off, or back on, in one tap', async () => {
    const onAction = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<DayControls record={day({ on: true, available: true })} busy={false} onAction={onAction}/>));
    const button = [...host.querySelectorAll('button')].find(candidate => candidate.textContent === 'Turn off Just do it')!;
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledWith('act_without_asking.set', { value: 'off' });
    expect(html(day({ on: false, available: true }))).toContain('>Turn on Just do it</button>');
    await act(async () => root.unmount());
  });

  it('says what it does and, word for word with the contract, what Waldo still asks about', () => {
    const shown = html(day({ on: true, available: true }));
    expect(STILL_ASKS).toBe(APP_ACT_WITHOUT_ASKING_STILL_ASKS_V1);
    expect(shown).toContain('Just do it — Waldo won’t ask before acting.');
    expect(shown).toContain(STILL_ASKS);
    expect(shown).toContain('<span class="value">On</span>');
  });

  it('where this Waldo does not act on it, says it is not active rather than on', () => {
    const shown = html(day({ on: true, available: false }));
    expect(shown).toContain('<span class="value">Not active yet</span>');
    expect(shown).toContain('This is not active on this Waldo yet, so Waldo asks before every action whatever you choose.');
    expect(shown).not.toContain('<span class="value">On</span>');
  });

  it('is not shown when the Worker does not say', () => {
    expect(html(day())).not.toContain('Just do it');
  });
});
