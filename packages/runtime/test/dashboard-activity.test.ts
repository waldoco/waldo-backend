import { describe, expect, it } from 'vitest';
import { dashboardActivity, DASHBOARD_ACTIVITY_PATH } from '../src/channels/dashboard-activity';

const input = () => ({
  now: Date.parse('2026-10-02T00:00:00Z'),
  steps: [] as { step: string; state: 'ok' | 'failed' | 'unseen'; at: string | null; note: string | null }[],
  trace: [] as { time: string; trace: string; hop: string; ok: boolean; ms: number; note: string }[],
  runs: [] as { id: string; kind: string; status: string; summary: string | null; parent_id: string | null; started: string; ended: string | null }[],
  page: undefined as { trace_before: number | null; runs_before: number | null } | undefined,
});

describe('dashboard activity projection', () => {
  it('has a versioned path, strict empty fields and null cursors', () => {
    expect(DASHBOARD_ACTIVITY_PATH).toBe('/console/dashboard/api/v1/activity');
    expect(dashboardActivity(input())).toEqual({
      version: 1, as_of: '2026-10-02T00:00:00.000Z', checklist: { seen: 0, total: 0, steps: [] },
      trace: [], runs: [], older: { trace_before: null, runs_before: null },
    });
  });
  it('lists trace newest first with typed fields, counts seen steps, passes cursors', () => {
    const out = dashboardActivity({ ...input(),
      steps: [{ step: 'Gmail read', state: 'ok', at: 'today', note: null }, { step: 'Send', state: 'failed', at: 'today', note: 'blocked' }, { step: 'Drive', state: 'unseen', at: null, note: null }],
      trace: [{ time: '10:00', trace: 't1', hop: 'turn', ok: true, ms: 12, note: '' }, { time: '10:05', trace: 't2', hop: 'tool', ok: false, ms: 30, note: 'denied' }],
      runs: [{ id: 'r1', kind: 'delegate', status: 'failed', summary: null, parent_id: 'p1', started: '09:00', ended: null }],
      page: { trace_before: 40, runs_before: null },
    });
    expect(out.checklist).toMatchObject({ seen: 1, total: 3 });
    expect(out.trace.map((t) => t.trace)).toEqual(['t2', 't1']);
    expect(out.trace[0]).toEqual({ trace: 't2', time: '10:05', hop: 'tool', ok: false, ms: 30, note: 'denied' });
    expect(out.runs[0]).toEqual({ id: 'r1', kind: 'delegate', status: 'failed', summary: null, parent_id: 'p1', started: '09:00', ended: null });
    expect(out.older).toEqual({ trace_before: 40, runs_before: null });
  });
  it('drops extra fields and does not mutate its input order', () => {
    const trace = [{ time: 'a', trace: 't1', hop: 'h', ok: true, ms: 1, note: '', csrf: 'tok' }, { time: 'b', trace: 't2', hop: 'h', ok: true, ms: 1, note: '' }];
    const out = dashboardActivity({ ...input(), trace: trace as never });
    expect(JSON.stringify(out)).not.toMatch(/csrf|tok"/);
    expect(trace.map((t) => t.trace)).toEqual(['t1', 't2']);
  });
});
