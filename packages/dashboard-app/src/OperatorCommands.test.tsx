// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './App';
import type { OverviewV1 } from './model';

const HARNESS = '/console/dashboard/api/v1/harness';
const CSRF = 'c'.repeat(64);
const offer = { version: 1, csrf: CSRF, commands: ['/trace', '/e2e', '/usage', '/heldrows', '/ledger', '/langfuse', '/fire'] };
const activity = { version: 1, view: 'activity', state: 'available', csrf: 'd'.repeat(64), revision: 'a'.repeat(64), data: {
  last_request: null, steps: [], trace: [], runs: [], page: { trace_before: null, runs_before: null, trace_applied: null, runs_applied: null }, ledger: '',
} };
const accessLog = { version: 1, as_of: '2026-10-26T10:00:00.000Z', window_days: 30, kept_steps: 500, tools: { rows: [], next_before: null, oldest_at: null }, approvals: { rows: [], next_before: null }, sends: { rows: [], next_before: null } };
const overview: OverviewV1 = { version: 1, as_of: '2026-10-26T10:00:00.000Z', timezone: 'UTC', brief: { status: 'not_scheduled', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

const mount = async (harness: () => Response, read: () => Response = () => Response.json(offer)) => {
  window.location.hash = '#/patrol';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const posts: { command: string; csrf: string }[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string, init?: RequestInit) => {
    if (input === HARNESS && init?.method !== 'POST') return read();
    if (input === HARNESS) { const form = init!.body as URLSearchParams; posts.push({ command: form.get('command')!, csrf: form.get('csrf')! }); return harness(); }
    return input.startsWith('/console/dashboard/api/v1/access-log') ? Response.json(accessLog) : Response.json(activity);
  }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<Dashboard data={overview} route="patrol"/>));
  await flush();
  const run = async (command: string) => {
    const input = host.querySelector<HTMLInputElement>('input[name="operator-command"]')!;
    await act(async () => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!; set.call(input, command); input.dispatchEvent(new Event('input', { bubbles: true })); });
    await act(async () => host.querySelector<HTMLFormElement>('form.operator-commands')!.requestSubmit());
    await flush(); await flush();
  };
  return { host, root, posts, run, calls: (fetch as unknown as { mock: { calls: [string][] } }).mock.calls.map(([url]) => url) };
};

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; window.location.hash = ''; });

describe('diagnostics on Patrol', () => {
  it('runs a command as the signed-in owner with the session token and shows what it answered', async () => {
    const { host, root, posts, run } = await mount(() => Response.json({ output: 'llm_reply ok 3ms' }));
    await run('/trace');
    expect(posts).toEqual([{ command: '/trace', csrf: CSRF }]);
    expect(host.querySelector('pre.operator-output')?.textContent).toBe('llm_reply ok 3ms');
    await act(async () => root.unmount());
  });

  it('lists the commands this Waldo takes and reads the token from its own offer, not another view\'s', async () => {
    const { host, root, calls } = await mount(() => Response.json({ output: '' }));
    expect(host.querySelector('.operator-panel')?.textContent).toContain('/trace, /e2e, /usage, /heldrows, /ledger, /langfuse, /fire');
    expect(host.querySelector('.operator-panel')?.textContent).not.toMatch(/telegram/i);
    expect(calls.filter(url => url === HARNESS)).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('offers an owner who is not an admin only the diagnostics their read listed, with no word of /fire', async () => {
    const { host, root } = await mount(() => Response.json({ output: '' }), () => Response.json({ ...offer, commands: ['/trace', '/e2e', '/usage', '/heldrows', '/ledger'] }));
    expect(host.querySelector('#operator-commands-title')?.textContent).toBe('Diagnostics');
    expect(host.querySelector('.operator-panel')?.textContent).toContain('/trace, /e2e, /usage, /heldrows, /ledger.');
    expect(host.querySelector('.operator-panel')?.textContent).not.toContain('/fire');
    await act(async () => root.unmount());
  });

  it('is not shown on a Waldo without diagnostics', async () => {
    const { host, root } = await mount(() => Response.json({ output: '' }), () => Response.json({ error: 'not_found' }, { status: 404 }));
    expect(host.querySelector('.operator-panel')).toBeNull();
    expect(host.textContent).toContain('Access log');
    await act(async () => root.unmount());
  });

  it('says plainly when the commands were turned off meanwhile, when a command is unknown, when it is busy and when it failed', async () => {
    for (const [status, said, error, retry] of [[403, 'Your console session changed. Reload the page and try again.', 'forbidden', null], [403, 'That command is for Waldo admins.', 'admin_only', null],
      [404, 'Diagnostics are off on this Waldo.', 'not_found', null], [400, 'Waldo doesn’t know that command.', 'invalid_command', null], [429, 'Too many commands just now. Wait a minute and try again.', 'rate_limited', '60'],
      [429, 'Too many just now. Try again in 10 minutes.', 'rate_limited', '600'], [429, 'Too many just now. Try again in 24 hours.', 'rate_limited', '86400'], [429, 'Too many commands just now. Wait a minute and try again.', 'rate_limited', null], [503, 'The command didn’t finish. Try again.', 'unavailable', null]] as const) {
      const { host, root, run } = await mount(() => Response.json({ error }, { status, headers: retry ? { 'retry-after': retry } : {} }));
      await run('/fire fetch');
      expect(host.querySelector('[role="alert"]')?.textContent, `${status} ${error} ${retry}`).toBe(said);
      expect(host.querySelector('pre.operator-output')).toBeNull();
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    }
  });

  it('shows no form until its read gives the session token, and none when that read fails or is out of shape', async () => {
    for (const read of [() => Response.json({ error: 'unavailable' }, { status: 503 }), () => Response.json({ version: 1, csrf: '', commands: [] }), () => Response.json({ version: 2, csrf: CSRF, commands: [] })]) {
      const { host, root } = await mount(() => Response.json({ output: '' }), read);
      expect(host.querySelector('form.operator-commands')).toBeNull();
      await act(async () => root.unmount());
      document.body.innerHTML = '';
    }
  });

  it('refuses an answer out of shape instead of showing it', async () => {
    const { host, root, run } = await mount(() => Response.json({ output: 7 }));
    await run('/usage');
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('The command didn’t finish. Try again.');
    await act(async () => root.unmount());
  });
});
