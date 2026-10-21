// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const record = (count: number) => ({ version: 1, as_of: '2026-09-29T07:40:00Z', timezone: 'Asia/Kolkata', brief: { status: 'not_sent', at: null }, waiting: { count, first: count ? { id: 'p1', summary: 'Move review' } : null }, next_card: null, latest_activity: null, services: [] });
const flush = async () => { await act(async () => { await Promise.resolve(); await Promise.resolve(); }); };
describe('live console polling', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  it('re-reads the overview in the background, swaps new data in, and pauses with a notice on failure', async () => {
    vi.useFakeTimers();
    let waiting = 0, fail = false, calls = 0;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (url.includes('/overview')) { calls += 1; if (fail) throw new Error('offline'); return new Response(JSON.stringify(record(waiting)), { status: 200 }); }
      return new Response('{}', { status: 404 });
    }));
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host);
    await act(async () => { root.render(<App/>); });
    await flush();
    expect(host.textContent).toContain('Live');
    expect(host.querySelector('.topbar')?.textContent).not.toContain('2');
    const first = calls;
    waiting = 2;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); await flush();
    expect(calls).toBeGreaterThan(first);
    expect(host.querySelector('.topbar')?.textContent).toContain('2');
    fail = true;
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); }); await flush();
    expect(host.textContent).toContain('Live updates paused');
    expect(host.querySelector('.topbar')?.textContent).toContain('2');
    fail = false;
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); }); await flush();
    expect(host.textContent).not.toContain('paused');
    act(() => root.unmount());
  });
});
