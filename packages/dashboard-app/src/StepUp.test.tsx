// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StepUpRequired } from './model';
import { ControlsActionError, readControls, submitControl } from './controls-model';
import { OwnerChangeError, OwnerControlsPanel, readOwnerControls, submitOwnerControl } from './OwnerControls';
import { ControlsPanel } from './Controls';
import { submitInvite, type AdminRecord } from './admin-model';

const revision = 'a'.repeat(64);
const connections = { version: 1, view: 'connections', state: 'available', csrf: 'c'.repeat(64), revision, data: {
  google: { connectAvailable: true, accounts: [] }, telegram: { linked: false, unlinkAvailable: false },
  sessions: { until: '2026-10-23 18:00', count: 1, items: [] },
} };
const invites = { version: 1, state: 'available', view: 'invites', csrf: 'session-csrf', revision, data: { issued: 0, limit: 5, creation_available: true, expiry_days: 14, invites: [] } };
const admin: AdminRecord = { csrf: 'admin-csrf', as_of: '2026-10-23T00:00:00Z', current_issuer: { id: 'o1', email: 'owner@example.test', issued_count: 0 }, owners: [], invites: [] };
const refused = () => Response.json({ error: 'step_up_required' }, { status: 403 });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; window.location.hash = ''; });

describe('an action that needs a fresh email code', () => {
  it('every submitter reads the refusal as a definite "not done", and a plain 403 keeps its old meaning', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => refused()));
    await expect(submitControl(readControls(connections, 'connections'), 'google.connect', { value: 'calendar' }, 'request-1')).rejects.toBeInstanceOf(StepUpRequired);
    await expect(submitOwnerControl({ record: readOwnerControls(invites, 'invites'), value: 'friend@example.test', confirmation: '', id: 'request-00001' }, 'https://console.example')).rejects.toBeInstanceOf(StepUpRequired);
    await expect(submitInvite(admin, 'invite.create', 'friend@example.test')).rejects.toBeInstanceOf(StepUpRequired);
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_action' }, { status: 403 })));
    await expect(submitControl(readControls(connections, 'connections'), 'google.connect', { value: 'calendar' }, 'request-2')).rejects.toBeInstanceOf(ControlsActionError);
    await expect(submitOwnerControl({ record: readOwnerControls(invites, 'invites'), value: 'friend@example.test', confirmation: '', id: 'request-00002' }, 'https://console.example')).rejects.toBeInstanceOf(OwnerChangeError);
  });

  it('owner controls offer the email code and come back here, and the invite form stays usable', async () => {
    window.location.hash = '#/settings/invites';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => init?.method === 'POST' ? refused() : Response.json(invites)));
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<OwnerControlsPanel view="invites"/>));
    await flush();
    const email = host.querySelector<HTMLInputElement>('input[type="email"]')!;
    await act(async () => { email.value = 'friend@example.test'; email.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => host.querySelector<HTMLFormElement>('form.control-form')!.requestSubmit());
    await flush();
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.getAttribute('href')?.startsWith('/console/signin?confirm=1'));
    expect(link?.getAttribute('href')).toBe('/console/signin?confirm=1#/settings/invites');
    expect(host.textContent).not.toContain('do not recreate the same invite blindly');
    expect(host.querySelector<HTMLButtonElement>('form.control-form button')!.disabled).toBe(false);
    await act(async () => root.unmount());
  });

  it('connections offer the email code after a refused connect', async () => {
    window.location.hash = '#/settings/connections';
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('fetch', vi.fn(async (_input: string, init?: RequestInit) => init?.method === 'POST' ? refused() : Response.json(connections)));
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<ControlsPanel view="connections"/>));
    await flush();
    const connect = [...host.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent?.includes('Connect Google'))!;
    await act(async () => connect.click());
    await flush();
    const link = [...host.querySelectorAll<HTMLAnchorElement>('a')].find(a => a.getAttribute('href')?.startsWith('/console/signin?confirm=1'));
    expect(link?.getAttribute('href')).toBe('/console/signin?confirm=1#/settings/connections');
    await act(async () => root.unmount());
  });
});
