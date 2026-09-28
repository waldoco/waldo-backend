import { OPENAI_GPT_6_LUNA_MODEL } from '@waldo/contracts';
import { describe, expect, it } from 'vitest';
import { consoleAccess, signInPage, parseConsoleAction, consoleMayApprove, renderConsole, sessionCookie } from '../src/channels/console';
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

  it('renders background runs with status and an honest empty state', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('Background tasks');
    expect(html).toContain('delegate_task');
    expect(html).toContain('Pulled the last three invoices');
    expect(html).toContain('from so-77');
    expect(html).toContain('completed');
    // Failed runs carry the bad-row marker.
    expect(html).toContain('<div class="t bad"><span>09-23 23:00</span><span>heartbeat</span>');
    const none = renderConsole({ ...SAMPLE_CONSOLE_VIEW, runs: [] });
    expect(none).toContain('No background tasks yet.');
  });

  it('builds the Overview only from recorded state, without inventing a Brief or a successful tool read', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('id="overview"');
    expect(html).toContain('The Brief is marked sent.');
    expect(html).toContain('does not confirm delivery');
    expect(html).toContain('1 decision waiting.');
    expect(html).toContain('Google is not connected.');
    const granted = renderConsole({ ...SAMPLE_CONSOLE_VIEW, google: { accounts: [{ id: 'g1', email: 'test@example.com', error: null, calendar: true, mail: true, tasks: true }], connectAvailable: true } });
    expect(granted).toContain('Google access saved. Live reads still need a real check.');
    expect(html).not.toContain('Protected window');
    const empty = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: [], runs: [], trace: [], google: { accounts: [], connectAvailable: true }, cards: SAMPLE_CONSOLE_VIEW.cards.map((card) => ({ ...card, sent: false })) });
    expect(empty).toContain('No Brief to read here yet.');
    expect(empty).toContain('Nothing needs your approval.');
    expect(empty).toContain('Nothing recorded yet.');
    expect(empty).toContain('Google is not connected.');
  });

  it('does not mistake a past or skipped card for the next one, or an older activity page for latest movement', () => {
    const html = renderConsole({ ...SAMPLE_CONSOLE_VIEW, now: '2026-09-23 23:40', cards: SAMPLE_CONSOLE_VIEW.cards.map((card) => ({ ...card, sent: false })), page: { trace_before: null, runs_before: null, trace_applied: 1, runs_applied: 1 } });
    expect(html).toContain('No more cards scheduled ahead.');
    expect(html).toContain('Nothing recorded yet.');
    expect(html).not.toContain('22:15 · The Close');
  });

  it('renders the stat row as Figma-style cards: uppercase small labels, serif values, hover affordance', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('text-transform:uppercase');
    expect(html).toContain('.stat:hover{border-color:var(--ink4)}');
    expect(html).toContain('border-radius:16px');
  });

  it('paginates the activity lists with keyset cursors, keeping the other list in place', () => {
    const paged = renderConsole({ ...SAMPLE_CONSOLE_VIEW, page: { trace_before: 111, runs_before: 222, trace_applied: null, runs_applied: null } });
    expect(paged).toContain('href="/console?trace_before=111#activity"');
    expect(paged).toContain('href="/console?runs_before=222#activity"');
    expect(paged).toContain('Older activity');
    expect(paged).not.toContain('&larr; Latest');
    const deep = renderConsole({ ...SAMPLE_CONSOLE_VIEW, page: { trace_before: null, runs_before: 222, trace_applied: 90, runs_applied: null } });
    expect(deep).toContain('href="/console#activity"');
    expect(deep).toContain('href="/console?trace_before=90&runs_before=222#activity"');
    const plain = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(plain).not.toContain('Older activity');
    expect(plain).not.toContain('Older tasks');
  });

  it('ships purpose-gated micro-interactions: pressed states, focus rings, and a reduced-motion off-ramp', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('.btn:active{transform:translateY(1px)}');
    expect(html).toContain(':focus-visible{outline:2px solid var(--teal)');
    expect(html).toContain('prefers-reduced-motion:reduce');
    expect(html).toContain('transition:border-color .15s ease-out');
  });

  it('renders pending approvals with acting buttons and an honest empty state', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('id="approvals"');
    expect(html).toContain('Waiting on you');
    expect(html).toContain('Move &#34;Gym&#34;');
    expect(html).toContain('value="approval.approve"');
    expect(html).toContain('value="approval.skip"');
    expect(html).toContain(`value="p1"`);
    const withUndo = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: [{ id: 'p9', kind: 'calendar_change', summary: 'Moved Gym', state: 'done' as const, undoable: true, review: { kind: 'calendar_change' as const, action: 'move' as const, title: 'Gym', event_id: 'gym-1', start: '2026-09-27T07:00:00+05:30', end: '2026-09-27T08:00:00+05:30', reason: 'Move' } }] });
    expect(withUndo).toContain('value="approval.undo"');
    const noneLeft = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: [] });
    expect(noneLeft).toContain('Nothing waiting on you');
  });

  it('shows the stored recipients and full words before a send, and refuses summary-only approval', () => {
    const proposals = [
      { id: 'mail', kind: 'email_send', summary: 'Send email to me@example.test: "Deck"', state: 'open' as const, undoable: false, review: { kind: 'email_send' as const, to: ['me@example.test'], cc: ['team@example.test'], bcc: ['audit@example.test'], subject: 'Deck', body: 'First line\nSecond line with <script>x</script>' } },
      { id: 'msg', kind: 'message_send', summary: 'Send this on Telegram: "Hello"', state: 'open' as const, undoable: false, review: { kind: 'message_send' as const, channel: 'Telegram', content: 'Hello, full message.' } },
      { id: 'mcp', kind: 'mcp_call', summary: 'Run lookup on MCP server', state: 'open' as const, undoable: false, review: null },
      { id: 'browser', kind: 'browser_submit', summary: 'Click submit', state: 'open' as const, undoable: false, review: null },
    ];
    const html = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: proposals });
    expect(html).toContain('To: me@example.test');
    expect(html).toContain('CC: team@example.test');
    expect(html).toContain('BCC: audit@example.test');
    expect(html).toContain('First line\nSecond line with &#60;script&#62;');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('Channel: Telegram');
    expect(html).toContain('Hello, full message.');
    expect(html).not.toContain('>Send it</button>');
    expect(html).not.toContain('value="approval.approve"');
    expect(html).toContain('approving this send happens there. Not now dismisses it');
    // Dismissal is the safe direction: open send proposals carry Not now, never Do it.
    expect(html).toContain('value="approval.skip"');
    expect(html).toContain('This console cannot approve or dismiss it.');
    // Exactly the two open send proposals are dismissible; mcp/browser stay undecidable here.
    expect((html.match(/value="approval.skip"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('Modify</button>');
    const wrongKind = renderConsole({ ...SAMPLE_CONSOLE_VIEW, approvals: [{ ...proposals[0]!, review: { kind: 'message_send' as const, channel: 'Telegram', content: 'Wrong' } }] });
    expect(wrongKind).not.toContain('value="approval.approve"');
    expect(consoleMayApprove(proposals[0])).toBe(false);
    expect(consoleMayApprove(SAMPLE_CONSOLE_VIEW.approvals[0])).toBe(true);
    expect(consoleMayApprove(proposals[2])).toBe(false);
    expect(consoleMayApprove({ ...proposals[0]!, review: null })).toBe(false);
  });

  it('shows gate holds as kind + reason + day only - refused words never reach the page', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('Held at the gate (1)');
    expect(html).toContain('self report');
    expect(html).toContain('2026-09-25');
    expect(html).not.toContain('fingerprint');
    const none = renderConsole({ ...SAMPLE_CONSOLE_VIEW, holds: [] });
    expect(none).not.toContain('Held at the gate');
  });

  it('distinguishes stored evidence notes from original-source links and does not fake a correction action', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('Evidence note:');
    expect(html).toContain('not a link to the original message');
    expect(html).toContain('tell Waldo the correction in chat');
    expect(html).not.toContain('name="action" value="spot.correct"');
    const unknown = renderConsole({ ...SAMPLE_CONSOLE_VIEW, spots: [{ ...SAMPLE_CONSOLE_VIEW.spots[0]!, source: 'legacy' }] });
    expect(unknown).toContain('Source unverified');
    expect(unknown).not.toContain('chip">You said this');
  });

  it('marks spots grounded only in shared content', () => {
    const untrusted = { ...SAMPLE_CONSOLE_VIEW.spots[0]!, origin: 'untrusted' };
    const html = renderConsole({ ...SAMPLE_CONSOLE_VIEW, spots: [untrusted] });
    expect(html).toContain('from shared content');
    expect(renderConsole(SAMPLE_CONSOLE_VIEW)).not.toContain('from shared content');
  });

  it('renders chips from the semantic taxonomy, every state backed by view data', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    // danger: a failed removal must stand out, not render as a default sand chip
    expect(html).toContain('chip danger">Removal incomplete');
    // good: settled positive states only (a promoted spot, a sent card)
    expect(html).toContain('chip good">In constellation');
    // provisional: Waldo's inferences are unconfirmed, shared-content origin is untrusted-derived
    expect(html).toContain('chip provisional">Waldo&#39;s inference');
    const untrusted = { ...SAMPLE_CONSOLE_VIEW.spots[0]!, origin: 'untrusted' };
    expect(renderConsole({ ...SAMPLE_CONSOLE_VIEW, spots: [untrusted] })).toContain('chip provisional">from shared content');
    // neutral is the bare class: stated sources and kind labels carry no state
    expect(html).toContain('chip">You said this');
    expect(html).not.toContain('chip teal');
    expect(html).not.toContain('chip red');
    // honest consumers: with no forgetting spots, no danger chip renders
    expect(renderConsole({ ...SAMPLE_CONSOLE_VIEW, forgettingSpots: [] })).not.toContain('chip danger');
  });

  it('renders real usage numbers with a total, and an honest empty state', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('id="usage"');
    expect(html).toContain(OPENAI_GPT_6_LUNA_MODEL);
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
    expect(html).not.toContain('Allow Gmail');
    expect(row('Set quiet hours')).toContain('Done');
    const done = renderConsole({ ...SAMPLE_CONSOLE_VIEW, google: { accounts: [{ id: 'g1', email: 'a@b.c', error: null, calendar: true, mail: true, tasks: true }], connectAvailable: true } });
    expect(done.slice(done.indexOf('Connect Google'), done.indexOf('Connect Google') + 500)).toContain('Done');
    expect(done).toContain('Access granted');
    expect(done).toContain('Calendar, Gmail, Tasks');
    expect(done).toContain('Access granted · read unverified');
    expect(done).toContain('permission states, not proof');
    expect(done).not.toContain('Gmail is a separate step');
    expect(done).toContain('does not confirm that live reads work');
    const unhealthy = renderConsole({ ...SAMPLE_CONSOLE_VIEW, google: { accounts: [{ id: 'g1', email: 'a@b.c', error: 'invalid_grant', calendar: true, mail: true, tasks: true }], connectAvailable: true } });
    expect(unhealthy).toContain('Needs reconnect');
    expect(unhealthy.slice(unhealthy.indexOf('Connect Google'), unhealthy.indexOf('Connect Google') + 500)).toContain('To do');
  });

  it('keeps connection health separate from access and does not call the WhatsApp route missing', () => {
    const html = renderConsole({ ...SAMPLE_CONSOLE_VIEW, google: { connectAvailable: true, accounts: [{ id: 'g1', email: 'work@example.test', error: 'invalid_grant', calendar: true, mail: true, tasks: true }] } });
    expect(html).toContain('Reconnect needed');
    expect(html).toContain('Needs reconnect');
    expect(html).toContain('Status unknown here');
    expect(html).not.toContain('WhatsApp</div><div class="sub">Chat with Waldo on WhatsApp. Needs');
    expect(html).toContain('invite-gated email OTP');
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

  it('a spot stuck mid-forget stays visible with a working Retry action', () => {
    const html = renderConsole(SAMPLE_CONSOLE_VIEW);
    expect(html).toContain('Forget in progress (1)');
    expect(html).toContain('Old phone number ending 4123');
    expect(html).toContain('Retry forget');
    // The Retry form posts the same spot.forget action with the purging row's id, which
    // act() selects from claims('purging').
    expect(html).toMatch(/name="id" value="7"/);
    expect(html).toContain('Removal incomplete');
  });
});
