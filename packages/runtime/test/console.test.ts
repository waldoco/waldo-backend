import { describe, expect, it } from 'vitest';
import { consoleAccess, signInPage, parseConsoleAction, renderConsole, sessionCookie } from '../src/channels/console';
import { SAMPLE_CONSOLE_VIEW } from './fixtures/console-sample';

const memoryStore = () => {
  const data = new Map<string, unknown>();
  return {
    get: async <T>(key: string) => data.get(key) as T | undefined,
    put: async (key: string, value: unknown) => { data.set(key, value); },
    delete: async (key: string) => data.delete(key),
  };
};
const formOf = (fields: Record<string, string>) => {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  return form;
};

describe('owner console', () => {
  it('opening a link only shows a sign-in button, so link previews cannot spend the token', async () => {
    const html = await signInPage('ab12"><zz>').text();
    expect(html).toContain('<form method="post" action="/console">');
    expect(html).toContain('name="t" value="ab12"');
    expect(html).not.toContain('<zz>');
  });

  it('redeems a link once, before it expires, into a session with its own csrf token', async () => {
    let now = 1_000;
    const access = consoleAccess(memoryStore(), () => now);
    const token = new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    expect(await access.redeem('wrong')).toBeNull();
    const cookie = await access.redeem(token);
    expect(cookie).toMatch(/^[0-9a-f]{64}$/);
    expect(await access.redeem(token)).toBeNull();
    const session = await access.session(cookie);
    expect(session?.csrf).toMatch(/^[0-9a-f]{64}$/);
    expect(session?.csrf).not.toBe(cookie);
    expect(await access.session(null)).toBeNull();
    await access.signOut();
    expect(await access.session(cookie)).toBeNull();
    const again = await access.redeem(new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!);
    now += 13 * 60 * 60_000;
    expect(await access.session(again)).toBeNull();
    const late = new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    now += 11 * 60_000;
    expect(await access.redeem(late)).toBeNull();
  });

  it('reads the session cookie', () => {
    expect(sessionCookie(new Request('https://x/console', { headers: { cookie: 'a=1; waldo_console=abc' } }))).toBe('abc');
    expect(sessionCookie(new Request('https://x/console'))).toBeNull();
  });

  it('accepts only known actions carrying the session csrf token', () => {
    expect(parseConsoleAction(formOf({ action: 'spot.dismiss', id: '4', csrf: 'good' }), 'good')).toEqual({ action: 'spot.dismiss', id: '4', value: '' });
    expect(parseConsoleAction(formOf({ action: 'spot.dismiss', id: '4', csrf: 'bad' }), 'good')).toBeNull();
    expect(parseConsoleAction(formOf({ action: 'drop.tables', csrf: 'good' }), 'good')).toBeNull();
  });

  it('renders every section with working controls and escapes stored text', () => {
    const view = { ...SAMPLE_CONSOLE_VIEW, spots: [{ ...SAMPLE_CONSOLE_VIEW.spots[0]!, text: '<script>x</script>' }] };
    const html = renderConsole(view);
    for (const id of ['connections', 'spots', 'constellation', 'day', 'memory', 'activity']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('&#60;script&#62;x&#60;/script&#62;');
    expect(html).not.toContain('<zz>');
    expect(html).toContain('href="/console/google">Connect Google');
    expect(html).toContain(`name="csrf" value="${view.csrf}"`);
    expect(html).toContain('value="spot.forget"');
    expect(html).toContain('Not built yet');
    expect(html.indexOf('The Brief')).toBeLessThan(html.indexOf('Check-in'));
    expect(renderConsole({ ...view, google: { connected: false, email: null, connectAvailable: false, error: null, mail: false } })).toContain('OAuth app keys are not set');
  });
});
