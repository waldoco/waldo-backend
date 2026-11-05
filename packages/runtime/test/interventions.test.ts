import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { interruptBook, type InterruptLimits } from '../src/channels/interruptions';
import { interventionApplier, interventionEveryMs, interventionSpec, parseIntervention, type InterventionCode } from '../src/channels/interventions';
import { jobBook } from '../src/tasks/jobs';
import { enqueueMachine } from '../src/tasks/machine';

// PROACTIVE_INTERVENTIONS: Waldo's own look across the owner's plate. The model judges what is worth raising; code holds only
// the owner's limits. A fake turn stands in for the model, and these check what was delivered, held and charged, never words.
const NOW = Date.parse('2026-11-05T10:00:00Z');
const LIMITS: InterruptLimits = { perDay: 1, urgentPerDay: 1, gapMs: 60 * 60_000 };
const DRIFT: TaskResult = { status: 'done', summary: 'The deck has slipped.', findings: [{ text: 'The deck block planned for this morning did not happen; the board deck is due Friday.', source_ref: 'event:deck' }], proposals: [], left: [] };
const NUDGE = { decision: 'say', say: 'The deck block slipped this morning, and the board deck is due Friday. Want me to hold 3 to 5 today for it?' };

type Look = Readonly<{ codes: InterventionCode[]; delivered: string[]; turns: number; tools: (readonly string[])[]; prompts: string[]; spent: ReturnType<ReturnType<typeof interruptBook>['spent']>; settled: number }>;
let seq = 0;
const look = (reply: unknown, setup: Readonly<{ quiet?: boolean; consent?: boolean; cards?: number; before?: (book: ReturnType<typeof interruptBook>) => void; result?: TaskResult }> = {}) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`interventions-${seq += 1}`)), async (_instance, state): Promise<Look> => {
    const sql = state.storage.sql;
    let n = 0;
    const jobs = jobBook(sql, { now: () => NOW, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const made = enqueueMachine(jobs, interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW }), []);
    if (made.code !== 'enqueued') throw new Error(made.code);
    const book = interruptBook(state.storage.kv, { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: () => false });
    setup.before?.(book);
    const out = { codes: [] as InterventionCode[], delivered: [] as string[], turns: 0, tools: [] as (readonly string[])[], prompts: [] as string[], settled: 0 };
    const handler = interventionApplier({
      book, limits: () => LIMITS, timezone: () => 'UTC', now: () => NOW, consent: () => setup.consent ?? true, quiet: () => setup.quiet ?? false,
      transaction: work => state.storage.transactionSync(work),
      context: async () => ({ goals: '- Get the Q4 board deck to the board by Friday', cards: 'The Brief reached them at 08:00.', style: 'chat' }),
      turn: async (_trace, text, _current, tools) => { out.turns += 1; out.prompts.push(text); out.tools.push(tools); return JSON.stringify(reply); },
      cardsSince: () => setup.cards ?? 0,
      deliver: async (id, _trace, text, commit) => { state.storage.transactionSync(commit); out.delivered.push(`${id.split(':')[0]}:${text}`); },
      chose: (_trace, code) => { out.codes.push(code); },
    });
    await handler.apply(made.job, setup.result ?? DRIFT, { trace: 't', current: async () => undefined, settle: () => { out.settled += 1; } });
    return { ...out, spent: book.spent() };
  });

describe('Waldo\'s own look across the day', () => {
  it('golden: drift within the budget goes out as one message, charged to the budget, and the turn read the worker\'s finding', async () => {
    const out = await look(NUDGE);
    expect([out.codes, out.delivered.length, out.settled]).toEqual([['say'], 1, 1]);
    expect(out.prompts[0]).toContain('deck block planned for this morning');
    expect(out.tools[0]).toEqual(expect.arrayContaining(['send_email', 'propose_calendar_change', 'propose_action']));
    expect(out.spent).toMatchObject({ count: 1, urgent: 0 });
  });

  it('nothing worth raising: silence, and nothing spent', async () => {
    const out = await look({ decision: 'none' });
    expect([out.codes, out.delivered, out.spent.count, out.settled]).toEqual([['none'], [], 0, 1]);
  });

  it('a card the turn raised is the intervention: no message, one interruption spent', async () => {
    const out = await look({ decision: 'act' }, { cards: 1 });
    expect([out.codes, out.delivered, out.spent.count]).toEqual([['act'], [], 1]);
  });

  it('budget spent: held unless the model calls it urgent, and urgent is charged to the allowance', async () => {
    const spend = (book: ReturnType<typeof interruptBook>) => { book.spend(LIMITS, false, 'earlier'); };
    const held = await look(NUDGE, { before: spend });
    expect([held.codes, held.delivered]).toEqual([['held_budget'], []]);
    const urgent = await look({ ...NUDGE, urgent: true }, { before: spend });
    expect([urgent.codes, urgent.delivered.length]).toEqual([['say+urgent'], 1]);
    expect(urgent.spent).toMatchObject({ count: 1, urgent: 1 });
  });

  it('budget and urgent allowance both spent: the look ends before any model is asked', async () => {
    const out = await look(NUDGE, { before: book => { book.spend(LIMITS, false, 'a'); book.spend(LIMITS, false, 'b'); } });
    expect([out.turns, out.codes, out.delivered, out.settled]).toEqual([0, ['held_budget'], [], 1]);
  });

  it('quiet hours and the owner\'s no hold it before any model is asked, urgent or not', async () => {
    const quiet = await look({ ...NUDGE, urgent: true }, { quiet: true });
    expect([quiet.turns, quiet.codes]).toEqual([0, ['held_quiet']]);
    const declined = await look({ ...NUDGE, urgent: true }, { consent: false });
    expect([declined.turns, declined.codes]).toEqual([0, ['held_consent']]);
  });

  it('one question in flight: a look that would ask again waits, even urgent; one that asks nothing still goes', async () => {
    const asked = (book: ReturnType<typeof interruptBook>) => { book.ask('card:brief:2026-11-05'); };
    const again = await look({ ...NUDGE, asks: true, urgent: true }, { before: asked });
    expect([again.codes, again.delivered]).toEqual([['held_question'], []]);
    const plain = await look(NUDGE, { before: asked });
    expect(plain.codes).toEqual(['say']);
  });

  it('health drift is the brain\'s to see: a quiet worker still leaves the turn a judgment', async () => {
    const out = await look({ decision: 'none' }, { result: { status: 'done', summary: 'Nothing found.', findings: [], proposals: [], left: [] } });
    expect([out.turns, out.codes]).toEqual([1, ['none']]);
    expect(interventionApplier({} as never).decidesOnEmpty).toBe(true);
  });
});

describe('the look\'s contract', () => {
  it('valid: none, act, and say with its text', () => {
    for (const reply of [{ decision: 'none' }, { decision: 'act', urgent: true }, { decision: 'say', say: 'x', asks: true }]) expect(parseIntervention(JSON.stringify(reply))).not.toBe('invalid');
  });

  it('invalid: say without text, text without say, unknown fields, not JSON', () => {
    for (const reply of [JSON.stringify({ decision: 'say' }), JSON.stringify({ decision: 'none', say: 'x' }), JSON.stringify({ decision: 'none', score: 3 }), 'nothing to add']) expect(parseIntervention(reply)).toBe('invalid');
  });

  it('the cadence comes from config, never under half an hour', () => {
    expect([interventionEveryMs('240'), interventionEveryMs(undefined), interventionEveryMs('5'), interventionEveryMs('soon')]).toEqual([240, 180, 180, 180].map(minutes => minutes * 60_000));
  });

  it('one look an hour at most: a second in the same owner-local hour is the same job', () => {
    expect(interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW }).key).toBe(interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW + 59 * 60_000 }).key);
  });
});
