// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardNavigation, isSettingsRoute, resolveRoute } from './App';
import { SettingsNavigation } from './Settings';
import { VaultPanel } from './Vault';
import { readVault } from './vault-model';

const revision = 'a'.repeat(64);
const vault = (over: Record<string, unknown> = {}) => ({
  version: 1, state: 'available', as_of: '2026-10-26T10:00:00.000Z',
  memory: { state: 'available', groups: [
    { kind: 'fact', total: 1, items: [{ id: 'scope:claim:7', text: 'Lives in Leeds', source_label: 'You said this', origin: 'owner', recorded_at: '2026-10-01' }] },
    { kind: 'interpretation', total: 1, items: [{ id: 'scope:node:2', text: 'Mornings are for deep work', source_label: 'Waldo\'s pattern from your Spots', origin: 'agent', recorded_at: '2026-10-05' }] },
  ] },
  connections: {
    token_note: 'Tokens are stored encrypted (Supabase Vault). Waldo\'s model never sees them.',
    google: [{ account_id: 'conn-1', email: 'owner@example.test', grants: ['calendar', 'gmail'], status: 'active', token_storage: 'supabase_vault', connected_at: null, last_used_at: null, revoke: { view: 'connections', action: 'google.disconnect' }, refresh_token: 'LEAKED-TOKEN' }],
    mcp: [{ id: 'mcp-1', name: 'Team Notes', host: 'mcp.example.test', status: 'active', scopes: ['notes.read'], tools: 3, runs_without_asking: 0, connected_at: '2026-10-20T09:00:00.000Z', last_used_at: null, revoke: { view: 'connections', action: 'mcp.disconnect' } }],
    channels: [{ channel: 'telegram', state: 'unlinked', revoke: null }, { channel: 'imessage', state: 'linked', revoke: { view: 'imessage', action: 'imessage.unlink' } }],
    health: { state: 'available', manage: 'app', rows: [{ source: 'apple', purpose: 'storage_compute', status: 'granted', granted_at: '2026-10-01T08:00:00.000Z', withdrawn_at: null, newest_upload_at: '2026-10-26T07:00:00.000Z' }] },
  },
  access_log: { window_days: 30, kept_steps: 500,
    tools: { rows: [{ at: '2026-10-26T09:00:00.000Z', tool: 'search_communication', category: 'core', kind: 'read', ok: true }, { at: '2026-10-26T08:00:00.000Z', tool: 'other', category: 'other', kind: 'unknown', ok: false }], next_before: 41, oldest_at: '2026-10-10T00:00:00.000Z' },
    approvals: { rows: [{ at: '2026-10-25T09:00:00.000Z', kind: 'email_send', decision: 'skipped', decided_at: '2026-10-25T09:05:00.000Z' }], next_before: null } },
  ...over,
});
const connections = { version: 1, view: 'connections', state: 'available', csrf: 'c'.repeat(64), revision, data: {
  google: { connectAvailable: true, accounts: [{ id: 'conn-1', email: 'owner@example.test', calendar: true, mail: true, tasks: false, health: 'access_granted' }] },
  telegram: { linked: false, unlinkAvailable: false }, sessions: { until: '2026-10-30 18:00', count: 1, items: [] },
} };
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const mount = async (fetcher: (input: string, init?: RequestInit) => Promise<Response>) => {
  window.location.hash = '#/vault';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => { calls.push({ url: input, ...(init ? { init } : {}) }); return fetcher(input, init); }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<VaultPanel/>));
  await flush();
  return { host, root, calls };
};

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; window.location.hash = ''; });

describe('the Vault page', () => {
  it('is a Settings page, outside the five top destinations', () => {
    expect(resolveRoute('vault')).toBe('vault');
    expect(isSettingsRoute('vault')).toBe(true);
    const settings = document.createElement('div'); const root = createRoot(settings);
    act(() => root.render(<SettingsNavigation selected="vault"/>));
    expect(settings.innerHTML).toMatch(/aria-current="page" href="#\/vault">Vault/);
    act(() => root.render(<DashboardNavigation route="vault"/>));
    expect(settings.innerHTML).not.toContain('#/vault');
  });

  it('without a fresh email code shows the locked state, offers the code and reads nothing else', async () => {
    const { host, root, calls } = await mount(async () => Response.json({ error: 'step_up_required' }, { status: 403 }));
    expect(host.textContent).toContain('Your Vault is locked.');
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.textContent === 'Get an email code');
    expect(link?.getAttribute('href')).toBe('/console/signin?confirm=1#/vault');
    expect(calls.map(call => call.url)).toEqual(['/console/dashboard/api/v1/vault']);
    expect(host.textContent).not.toContain('Memories');
    await act(async () => root.unmount());
  });

  it('renders every section from the read, and keeps fields it does not name off the page', async () => {
    const { host, root } = await mount(async () => Response.json(vault()));
    const text = host.textContent ?? '';
    for (const shown of ['Lives in Leeds', 'You said this', '2026-10-01', 'Patterns Waldo noticed', 'owner@example.test',
      'See, add, move and cancel events on your calendars.', 'Read your mail, write drafts and send email.', 'Tokens are stored encrypted (Supabase Vault). Waldo\'s model never sees them.',
      'Team Notes', 'mcp.example.test', 'notes.read', 'iMessage', 'Apple Health', 'Withdraw health sharing in the Waldo app.',
      'search_communication', 'Unrecognised tool', 'You said no', 'Waldo keeps its newest 500 steps',
      'Coming with 1Password. Waldo will never see or store your passwords.', 'Payments', 'Coming later.']) expect(text, shown).toContain(shown);
    expect(text).toContain('Last used: Not recorded');
    expect(host.innerHTML).not.toContain('LEAKED-TOKEN');
    expect(Object.keys(readVault(vault()).connections.google[0]!)).not.toContain('refresh_token');
    await act(async () => root.unmount());
  });

  it('reads one memory\'s controls only when that memory is opened, through the existing memory-controls read', async () => {
    const { host, root, calls } = await mount(async (url) => url.startsWith('/console/dashboard/api/v1/memory-controls')
      ? Response.json({ version: 1, view: 'memory', state: 'available', csrf: 'c'.repeat(64), revision, data: { id: 'scope:claim:7', status: 'active', review: { label: 'Lives in Leeds', note: 'synthetic' }, actions: ['spot.forget'] } })
      : Response.json(vault()));
    expect(calls.filter(call => call.url.includes('memory-controls'))).toHaveLength(0);
    const details = host.querySelector<HTMLDetailsElement>('details')!;
    await act(async () => { details.open = true; details.dispatchEvent(new Event('toggle')); });
    await flush();
    expect(calls.filter(call => call.url.includes('memory-controls')).map(call => call.url)).toEqual(['/console/dashboard/api/v1/memory-controls?id=scope%3Aclaim%3A7']);
    expect(host.textContent).toContain('Forget this Spot');
    await act(async () => root.unmount());
  });

  it('revokes through a fresh connections read and the console action path', async () => {
    vi.stubGlobal('confirm', () => true);
    const { host, root, calls } = await mount(async (url, init) => init?.method === 'POST'
      ? Response.json({ receipt: { state: 'recorded', message: 'Google disconnected. Waldo no longer reads your calendar or mail.' }, duplicate: false })
      : url.startsWith('/console/dashboard/api/v1/controls') ? Response.json(connections) : Response.json(vault()));
    const revoke = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Revoke owner@example.test')!;
    await act(async () => revoke.click());
    await flush();
    const post = calls.find(call => call.init?.method === 'POST')!;
    expect(calls.map(call => call.url)).toContain('/console/dashboard/api/v1/controls?view=connections');
    expect(post.url).toBe('/console/dashboard/api/v1/actions');
    const body = post.init!.body as FormData;
    expect({ view: body.get('view'), action: body.get('action'), id: body.get('id'), csrf: body.get('csrf'), revision: body.get('revision') })
      .toEqual({ view: 'connections', action: 'google.disconnect', id: 'conn-1', csrf: 'c'.repeat(64), revision });
    expect(host.textContent).toContain('Google disconnected.');
    await act(async () => root.unmount());
  });

  it('refuses a read whose revoke names an action the console does not offer', () => {
    const bad = vault();
    (bad.connections as { mcp: { revoke: unknown }[] }).mcp[0]!.revoke = { view: 'connections', action: 'account.delete' };
    expect(() => readVault(bad)).toThrow('unsupported data shape');
  });
});
