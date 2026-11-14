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
  it('labels batches interrupt, act, brief and silent, under an id prefix nothing else uses', () => {
    expect(TRIAGE_SCENARIOS.map((entry) => entry.receipts![0]!.why.match(/\((\w+)\)$/)![1])).toEqual(['interrupt', 'interrupt', 'act', 'act', 'brief', 'brief', 'silent', 'act', 'silent', 'brief', 'brief', 'interrupt', 'interrupt', 'silent', 'silent']);
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
    const unreadable = await triage('g6-triage-fyi-notes', [{ text: 'Sure! I would keep this for later.' }]);
    expect(unreadable.record.effects).toContainEqual({ kind: 'triage.decision', payload: { decision: 'invalid' } });
    expect(unreadable.failed).toEqual(['the triage chose brief (brief)']);
  });
});

// The update sweep's reader runs first on a reader batch, through the production worker loop and model call, and triage builds
// on what it returned. A reader that finds nothing ends the batch silent, as the owner object's job ends without news: a
// deadline next week the reader leaves out never reaches triage at all.
describe('a reader batch in the nightly world', () => {
  const FINDING = { status: 'done', summary: 'The Q2 return needs a signature.', findings: [{ text: 'The Q2 GST return needs the owner\'s e-signature by Wednesday 30 September; a daily late fee starts after.', source_ref: 'message:r1-ca' }], proposals: [], left: [] };
  const NONE = { status: 'done', summary: 'Nothing that changes today or tomorrow.', findings: [], proposals: [], left: [] };
  const read = async (id: string, result: unknown, triaged: readonly ScriptedRound[] = reply({ decision: 'brief' })) => {
    const gateway = scriptedGateway({ rules: [
      { match: /Task: Update sweep/, rounds: [{ toolCalls: [{ name: 'finish_task', arguments: result as Record<string, unknown> }] }] },
      { match: /Update triage/, rounds: triaged },
    ], unmatchedText: 'ok' });
    const record = await runTrial(scenario(id), { gateway, budget: callBudget(10) });
    expect(record.status).toBe('ran');
    const texts = gateway.requests().map((request) => JSON.stringify(request.request));
    return { record, reader: texts.filter((text) => text.includes('Task: Update sweep')), triaged: texts.filter((text) => text.includes('Update triage')),
      failed: failedReceipts([...STATE_INVARIANTS, ...scenario(id).receipts!], record) };
  };

  it('golden: the reader reads the batch with its goal, and triage builds on what it found', async () => {
    const run = await read('g10-reader-filing-due-next-week', FINDING);
    expect(run.reader).toHaveLength(1);
    expect(run.reader[0]).toContain('whenever they fall due');
    expect(run.reader[0]).not.toContain('today or tomorrow');
    expect(run.reader[0]).toContain('Q2 GST return: your signature by Wed 30 Sep');
    expect(run.triaged).toHaveLength(1);
    expect(run.triaged[0]).toContain('<task_result>');
    expect(run.triaged[0]).toContain('a daily late fee starts after');
    expect(run.failed).toEqual([]);
  });

  it('a reader that finds nothing ends the batch silent with no triage turn, and the deadline next week fails its label', async () => {
    const run = await read('g10-reader-filing-due-next-week', NONE);
    expect(run.reader).toHaveLength(1);
    expect(run.record.transcript).toContainEqual({ role: 'world', text: 'The reader worker returned 0 finding(s) and 0 proposal(s).' });
    expect(run.triaged).toEqual([]);
    expect(run.record.effects).toContainEqual({ kind: 'triage.decision', payload: { decision: 'silent', reader: 'no_news' } });
    expect(run.failed).toEqual(['the triage chose brief (brief)']);
  });

  it('a loud sale the reader leaves out holds the silent label', async () => {
    expect((await read('g15-reader-last-chance-sale', NONE)).failed).toEqual([]);
  });

  it('every reader batch runs the reader first', () => {
    const readers = TRIAGE_SCENARIOS.filter((entry) => entry.steps.some((step) => 'triage' in step && step.reader === true)).map((entry) => entry.id);
    expect(readers).toEqual(['g10-reader-filing-due-next-week', 'g11-reader-talk-moved-next-week', 'g12-reader-new-sender-closing-the-round',
      'g13-reader-stranger-found-laptop', 'g14-reader-urgent-account-alert', 'g15-reader-last-chance-sale']);
  });
});
