// Runtime-owned capability. Never constructed from provider content or model arguments.
export type RunEffectScope = Readonly<{
  runId: string;
  attempt: string;
  deadline: number;
  signal: AbortSignal;
  // Admission of I/O only. This is not remote rollback or an effect receipt.
  admit(): void;
  // Check and local publication share one host synchronization boundary.
  commit<T>(work: () => T): T;
}>;
export class ClosedRunError extends Error {
  constructor() { super('run is closed or expired'); }
}
// Outbound I/O never outlives the run that admitted it. Without a run, the ceiling alone bounds it.
export const effectSignal = (scope: RunEffectScope | undefined, ceilingMs: number): AbortSignal => {
  const timeout = AbortSignal.timeout(Math.max(1, Math.min(ceilingMs, (scope?.deadline ?? Infinity) - Date.now())));
  if (!scope) return timeout;
  // On staging a turn's scope reached web_search with a signal that passes instanceof but that workerd's AbortSignal.any
  // rejects, and every search threw. The deadline still bounds the I/O through the timeout; only the early cancel is lost.
  try { return AbortSignal.any([scope.signal, timeout]); } catch { return timeout; }
};
