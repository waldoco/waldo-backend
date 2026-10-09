import { expect, it } from 'vitest';
import { admitFrame, FRAME_BUDGET, principalFresh, PRINCIPAL_CACHE_SECONDS, type FrameWindow } from '../src/devices/frame-budget';

it('admits frames up to the budget in a window, refuses the next, and opens a new window later', () => {
  let state: FrameWindow | null | undefined;
  for (let n = 0; n < FRAME_BUDGET.limit; n++) { state = admitFrame(state ?? undefined, 1000); expect(state).not.toBeNull(); }
  expect(admitFrame(state ?? undefined, 1000 + FRAME_BUDGET.seconds - 1)).toBeNull();
  expect(admitFrame(state ?? undefined, 1000 + FRAME_BUDGET.seconds)).toEqual({ window_start: 1000 + FRAME_BUDGET.seconds, count: 1 });
});
it('treats a principal check as fresh only inside the cache window', () => {
  expect(principalFresh(undefined, 1000)).toBe(false);
  expect(principalFresh(1000, 1000 + PRINCIPAL_CACHE_SECONDS - 1)).toBe(true);
  expect(principalFresh(1000, 1000 + PRINCIPAL_CACHE_SECONDS)).toBe(false);
});
