// Evaluator-only consistency check. Provider rows must be collected independently
// of the runner; this compares them but cannot authenticate their source or billing.
export type UsageLine = Readonly<{
  response_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cached_tokens: number;
  billed_usd: number; // provider-side per-response charge, not estimated modelCost
}>;
export type UsageReconciliation = Readonly<{
  status: 'consistent_unverified' | 'harness_error';
  errors: readonly string[];
  total_usd: number | null;
}>;
const validLine = (line: UsageLine): boolean => Boolean(line.response_id?.trim() && line.model?.trim()) &&
  [line.input_tokens, line.output_tokens, line.cached_tokens].every((n) => Number.isSafeInteger(n) && n >= 0) &&
  line.cached_tokens <= line.input_tokens && Number.isFinite(line.billed_usd) && line.billed_usd >= 0;
const sameUsage = (a: UsageLine, b: UsageLine): boolean => a.response_id === b.response_id && a.model === b.model &&
  a.input_tokens === b.input_tokens && a.output_tokens === b.output_tokens && a.cached_tokens === b.cached_tokens;
export const reconcileTrialUsage = (
  runner: readonly UsageLine[], provider: readonly UsageLine[], assertedCostUsd: number | null,
): UsageReconciliation => {
  const errors: string[] = [];
  if (!runner.length || !provider.length) errors.push('missing model usage');
  if (runner.some((line) => !validLine(line)) || provider.some((line) => !validLine(line))) errors.push('invalid usage line');
  if (new Set(runner.map((line) => line.response_id)).size !== runner.length ||
      new Set(provider.map((line) => line.response_id)).size !== provider.length) errors.push('duplicate response id');
  if (runner.length !== provider.length || runner.some((line) => {
    const found = provider.find((candidate) => candidate.response_id === line.response_id);
    return !found || !sameUsage(line, found) || Math.abs(line.billed_usd - found.billed_usd) > 0.00000001;
  })) errors.push('provider response usage mismatch');
  const cost = provider.reduce((sum, line) => sum + line.billed_usd, 0);
  if (assertedCostUsd === null || !Number.isFinite(assertedCostUsd) || assertedCostUsd < 0 ||
    !Number.isFinite(cost) || Math.abs(assertedCostUsd - cost) > 0.00000001) errors.push('provider cost mismatch');
  return { status: errors.length ? 'harness_error' : 'consistent_unverified', errors, total_usd: errors.length ? null : cost };
};
