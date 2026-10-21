// One judge call to the Anthropic Messages API, with thinking on, counted against the run's call budget.
// No retries: a failed call is a judge error for that trial, never a second spend.
import type { CallBudget } from './budget';

export type JudgeModelConfig = Readonly<{ apiKey: string; model: string; budget: CallBudget; fetcher?: typeof fetch }>;

// The reply's text, 'budget_exhausted' when the budget refused the call, or null when the call failed.
export const askJudgeModel = async (config: JudgeModelConfig, system: string, user: string): Promise<string | 'budget_exhausted' | null> => {
  if (!config.budget.take('judge')) return 'budget_exhausted';
  try {
    const response = await (config.fetcher ?? fetch)('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: config.model, max_tokens: 6000, thinking: { type: 'enabled', budget_tokens: 4000 },
        system, messages: [{ role: 'user', content: user }],
      }),
    });
    if (!response.ok) return null;
    const body = await response.json() as { content?: { type: string; text?: string }[]; usage?: { input_tokens?: number; output_tokens?: number } };
    config.budget.spent('judge', (body.usage?.input_tokens ?? 0) + (body.usage?.output_tokens ?? 0));
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
