import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { TaskResult } from '@waldo/contracts';
import { interruptBook, type InterruptLimits } from '../src/channels/interruptions';
import { armInterventionReview, interventionApplier, interventionEveryMs, interventionSpec, INTERVENTION_REVIEW_ID, lookCause, movePullAllowed, nextLocalHour, nextLookAt, parseIntervention, type LookCause, type InterventionCode } from '../src/channels/interventions';
import { verifiedPlaceArrived, verifiedPlaceMoved } from '../src/health/zone-change-route';
import { routerSignature } from '../src/identity/owner-directory';
import { triageTools } from '../src/channels/update-sweep';
import type { Scheduler } from '../src/scheduler/multiplexer';
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
const look = (reply: unknown, setup: Readonly<{ cause?: LookCause; quiet?: boolean; consent?: boolean; closes?: 'before' | 'during'; cards?: number; before?: (book: ReturnType<typeof interruptBook>) => void; during?: (book: ReturnType<typeof interruptBook>) => void; result?: TaskResult }> = {}) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`interventions-${seq += 1}`)), async (_instance, state): Promise<Look> => {
    const sql = state.storage.sql;
    let n = 0;
    const jobs = jobBook(sql, { now: () => NOW, newId: () => (n += 1).toString(16).padStart(12, '0'), newToken: () => `tok-${n += 1}` });
    const made = enqueueMachine(jobs, interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW, cause: setup.cause }), []);
    if (made.code !== 'enqueued') throw new Error(made.code);
    const book = interruptBook(state.storage.kv, { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: () => false });
    setup.before?.(book);
    const out = { codes: [] as InterventionCode[], delivered: [] as string[], turns: 0, tools: [] as (readonly string[])[], prompts: [] as string[], settled: 0 };
    const handler = interventionApplier({
      book, limits: () => LIMITS, timezone: () => 'UTC', now: () => NOW, consent: () => setup.consent ?? true, quiet: () => setup.quiet ?? false,
      closed: () => setup.closes === 'before' || (setup.closes === 'during' && out.turns > 0),
      transaction: work => state.storage.transactionSync(work),
      context: async () => ({ goals: '- Get the Q4 board deck to the board by Friday', cards: 'The Brief reached them at 08:00.', style: 'chat' }),
      turn: async (_trace, text, _current, tools) => { out.turns += 1; out.prompts.push(text); out.tools.push(tools); setup.during?.(book); return JSON.stringify(reply); },
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

  it('the look itself is never urgent: with the budget spent it ends before any model is asked, allowance or not', async () => {
    const out = await look({ ...NUDGE, urgent: true }, { before: book => { book.spend(LIMITS, false, 'earlier'); } });
    expect([out.turns, out.codes, out.delivered, out.settled, out.spent.urgent]).toEqual([0, ['held_budget'], [], 1, 0]);
  });

  it('a card that lands past the budget draws on the allowance, marked or not; an unmarked one is traced apart', async () => {
    // Another message spends the budget while the turn runs, so the card lands past it.
    const late = (urgent: boolean) => look({ decision: 'act', ...(urgent ? { urgent: true } : {}) }, { cards: 1, during: book => { book.spend(LIMITS, false, 'other'); } });
    const marked = await late(true), unmarked = await late(false);
    expect([marked.codes, marked.spent]).toEqual([['act+urgent'], expect.objectContaining({ count: 1, urgent: 1 })]);
    expect([unmarked.codes, unmarked.spent]).toEqual([['act+over_budget'], expect.objectContaining({ count: 1, urgent: 1 })]);
  });

  it('outside the owner\'s day nothing runs, and a day that closes while the turn runs holds the message', async () => {
    const night = await look({ ...NUDGE, urgent: true }, { closes: 'before' });
    expect([night.turns, night.codes]).toEqual([0, ['held_closed']]);
    const closing = await look({ ...NUDGE, urgent: true }, { closes: 'during' });
    expect([closing.turns, closing.codes, closing.delivered, closing.spent.count]).toEqual([1, ['held_closed'], [], 0]);
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

  it('the next look stays inside the owner\'s day: on its cadence until the Close, then at the next Brief', () => {
    const window = (day: string) => ({ opens: Date.parse(`${day}T08:00:00Z`), closes: Date.parse(`${day}T21:30:00Z`) });
    const every = 180 * 60_000;
    expect(nextLookAt(NOW, every, 'UTC', window)).toBe(NOW + every);
    expect(nextLookAt(Date.parse('2026-11-05T20:00:00Z'), every, 'UTC', window)).toBe(Date.parse('2026-11-06T08:00:00Z'));
    expect(nextLookAt(Date.parse('2026-11-05T02:00:00Z'), every, 'UTC', window)).toBe(Date.parse('2026-11-05T08:00:00Z'));
    expect(nextLookAt(Date.parse('2026-11-05T23:00:00Z'), every, 'UTC', window)).toBe(Date.parse('2026-11-06T08:00:00Z'));
  });

  it('one look an hour at most: a second in the same owner-local hour is the same job', () => {
    expect(interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW }).key).toBe(interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW + 59 * 60_000 }).key);
  });
});

// Arriving home or at the gym, places the owner named on their phone, brings the same look forward (ARRIVAL_LOOK).
describe('a look brought forward by an arrival', () => {
  it('knows where the owner arrived, is told an arrival is a reason to look and not to speak, and reads health and place', async () => {
    for (const [cause, where] of [['arrived_home', 'arrived home'], ['arrived_gym', 'arrived at the gym']] as const) {
      const arrived = await look({ decision: 'none' }, { cause });
      expect(arrived.codes).toEqual(['none']);
      expect(arrived.prompts[0]).toContain(`brought forward because the owner's phone says they just ${where}`);
      expect(arrived.prompts[0]).toContain('An arrival is a reason to look, not a reason to speak');
      expect(arrived.prompts[0]).not.toContain('reported another time zone or city');
      expect(arrived.tools[0]).toEqual(expect.arrayContaining(['get_device_context', 'get_health']));
    }
  });

  it('answers to the owner\'s limits like any look: quiet hours hold it before any model is asked', async () => {
    const held = await look(NUDGE, { cause: 'arrived_home', quiet: true });
    expect([held.turns, held.delivered]).toEqual([0, []]);
  });

  it('takes only a signed notice that carries home or gym, addressed to this very object', async () => {
    const secret = 'fictional-router-secret-00000000000000000';
    const notice = async (doName: string, body: string, statement?: string, sig?: string) => new Request('https://telegram-owner/app/v1/internal/place-arrived', { method: 'POST', body,
      headers: { 'x-waldo-do-name': doName, 'x-waldo-arrived-sig': sig ?? await routerSignature(secret, 0, statement ?? `placearrived.${(JSON.parse(body) as { place?: string }).place}.${doName}`) } });
    const mine = (name: string) => name === 'owner-1';
    expect(await verifiedPlaceArrived(await notice('owner-1', '{"place":"home"}'), secret, mine)).toBe('home');
    expect(await verifiedPlaceArrived(await notice('owner-1', '{"place":"gym"}'), secret, mine)).toBe('gym');
    expect(await verifiedPlaceArrived(await notice('owner-2', '{"place":"gym"}'), secret, mine)).toBeNull();
    expect(await verifiedPlaceArrived(await notice('owner-1', '{"place":"office"}'), secret, mine)).toBeNull();
    expect(await verifiedPlaceArrived(await notice('owner-1', '{"place":"gym","cell":"tdr1w"}'), secret, mine)).toBeNull();
    expect(await verifiedPlaceArrived(await notice('owner-1', '{"place":"gym"}', 'placearrived.home.owner-1'), secret, mine)).toBeNull();
    expect(await verifiedPlaceArrived(await notice('owner-1', '{"place":"gym"}', undefined, 'forged'), secret, mine)).toBeNull();
  });
});

// A phone that moves to another time zone or city brings the look forward; the look, not code, decides whether that matters.
describe('a look brought forward by a move', () => {
  it('knows why it runs, is told a move is a reason to look and not to speak, and can read where the phones are', async () => {
    const moved = await look({ decision: 'none' }, { cause: 'place_moved' });
    expect(moved.codes).toEqual(['none']);
    expect(moved.prompts[0]).toContain('brought forward because one of the owner\'s phones reported another time zone or city since the last look');
    expect(moved.prompts[0]).toContain('It may be night where they are now');
    expect(moved.prompts[0]).toContain('A move is a reason to look, not a reason to speak');
    expect(moved.tools[0]).toContain('get_device_context');
    const usual = await look({ decision: 'none' });
    expect(usual.prompts[0]).toContain('Nothing new arrived');
    expect(usual.prompts[0]).not.toContain('reported another time zone or city');
  });

  it('still answers to the owner\'s limits: quiet hours hold it before any model is asked', async () => {
    const held = await look(NUDGE, { cause: 'place_moved', quiet: true });
    expect([held.turns, held.delivered]).toEqual([0, []]);
  });

  it('is armed now inside the owner\'s day, or at their next Brief outside it, replacing the look armed on the cadence', async () => {
    const window = (day: string) => ({ opens: Date.parse(`${day}T08:00:00Z`), closes: Date.parse(`${day}T21:30:00Z`) });
    expect(nextLookAt(NOW, 0, 'UTC', window)).toBe(NOW);
    expect(nextLookAt(Date.parse('2026-11-05T23:00:00Z'), 0, 'UTC', window)).toBe(Date.parse('2026-11-06T08:00:00Z'));
    const scheduled: unknown[] = [];
    const scheduler = { lookup: () => ({ state: 'entry', entry: { recurrence: null } }), schedule: async (entry: unknown) => { scheduled.push(entry); } } as unknown as Scheduler;
    await armInterventionReview(scheduler, NOW, true, 'place_moved');
    await armInterventionReview(scheduler, NOW + 1, true);
    expect(scheduled).toEqual([
      { id: INTERVENTION_REVIEW_ID, kind: 'patrol', payloadRefs: { id: INTERVENTION_REVIEW_ID, cause_id: 'place_moved' }, occurrenceAt: NOW, dueAt: NOW, recurrence: null },
      { id: INTERVENTION_REVIEW_ID, kind: 'patrol', payloadRefs: { id: INTERVENTION_REVIEW_ID }, occurrenceAt: NOW + 1, dueAt: NOW + 1, recurrence: null },
    ]);
    expect(['place_moved', 'arrived_home', 'arrived_gym', 'tea_time', undefined].map(cause => lookCause({ payload_refs: { id: INTERVENTION_REVIEW_ID, ...(cause ? { cause_id: cause } : {}) } }))).toEqual(['place_moved', 'arrived_home', 'arrived_gym', null, null]);
    expect((['place_moved', 'arrived_home', 'arrived_gym'] as const).map(cause => interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW, cause }).items.map(item => item.ref))).toEqual([['now', 'moved'], ['now', 'arrived_home'], ['now', 'arrived_gym']]);
    expect(interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW, cause: 'arrived_gym' }).key).toBe(interventionSpec({ surface: 'app', timezone: 'UTC', now: NOW }).key);
    expect(triageTools(false, true)).toContain('get_device_context');
  });

  it('a move that lands on an hour that already had its look is looked at in the next owner-local hour, half-hour zones included', () => {
    const at = Date.parse('2026-11-05T10:40:12.345Z');
    expect(nextLocalHour(at, 'UTC')).toBe(Date.parse('2026-11-05T11:00:00Z'));
    expect(nextLocalHour(at, 'Asia/Kolkata')).toBe(Date.parse('2026-11-05T10:30:00Z') + 3_600_000);
    expect(nextLocalHour(Date.parse('2026-11-05T10:00:00Z'), 'UTC')).toBe(Date.parse('2026-11-05T11:00:00Z'));
    expect(interventionSpec({ surface: 'app', timezone: 'Asia/Kolkata', now: nextLocalHour(at, 'Asia/Kolkata') }).key)
      .not.toBe(interventionSpec({ surface: 'app', timezone: 'Asia/Kolkata', now: at }).key);
  });

  it('takes only a signed, empty notice addressed to this very object', async () => {
    const secret = 'fictional-router-secret-00000000000000000';
    const notice = async (doName: string, body: string, sig?: string) => new Request('https://telegram-owner/app/v1/internal/place-moved', { method: 'POST', body,
      headers: { 'x-waldo-do-name': doName, 'x-waldo-moved-sig': sig ?? await routerSignature(secret, 0, `placemoved.${doName}`) } });
    const mine = (name: string) => name === 'owner-1';
    expect(await verifiedPlaceMoved(await notice('owner-1', '{}'), secret, mine)).toBe(true);
    expect(await verifiedPlaceMoved(await notice('owner-2', '{}'), secret, mine)).toBe(false);
    expect(await verifiedPlaceMoved(await notice('owner-1', '{"timezone":"Asia/Dubai"}'), secret, mine)).toBe(false);
    expect(await verifiedPlaceMoved(await notice('owner-1', '{}', 'forged'), secret, mine)).toBe(false);
    expect(await verifiedPlaceMoved(await notice('owner-1', '{}'), undefined, mine)).toBe(false);
  });
});

describe('a move pulling the look forward', () => {
  it('pulls it at most once per cadence', () => {
    const every = 120 * 60_000;
    expect(movePullAllowed(undefined, 1_000, every)).toBe(true);
    expect(movePullAllowed(1_000, 1_000 + every - 1, every)).toBe(false);
    expect(movePullAllowed(1_000, 1_000 + every, every)).toBe(true);
  });
});
