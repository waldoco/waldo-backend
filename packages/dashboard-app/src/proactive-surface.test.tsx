// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DayControls } from './Controls';
import { readControls, submitControl, type DayRecord, type ProactiveSurface } from './controls-model';

const surface = (changed: Partial<ProactiveSurface> = {}): ProactiveSurface => ({ value: 'app', app_linked: true, whatsapp_linked: true, telegram_linked: false, ...changed });
const day = (proactive?: ProactiveSurface): DayRecord => ({ version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  date: '2026-10-02', timezone: 'Asia/Kolkata', cards: [], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' }, ...(proactive ? { proactive_surface: proactive } : {}),
} });
const noop = () => {};
afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

describe('reading where Waldo writes', () => {
  const read = (proactive: unknown) => readControls({ ...day(), data: { ...day().data, proactive_surface: proactive } }, 'day');

  it('keeps the setting and what the owner can be reached on, and drops anything else in it', () => {
    expect(read({ ...surface({ value: 'both' }), owner_id: 'other' }).data.proactive_surface).toEqual(surface({ value: 'both' }));
  });

  it('refuses a value it does not know and a link state that is not a yes or no', () => {
    for (const bad of [surface({ value: 'telegram' as never }), { ...surface(), whatsapp_linked: 'yes' }, { value: 'app' }, 'app', null]) expect(() => read(bad)).toThrow('Refresh the records');
  });

  it('keeps an iMessage choice and its link state, and refuses a link state that is not a yes or no', () => {
    expect(read(surface({ value: 'app_imessage', imessage_linked: true })).data.proactive_surface).toEqual(surface({ value: 'app_imessage', imessage_linked: true }));
    expect(() => read({ ...surface({ value: 'imessage' }), imessage_linked: 'yes' })).toThrow('Refresh the records');
  });

  it('reads a Worker that does not say as having no setting', () => {
    expect(readControls(day(), 'day').data).not.toHaveProperty('proactive_surface');
  });

  it('sends the choice with the read\'s CSRF value, revision and a stable request id, and no owner', async () => {
    const fetch = vi.fn(async () => Response.json({ receipt: { state: 'recorded', message: 'Saved.' }, duplicate: false }));
    vi.stubGlobal('fetch', fetch);
    await submitControl(day(surface()), 'proactive_surface.set', { value: 'both' }, 'surface-request-1');
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(Object.fromEntries((init.body as FormData).entries())).toEqual({ csrf: 'c'.repeat(64), revision: 'a'.repeat(64), view: 'day', request_id: 'surface-request-1', action: 'proactive_surface.set', value: 'both' });
  });
});

describe('the where Waldo writes control', () => {
  const html = (proactive?: ProactiveSurface, busy = false) => renderToStaticMarkup(<DayControls record={day(proactive)} busy={busy} onAction={noop}/>);
  // Only this setting's part of the day view; the quiet hours above it have a select and notes of their own.
  const setting = (shown: string) => shown.slice(shown.indexOf('Where Waldo writes'));

  it('offers the app only, WhatsApp only and both, with the saved choice selected', () => {
    const shown = html(surface({ value: 'whatsapp' }));
    expect(shown).toContain('Where Waldo writes');
    for (const label of ['The app only', 'WhatsApp only', 'The app and WhatsApp']) expect(shown).toContain(`>${label}</option>`);
    expect(shown).toMatch(/<option value="whatsapp" selected="">WhatsApp only<\/option>/);
    expect(shown).toContain('Replies always come where you wrote.');
    expect(setting(html(surface(), true))).toMatch(/<select disabled="">.*<button class="primary" disabled="">Save where Waldo writes/);
  });

  it('offers iMessage the same two ways as WhatsApp, and says what each does today', () => {
    const shown = html(surface({ value: 'imessage', imessage_linked: true }));
    for (const label of ['iMessage only', 'The app and iMessage']) expect(shown).toContain(`>${label}</option>`);
    expect(shown).toMatch(/<option value="imessage" selected="">iMessage only<\/option>/);
    expect(setting(shown)).toContain('Approval cards still come to the app.');
    expect(setting(html(surface({ value: 'app_imessage', imessage_linked: false })))).toContain('Write to Waldo on iMessage first');
  });

  it('is not shown when the Worker does not say where Waldo writes', () => {
    expect(html()).not.toContain('Where Waldo writes');
  });

  it('says what each choice does today, given where the owner can be reached', () => {
    expect(setting(html(surface()))).not.toContain('class="meta"');
    expect(html(surface({ value: 'both', whatsapp_linked: false }))).toContain('WhatsApp isn’t connected, so these come to the app for now.');
    expect(html(surface({ app_linked: false }))).toContain('You haven’t written to Waldo in the app yet, so these come to WhatsApp for now.');
    expect(html(surface({ value: 'both', telegram_linked: true }))).toContain('While Telegram is linked');
    const whatsapp = html(surface({ value: 'whatsapp' }));
    expect(whatsapp).toContain('Meeting prep before your events isn’t sent on WhatsApp yet.');
    expect(whatsapp).toContain('a day card waits only until your next card is due or its day ends, update cards aren’t sent, and a standing order’s newer report replaces a waiting one.');
    expect(whatsapp).toContain('Other messages wait up to 30 days for your next message there, unless they no longer apply.');
    const both = html(surface({ value: 'both' }));
    expect(both).toContain('Meeting prep before your events, update cards and notices about paused jobs come to the app only.');
    expect(both).toContain('each copy waits a day at most for your next message there; the app keeps every message.');
    expect(both).not.toContain('30 days');
  });

  it('saves the owner\'s new choice through the day view\'s action', async () => {
    const onAction = vi.fn();
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(<DayControls record={day(surface())} busy={false} onAction={onAction}/>));
    const select = [...host.querySelectorAll('select')].find(element => element.closest('label')?.textContent?.startsWith('Send them to'))!;
    await act(async () => { select.value = 'both'; select.dispatchEvent(new Event('change', { bubbles: true })); });
    await act(async () => { select.closest('form')!.requestSubmit(); });
    expect(onAction).toHaveBeenCalledWith('proactive_surface.set', { value: 'both' });
    await act(async () => root.unmount());
  });
});
