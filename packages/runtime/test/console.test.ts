import { OPENAI_GPT_5_MINI_MODEL } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { approvalRedirectCode, consoleAccess, signInPage, parseConsoleAction, renderConsole, sessionCookie, NOTICES } from '../src/channels/console';
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
    await access.signOut(cookie!);
    expect(await access.session(cookie)).toBeNull();
    const again = await access.redeem(new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!);
    now += 13 * 60 * 60_000;
    expect(await access.session(again)).toBeNull();
    const late = new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    now += 11 * 60_000;
    expect(await access.redeem(late)).toBeNull();
  });

  it('redeeming on a browser that already holds a live session refreshes it instead of stacking', async () => {
    let now = 1_000;
    const access = consoleAccess(memoryStore(), () => now);
    const mint = async () => new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    const cookie = (await access.redeem(await mint()))!;
    now += 60_000;
    const again = await access.redeem(await mint(), cookie);
    expect(again).toBe(cookie);
    const refreshed = await access.session(cookie);
    expect(refreshed?.expires).toBe(now + 12 * 60 * 60_000);
    now += 11 * 60 * 60_000;
    expect(await access.session(cookie)).not.toBeNull();
  });

  it('keeps sessions per browser: a second browser gets its own, sign-out kills only that one', async () => {
    const access = consoleAccess(memoryStore(), () => 1_000);
    const mint = async () => new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    const browserA = (await access.redeem(await mint()))!;
    const browserB = (await access.redeem(await mint()))!;
    expect(browserB).not.toBe(browserA);
    expect(await access.session(browserA)).not.toBeNull();
    expect(await access.session(browserB)).not.toBeNull();
    await access.signOut(browserA);
    expect(await access.session(browserA)).toBeNull();
    expect(await access.session(browserB)).not.toBeNull();
    // An expired session cookie does not refresh: redeeming with it creates a fresh session.
    let clock = 5_000;
    const store = memoryStore();
    const timed = consoleAccess(store, () => clock);
    const mintTimed = async () => new URL(await timed.mintLink('https://waldo.example')).searchParams.get('t')!;
    const old = (await timed.redeem(await mintTimed()))!;
    clock += 13 * 60 * 60_000;
    expect(await timed.session(old)).toBeNull();
    const fresh = (await timed.redeem(await mintTimed(), old))!;
    expect(fresh).not.toBe(old);
    expect(await timed.session(old)).toBeNull();
    expect(await timed.session(fresh)).not.toBeNull();
  });

  it('lists live sessions and sign-out-everywhere kills them all', async () => {
    let now = 1_000;
    const access = consoleAccess(memoryStore(), () => now);
    const mint = async () => new URL(await access.mintLink('https://waldo.example')).searchParams.get('t')!;
    const a = (await access.redeem(await mint()))!;
    const b = (await access.redeem(await mint()))!;
    expect((await access.list()).map((session) => session.token).sort()).toEqual([a, b].sort());
    now += 13 * 60 * 60_000;
    expect(await access.list()).toEqual([]);
    const c = (await access.redeem(await mint()))!;
    const d = (await access.redeem(await mint()))!;
    await access.signOutAll();
    expect(await access.list()).toEqual([]);
    expect(await access.session(c)).toBeNull();
    expect(await access.session(d)).toBeNull();
  });

  it('renders pending approvals with acting buttons and an honest empty state', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('id="approvals"');
    expect(html).toContain('Waiting on you');
    expect(html).toContain('Move &#34;Gym&#34;');
    expect(html).toContain('value="approval.approve"');
    expect(html).toContain('value="approval.skip"');
    expect(html).toContain(`value="p1"`);
    const unconfirmed = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: [{ id: 'p7', summary: 'Send Hello to a@x.test', state: 'unknown' as const, undoable: false }] });
    // An unreconciled send must never render as a green Done: explicit Send unconfirmed chip,
    // recovery guidance, and both resolution actions - a false success receipt is the bug.
    expect(unconfirmed).toContain('Send unconfirmed');
    expect(unconfirmed).toContain('Check Sent');
    expect(unconfirmed).toContain('I checked Sent - not there');
    expect(unconfirmed).toContain('value="approval.reconcile"');
    expect(unconfirmed).toContain('value="approval.notsent"');
    const unknownRow = unconfirmed.split('\n').filter((l) => l.includes('p7') || l.includes('Send Hello')).join('\n');
    expect(unknownRow).not.toContain('>Done<');

    const withUndo = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: [{ id: 'p9', summary: 'Moved Gym', state: 'done' as const, undoable: true }] });
    expect(withUndo).toContain('value="approval.undo"');
    const noneLeft = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: [] });
    expect(noneLeft).toContain('Nothing waiting on you');
  });

  it('renders real usage numbers with a total, and an honest empty state', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('id="usage"');
    expect(html).toContain(OPENAI_GPT_5_MINI_MODEL);
    expect(html).toContain('12 calls, 48.2k in (25% cached), 3.9k out');
    expect(html).toContain('$0.0231');
    expect(html).toContain('Total');
    expect(renderConsole({ ...SAMPLE_CONSOLE_VIEW, usage: [] })).toContain('No model calls recorded yet');
  });

  it('checklist reflects real connection state, honestly marking what is not done', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('id="checklist"');
    // Fixture: telegram linked, no google account, quiet hours set.
    const row = (label: string) => html.slice(html.indexOf(label), html.indexOf(label) + 400);
    expect(row('Link Telegram')).toContain('Done');
    expect(row('Connect Google')).toContain('To do');
    expect(row('Allow Gmail')).toContain('To do');
    expect(row('Set quiet hours')).toContain('Done');
    const done = renderConsole({ ...SAMPLE_CONSOLE_VIEW, google: { accounts: [{ id: 'g1', email: 'a@b.c', error: null, mail: true }], connectAvailable: true } });
    expect(done.slice(done.indexOf('Connect Google'), done.indexOf('Connect Google') + 400)).toContain('Done');
  });

  it('shows the browser count and offers sign-out-everywhere only when more than one browser is signed in', () => {
    const one = renderConsole({ ...SAMPLE_CONSOLE_VIEW, sessionCount: 1 });
    expect(one).toContain('on 1 browser.');
    expect(one).not.toContain('session.signout.all');
    const two = renderConsole({ ...SAMPLE_CONSOLE_VIEW, sessionCount: 2 });
    expect(two).toContain('on 2 browsers.');
    expect(two).toContain('session.signout.all');
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
    for (const id of ['checklist', 'approvals', 'connections', 'spots', 'constellation', 'day', 'memory', 'usage', 'activity']) expect(html).toContain(`id="${id}"`);
    expect(html).toContain('&#60;script&#62;x&#60;/script&#62;');
    expect(html).not.toContain('<zz>');
    // S5: connect is a CSRF-checked POST that 303s to a /c/<ticket>; no GET link that a preview could mint from.
    expect(html).toContain('<input type="hidden" name="action" value="google.connect"><input type="hidden" name="value" value="calendar">');
    expect(html).not.toContain('href="/console/google');
    expect(html).toContain(`name="csrf" value="${view.csrf}"`);
    expect(html).toContain('value="spot.forget"');
    expect(html).toContain('Not built yet');
    expect(html.indexOf('The Brief')).toBeLessThan(html.indexOf('Check-in'));
    expect(renderConsole({ ...view, google: { accounts: [], connectAvailable: false } })).toContain('OAuth app keys are not set');
  });
});

describe('approvalRedirectCode privacy boundary', () => {
  it('never carries decision message content into the redirect code', () => {
    const marker = 'PRIVATE-SUBJECT-cat-facts-to-alice@example.com';
    for (const toast of ['Sent', 'Found in Sent', 'Send unconfirmed', 'Not in Sent yet', 'Marked as not sent', 'Already handled.', 'That failed', 'Google is not connected', 'Account unavailable', marker]) {
      const code = approvalRedirectCode(toast);
      expect(code).not.toContain(marker);
      expect(code).toMatch(/^approval\.[a-z]+$/);
      expect(NOTICES[code]).toBeTruthy();
      expect(NOTICES[code]).not.toContain(marker);
    }
  });
});

describe('console approval notices stay truthful on failure', () => {
  it('failure classes never render the Done fallback', () => {
    expect(approvalRedirectCode('That failed')).toBe('approval.failed');
    expect(approvalRedirectCode('Google is not connected')).toBe('approval.offline');
    expect(approvalRedirectCode('Account unavailable')).toBe('approval.unavailable');
    expect(NOTICES['approval.failed']).not.toContain('Done');
    expect(NOTICES['approval.offline']).not.toContain('Done');
    expect(NOTICES['approval.unavailable']).not.toContain('Done');
  });

  it('expired, changed, skipped and change-request outcomes get their own accurate statuses', () => {
    // Owner review on #202: these fell into a fallback that claimed "Telegram has the details"
    // while the console action only redirects. Each outcome now says what actually happened.
    expect(approvalRedirectCode('This proposal expired')).toBe('approval.expired');
    expect(NOTICES['approval.expired']).toContain('expired');
    expect(NOTICES['approval.expired']).toContain('nothing happened');
    expect(approvalRedirectCode('Email changed')).toBe('approval.changed');
    expect(approvalRedirectCode('The event changed')).toBe('approval.changed');
    expect(NOTICES['approval.changed']).toContain('nothing was sent');
    expect(approvalRedirectCode('Not now')).toBe('approval.skipped');
    expect(NOTICES['approval.skipped']).toContain('Nothing changed');
    expect(approvalRedirectCode('Tell me what to change')).toBe('approval.change');
    expect(approvalRedirectCode("Can't be undone")).toBe('approval.cannotundo');
  });

  it('no approval notice claims Telegram has details - the console redirect sends nothing there', () => {
    for (const [code, text] of Object.entries(NOTICES)) {
      if (code.startsWith('approval.')) expect(text).not.toContain('Telegram');
    }
  });
});
