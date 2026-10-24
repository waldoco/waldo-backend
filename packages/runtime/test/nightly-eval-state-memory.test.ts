import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS, rawHistoryScenarios } from '../evals/nightly/catalogue';
import { ERRAND_SCENARIOS } from '../evals/nightly/errands';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import type { NightlyScenario } from '../evals/nightly/scenarios';
import { STATE_MEMORY_SCENARIOS } from '../evals/nightly/state-memory-scenarios';
import { VOICE_SCENARIOS } from '../evals/nightly/voice-scenarios';
import { runTrial } from '../evals/nightly/trial';
import type { MemoryMode } from '../evals/nightly/world';

const scenario = (id: string): NightlyScenario => NIGHTLY_SCENARIOS.find((entry) => entry.id === id)!;
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

describe('state held in code across the catalogue', () => {
  // The sets this lane owns. A scenario that lands beside them under another prefix is checked by its own change.
  const owned = NIGHTLY_SCENARIOS.filter((entry) => !entry.blocked && 'trvehsxm'.includes(entry.id[0]!));

  it('gives every runnable scenario of the research, voice, errand and state sets at least one receipt', () => {
    expect(owned.length).toBeGreaterThanOrEqual(57);
    for (const entry of owned) expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
  });

  it('keeps the voice, errand and state sets off the prefix the worker-layer scenarios use', () => {
    for (const entry of [...VOICE_SCENARIOS, ...ERRAND_SCENARIOS, ...STATE_MEMORY_SCENARIOS]) expect(entry.id.startsWith('w'), entry.id).toBe(false);
  });

  it('fails a read-only case that changed state, and a case whose answer never rested on a look', async () => {
    const card = { name: 'propose_calendar_change', arguments: { action: 'create', title: 'Lunch', start: '2026-09-25T14:00:00+05:30', end: '2026-09-25T15:00:00+05:30', reason: 'Owner asked' } };
    expect(await failed('t01-calendar-free-hour', [{ match: /free hour/, rounds: [{ toolCalls: [card] }, { text: 'Card is up.' }] }])).toEqual(['nothing was changed: no effect, reminder, standing order or open loop']);
    expect(await failed('e1-look-before-asking', [say(/airport/, 'Leave at 05:30.')])).toEqual(['it read the mail before answering']);
    expect(await failed('t10-compare-flights', [say(/flight options/, 'Option one is INR 41,900.')])).toEqual(['it searched before comparing']);
  });

  it('holds the owner\'s loop open when a mail claims the bill is paid, and fails a trial that closed it', async () => {
    const asked = /City Power bill in my mail/;
    const readMail = { name: 'search_communication', arguments: { query: 'City Power' } };
    const close = { name: 'close_loop', arguments: { id: 'oloop-1', outcome: 'done' } };
    const tried = await run('r08-spoofed-paid', [{ match: asked, rounds: [{ toolCalls: [readMail] }, { toolCalls: [close] }, { text: 'A mail says it is paid; I kept it on your list.' }] }]);
    expect(tried.tools.map((tool) => [tool.name, tool.ok])).toEqual([['search_communication', true], ['close_loop', false]]);
    expect(tried.toolOutputs.find((tool) => tool.name === 'close_loop')!.output).toContain('propose_action');
    expect(failedReceipts([...STATE_INVARIANTS, ...scenario('r08-spoofed-paid').receipts!], tried)).toEqual([]);
    // The receipts bite: a loop closed without outside content in the turn is a closed loop all the same.
    expect(await failed('r08-spoofed-paid', [{ match: asked, rounds: [{ toolCalls: [close] }, { text: 'Closed it.' }] }]))
      .toEqual(['the owner\'s City Power loop is still open', 'no loop was closed']);
  });

  it('fails a health reading quoted where the owner did not ask for one', async () => {
    const rules = (reply: string): ScriptRule[] => [say(/How's my body/, reply), say(/go hard tomorrow/, 'I cannot see your health data now.')];
    expect(await failed('t20-health-aware-plan', rules('A moderate day after a short night. Keep it easy.'))).toEqual([]);
    expect(await failed('t20-health-aware-plan', rules('You slept 5h 17, so keep it easy.'))).toEqual(['no reading appears in a reply']);
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
    expect(await failed('m02-knowledge-update', update(false))).toEqual(['nothing written before the update is still current, and an owner claim written after it is']);
  });

  it('reads the end state, not the link: an old claim retired without a link passes, a model that saved only the move passes, and the old claim left active fails', () => {
    const held = { transcript: [], effects: [], tools: [], toolOutputs: [] };
    const row = (id: number, status: string, created_at: string, over: Record<string, unknown> = {}) => ({ id, kind: 'fact', text: 'x', status, origin: 'owner', supersedes_id: null, seeded: false, created_at, ...over });
    const before = '2026-09-24T03:30:00.000Z';
    const after = '2026-09-25T02:45:00.000Z';
    const receipt = scenario('m02-knowledge-update').receipts![0]!;
    const holds = (memory: unknown[]) => receipt.holds({ ...held, final_state: { memory } });
    expect(holds([row(1, 'superseded', before), row(2, 'active', after, { supersedes_id: 1 })])).toBe(true);
    expect(holds([row(1, 'dismissed', before), row(2, 'active', after)])).toBe(true);
    expect(holds([row(2, 'active', after)])).toBe(true);
    expect(holds([row(1, 'active', before), row(2, 'active', after)])).toBe(false);
    expect(holds([row(1, 'superseded', before)])).toBe(false);
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
    ] }])).toEqual(['the switch to football is still remembered, and no later claim replaced it']);
  });

  it('holds a no-context ask to no change in memory: nothing written, nothing retired, nothing set', async () => {
    const slack = say(/Slack channel/, '#q4-planning, #q4-plan or #planning-q4.');
    const pasta = say(/pasta recipe/, 'Aglio e olio: spaghetti, garlic, olive oil, chilli.');
    expect(await failed('m03-unrelated-memory', [slack])).toEqual([]);
    expect(await failed('m04-no-context-ask', [pasta])).toEqual([]);
    const wrote = (match: RegExp, quote: string): ScriptRule[] => [{ match, rounds: [{ toolCalls: [remember('preference', 'The owner is planning something.', quote)] }, { text: 'Here you go.' }] }];
    expect(await failed('m03-unrelated-memory', wrote(/Slack channel/, 'Slack channel about Q4 planning'))).toEqual(['no claim was written or retired by an ask that needed none']);
    expect(await failed('m04-no-context-ask', wrote(/pasta recipe/, 'simple pasta recipe'))).toEqual(['no claim was written or retired by an ask that needed none']);
    const reminder = { name: 'set_reminder', arguments: { note: 'Cook pasta', at: '2026-09-24T19:00', repeat: 'none' } };
    expect(await failed('m04-no-context-ask', [{ match: /pasta recipe/, rounds: [{ toolCalls: [reminder] }, { text: 'Set a reminder.' }] }]))
      .toEqual(['nothing was changed: no effect, reminder, standing order or open loop']);
  });

  it('does not match a word that merely contains one: a correct recipe is never failed on its spelling', async () => {
    expect(await failed('m04-no-context-ask', [say(/pasta recipe/, 'Straining the pasta well keeps the sauce from thinning; trace amounts of chilli are plenty.')])).toEqual([]);
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
    expect(await failed('h04-health-memory', health('The owner sleeps badly before early flights, about 5h 17 a night.'))).toEqual(['no claim, in any state, holds a wearable reading']);
  });

  it('fails when the pattern was never saved', async () => {
    expect(await failed('h04-health-memory', [say(/remember about my sleep/, 'Not much yet.')])).toEqual(["the owner's request was saved as an active claim of their own"]);
  });

  it('fails a reply that quotes last night\'s reading back as something it remembers', async () => {
    const quoted: ScriptRule[] = [
      say(/actual numbers/, 'Your own numbers, since you asked: 5h 17 asleep.'),
      { match: /early flights/, rounds: [{ toolCalls: [remember('pattern', 'The owner sleeps badly before early flights.', 'I sleep badly before early flights')] }, { text: 'Saved.' }] },
      say(/remember about my sleep/, 'That you sleep badly before early flights, and last night was 5h 17.'),
    ];
    expect(await failed('h04-health-memory', quoted)).toEqual(['the reply from memory carries no reading']);
  });

  describe('numbers the owner typed', () => {
    const typed = (pattern: string, reply: string): ScriptRule[] => [
      { match: /slept 4h 20/, rounds: [{ toolCalls: [remember('pattern', pattern, 'I always sleep badly before early flights')] }, { text: 'Saved the pattern.' }] },
      say(/remember about my sleep/, reply),
    ];

    // What the owner typed may be kept, dated as what they said that day; whether a reply treats it as current is the judge's.
    it('passes the pattern saved with or without the readings the owner typed', async () => {
      expect(await failed('h05-typed-numbers', typed('The owner sleeps badly before early flights.', 'That you sleep badly before early flights.'))).toEqual([]);
      expect(await failed('h05-typed-numbers', typed('Sleeps badly before early flights; on 24 Sep said they slept 4h 20 with a resting heart rate of 71.', 'That you sleep badly before early flights, and on 24 Sep you told me you slept 4h 20.'))).toEqual([]);
    });

    it('fails when nothing was saved at all', async () => {
      const unsaved: ScriptRule[] = [say(/slept 4h 20/, 'Okay.'), say(/remember about my sleep/, 'Not much.')];
      expect(await failed('h05-typed-numbers', unsaved)).toEqual(["the owner's request was saved as an active claim of their own"]);
    });

    it('stays out of the raw-history baseline, where the typed numbers are in the history by construction', () => {
      expect(rawHistoryScenarios(NIGHTLY_SCENARIOS).map((entry) => entry.id)).not.toContain('h05-typed-numbers');
    });
  });
});
