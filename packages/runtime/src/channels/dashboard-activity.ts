// Narrow read projection for the dashboard activity page: end-to-end checklist, recent trace
// (newest first) and background runs, with the keyset cursors the console already uses. Pure
// function over owner-DO state, never ConsoleView. `note` and run `summary` are the harness's own
// strings (console parity) and may contain model-derived text: the UI must render them as inert text.
import type { E2EStep, TraceRow } from './harness';

export const DASHBOARD_ACTIVITY_PATH = '/console/dashboard/api/v1/activity';

type Run = Readonly<{ id: string; kind: string; status: string; summary: string | null; parent_id: string | null; started: string; ended: string | null }>;

export const dashboardActivity = (input: Readonly<{
  now: number; steps: readonly E2EStep[]; trace: readonly TraceRow[]; runs: readonly Run[];
  page?: Readonly<{ trace_before: number | null; runs_before: number | null }>;
}>) => ({
  version: 1 as const,
  as_of: new Date(input.now).toISOString(),
  checklist: {
    seen: input.steps.filter((step) => step.state === 'ok').length,
    total: input.steps.length,
    steps: input.steps.map((step) => ({ step: step.step, state: step.state, at: step.at, note: step.note })),
  },
  trace: [...input.trace].reverse().map((row) => ({ trace: row.trace, time: row.time, hop: row.hop, ok: row.ok, ms: row.ms, note: row.note })),
  runs: input.runs.map((run) => ({ id: run.id, kind: run.kind, status: run.status, summary: run.summary, parent_id: run.parent_id, started: run.started, ended: run.ended })),
  older: { trace_before: input.page?.trace_before ?? null, runs_before: input.page?.runs_before ?? null },
});
