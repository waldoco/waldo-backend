import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { interruptBook, type InterruptLimits } from '../src/channels/interruptions';
import type { LookCause } from '../src/channels/interventions';
import type { RunEndReport } from '../src/channels/owner-turn';
import { GENERAL_WAKE_TOOLS, generalWake, wakeOutcomeBook, wakeRole, WITHHELD_REASON, type WakeCode, type WakeRow } from '../src/channels/wake';

// GENERAL_WAKE: Waldo's general wake replaces the look. The model judges; code holds only the owner's limits, and only when
// the run decides to speak. A fake run stands in for the model, and these check what ran, what went, what was held and charged,
// and the one outcome row each run leaves, never the model's judgment.
const NOW = Date.parse('2026-11-28T10:00:00Z');
const LIMITS: InterruptLimits = { perDay: 1, urgentPerDay: 1, gapMs: 60 * 60_000 };
const NUDGE = 'The deck block slipped this morning and the board deck is due Friday. Want me to hold 3 to 5 today for it?';
const end = (reason: string, why?: string, tools: readonly string[] = []): RunEndReport => ({ reason, ...(why ? { why } : {}), tools });

type Wake = Readonly<{ code: WakeCode; delivered: string[]; runs: number; prompts: string[]; rows: readonly WakeRow[]; spent: ReturnType<ReturnType<typeof interruptBook>['spent']>; question: boolean }>;
let seq = 0;
const wake = (reply: string, ended: RunEndReport | undefined, setup: Readonly<{ cause?: LookCause; quiet?: boolean; consent?: boolean; closed?: boolean; cards?: number; before?: (book: ReturnType<typeof interruptBook>) => void; throws?: boolean }> = {}) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`general-wake-${seq += 1}`)), async (_instance, state): Promise<Wake> => {
    const book = interruptBook(state.storage.kv, { now: () => NOW, timezone: () => 'UTC', ownerSpokeSince: () => false });
    const outcomes = wakeOutcomeBook(state.storage.sql);
    setup.before?.(book);
    const out = { delivered: [] as string[], runs: 0, prompts: [] as string[] };
    const run = generalWake({
      book, limits: () => LIMITS, now: () => NOW, localNow: () => '2026-11-28T10:00',
      consent: () => setup.consent ?? true, quiet: () => setup.quiet ?? false, closed: () => setup.closed ?? false,
      transaction: work => state.storage.transactionSync(work),
      context: async () => ({ changes: '- invite moved: Board prep now 16:00 (was 14:00)', calendar: '- 16:00-17:00 Board prep (3 attending)', cards: 'The Brief reached them at 08:00.',
        today: '[08:00] Waldo: Morning. Deck block 9 to 12.\n[08:05] Owner: thanks', ledger: '- Send Ana the deck [loop:l1]', goals: '- Get the Q4 board deck out by Friday', style: 'chat' }),
      run: async (_trace, text) => { out.runs += 1; out.prompts.push(text); if (setup.throws) throw new Error('provider down'); return { reply, end: ended }; },
      cardsSince: () => setup.cards ?? 0,
      deliver: async (id, _trace, text, commit) => { state.storage.transactionSync(commit); out.delivered.push(`${id.split(':')[0]}:${text}`); },
      record: row => outcomes.record(row),
      chose: () => undefined,
    });
    let code: WakeCode | 'threw';
    try { code = await run('intervention-review:1', 'look', setup.cause ?? null); } catch { code = 'threw'; }
    return { ...out, code: code as WakeCode, rows: outcomes.recent(10), spent: book.spent(), question: book.question() !== null };
  });

describe('Waldo\'s general wake', () => {
  it('golden: one run reads what changed, the rest of today, what was said and what is open; its message goes once, charged, with one outcome row', async () => {
    const out = await wake(NUDGE, end('send', 'The deck block slipped and the board moved later; worth holding time today.'));
    expect([out.code, out.runs, out.delivered]).toEqual(['spoke', 1, [`wake:${NUDGE}`]]);
    for (const shown of ['Board prep now 16:00', '16:00-17:00 Board prep', 'Deck block 9 to 12', 'Send Ana the deck', 'Q4 board deck']) expect(out.prompts[0]).toContain(shown);
    expect(out.spent).toMatchObject({ count: 1 });
    expect(out.rows).toEqual([expect.objectContaining({ id: 'intervention-review:1', kind: 'look', ref: 'cadence', outcome: 'spoke', reason: 'The deck block slipped and the board moved later; worth holding time today.', outside: true })]);
  });

  it('a wake that chooses nothing leaves its reason, and nothing is spent or sent', async () => {
    const out = await wake('SKIP', end('nothing_to_send', 'Looked: the deck block is on track and nothing moved since the Brief.'));
    expect([out.code, out.delivered, out.spent.count]).toEqual(['nothing', [], 0]);
    expect(out.rows.map(row => [row.outcome, row.reason])).toEqual([['nothing', 'Looked: the deck block is on track and nothing moved since the Brief.']]);
  });

  it('the look is never held: with the budget spent the run still looks, and a message it wants to send is held and recorded', async () => {
    const out = await wake(NUDGE, end('send', 'Worth raising.'), { before: book => { book.spend(LIMITS, false, 'earlier'); } });
    expect([out.runs, out.code, out.delivered, out.spent.count]).toEqual([1, 'held_budget', [], 1]);
    expect(out.rows.map(row => row.outcome)).toEqual(['held']);
  });

  it('the owner\'s no to unasked messages, quiet hours and the end of their day hold the message, not the look', async () => {
    for (const [setup, code] of [[{ consent: false }, 'held_consent'], [{ quiet: true }, 'held_quiet'], [{ closed: true }, 'held_closed']] as const) {
      const out = await wake(NUDGE, end('send', 'Worth raising.'), setup);
      expect([out.runs, out.code, out.delivered]).toEqual([1, code, []]);
    }
  });

  it('a question goes as one and waits for the owner\'s answer', async () => {
    const out = await wake('Do you still want the 16:00 board prep, now that it moved?', end('ask_owner', 'Only they know.'));
    expect([out.code, out.delivered.length, out.question]).toEqual(['asked', 1, true]);
  });

  it('a card it raised is the notification: charged once, no message; a follow-up or a note alone is its own outcome', async () => {
    const carded = await wake('SKIP', end('nothing_to_send', 'Put the move on a card.', ['propose_calendar_change']), { cards: 1 });
    expect([carded.code, carded.delivered, carded.spent.count]).toEqual(['carded', [], 1]);
    expect((await wake('SKIP', end('follow_up', 'Check after the 16:00.', ['open_loop']))).code).toBe('followed_up');
    expect((await wake('SKIP', end('nothing_to_send', 'Kept that the deck moved to Friday.', ['remember']))).code).toBe('noted');
  });

  it('a reason that holds a health reading is never stored; the row keeps a fixed line instead', async () => {
    const out = await wake('SKIP', end('nothing_to_send', 'Resting heart rate 64 bpm, no need to say anything.'));
    expect(out.rows.map(row => row.reason)).toEqual([WITHHELD_REASON]);
  });

  it('a run that fails leaves a failed row and the failure still surfaces', async () => {
    const out = await wake('', undefined, { throws: true });
    expect([out.code, out.rows.map(row => row.outcome)]).toEqual(['threw', ['failed']]);
  });

  it('a move or an arrival says why it woke; no line tells the model that silence is the normal end', async () => {
    const moved = await wake('SKIP', end('nothing_to_send', 'Landed; nothing to change.'), { cause: 'place_moved' });
    expect(moved.prompts[0]).toContain('another time zone or city');
    expect(moved.rows.map(row => row.ref)).toEqual(['place_moved']);
    expect(moved.prompts[0]).not.toMatch(/most looks end in nothing|nothing is normal/i);
    expect(moved.prompts[0]).toContain('end_run');
  });
});

describe('what a wake holds and keeps', () => {
  it('its tools include memory and health reads, its own note, a follow-up and the owner\'s card', () => {
    expect(GENERAL_WAKE_TOOLS).toEqual(expect.arrayContaining(['read_memory', 'search_episodes', 'get_health', 'remember', 'open_loop', 'close_loop', 'propose_action', 'propose_calendar_change']));
  });

  it('its model role is configuration, with the look\'s role when unset or unknown', () => {
    expect([wakeRole(undefined), wakeRole('decides'), wakeRole('chat'), wakeRole('auxiliary'), wakeRole('fastest')]).toEqual(['plans', 'decides', true, false, 'plans']);
  });

});
