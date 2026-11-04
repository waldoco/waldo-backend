// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DayControls } from './Controls';
import { readControls, type DayRecord } from './controls-model';

const day = (health?: unknown): DayRecord => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  date: '2026-10-21', timezone: 'Asia/Kolkata', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, ...(health === undefined ? {} : { health_memory: health as boolean }),
} });
afterEach(() => { document.body.innerHTML = ''; });

describe('reading the health notes setting', () => {
  it('keeps a yes or no, reads a Worker that does not say as no setting, and refuses anything else', () => {
    expect(readControls(day(false), 'day').data.health_memory).toBe(false);
    expect(readControls(day(), 'day').data).not.toHaveProperty('health_memory');
    for (const bad of ['off', 1, null]) expect(() => readControls(day(bad), 'day')).toThrow('Refresh the records');
  });
});

describe('the health notes control', () => {
  const html = (record: DayRecord) => renderToStaticMarkup(<DayControls record={record} busy={false} onAction={() => {}}/>);

  it('turns health notes off, or back on, in one tap', async () => {
    const onAction = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<DayControls record={day(true)} busy={false} onAction={onAction}/>));
    const button = [...host.querySelectorAll('button')].find((candidate) => candidate.textContent === 'Turn off health notes')!;
    await act(async () => button.click());
    expect(onAction).toHaveBeenCalledWith('health_memory.set', { value: 'off' });
    expect(html(day(false))).toContain('>Turn on health notes</button>');
    await act(async () => root.unmount());
  });

  // Only notes kept as older chat leaves view are named in a reply; the nightly pass names none, so the copy promises no more.
  it('says which notes are named in a reply and where every note can be corrected', () => {
    const shown = html(day(true));
    expect(shown).toContain('A note kept as older chat leaves its view is named in its next reply to you.');
    expect(shown).toContain('Every note shows in Profile');
    expect(shown).not.toContain('Each health note it keeps is named');
  });

  // What the owner tells Waldo is kept, readings included, dated; wearable readings stay in the health plane.
  it('says readings you mention are kept with their day, and wearable readings never are', () => {
    const shown = html(day(true));
    expect(shown).toContain('readings you mention, each kept with the day you said it');
    expect(shown).toContain('Readings from your wearable are never copied into memory.');
    expect(shown).not.toContain('never numbers');
  });

  it('is not shown when the Worker does not say', () => {
    expect(html(day())).not.toContain('Health notes');
  });
});
