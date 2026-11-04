import type { LLMAttempt } from '../llm/provider';
import type { TurnLogEntry } from './owner-turn-types';

// One usage line for each failed attempt a provider still billed, priced at the model that billed it. The answering model's own
// usage is on the call's main line, so a caller that logs the main line and these never counts a token twice.
export const billedAttemptEntries = (
  attempts: readonly LLMAttempt[],
  stamp: Pick<TurnLogEntry, 'trace' | 'hop'> & Partial<Pick<TurnLogEntry, 'cost_kind' | 'job_id' | 'job_profile'>>,
): TurnLogEntry[] => attempts.flatMap((attempt) => {
  if (attempt.outcome !== 'failure' || !attempt.spent) return [];
  const { input_tokens: input, output_tokens: output, cache_read_input_tokens: cached, cache_write_input_tokens: written } = attempt.spent;
  return [{ ...stamp, ms: 0, ok: false, error_code: attempt.code, provider: attempt.provider,
    usage: { model: attempt.billed_model ?? attempt.model, input, output, cached, ...(written ? { cache_write: written } : {}), web_searches: 0 } }];
});
