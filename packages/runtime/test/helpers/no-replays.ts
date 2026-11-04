import type { JobsLaneDeps } from '../../src/tasks/lane';

// Lane wiring for a test with no approval cards: a replay job reaching it is a test bug.
export const NO_REPLAYS: Pick<JobsLaneDeps, 'startReplay' | 'approvals'> = {
  startReplay: () => { throw new Error('an approval replay reached a lane with no approval cards'); },
  approvals: { replays: () => [], replayReceipt: () => { throw new Error('no approval cards here'); }, settleReplay: () => false },
};
