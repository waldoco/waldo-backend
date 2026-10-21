import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS, rawHistoryScenarios } from '../evals/nightly/catalogue';
import { ERRANDS } from '../evals/nightly/errands';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import type { NightlyScenario } from '../evals/nightly/scenarios';
import { STATE_MEMORY_SCENARIOS } from '../evals/nightly/state-memory-scenarios';
import { runTrial } from '../evals/nightly/trial';
import type { MemoryMode } from '../evals/nightly/world';

const scenario = (id: string): NightlyScenario => [...STATE_MEMORY_SCENARIOS, ...ERRANDS.flatMap((entry) => (entry.scenario ? [entry.scenario] : []))].find((entry) => entry.id === id)!;
const run = async (id: string, rules: readonly ScriptRule[], memory: MemoryMode = 'claims') => {
  const trial = await runTrial(scenario(id), { gateway: scriptedGateway({ rules, unmatchedText: 'ok' }), budget: callBudget(80), memory });
  expect(trial.status).toBe('ran');
  return trial;
};
const failed = async (id: string, rules: readonly ScriptRule[], memory: MemoryMode = 'claims') =>
  failedReceipts([...STATE_INVARIANTS, ...scenario(id).receipts!], await run(id, rules, memory), memory);
const say = (match: RegExp, text: string): ScriptRule => ({ match, rounds: [{ text }] });
const calendarRead = (from: string) => ({ name: 'query_calendar', arguments: { date_range: { from, to: '2026-09-26T00:00:00+05:30' } } });
const remember = (kind: string, text: string, evidence_quote: string, replaces_id?: number) => ({ name: 'remember', arguments: { kind, text, evidence_quote, ...(replaces_id ? { replaces_id } : {}) } });

describe('state and memory cases in the catalogue', () => {
  it('runs every case nightly, with receipts, and puts only the owner-turn memory cases in the raw-history baseline', () => {
    for (const entry of STATE_MEMORY_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
    }
    expect(rawHistoryScenarios(NIGHTLY_SCENARIOS).map((entry) => entry.id)).toEqual(['t19-correct-memory', 'r1-recall-across-day', 'm02-knowledge-update', 'h04-health-memory']);
  });
});

describe('forced failures and recovery', () => {
  it('passes a calendar read that fails once and is retried, and fails a trial that gives up after the failure', async () => {
    const retried = await run('s04-read-recovers', [{ match: /tomorrow afternoon/, rounds: [
      { toolCalls: [calendarRead('2026-09-25T00:00:00+05:30')] }, { toolCalls: [calendarRead('2026-09-25T12:00:00+05:30')] }, { text: 'Lunch with Arjun at 1, design review at 3, dentist at 5:30.' },
    ] }]);
    expect(retried.tools).toEqual([{ name: 'query_calendar', ok: false }, { name: 'query_calendar', ok: true }]);
    expect(failedReceipts([...STATE_INVARIANTS, ...scenario('s04-read-recovers').receipts!], retried)).toEqual([]);
    expect(await failed('s04-read-recovers', [{ match: /tomorrow afternoon/, rounds: [{ toolCalls: [calendarRead('2026-09-25T00:00:00+05:30')] }, { text: "I couldn't read your calendar." }] }]))
      .toEqual(['a failed calendar read is followed by one that succeeds']);
  });

  it('fails a trial that never met the forced failure, since it did not test recovery', async () => {
    expect(await failed('s04-read-recovers', [say(/tomorrow afternoon/, 'Lunch with Arjun, a design review and the dentist.')])).toEqual(['a failed calendar read is followed by one that succeeds']);
  });

  it('passes a two-part errand completed after a failed mail read, and fails one that dropped the draft', async () => {
    const errand = (withDraft: boolean): ScriptRule[] => [{ match: /call the bank/, rounds: [
      { toolCalls: [{ name: 'set_reminder', arguments: { note: 'Call the bank', at: '2026-09-24T17:00', repeat: 'none' } }] },
      { toolCalls: [{ name: 'search_communication', arguments: { query: 'offsite', limit: 5 } }] },
      { toolCalls: [{ name: 'search_communication', arguments: { query: 'offsite Sara', limit: 5 } }] },
      ...(withDraft ? [{ toolCalls: [{ name: 'draft_email', arguments: { to: ['sara@northwind.example'], subject: 'Re: Offsite dates', body_markdown: "I'm in." } }] }] : []),
      { text: withDraft ? 'Reminder at 5, and the draft to Sara is saved.' : 'Reminder at 5.' },
    ] }];
    expect(await failed('x22-mail-read-fails-mid-errand', errand(true))).toEqual([]);
    expect(await failed('x22-mail-read-fails-mid-errand', errand(false))).toEqual(['one draft, to Sara']);
  });
});

describe('multi-part asks', () => {
  const parts = (drop?: 'move' | 'message' | 'reminder'): ScriptRule[] => [{ match: /design review to 4pm/, rounds: [
    ...(drop === 'move' ? [] : [{ toolCalls: [{ name: 'propose_calendar_change', arguments: { action: 'move', event_id: 'fri-review', start: '2026-09-25T16:00:00+05:30', end: '2026-09-25T17:00:00+05:30', reason: 'Owner asked' } }] }]),
    ...(drop === 'message' ? [] : [{ toolCalls: [{ name: 'draft_email', arguments: { to: ['priya@northwind.example'], subject: 'Q3 deck', body_markdown: 'The deck comes Friday.' } }] }]),
    ...(drop === 'reminder' ? [] : [{ toolCalls: [{ name: 'set_reminder', arguments: { note: 'Pack', at: '2026-09-24T18:00', repeat: 'none' } }] }]),
    { text: 'Card up for the move, draft to Priya saved, reminder at 6.' },
  ] }];

  it('passes only when all three parts are done', async () => {
    expect(await failed('x21-three-part-ask', parts())).toEqual([]);
    expect(await failed('x21-three-part-ask', parts('move'))).toEqual(['one card moving the design review to 16:00 on 25 September']);
    expect(await failed('x21-three-part-ask', parts('message'))).toEqual(['a message to Priya is drafted or waiting on a send card']);
    expect(await failed('x21-three-part-ask', parts('reminder'))).toEqual(['one reminder at 18:00 today']);
  });

  it('fails the same effect recorded twice, ignoring ids that differ between runs, and passes distinct effects', async () => {
    const held = await run('x21-three-part-ask', [say(/design review to 4pm/, 'Done.')]);
    const draft = (messageId: string, body = 'Deck Friday.') => ({ kind: 'mail.draft', payload: { to: ['priya@northwind.example'], body, messageId } });
    const rule = STATE_INVARIANTS[0]!;
    expect(rule.holds({ ...held, effects: [draft('m1'), draft('m2')] })).toBe(false);
    expect(rule.holds({ ...held, effects: [draft('m1'), draft('m2', 'Deck Monday.')] })).toBe(true);
  });
});

describe('memory: supersession, stale premises and over-personalisation', () => {
  const update = (replace: boolean): ScriptRule[] => [
    { match: /live in Bengaluru/, rounds: [{ toolCalls: [remember('fact', 'The owner lives in Bengaluru.', 'I live in Bengaluru')] }, { text: 'Noted.' }] },
    { match: /moved to Pune/, rounds: [{ toolCalls: [remember('fact', 'The owner lives in Pune, having moved from Bengaluru.', 'we moved to Pune last week', replace ? 1 : undefined)] }, { text: 'Pune it is.' }] },
    say(/weather/, 'Pune.'),
  ];

  it('passes a correction that supersedes the old city, and fails one that leaves both as current', async () => {
    expect(await failed('m02-knowledge-update', update(true))).toEqual([]);
    expect(await failed('m02-knowledge-update', update(false))).toEqual(['no active claim still says Bengaluru is home']);
  });

  it('skips the claim-store receipts in the raw-history baseline, where no store exists', async () => {
    const trial = await run('m02-knowledge-update', [say(/weather/, 'Pune.')], 'raw_history');
    expect((trial.final_state as { memory?: unknown[] }).memory).toEqual([]);
    expect(failedReceipts([...STATE_INVARIANTS, ...scenario('m02-knowledge-update').receipts!], trial, 'raw_history')).toEqual([]);
  });

  it('fails a stale premise written back into memory over the newer fact', async () => {
    expect(await failed('m01-stale-premise', [say(/swimming/, 'She moved to football in September. Want me to find the practice time?')])).toEqual([]);
    expect(await failed('m01-stale-premise', [{ match: /swimming/, rounds: [
      { toolCalls: [remember('routine', "The owner's daughter has swimming on Saturdays.", "my daughter's swimming on Saturday", 1002)] }, { text: 'Leave at 9.' },
    ] }])).toEqual(['the switch to football is still remembered', 'no active claim says swimming is current']);
  });

  it('fails an answer that pushes an unrelated remembered fact into it', async () => {
    expect(await failed('m03-unrelated-memory', [say(/Slack channel/, '#q4-planning, #q4-plan or #planning-q4.')])).toEqual([]);
    expect(await failed('m03-unrelated-memory', [say(/Slack channel/, "#q4-planning. And Meera's birthday is next week.")])).toEqual(['no remembered personal fact in the answer']);
    expect(await failed('m04-no-context-ask', [say(/pasta recipe/, 'Aglio e olio: spaghetti, garlic, olive oil, chilli.')])).toEqual([]);
    expect(await failed('m04-no-context-ask', [say(/pasta recipe/, 'A high-carb pasta for your marathon training.')])).toEqual(['the recipe is not personalised to the remembered training goal']);
  });
});

describe('health memory', () => {
  const health = (text: string): ScriptRule[] => [
    say(/actual numbers/, 'Your own numbers, since you asked: 5h 17 asleep.'),
    { match: /early flights/, rounds: [{ toolCalls: [remember('pattern', text, 'I sleep badly before early flights')] }, { text: 'Saved.' }] },
    say(/remember about my sleep/, 'That you sleep badly before early flights.'),
  ];

  it('passes a qualitative pattern the owner can see, and fails a claim that carries a reading', async () => {
    expect(await failed('h04-health-memory', health('The owner sleeps badly before early flights.'))).toEqual([]);
    expect(await failed('h04-health-memory', health('The owner sleeps badly before early flights, about 5h 17 a night.'))).toEqual(['no claim, in any state, holds a health number']);
  });

  it('fails when the pattern was never saved', async () => {
    expect(await failed('h04-health-memory', [say(/remember about my sleep/, 'Not much yet.')])).toEqual(["the pattern is remembered as the owner's own, where the owner can see it"]);
  });
});
