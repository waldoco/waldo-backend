// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DayControls } from './Controls';
import { readControls, submitControl, type DayRecord, type DiagnosticRecording } from './controls-model';

const wording = { version: 'beta-2026-10-22', label: 'During the beta, let the Waldo team read my chats with Waldo to find and fix problems (optional)', detail: 'If you agree, Waldo records the full text of your conversations.' };
const recording = (changed: Partial<DiagnosticRecording> = {}): DiagnosticRecording => ({ state: 'off', recorded_here: true, ...wording, ...changed });
const day = (diagnostic?: unknown): DayRecord => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  date: '2026-10-22', timezone: 'Asia/Kolkata', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, ...(diagnostic === undefined ? {} : { diagnostic_recording: diagnostic as DiagnosticRecording }),
} });
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('reading the diagnostic recording choice', () => {
  it('keeps the state, whether this server records, and the wording, and drops anything else', () => {
    expect(readControls(day({ ...recording({ state: 'on' }), owner_id: 'other' }), 'day').data.diagnostic_recording).toEqual(recording({ state: 'on' }));
  });

  it('refuses a state it does not know or a record without its wording', () => {
    for (const bad of [recording({ state: 'maybe' as never }), { ...recording(), recorded_here: 'yes' }, { ...recording(), label: 3 }, { state: 'on' }, 'on', null]) expect(() => readControls(day(bad), 'day')).toThrow('Refresh the records');
  });

  it('reads a Worker that does not say as having no control', () => {
    expect(readControls(day(), 'day').data).not.toHaveProperty('diagnostic_recording');
  });

  it('sends the choice with the read\'s CSRF value and revision', async () => {
    const fetch = vi.fn(async () => Response.json({ receipt: { state: 'recorded', message: 'Saved.' }, duplicate: false }));
    vi.stubGlobal('fetch', fetch);
    await submitControl(day(recording()), 'diagnostic_recording.set', { value: 'on' }, 'diagnostic-request-1');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ csrf: 'c'.repeat(64), revision: 'a'.repeat(64), view: 'day', request_id: 'diagnostic-request-1', action: 'diagnostic_recording.set', value: 'on' });
  });
});

describe('the diagnostic recording control', () => {
  const html = (value?: DiagnosticRecording, busy = false) => renderToStaticMarkup(<DayControls record={day(value)} busy={busy} onAction={() => {}}/>);
  const setting = (shown: string) => shown.slice(shown.indexOf('Diagnostic recording'));

  it('shows the state and the wording the owner agrees to', () => {
    const shown = setting(html(recording()));
    expect(shown).toMatch(/Diagnostic recording<\/span><span class="value">Off</);
    expect(shown).toContain(wording.label);
    expect(shown).toContain(wording.detail);
    expect(shown).toContain('Turn on diagnostic recording');
    expect(shown).not.toContain('Turn off diagnostic recording');
    expect(setting(html(recording({ state: 'on' })))).toContain('Turn off diagnostic recording');
    expect(setting(html(recording({ state: 'on' })))).not.toContain('Turn on diagnostic recording');
  });

  it('says unknown, not off, and offers both choices when the record could not be read', () => {
    const shown = setting(html(recording({ state: 'unknown' })));
    expect(shown).toMatch(/<span class="value">Unknown</);
    expect(shown).toContain('Turn on diagnostic recording');
    expect(shown).toContain('Turn off diagnostic recording');
  });

  it('says when this server records no chat text whatever the owner chooses', () => {
    expect(setting(html(recording({ recorded_here: false })))).toContain('This server doesn’t record chat text, whatever you choose.');
    expect(setting(html(recording()))).not.toContain('This server doesn’t record');
  });

  it('is not shown when the Worker does not say, and is disabled while busy', () => {
    expect(html()).not.toContain('Diagnostic recording');
    expect(setting(html(recording(), true))).toMatch(/<button class="primary" disabled="">Turn on diagnostic recording/);
  });

  it('asks for the change the owner picks', async () => {
    const onAction = vi.fn();
    const root = document.createElement('div'); document.body.append(root);
    await act(async () => { createRoot(root).render(<DayControls record={day(recording({ state: 'on' }))} busy={false} onAction={onAction}/>); });
    const off = [...root.querySelectorAll('button')].find(button => button.textContent === 'Turn off diagnostic recording')!;
    await act(async () => { off.click(); });
    expect(onAction).toHaveBeenCalledWith('diagnostic_recording.set', { value: 'off' });
  });
});
