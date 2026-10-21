// Polling cadence for the live console. Pure helpers so they can be tested without timers.
export const LIVE_BASE_MS = 15_000;
export const LIVE_MAX_MS = 120_000;

/** Delay before the next background read: 15s when healthy, doubling to 2min after failures. */
export function nextLiveDelay(failures: number): number {
  return Math.min(LIVE_MAX_MS, LIVE_BASE_MS * 2 ** Math.max(0, failures));
}

/** Background reads run only while the tab is visible. */
export function shouldPoll(visibility: string | undefined): boolean {
  return visibility !== 'hidden';
}

/** Skip a re-render when the read returned the same record. */
export function sameRecord(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
