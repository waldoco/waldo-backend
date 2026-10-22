// One judge call to the Anthropic Messages API, counted against the run's call budget. Current Claude models take
// adaptive thinking with an effort level; a fixed thinking budget is refused with a 400 on Opus 5.5, Sonnet 5.5 and
// Fable 5.1, which would turn every verdict into a judge error. Thinking tokens count against max_tokens.
// No retries: a failed call is a judge error for that trial, never a second spend. A call that has not answered in
// timeoutMs is abandoned the same way: one hung connection would otherwise hold the whole run until its job timeout, and a
// cancelled run publishes no scorecard.
import type { CallBudget } from './budget';

export type JudgeModelConfig = Readonly<{ apiKey: string; model: string; budget: CallBudget; fetcher?: typeof fetch; timeoutMs?: number }>;
export const JUDGE_CALL_TIMEOUT_MS = 180_000;

// The reply's text, 'budget_exhausted' when the budget refused the call, or null when the call failed.
export const askJudgeModel = async (config: JudgeModelConfig, system: string, user: string): Promise<string | 'budget_exhausted' | null> => {
  if (!config.budget.take('judge')) return 'budget_exhausted';
  try {
    const response = await (config.fetcher ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model, max_tokens: 16_000, thinking: { type: 'adaptive' }, output_config: { effort: 'high' },
        system, messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(config.timeoutMs ?? JUDGE_CALL_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body = await response.json() as { stop_reason?: string; content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    config.budget.spent('judge', (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0));
    // A refused or truncated grade is no grade.
    if (body.stop_reason === 'refusal' || body.stop_reason === 'max_tokens') return null;
    return (body.content ?? []).filter((part) => part.type === 'text').map((part) => part.text ?? '').join('');
  } catch {
    return null;
  }
};

// The first {...} span of a reply, parsed; null when there is none or it is not JSON.
export const jsonIn = (text: string): unknown => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
};
