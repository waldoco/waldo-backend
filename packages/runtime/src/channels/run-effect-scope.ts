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
