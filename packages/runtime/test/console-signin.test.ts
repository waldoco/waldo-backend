import { describe, expect, it, vi } from 'vitest';
import { handleConsole } from '../src/channels/console-signin';
import type { ConsoleAuth } from '../src/identity/console-auth';

const owners = () => {
  const fetch = vi.fn(async (input: RequestInfo) => new Response(typeof input === 'string' && input.endsWith('/grant-console') ? 'session-token' : 'console page'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const auth = (overrides: Partial<ConsoleAuth> = {}): ConsoleAuth => ({
  sendCode: vi.fn(async () => true),
  verify: vi.fn(async () => null),
  issueLinkCode: vi.fn(async () => null),
  saveSettings: vi.fn(async () => true),
  unlinkTelegram: vi.fn(async () => true),
  deleteOwner: vi.fn(async () => true),
  adminOverview: vi.fn(async () => null),
  invite: vi.fn(async () => false),
  revokeInvite: vi.fn(async () => false),
  ownerCookie: vi.fn(async (doName: string) => `${doName}.session.sig`),
  readOwnerCookie: vi.fn(async () => null),
  listSessions: vi.fn(async () => []),
  revokeSession: vi.fn(async () => true),
  signOutAll: vi.fn(async () => 2),
  ...overrides,
});
const form = (path: string, fields: Record<string, string>) => new Request(`https://w.test${path}`, { method: 'POST', body: new URLSearchParams(fields) });

describe('handleConsole', () => {
  it('sign-out-everywhere drops server-side sessions and clears both cookies', async () => {
    const signOutAll = vi.fn(async () => 3);
    const response = await handleConsole(
      new Request('https://w.test/console/signout-all', { method: 'POST' }),
      { TELEGRAM_OWNER_DO: owners().ns },
      auth({ readOwnerCookie: vi.fn(async () => 'do-a'), signOutAll }),
    );
    expect(response?.status).toBe(303);
    expect(signOutAll).toHaveBeenCalledWith('do-a');
    const cleared = response?.headers.get('set-cookie') ?? '';
    expect(cleared).toContain('waldo_owner=');
    expect(cleared).toContain('Max-Age=0');
  });

  it('stays out of the way when Supabase sign-in is not configured', async () => {
    expect(await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: owners().ns }, null)).toBeNull();
  });

  it('sends a signed-out visitor to the email form', async () => {
    const response = await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: owners().ns }, auth());
    expect(response?.status).toBe(303);
    expect(response?.headers.get('location')).toBe('/console/signin');
  });

  it('gives the same answer for an invited and an unknown address', async () => {
    const a = auth();
    const known = await (await handleConsole(form('/console/signin', { email: 'owner@example.com' }), { TELEGRAM_OWNER_DO: owners().ns }, a))!.text();
    const unknown = await (await handleConsole(form('/console/signin', { email: 'nobody@example.com' }), { TELEGRAM_OWNER_DO: owners().ns }, a))!.text();
    expect(known.replaceAll('owner@example.com', 'X')).toBe(unknown.replaceAll('nobody@example.com', 'X'));
    expect(a.sendCode).toHaveBeenCalledTimes(2);
  });

  it('a verified code gets a session from that owner DO and both cookies', async () => {
    const { ns, fetch, idFromName } = owners();
    const response = (await handleConsole(form('/console/verify', { email: 'owner@example.com', code: '123456' }), { TELEGRAM_OWNER_DO: ns }, auth({ verify: vi.fn(async () => 'do-a') })))!;
    expect(response.status).toBe(303);
    expect(idFromName).toHaveBeenCalledWith('do-a');
    expect(fetch.mock.calls[0]?.[0]).toBe('https://telegram-owner/grant-console');
    const cookies = [...response.headers].filter(([name]) => name === 'set-cookie').map(([, value]) => value);
    expect(cookies.some((cookie) => cookie.startsWith('waldo_console=session-token;') && cookie.includes('HttpOnly') && cookie.includes('SameSite=Strict'))).toBe(true);
    expect(cookies.some((cookie) => cookie.startsWith('waldo_owner=do-a.session.sig;'))).toBe(true);
  });

  it('a wrong code wakes no owner DO', async () => {
    const { ns, fetch } = owners();
    const response = (await handleConsole(form('/console/verify', { email: 'owner@example.com', code: '000000' }), { TELEGRAM_OWNER_DO: ns }, auth()))!;
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('did not work');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes a signed-in request to the owner named by the verified cookie only', async () => {
    const { ns, fetch, idFromName } = owners();
    await handleConsole(new Request('https://w.test/console'), { TELEGRAM_OWNER_DO: ns }, auth({ readOwnerCookie: vi.fn(async () => 'do-b') }));
    expect(idFromName).toHaveBeenCalledWith('do-b');
    expect((fetch.mock.calls[0]?.[0] as Request).headers.get('x-waldo-do-name')).toBe('do-b');
  });
});
