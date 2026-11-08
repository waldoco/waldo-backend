import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptedRound } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';
import { TRIAGE_SCENARIOS } from '../evals/nightly/triage-scenarios';

// The deterministic half of the triage set: each labelled batch runs through the production triage prompt in the nightly
// world, and its receipts tell the labelled decision from any other. Whether the words are right is the live judge's.
// Replies are scripted; every person, address and event is synthetic.
const scenario = (id: string) => TRIAGE_SCENARIOS.find((entry) => entry.id === id)!;
const triage = async (id: string, rounds: readonly ScriptedRound[]) => {
  const gateway = scriptedGateway({ rules: [{ match: /Update triage/, rounds }], unmatchedText: 'ok' });
  const record = await runTrial(scenario(id), { gateway, budget: callBudget(10) });
  expect(record.status).toBe('ran');
  const sent = gateway.requests().map((request) => JSON.stringify(request.request)).filter((text) => text.includes('Update triage'));
  return { record, sent, failed: failedReceipts([...STATE_INVARIANTS, ...scenario(id).receipts!], record) };
};
const reply = (value: unknown): readonly ScriptedRound[] => [{ text: JSON.stringify(value) }];
const SEND = { name: 'send_email', arguments: { to: ['priya@northwind.example'], subject: 'Re: Term sheet call - Friday 11:00 works?', body_markdown: 'Yes, Friday 11:00 works.' } };

describe('the triage set in the catalogue', () => {
  it('labels batches interrupt, act, brief, noted and silent, under an id prefix nothing else uses', () => {
    expect(TRIAGE_SCENARIOS.map((entry) => entry.receipts![0]!.why.match(/\((\w+)\)$/)![1])).toEqual(['interrupt', 'interrupt', 'act', 'act', 'brief', 'noted', 'silent', 'act', 'silent']);
    for (const entry of TRIAGE_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.id.startsWith('g')).toBe(true);
      expect(entry.rubric.must_not.length, entry.id).toBeGreaterThan(0);
      expect(entry.steps.some((step) => 'triage' in step), entry.id).toBe(true);
    }
    expect(NIGHTLY_SCENARIOS.filter((entry) => /^g\d/.test(entry.id))).toHaveLength(TRIAGE_SCENARIOS.length);
  });
});

describe('a triage batch in the nightly world', () => {
  it('interrupt: a tell holds the label; leaving it for the brief fails it', async () => {
    const told = await triage('g1-triage-investor-call-moved-up', reply({ decision: 'tell', say: 'Your Northwind call moved to 09:45, in 45 minutes.', push: { event: 'g-investor' } }));
    expect(told.failed).toEqual([]);
    expect(told.sent[0]).toContain('Close the seed round with Northwind Capital this month');
    expect(told.record.transcript.at(-1)).toMatchObject({ role: 'waldo', surface: 'notification' });
    expect((await triage('g1-triage-investor-call-moved-up', reply({ decision: 'brief' }))).failed).toEqual(['the triage chose tell (interrupt)']);
  });

  it('act: the card the turn raises is the act, whatever it answered; an act with no card fails', async () => {
    const acted = await triage('g3-triage-confirm-by-noon', [{ toolCalls: [SEND] }, { text: '{"decision": "brief"}' }]);
    expect(acted.failed, JSON.stringify(acted.record.toolOutputs)).toEqual([]);
    expect(acted.record.effects.filter((effect) => effect.kind === 'mail.send.proposed')).toHaveLength(1);
    expect((await triage('g3-triage-confirm-by-noon', reply({ decision: 'act' }))).failed).toEqual(['the triage chose act (act)', 'exactly one card was raised']);
  });

  it('brief and silent hold their labels, and a card raised on a newsletter fails', async () => {
    expect((await triage('g5-triage-next-week-shift', reply({ decision: 'brief' }))).failed).toEqual([]);
    expect((await triage('g7-triage-newsletter', reply({ decision: 'silent' }))).failed).toEqual([]);
    const carded = await triage('g7-triage-newsletter', [{ toolCalls: [SEND] }, { text: '{"decision": "silent"}' }]);
    expect(carded.failed).toEqual(['the triage chose silent (silent)', 'no card was raised']);
  });

  it('an unreadable reply is recorded as invalid and fails the label without stopping the trial', async () => {
    const unreadable = await triage('g5-triage-next-week-shift', [{ text: 'Sure! I would keep this for later.' }]);
    expect(unreadable.record.effects).toContainEqual({ kind: 'triage.decision', payload: { decision: 'invalid', notes: [] } });
    expect(unreadable.failed).toEqual(['the triage chose brief (brief)']);
  });

  it('noted: a note on the confirmation, alone or with brief, holds the label; brief without it, or a tell, fails', async () => {
    const NOTE = { ref: 'message:g6-form', line: 'Google Forms recorded the Schengen visa application at 08:32.' };
    const kept = await triage('g6-triage-form-submitted', reply({ decision: 'note', notes: [NOTE] }));
    expect(kept.failed).toEqual([]);
    expect(kept.sent[0]).toContain('- note: worth keeping on record');
    expect((await triage('g6-triage-form-submitted', reply({ decision: 'brief', notes: [NOTE] }))).failed).toEqual([]);
    expect((await triage('g6-triage-form-submitted', reply({ decision: 'brief' }))).failed).toEqual(['the triage kept a note and told no one (noted)']);
    expect((await triage('g6-triage-form-submitted', reply({ decision: 'tell', say: 'Your visa form went in.', notes: [NOTE] }))).failed).toEqual(['the triage kept a note and told no one (noted)']);
  });

  it('interrupt: a free tier about to stop taking the owner\'s data is told now', async () => {
    expect((await triage('g2-triage-ingestion-suspended', reply({ decision: 'tell', say: 'Logtail stops taking your logs in 24 hours unless you upgrade.' }))).failed).toEqual([]);
    expect((await triage('g2-triage-ingestion-suspended', reply({ decision: 'silent' }))).failed).toEqual(['the triage chose tell (interrupt)']);
  });
});
