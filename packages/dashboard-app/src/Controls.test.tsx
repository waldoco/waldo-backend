import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ConnectionsControls, ControlReceipt, ControlsFeedback, DayControls } from './Controls';
import type { ConnectionsRecord, DayRecord } from './controls-model';

const day: DayRecord = { version: 1, view: 'day', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: { date: '2026-10-02', timezone: 'Asia/Kolkata', cards: [
  { id: 'card:brief', name: 'The Brief', defaultTime: '08:00', time: '08:30', reason: 'Already sent', sent: true, pin: '08:30' },
  { id: 'card:close', name: 'The Close', defaultTime: '21:30', time: null, reason: '<script>hostile</script>', sent: false, pin: null },
], proactivity: { quiet_start: null, quiet_end: null, volume: 'normal' } } };
const connections: ConnectionsRecord = { version: 1, view: 'connections', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: { google: { connectAvailable: true, accounts: [
  { id: 'g1', email: '<script>@test.invalid', calendar: true, mail: false, tasks: true, health: 'access_granted' },
  { id: 'g2', email: 'work@test.invalid', calendar: false, mail: true, tasks: false, health: 'needs_reconnect' },
] }, telegram: { linked: false, unlinkAvailable: true }, sessions: { count: 1, until: '2026-10-02 07:30' } } };
const noop = () => {};

describe('modern day controls', () => {
  it('renders editable unsent timing, clear pin for sent cards, and exact recorded-send limits', () => {
    const html = renderToStaticMarkup(<DayControls record={day} busy={false} onAction={noop}/>);
    expect(html).toContain('Clear pin for The Brief');
    expect(html).not.toContain('Time for The Brief');
    expect(html).toContain('Time for The Close');
    expect(html).toContain('Skipped today');
    expect(html).toContain('value="21:30"');
    expect(html).toContain('not verified delivery');
    expect(html).toContain('&lt;script&gt;hostile&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('/console/day');
  });

  it('labels settings inputs, preserves null quiet hours and disables pending controls', () => {
    const html = renderToStaticMarkup(<DayControls record={day} busy onAction={noop}/>);
    expect(html).toContain('Time zone<input'); expect(html).toContain('Quiet from<input'); expect(html).toContain('Quiet until<input');
    expect(html).toContain('Save quiet hours &amp; volume'); expect(html).toContain('Reminders you set still fire');
    expect(html).toContain('disabled=""'); expect(html).not.toContain('type="hidden"'); expect(html).not.toContain(day.csrf);
  });
});

describe('modern account controls', () => {
  it('keeps reconnect per account, grant/read honesty, escaped labels and session eligibility', () => {
    const html = renderToStaticMarkup(<ConnectionsControls record={connections} busy={false} onAction={noop}/>);
    expect(html).toContain('Reconnect work@test.invalid');
    expect(html).not.toContain('Reconnect &lt;script&gt;');
    expect(html).toContain('Access granted · read unverified');
    expect(html).toContain('Disconnect &lt;script&gt;@test.invalid'); expect(html).not.toContain('<script>');
    expect(html).toContain('Link a Telegram account'); expect(html).not.toContain('Unlink Telegram');
    expect(html).toContain('Sign out of this browser'); expect(html).not.toContain('Sign out everywhere');
    expect(html).not.toContain('/console/connections');
    const multiple = renderToStaticMarkup(<ConnectionsControls record={{ ...connections, data: { ...connections.data, telegram: { linked: true, unlinkAvailable: true }, sessions: { count: 2, until: connections.data.sessions.until } } }} busy={false} onAction={noop}/>);
    expect(multiple).toContain('Unlink Telegram'); expect(multiple).toContain('Sign out everywhere');
  });

  it('does not offer unavailable connect or unlink actions and honestly shows absent accounts', () => {
    const html = renderToStaticMarkup(<ConnectionsControls record={{ ...connections, data: { ...connections.data, google: { connectAvailable: false, accounts: [] }, telegram: { linked: true, unlinkAvailable: false } } }} busy={false} onAction={noop}/>);
    expect(html).toContain('No Google accounts returned'); expect(html).toContain('connection is unavailable');
    expect(html).not.toContain('>Connect Google<'); expect(html).not.toContain('>Unlink Telegram<');
  });
});

describe('receipt and read recovery', () => {
  it('distinguishes loading, signed-out and failed reads without manufacturing empty records', () => {
    expect(renderToStaticMarkup(<ControlsFeedback state={{ kind: 'loading' }} onRefresh={noop}/>)).toContain('role="status"');
    const failed = renderToStaticMarkup(<ControlsFeedback state={{ kind: 'error', message: 'Read failed', signedOut: false }} onRefresh={noop}/>);
    expect(failed).toContain('Retry read'); expect(failed).not.toContain('No Google');
    const signedOut = renderToStaticMarkup(<ControlsFeedback state={{ kind: 'error', message: 'Sign in', signedOut: true }} onRefresh={noop}/>);
    expect(signedOut).toContain('href="/console/signin"'); expect(signedOut).not.toContain('Retry read');
  });

  it('shows exact incomplete/uncertain receipts and same-request checks without done claims', () => {
    const html = renderToStaticMarkup(<ControlReceipt result={{ receipt: { state: 'unconfirmed', message: '<script>outcome unknown</script>' }, duplicate: true }} onCheck={noop} onRefresh={noop} busy={false}/>);
    expect(html).toContain('Outcome unconfirmed'); expect(html).toContain('Check this request'); expect(html).toContain('did not run again');
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toContain('Receipt recorded');
    const signedOut = renderToStaticMarkup(<ControlReceipt result={{ receipt: { state: 'recorded', message: 'Signed out', signed_out: true }, duplicate: false }} onRefresh={noop} busy={false}/>);
    expect(signedOut).toContain('Sign in again'); expect(signedOut).not.toContain('Refresh controls');
  });
});
