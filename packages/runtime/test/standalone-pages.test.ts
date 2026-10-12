import { describe, expect, it, vi } from 'vitest';
import { deviceConsoleAction, devicesUnavailablePage, renderDevices } from '../src/devices/console-devices';
import { workspacePage, workspaceDownload, workspaceReceipt } from '../src/channels/console-workspace';
import { workspaceRequest } from '../src/channels/workspace-host';
import { browserHandoffConsole } from '../src/channels/browser-handoff-console';
import { inviteReceipt, renderMemberInvites } from '../src/channels/console-invites';
import { renderAdmin } from '../src/channels/console-admin';
import { handleConsole } from '../src/channels/console-signin';
import { handleSignup } from '../src/channels/console-signup';
import { consoleNotice, signInPage, telegramLinkResult } from '../src/channels/console';
import { consentPage } from '../src/channels/google-oauth';
import { artifactPage, ARTIFACT_PATH } from '../src/channels/artifact-delivery';
import type { ArtifactBook, ReadResult } from '../src/channels/artifacts';
import type { ConsoleAuth } from '../src/identity/console-auth';

const browser = { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' };
const device = { device_id: 'device_fixture', label: '<script>hostile</script>', capabilities: 'machine_state_query,notify_local', created_at: '2026-10-11T10:00:00Z', last_seen_at: null, online: true };
const fileMeta = { file_id: '00000000-0000-4000-8000-000000000001', path: 'notes/<script>x</script>.md', revision: 2, mime: 'text/markdown', byte_size: 4096, sha256: 'never-public', provenance: 'owner_upload', source_taint: 'external', created_at: 0, updated_at: 0, state: 'ready' } as const;
const artifact: ReadResult = { meta: { id: 'art:test', name: '<b>Report</b>', kind: 'document', revision: 1, byte_size: 6, r2_key: 'private-key', provenance: 'tool', taint: 'external', created_at: 0, updated_at: 0 }, text: '# Heading\n- item', total_chars: '# Heading\n- item'.length, next_offset: null };
const book = (result: ReadResult | null = artifact) => ({ read: async () => result, byId: () => result?.meta ?? null } as unknown as ArtifactBook);
const handoff = (status: 'waiting' | 'none' = 'waiting', allowed = true) => ({
  csrf: 'csrf_fixture', ownerScope: 'owner_fixture', limiter: { limit: async () => ({ success: allowed }) }, assertConsole: async () => {},
  status: async () => status === 'waiting' ? { state: 'pending', origin: 'https://login.fixture.invalid', reason: 'Owner <login>', expiresAt: Date.now() + 1000 } : undefined,
  open: async () => 'https://live.browser.run/ui/view?mode=tab', cancel: async () => {},
});
const handoffPost = (body: string) => new Request('https://fixture.invalid/console/browser-handoff', { method: 'POST', headers: { origin: 'https://fixture.invalid', 'content-type': 'application/x-www-form-urlencoded' }, body });

// Every family, rendered in a representative state, as the browser would receive it.
const families = async (): Promise<Record<string, string>> => ({
  devices: renderDevices([{ ...device, commands: [] }], 'csrf_fixture'),
  devicesUnavailable: devicesUnavailablePage(),
  workspace: await workspacePage([fileMeta], 'csrf_fixture', null).text(),
  workspaceReceipt: await workspaceReceipt('remove', { status: 200, body: { status: 'cleanup_pending' } }).text(),
  handoff: await (await browserHandoffConsole(new Request('https://fixture.invalid/console/browser-handoff'), handoff())).text(),
  invites: renderMemberInvites([], 'csrf_fixture'),
  admin: renderAdmin({ owners: [], invites: [] } as never, 'csrf_fixture'),
  signin: await (await handleConsole(new Request('https://fixture.invalid/console/signin'), { TELEGRAM_OWNER_DO: {} } as never, {} as ConsoleAuth))!.text(),
  signup: await (await handleSignup(new Request('https://fixture.invalid/console/signup'), {} as never, null, null)).text(),
  ticket: await signInPage('c1.fixture.' + 'a'.repeat(64)).text(),
  oauth: await consentPage({ kind: 'invalid' }, null).text(),
  artifact: await (await artifactPage(new Request(`https://fixture.invalid${ARTIFACT_PATH}/art%3Atest`), book()))!.text(),
  telegramLink: await telegramLinkResult('LINKFIXTURE', 'fixture').text(),
});

describe('standalone worker pages share the dashboard presentation', () => {
  it('every family is a complete, language-tagged, mobile-ready document in dashboard tokens', async () => {
    for (const [name, html] of Object.entries(await families())) {
      expect(html, name).toMatch(/^<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">/);
      expect(html, name).toContain('--canvas:#f4f3f0');
      expect(html, name).toContain('--r-card:20px');
      expect(html, name).toContain('class="waldo-mark"');
      // Retired independent themes stay retired: no auto-dark, no browser-blue, no classic serif.
      for (const retired of ['prefers-color-scheme', '#2a6fdb', '#5267AF', 'Instrument Serif', '#FAFAF8', '#fafaf8']) expect(html, `${name} ${retired}`).not.toContain(retired);
      expect(html, name).not.toContain('<table');
    }
  });

  it('auth and public result pages never present owner navigation or a dashboard link', async () => {
    const pages = await families();
    for (const name of ['signin', 'signup', 'ticket', 'oauth'] as const) {
      expect(pages[name], name).not.toContain('aria-label="Waldo dashboard home"');
      expect(pages[name], name).not.toContain('Back to dashboard');
    }
    for (const name of ['signin', 'signup', 'ticket'] as const) expect(pages[name], name).not.toContain('href="/console"');
    for (const name of ['devices', 'workspace', 'handoff', 'invites', 'admin', 'artifact'] as const) expect(pages[name], name).toContain('href="/console"');
  });
});

describe('devices', () => {
  it('labels every command control and keeps commands, history and revoke on separate rows', () => {
    const html = renderDevices([{ ...device, commands: [{ command_id: 'c', class: 'notify_local', state: 'delivery_unknown', result_status: null, result_state: 'unknown', issued_at: 1, expires_at: 2 }] }], 'csrf_fixture');
    expect(html).toContain('<label for="query-0">Question</label><select id="query-0" name="query_kind">');
    for (const kind of ['session_status', 'attempt_status', 'worktree_watch']) expect(html).toContain(`<option value="${kind}">`);
    expect(html).toContain('<label>Severity <select name="severity">');
    expect(html).toContain('<label>Notification text <select name="body">');
    // Literal states stay literal and neutral; nothing reads as confirmed.
    expect(html).toContain('<span class="chip">delivery_unknown</span>');
    expect(html).toContain('Reported result: unknown');
    expect(html).not.toMatch(/delivery_unknown<\/span>[^<]*positive|chip positive">delivery_unknown/);
    expect(html).toContain('<button class="danger">Revoke</button>');
    expect(html).toContain('2026-10-11 10:00 UTC');
    expect(html).not.toContain('<script>hostile</script>');
  });

  it('renders the empty state and absent capabilities without inventing any', () => {
    expect(renderDevices([], 'csrf')).toContain('No devices are paired yet.');
    const bare = renderDevices([{ ...device, capabilities: '', online: false }], 'csrf');
    expect(bare).toContain('None reported');
    expect(bare).not.toContain('device.query');
    expect(bare).not.toContain('device.notify');
    expect(bare).toContain('Never');
  });

  it('pairing returns a styled one-time receipt only to browsers; other callers keep the text contract', async () => {
    const directory = () => ({ issuePairingCode: vi.fn(async () => true), revokeDevice: vi.fn() });
    const form = () => { const value = new FormData(); value.set('action', 'device.pair'); value.set('csrf', 'csrf'); return value; };
    const text = await deviceConsoleAction(form(), 'csrf', 'owner', directory());
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toMatch(/^[^\n]+\nExpires in 10 minutes\. Single use\.$/);
    const page = await deviceConsoleAction(form(), 'csrf', 'owner', directory(), undefined, true);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await page.text();
    expect(html).toMatch(/<code class="secret">[^<]+<\/code>/);
    expect(html).toContain('expires in 10 minutes');
  });

  it('a refused browser action is a styled page with the same status; API callers keep plain text', async () => {
    const form = new FormData(); form.set('action', 'device.pair'); form.set('csrf', 'wrong');
    const directory = { issuePairingCode: vi.fn(), revokeDevice: vi.fn() };
    expect(await (await deviceConsoleAction(form, 'csrf', 'owner', directory)).text()).toBe('invalid');
    const page = await deviceConsoleAction(form, 'csrf', 'owner', directory, undefined, true);
    expect(page.status).toBe(403);
    expect(await page.text()).toContain('role="alert"');
    expect(directory.issuePairingCode).not.toHaveBeenCalled();
  });
});

describe('workspace', () => {
  it('styles through a per-response nonce while scripts and other style sources stay blocked', async () => {
    const response = workspacePage([fileMeta], 'csrf', null);
    const policy = response.headers.get('content-security-policy')!;
    const nonce = /style-src 'nonce-([^']+)'/.exec(policy)?.[1];
    expect(nonce).toBeTruthy();
    expect(await response.text()).toContain(`<style nonce="${nonce}">`);
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('script-src');
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('keeps JSON for API callers and gives native form posts the same outcome as a page', async () => {
    const reject = (headers: Record<string, string>) => workspaceRequest(new Request('https://fixture/console/workspace/remove', { method: 'POST', headers: { origin: 'https://other.invalid', ...headers }, body: 'x' }), 'csrf', vi.fn(), workspacePage, vi.fn(), workspaceDownload);
    const json = await reject({ accept: 'application/json' });
    expect(json.status).toBe(403);
    expect(await json.json()).toEqual({ error: 'workspace_rejected' });
    const page = await reject(browser);
    expect(page.status).toBe(403);
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await page.text()).toContain('role="alert"');

    const remove = (headers: Record<string, string>) => { const form = new FormData(); form.set('csrf', 'csrf'); form.set('file_id', fileMeta.file_id); form.set('revision', '2'); return workspaceRequest(new Request('https://fixture/console/workspace/remove', { method: 'POST', headers, body: form }), 'csrf', async () => ({ tombstone: async () => ({ status: 'cleanup_pending' }) }) as never, workspacePage, vi.fn(), workspaceDownload); };
    expect(await (await remove({ accept: 'application/json' })).json()).toEqual({ status: 'cleanup_pending' });
    const receipt = await (await remove(browser)).text();
    // Pending cleanup never reads as deleted bytes.
    expect(receipt).toContain('Removal recorded.');
    expect(receipt).toContain('cleanup is pending');
    expect(receipt).not.toContain('<h1>Removed.</h1>');
  });

  it('a failed read is never described as an unconfirmed write', async () => {
    const html = await workspaceReceipt('list', { status: 503, body: { error: 'workspace_unavailable' } }).text();
    expect(html).toContain('Private workspace unavailable.');
    expect(html).not.toContain('Outcome unconfirmed');
  });
});

describe('browser handoff', () => {
  it('waiting state shows request context, caution and separate open/close actions without opening', async () => {
    const options = handoff(); const open = vi.spyOn(options, 'open');
    const html = await (await browserHandoffConsole(new Request('https://fixture.invalid/console/browser-handoff'), options)).text();
    expect(open).not.toHaveBeenCalled();
    expect(html).toContain('Owner &lt;login&gt;');
    expect(html).toContain('Check the actual address in the provider viewer');
    expect(html).toContain('<button class="primary" name="action" value="open">');
    expect(html).toContain('<button class="danger" name="action" value="cancel">');
    expect(html).not.toContain('<iframe');
  });

  it('active viewer uses the bounded responsive frame and keeps the close control', async () => {
    const html = await (await browserHandoffConsole(handoffPost('csrf=csrf_fixture&action=open'), handoff())).text();
    expect(html).toContain('<iframe class="viewer"');
    expect(html).not.toContain('style="width:100%;height:75vh"');
    expect(html).toContain('value="cancel"');
  });

  it('every refusal and outcome keeps its status and reads as the shared state page', async () => {
    const cases: [Response, number][] = [
      [await browserHandoffConsole(new Request('https://fixture.invalid/console/browser-handoff'), handoff('none')), 409],
      [await browserHandoffConsole(handoffPost('csrf=csrf_fixture&action=open'), handoff('waiting', false)), 429],
      [await browserHandoffConsole(handoffPost('csrf=wrong&action=open'), handoff()), 403],
      [await browserHandoffConsole(handoffPost('csrf=csrf_fixture&action=cancel'), handoff()), 200],
      [await browserHandoffConsole(new Request('https://fixture.invalid/console/browser-handoff', { method: 'PUT' }), handoff()), 405],
    ];
    for (const [response, status] of cases) {
      expect(response.status).toBe(status);
      const html = await response.text();
      expect(html).toContain('class="tile card-body"');
      expect(html).toContain('--canvas:#f4f3f0');
    }
  });
});

describe('invites, admin and one-time receipts', () => {
  it('invite rows stack recipient, status and dates; five issued removes the form', () => {
    const invite = (n: number) => ({ email: `p${n}@example.test`, created_at: '2026-10-11T00:00:00Z', expires_at: '2026-10-25T00:00:00Z', used_at: null, revoked_at: null });
    const html = renderMemberInvites([invite(1)], 'csrf');
    expect(html).toContain('1/5 issued');
    expect(html).toContain('<span class="chip">Pending</span>');
    expect(html).toContain('<dt>Expires</dt><dd class="time">2026-10-25</dd>');
    expect(renderMemberInvites([1, 2, 3, 4, 5].map(invite) as never, 'csrf')).toContain('You have used all five invites.');
  });

  it('admin keeps revoke only for open invites and escapes records', () => {
    const html = renderAdmin({ owners: [{ email: '<b>x</b>', state: 'active', presences: [], created_at: '2026-10-11T10:00:00Z' }], invites: [{ id: 'i-open', email: 'a@example.test', created_at: '2026-10-11T00:00:00Z', expires_at: '2999-01-01T00:00:00Z', used_at: null, revoked_at: null }] } as never, 'csrf"x');
    expect(html).toContain('<button class="danger">Revoke</button>');
    expect(html).not.toContain('<b>x</b>');
    expect(html).toContain('value="csrf&#34;x"');
  });

  it('invite receipts: browsers get the one-time page, every other caller the stable text', async () => {
    const link = 'https://fixture.invalid/console/signup#email=a%40b.test&invite=CODE';
    const text = inviteReceipt(new Request('https://fixture.invalid/console/action', { method: 'POST' }), 'a@b.test', link, '/console/invites');
    expect(text.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await text.text()).toBe(`Invite for a@b.test: ${link} (expires in 14 days). Copy it now and send it yourself. Waldo did not email anyone.`);
    const page = inviteReceipt(new Request('https://fixture.invalid/console/action', { method: 'POST', headers: browser }), '<b>a</b>', link, '/console/invites');
    expect(page.headers.get('cache-control')).toBe('no-store');
    expect(page.headers.get('referrer-policy')).toBe('no-referrer');
    const html = await page.text();
    expect(html).toContain(`<code class="secret">${link.replaceAll('&', '&#38;')}</code>`);
    expect(html).toContain('Waldo did not email anyone.');
    expect(html).not.toContain('<b>a</b>');
  });

  it('telegram link result shows the exact instruction once, and an honest unavailable state', async () => {
    const html = await telegramLinkResult('ABC<1>', 'unused').text();
    expect(html).toContain('<code class="secret">/link ABC&#60;1&#62;</code>');
    expect(html).toContain('within 10 minutes');
    const missing = await telegramLinkResult(null, 'Linking Telegram from the console needs account sign-in.').text();
    expect(missing).toContain('Telegram linking unavailable');
    expect(missing).not.toContain('/link ');
  });
});

describe('auth entry and result pages', () => {
  it('ticket refusals never echo the rejected link and keep their status', async () => {
    const page = consoleNotice(new Request('https://fixture.invalid/console?t=c1.secret', { headers: browser }), 403, 'This console link is used or expired.', 'Send /console to Waldo for a new one.');
    expect(page.status).toBe(403);
    expect(await page.text()).not.toContain('c1.secret');
    const text = consoleNotice(new Request('https://fixture.invalid/console', { method: 'POST' }), 403, 'title', 'Invalid console link.');
    expect(await text.text()).toBe('Invalid console link.');
  });

  it('the ticket page shows a button without spending the ticket and never reflects a malformed token', async () => {
    const html = await signInPage('"><script>x</script>').text();
    expect(html).toContain('<button class="primary">Open console</button>');
    expect(html).not.toContain('<script>x');
  });

  it('the OAuth result keeps a single hashed script and an ink return action', async () => {
    const html = await consentPage({ kind: 'linked', email: 'me@example.test', scopes: [] }, 'waldo_bot', 'telegram').text();
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html).toContain('<a class="button-link" href="https://t.me/waldo_bot">Back to Telegram</a>');
    expect(html).toContain('does not confirm a live Calendar or Gmail read yet');
  });

  it('artifact errors are styled for browsers without reflecting the requested ID; API callers keep text', async () => {
    const id = 'art%3Amissing_canary';
    const page = await artifactPage(new Request(`https://fixture.invalid${ARTIFACT_PATH}/${id}`, { headers: browser }), book(null));
    expect(page!.status).toBe(404);
    expect(await page!.text()).not.toContain('missing_canary');
    expect(await (await artifactPage(new Request(`https://fixture.invalid${ARTIFACT_PATH}/${id}`), book(null)))!.text()).toBe('not found');
  });
});
