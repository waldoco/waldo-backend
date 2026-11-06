import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { TESTER_TYPES, TONE_SCENARIOS } from '../evals/nightly/tone-scenarios';
import { runTrial } from '../evals/nightly/trial';

// The deterministic half of the tone set: the cases are registered across the three tester types, the eval world feeds them
// what the runtime would (a one-day blood-oxygen signal waking the health check, three nights of readings under the owner's
// usual), and their receipts tell an honest message from a bad one. Whether the tone fits the day is the live judges' call.
// Replies here are scripted; every reading is synthetic.
const scenario = (id: string) => TONE_SCENARIOS.find((entry) => entry.id === id)!;
const run = async (id: string, rules: readonly ScriptRule[]) => {
  const gateway = scriptedGateway({ rules, unmatchedText: 'ok' });
  const record = await runTrial(scenario(id), { gateway, budget: callBudget(80) });
  expect(record.status).toBe('ran');
  const failed = failedReceipts([...STATE_INVARIANTS, ...scenario(id).receipts!], record);
  const asked = (match: RegExp) => gateway.requests().map((request) => JSON.stringify(request)).filter((text) => match.test(text));
  return { record, failed, asked };
};
const reply = (match: RegExp, text: string): ScriptRule[] => [{ match, rounds: [{ text }] }];
const NOTE = /\[Health check,/;

describe('the tone set in the catalogue', () => {
  it('runs every case nightly, across all three tester types, each held by a receipt', () => {
    expect(new Set(NIGHTLY_SCENARIOS.map((entry) => entry.id)).size).toBe(NIGHTLY_SCENARIOS.length);
    for (const entry of TONE_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
      expect(entry.rubric.must_not.length, entry.id).toBeGreaterThan(0);
    }
    const types = new Set(TONE_SCENARIOS.flatMap((entry) => entry.world.memory ?? []).map((claim) => claim.id));
    for (const type of Object.values(TESTER_TYPES)) expect(types.has(type.id), type.text).toBe(true);
  });
});

describe('a message is plain: no exclamation marks, no emoji', () => {
  const both = (saturday: string): ScriptRule[] => [
    ...reply(/What should I hit first/, 'The pricing doc, this morning, before lunch at 1pm. You can do the hard one while you\'re fresh.'),
    ...reply(/Anything I need to deal with today/, saturday),
  ];
  it('tn01: an honest Friday and a quiet Saturday hold, and a Saturday with an exclamation mark or an emoji fails', async () => {
    expect((await run('tn01-go-friday-loose-saturday', both("Nothing. The calendar's empty and the doc can wait till Monday."))).failed).toEqual([]);
    expect((await run('tn01-go-friday-loose-saturday', both('Nothing at all today!'))).failed).toEqual([expect.stringContaining('exclamation mark')]);
    expect((await run('tn01-go-friday-loose-saturday', both('Nothing today 🎉'))).failed).toEqual([expect.stringContaining('emoji')]);
  });
});

describe('the health gate on a one-day signal, then the loop when asked', () => {
  const said = /Anything about my body I should know/;
  const read = { name: 'get_health', arguments: { signals: ['spo2'], from: '2026-09-11', to: '2026-09-24', aggregation: 'daily' } };
  const quiet = reply(NOTE, JSON.stringify({ kind: 'no_op', text: '' }));
  const loop: ScriptRule = { match: said, rounds: [{ toolCalls: [read] }, { text: 'Blood oxygen has run a touch under your usual for three nights. Nothing to change today; I\'ll keep an eye on it as your watch syncs.' }] };

  it('tn03: the health check is woken by the new signal and told of it, the question reaches the model with it, and get_health returns the three nights under the usual ones', async () => {
    const { record, failed, asked } = await run('tn03-oxygen-quiet-then-loop', [...quiet, loop]);
    expect(asked(NOTE)).toHaveLength(1);
    expect(asked(NOTE)[0]).toContain('blood oxygen below usual');
    expect(asked(said)[0]).toContain('blood oxygen below usual');
    const output = record.toolOutputs.find((entry) => entry.name === 'get_health')?.output ?? '';
    for (const night of ['94.4', '94.2', '94.1', '97.1']) expect(output).toContain(night);
    expect(failed).toEqual([]);
  });

  it('tn03: a note about the one-day signal fails', async () => {
    const note = reply(NOTE, JSON.stringify({ kind: 'notice', text: "Blood oxygen's a little below your usual today, while recovery still reads excellent." }));
    expect((await run('tn03-oxygen-quiet-then-loop', [...note, loop])).failed).toEqual([expect.stringContaining('no note')]);
  });

  it('tn03: a reply that never read the readings fails', async () => {
    expect((await run('tn03-oxygen-quiet-then-loop', [...quiet, ...reply(said, 'Nothing to worry about.')])).failed).toEqual([expect.stringContaining('read the readings')]);
  });
});
