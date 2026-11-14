import { describe, expect, it } from 'vitest';
import { scriptedGateway, type ScriptRule } from '../src/testing/scripted-gateway';
import { CLASH_LINE } from '../src/prompt/day-cards';
import { callBudget } from '../evals/nightly/budget';
import { NIGHTLY_SCENARIOS } from '../evals/nightly/catalogue';
import { BRIEF_HEALTH_SCENARIOS } from '../evals/nightly/brief-health-scenarios';
import { failedReceipts, STATE_INVARIANTS } from '../evals/nightly/receipts';
import { runTrial } from '../evals/nightly/trial';

// The deterministic half of the Brief and health-only-day set: the cases are registered and their receipts tell an honest
// message from a bad one. Whether a live model writes a good Brief or judges a
// note worth sending is the live judge's, which the owner runs. Replies here are scripted; every reading is synthetic.
const scenario = (id: string) => BRIEF_HEALTH_SCENARIOS.find((entry) => entry.id === id)!;
const BRIEF = /\[Scheduled card \\?"The Daily Brief/;
const NOTE = /\[Health check,/;
const run = async (id: string, rules: readonly ScriptRule[]) => {
  const gateway = scriptedGateway({ rules, unmatchedText: 'ok' });
  const record = await runTrial(scenario(id), { gateway, budget: callBudget(80) });
  expect(record.status).toBe('ran');
  const failed = failedReceipts([...STATE_INVARIANTS, ...scenario(id).receipts!], record);
  const asked = (match: RegExp) => gateway.requests().map((request) => JSON.stringify(request)).filter((text) => match.test(text));
  return { record, failed, asked };
};
const reply = (match: RegExp, text: string): ScriptRule[] => [{ match, rounds: [{ text }] }];
const note = (text: string) => JSON.stringify({ kind: 'notice', text });
const quiet = JSON.stringify({ kind: 'no_op', text: '' });
// The line the shared health block opens its zones with; absent whenever no health is shared.
const ZONE_LINE = 'Form zone:';
const SCORES = ['29.3', '63.8'];


describe('the Brief and health-only-day set in the catalogue', () => {
  it('runs four cases nightly, each held by a receipt', () => {
    expect(BRIEF_HEALTH_SCENARIOS.map((entry) => entry.id)).toEqual([
      'h21-brief-without-health', 'h22-brief-after-sharing-withdrawn', 'h23-brief-heavy-day-low-form', 'h24-health-only-day-sharp-drop',
    ]);
    expect(new Set(NIGHTLY_SCENARIOS.map((entry) => entry.id)).size).toBe(NIGHTLY_SCENARIOS.length);
    for (const entry of BRIEF_HEALTH_SCENARIOS) {
      expect(NIGHTLY_SCENARIOS).toContain(entry);
      expect(entry.receipts?.length, entry.id).toBeGreaterThan(0);
      expect(entry.rubric.must_not.length, entry.id).toBeGreaterThan(0);
      for (const driver of entry.world.health?.drivers ?? []) expect(driver, entry.id).not.toMatch(/\d/);
    }
  });
});

describe('the Brief with and without shared health', () => {


  it.each(['h21-brief-without-health', 'h22-brief-after-sharing-withdrawn'])('%s: tells the model no health is available, shows none, and fails a Brief that speaks of the body', async (id) => {
    const honest = await run(id, reply(BRIEF, 'The Brief\nStandup at 10, then Board prep at 11. Board prep is the one thing that matters today.'));
    expect(honest.asked(BRIEF)[0]).toContain('No derived health context is available for this invocation.');
    // "short night" is also in the system prompt's own rule, so the zone line and the seeded debt stand for the shared health.
    for (const word of [ZONE_LINE, 'sleep debt building', ...SCORES]) expect(honest.asked(BRIEF)[0]).not.toContain(word);
    expect(honest.failed).toEqual([]);
    const invented = await run(id, reply(BRIEF, 'The Brief\nYou probably slept badly, so your recovery is low. Take it easy before Board prep.'));
    expect(invented.failed).toEqual([expect.stringContaining('sleep, recovery, energy')]);
  });

  it('h23: the Brief request carries the clash line, the heavy day and the low one; an offer holds and a raised card fails', async () => {
    const { failed, asked } = await run('h23-brief-heavy-day-low-form', reply(BRIEF, 'The Brief\nA heavy day on a low one after short nights. Keep the board review; want me to move the 18:00 spin class to the weekend?'));
    expect(asked(BRIEF)[0]).toContain(CLASH_LINE);
    for (const said of ['Board review', 'Spin class with Dev', 'short night', 'sleep debt building']) expect(asked(BRIEF)[0]).toContain(said);
    expect(failed).toEqual([]);
    const tools = JSON.parse(asked(BRIEF)[0]!) as { request: { tools?: { name?: string; function?: { name?: string } }[] } };
    expect((tools.request.tools ?? []).map((tool) => tool.name ?? tool.function?.name)).not.toContain('propose_calendar_change');
  });
});

describe('the health trigger on a day with nothing booked', () => {
  it('h24: one note in zone words goes out as an update card, and the receipts hold', async () => {
    const text = 'Update\nRecovery dropped to compromised after a run of short nights. With nothing booked, an easy day and an early night would help.';
    const { record, failed, asked } = await run('h24-health-only-day-sharp-drop', reply(NOTE, note(text)));
    expect(asked(NOTE)).toHaveLength(1);
    expect(asked(NOTE)[0]).toContain("Nothing is on the owner's calendar, tasks or open loops in the next 24 hours.");
    expect(record.transcript).toContainEqual({ role: 'waldo', surface: 'notification', text });
    expect(failed).toEqual([]);
  });

  it('h24: silence fails, and a note with a reading never goes out', async () => {
    expect((await run('h24-health-only-day-sharp-drop', reply(NOTE, quiet))).failed).toEqual([expect.stringContaining('one note')]);
    const refused = await run('h24-health-only-day-sharp-drop', reply(NOTE, note('Update\nYou slept 5 hours last night, so go easy.')));
    expect(refused.record.transcript.some((turn) => turn.role === 'waldo')).toBe(false);
  });

});
