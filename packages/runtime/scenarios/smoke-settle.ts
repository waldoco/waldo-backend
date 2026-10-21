import type { SmokeFetchBoundary } from './smoke-model-fetch';
// Test-only: the production DO already owns this serial queue. Do not sleep or
// freeze usage while a queued task can create another outbound attempt.
export const settleSmokeOwner = async (owner: { queue: Promise<unknown> }, transport: Pick<SmokeFetchBoundary, 'settle' | 'pending'>): Promise<void> => {
  for (;;) {
    const queue = owner.queue;
    await queue;
    await transport.settle();
    if (owner.queue === queue && transport.pending() === 0) return;
  }
};
