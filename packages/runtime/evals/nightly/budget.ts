// One hard cap on model calls per run, shared by the model under test and the judge. A refused
// call marks the run exhausted; nothing retries past it.
export type CallRole = 'candidate' | 'judge';

export const callBudget = (limit: number) => {
  if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('the call budget must be a positive integer');
  const calls: Record<CallRole, number> = { candidate: 0, judge: 0 };
  const tokens: Record<CallRole, number> = { candidate: 0, judge: 0 };
  let exhausted = false;
  return {
    take(role: CallRole): boolean {
      if (calls.candidate + calls.judge >= limit) { exhausted = true; return false; }
      calls[role] += 1;
      return true;
    },
    spent(role: CallRole, count: number): void { tokens[role] += count; },
    exhausted: () => exhausted,
    usage: () => ({ candidate_calls: calls.candidate, judge_calls: calls.judge, budget: limit, exhausted, candidate_tokens: tokens.candidate, judge_tokens: tokens.judge }),
  };
};
export type CallBudget = ReturnType<typeof callBudget>;
