export const FRAME_BUDGET = { limit: 120, seconds: 60 } as const;
export const PRINCIPAL_CACHE_SECONDS = 10;
export type FrameWindow = { window_start: number; count: number };
export function admitFrame(state: FrameWindow | undefined, now: number): FrameWindow | null {
  if (!state || now - state.window_start >= FRAME_BUDGET.seconds) return { window_start: now, count: 1 };
  return state.count >= FRAME_BUDGET.limit ? null : { window_start: state.window_start, count: state.count + 1 };
}
export function principalFresh(checkedAt: number | undefined, now: number): boolean {
  return checkedAt !== undefined && now - checkedAt < PRINCIPAL_CACHE_SECONDS;
}
