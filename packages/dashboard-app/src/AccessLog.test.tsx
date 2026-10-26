// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dashboard } from './App';
import { readAccessLog } from './access-log-model';
import type { OverviewV1 } from './model';

const log = (over: Record<string, unknown> = {}) => ({
  version: 1, as_of: '2026-10-26T10:00:00.000Z', window_days: 30, kept_steps: 500,
  tools: { rows: [{ at: '2026-10-26T09:00:00.000Z', tool: 'search_communication', category: 'core', kind: 'read', ok: true }, { at: '2026-10-26T08:00:00.000Z', tool: 'other', category: 'other', kind: 'unknown', ok: false }], next_before: 41, oldest_at: '2026-10-10T00:00:00.000Z' },
  approvals: { rows: [{ at: '2026-10-25T09:00:00.000Z', kind: 'email_send', decision: 'skipped', decided_at: '2026-10-25T09:05:00.000Z', summary: 'LEAKED-SUBJECT' }], next_before: '1793008800000.p00a' },
  ...over,
});
const activity = { version: 1, view: 'activity', state: 'available', csrf: 'c'.repeat(64), revision: 'a'.repeat(64), data: {
  last_request: null, steps: [], trace: [], runs: [], page: { trace_before: null, runs_before: null, trace_applied: null, runs_applied: null }, ledger: '',
} };
const overview: OverviewV1 = { version: 1, as_of: '2026-10-26T10:00:00.000Z', timezone: 'UTC', brief: { status: 'not_scheduled', at: null }, waiting: { count: 0, first: null }, next_card: null, latest_activity: null, services: [] };
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const mountPatrol = async (respond: (url: string) => Response) => {
  window.location.hash = '#/patrol';
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (input: string) => { calls.push(input); return respond(input); }));
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host);
  await act(async () => root.render(<Dashboard data={overview} route="patrol"/>));
  await flush();
  return { host, root, calls };
};
const patrolReads = (url: string) => url.startsWith('/console/dashboard/api/v1/access-log') ? Response.json(log()) : Response.json(activity);

afterEach(() => { vi.unstubAllGlobals(); document.body.innerHTML = ''; window.location.hash = ''; });

describe('the access log on Patrol', () => {
  it('shows tool names, categories and approval decisions from the signed-in read, and no field it does not name', async () => {
    const { host, root, calls } = await mountPatrol(patrolReads);
    expect(calls).toContain('/console/dashboard/api/v1/access-log');
    const text = host.textContent ?? '';
    for (const shown of ['Access log', 'search_communication', 'Everyday · reads', 'Unrecognised tool', 'Failed', 'Email', 'You said no', 'Waldo keeps its newest 500 steps']) expect(text, shown).toContain(shown);
    expect(host.innerHTML).not.toContain('LEAKED-SUBJECT');
    expect(Object.keys(readAccessLog(log()).approvals.rows[0]!)).not.toContain('summary');
    await act(async () => root.unmount());
  });

  it('asks for older pages with the cursors the read gave, and can go back to the newest', async () => {
    const { host, root, calls } = await mountPatrol(patrolReads);
    const button = (label: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === label)!;
    await act(async () => button('Older approvals').click());
    await flush();
    expect(calls.at(-1)).toBe('/console/dashboard/api/v1/access-log?approvals_before=1793008800000.p00a');
    await act(async () => button('Older tool use').click());
    await flush();
    expect(calls.at(-1)).toBe('/console/dashboard/api/v1/access-log?approvals_before=1793008800000.p00a&tools_before=41');
    await act(async () => button('Back to the newest').click());
    await flush();
    expect(calls.at(-1)).toBe('/console/dashboard/api/v1/access-log');
    await act(async () => root.unmount());
  });

  it('says so when the log cannot be read, and keeps the rest of Patrol', async () => {
    const { host, root } = await mountPatrol(url => url.startsWith('/console/dashboard/api/v1/access-log') ? Response.json({ error: 'access_log_unavailable' }, { status: 503 }) : Response.json(activity));
    expect(host.textContent).toContain('Couldn’t read the access log.');
    expect(host.textContent).toContain('Patrol');
    await act(async () => root.unmount());
  });

  it('refuses a read out of shape', () => {
    for (const bad of [log({ version: 2 }), log({ approvals: { rows: [], next_before: '12; drop' } }), log({ tools: { rows: [{ at: 'x', tool: 't', category: 'c', kind: 'read', ok: true }], next_before: null, oldest_at: null } })]) {
      expect(() => readAccessLog(bad)).toThrow('unsupported data shape');
    }
  });
});
