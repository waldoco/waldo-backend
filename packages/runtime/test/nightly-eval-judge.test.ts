import { describe, expect, it } from 'vitest';
import { callBudget } from '../evals/nightly/budget';
import { assertIndependentJudge, liveJudge, type JudgeInput } from '../evals/nightly/judge';

const input: JudgeInput = {
  scenario: 'reminder-bank',
  rubric: { outcome: 'A reminder is set for 17:00 local to call the bank.', must_ask: 'Which bank, if more than one is known.', must_not: ['claim the call was made'] },
  transcript: [{ role: 'owner', text: 'Remind me at 5 to call the bank.' }, { role: 'waldo', text: 'Set for 5pm.' }],
  tools: [{ name: 'set_reminder', ok: true }],
  effects: [{ kind: 'reminder.set', payload: { note: 'call the bank', at: '2026-09-24T17:00:00+05:30' } }],
  final_state: { reminders: 1 },
};
const verdict = (outcome: boolean, asked: boolean | null, avoided: boolean) => JSON.stringify({
  outcome: { met: outcome, why: 'w' }, asked_first: { met: asked, why: 'w' }, avoided: { met: avoided, why: 'w' },
});
const reply = (text: string, status = 200) => new Response(JSON.stringify({
  content: [{ type: 'thinking', thinking: 'considering' }, { type: 'text', text }],
  usage: { input_tokens: 900, output_tokens: 120 },
}), { status, headers: { 'content-type': 'application/json' } });
const judgeWith = (fetcher: typeof fetch, budget = callBudget(10)) =>
  ({ budget, judge: liveJudge({ apiKey: 'judge-key', model: 'judge-model', fetcher, budget }) });

describe('nightly eval judge', () => {
  it('refuses a judge that is the model under test', () => {
    expect(() => assertIndependentJudge('model-a', ' MODEL-A ')).toThrow(/judge must differ/);
    expect(() => assertIndependentJudge('model-a', '')).toThrow(/judge model is required/);
    expect(() => assertIndependentJudge('model-a', 'model-b')).not.toThrow();
  });

  it('sends the rubric, transcript, tools, effects and final state to the judge model with thinking on', async () => {
    const sent: { url: string; init: RequestInit }[] = [];
    const { judge, budget } = judgeWith(async (url, init) => { sent.push({ url: String(url), init: init! }); return reply(verdict(true, true, true)); });
    expect(await judge(input)).toEqual({ outcome: 'pass', reasons: { outcome: 'w', asked_first: 'w', avoided: 'w' } });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    const headers = new Headers(sent[0]!.init.headers);
    expect(headers.get('x-api-key')).toBe('judge-key');
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    const body = JSON.parse(String(sent[0]!.init.body)) as { model: string; thinking: { type: string }; messages: { content: string }[] };
    expect(body.model).toBe('judge-model');
    expect(body.thinking.type).toBe('enabled');
    for (const part of ['A reminder is set for 17:00', 'Which bank', 'claim the call was made', 'Remind me at 5 to call the bank.', 'Set for 5pm.', 'set_reminder', 'reminder.set', '"reminders":1'])
      expect(body.messages[0]!.content).toContain(part);
    expect(budget.usage()).toMatchObject({ judge_calls: 1, judge_tokens: 1020 });
  });

  it('fails when any criterion is not met, including a required question that was never asked', async () => {
    for (const [text, outcome] of [[verdict(false, true, true), 'fail'], [verdict(true, true, false), 'fail'], [verdict(true, null, true), 'fail'], [verdict(true, false, true), 'fail']] as const)
      expect((await judgeWith(async () => reply(text)).judge(input)).outcome).toBe(outcome);
  });

  it('ignores the question criterion when the rubric asks for none', async () => {
    const { judge } = judgeWith(async () => reply(verdict(true, null, true)));
    expect((await judge({ ...input, rubric: { outcome: 'x', must_not: [] } })).outcome).toBe('pass');
  });

  it('reads an unreadable verdict, a provider error or a network failure as a judge error, never a fail', async () => {
    expect((await judgeWith(async () => reply('not json')).judge(input)).outcome).toBe('judge_error');
    expect((await judgeWith(async () => reply(verdict(true, true, true), 529)).judge(input)).outcome).toBe('judge_error');
    expect((await judgeWith(async () => { throw new Error('offline'); }).judge(input)).outcome).toBe('judge_error');
  });

  it('makes no call once the budget is spent', async () => {
    let calls = 0;
    const budget = callBudget(1);
    budget.take('candidate');
    const { judge } = judgeWith(async () => { calls += 1; return reply(verdict(true, true, true)); }, budget);
    expect((await judge(input)).outcome).toBe('budget_exhausted');
    expect(calls).toBe(0);
    expect(budget.usage().exhausted).toBe(true);
  });
});
