import { describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { isSettingsRoute, resolveRoute } from './App';
import { AgentMailControls, handleProblem } from './ChannelSetup';
import { readControls, submitControl, type AgentMailRecord } from './controls-model';

const base = { version: 1 as const, state: 'available' as const, csrf: 'c'.repeat(64), revision: 'a'.repeat(64) };
const notice = { version: '2026-10-31', text: 'Your Waldo address receives mail for Waldo.\n\nReleasing or changing the address stops its mail at once.' };
const record = (data: Partial<AgentMailRecord['data']> = {}): AgentMailRecord => ({ ...base, view: 'agent_mail', data: { enabled: true, domain: 'mail.test.invalid', notice, display_name: 'Waldo', actions: ['agent_mail.claim'], ...data } });
const held = (rule: NonNullable<AgentMailRecord['data']['rule']>, extra: Partial<AgentMailRecord['data']> = {}) =>
  record({ handle: 'priya', address: 'priya@mail.test.invalid', rule, actions: ['agent_mail.claim', 'agent_mail.release'], ...extra });
const html = (value: AgentMailRecord) => renderToStaticMarkup(<AgentMailControls record={value} busy={false} onAction={() => {}}/>);

describe('your Waldo address', () => {
  it('has its own Connections page', () => {
    expect(resolveRoute('connections/agent_mail')).toBe('connections/agent_mail');
    expect(isSettingsRoute('connections/agent_mail')).toBe(true);
  });

  it('says plainly when agent mail is off and offers nothing', () => {
    const off = html(record({ enabled: false, domain: undefined, notice: undefined, actions: [] }));
    expect(off).toContain('aren’t enabled'); expect(off).not.toContain('<button'); expect(off).not.toContain('<input');
  });

  it('before a claim shows the notice in full with its version, and a claim that accepts it', () => {
    const page = html(record());
    expect(page).toContain('Choose your Waldo address');
    expect(page).toContain('<p>Your Waldo address receives mail for Waldo.</p><p>Releasing or changing the address stops its mail at once.</p>');
    expect(page).toContain('Notice version 2026-10-31. Claiming an address means you accept it.');
    expect(page).toContain('@mail.test.invalid'); expect(page).toContain('Accept and claim');
    expect(page).not.toContain('Release this address');
  });

  it('checks the handle as it is typed, by the directory\'s own rules', () => {
    expect(handleProblem('')).toBeNull();
    expect(handleProblem(' Priya.K ')).toBeNull();
    for (const bad of ['a', 'pr', '-ab', 'ab-', 'a..b', 'a+b', 'a b', 'a@b', 'x'.repeat(33)]) expect(handleProblem(bad), bad).toContain('3 to 32');
    for (const reserved of ['postmaster', 'Abuse', 'waldo']) expect(handleProblem(reserved)).toBe('That address is reserved. Try another.');
  });

  it('pending says it is being set up, and why it waits when routing is not on yet; it never reads as live', () => {
    const pending = html(held('pending'));
    expect(pending).toContain('priya@mail.test.invalid'); expect(pending).toContain('Setting up'); expect(pending).toContain('may not arrive until that finishes');
    expect(pending).not.toContain('Receiving mail'); expect(pending).not.toContain('Copy address');
    const waiting = html(held('pending', { rule_reason: 'not_configured' }));
    expect(waiting).toContain('Mail routing isn’t switched on for this server yet'); expect(waiting).not.toContain('Receiving mail');
  });

  it('live shows the address with a copy button', () => {
    const live = html(held('live'));
    expect(live).toContain('Receiving mail'); expect(live).toContain('Mail sent to this address reaches your Waldo.'); expect(live).toContain('Copy address');
    expect(live).not.toContain('Try again');
  });

  it('failed and unknown say so honestly and offer Try again', () => {
    const failed = html(held('failed')), unknown = html(held('unknown'));
    expect(failed).toContain('Not set up'); expect(failed).toContain('could not set up this address, so it receives no mail');
    expect(unknown).toContain('Not confirmed'); expect(unknown).toContain('could not confirm this address is set up');
    for (const page of [failed, unknown]) { expect(page).toContain('Try again'); expect(page).not.toContain('Copy address'); }
  });

  it('release and change say what they cost: intake stops at once, unread mail is discarded, the address is held 180 days', () => {
    const page = html(held('live'));
    expect(page).toContain('Release this address');
    expect(page).toContain('Releasing priya@mail.test.invalid stops its mail at once. Mail Waldo hasn’t read yet is discarded unread, and no one, you included, can claim that address for 180 days.');
    expect(page).toContain('Change your address'); expect(page).toContain('Changing it releases priya@mail.test.invalid, which stops its mail at once.');
    expect(page).toContain('Accept and change');
  });

  it('escapes what the server sends', () => {
    const page = html(record({ notice: { version: '1', text: '<img src=x>' }, domain: '<b>x</b>' }));
    expect(page).not.toContain('<img'); expect(page).not.toContain('<b>x');
  });
});

describe('the agent_mail read and claim', () => {
  const read = (data: object) => readControls({ ...base, view: 'agent_mail', data }, 'agent_mail');

  it('reads each rule state and the notice, and refuses fields that do not belong together', () => {
    for (const rule of ['pending', 'live', 'failed', 'unknown']) expect(read({ ...held(rule as 'live').data }).data.rule).toBe(rule);
    expect(read({ enabled: false, display_name: 'Waldo', actions: [] }).data).toEqual({ enabled: false, display_name: 'Waldo', actions: [] });
    for (const bad of [{ ...held('live').data, rule: 'releasing' }, { ...held('live').data, address: undefined }, { ...record().data, rule: 'live' }, { ...record().data, actions: ['agent_mail.rename'] },
      { ...held('pending').data, rule_reason: 'later' }, { ...record().data, notice: { version: 1, text: 'x' } }, { ...record().data, enabled: 'yes' }])
      expect(() => read(bad), JSON.stringify(bad)).toThrow();
  });

  it('a claim posts the handle and the notice version it showed, and nothing else', async () => {
    const posted: Record<string, string> = {};
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      for (const [key, value] of (init.body as FormData).entries()) posted[key] = String(value);
      return Response.json({ duplicate: false, receipt: { state: 'recorded', message: 'Address saved.' } });
    });
    try { await submitControl(record(), 'agent_mail.claim', { value: 'priya', notice: notice.version }, 'request-1', 'https://console.test.invalid'); }
    finally { vi.unstubAllGlobals(); }
    expect(posted).toEqual({ csrf: base.csrf, view: 'agent_mail', revision: base.revision, request_id: 'request-1', action: 'agent_mail.claim', value: 'priya', notice: '2026-10-31' });
  });
});
