// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DashboardNavigation, isSettingsRoute, resolveRoute } from './App';
import { SettingsNavigation } from './Settings';
import { VaultPanel } from './Vault';

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; });

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

  it('holds passwords and payments only, says nothing is stored yet, and reads nothing', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const fetcher = vi.fn(async () => Response.json({}));
    vi.stubGlobal('fetch', fetcher);
    const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
    await act(async () => root.render(<VaultPanel/>));
    const text = host.textContent ?? '';
    for (const shown of ['Passwords', 'Sign-ins Waldo can use for you', 'Coming soon', 'Nothing is stored here yet.', 'each sign-in you save is encrypted, used only on its own website, and never shown to Waldo’s model.', 'Payments', 'Coming later']) expect(text, shown).toContain(shown);
    for (const gone of ['email code', 'locked', 'Memories', 'Logins and connections', 'Access log', 'Supabase Vault', '1Password', 'never see or store']) expect(text, gone).not.toContain(gone);
    expect(host.querySelector('a[href^="/console/signin"]')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });
});
