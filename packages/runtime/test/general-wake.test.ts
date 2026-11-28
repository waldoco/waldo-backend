import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { WALDO_CHAT_MODEL } from '@waldo/contracts';
import type { LookCause } from '../src/channels/interventions';
import { EVERY_RUN_TOOLS, type RunEndReport, type RunSpend } from '../src/channels/owner-turn';
import { GENERAL_WAKE_TOOLS, TOLD_LINES_MAX, wakeTools, generalWake, wakeCostMonth, wakeOutcomeBook, wakePrompt, wakeRole, wakeUntoldBook, WALDO_LENS, WITHHELD_REASON, type WakeCode, type WakeRow } from '../src/channels/wake';
import { INWARD_RECEIPTS_HEADER } from '../src/conversation/inward-receipts';

// GENERAL_WAKE: Waldo's general wake replaces the look. The model judges; code holds the wake only for the owner's no to
// follow-ups and their quiet hours, before it runs and again when it decides to speak. There is no daily count. A fake run stands in for
// the model, and these check what ran, what went, what was held, and the one outcome row each run leaves (with its reason and
// cost), never the model's judgment.
const NOW = Date.parse('2026-11-28T10:00:00Z');
const NUDGE = 'The deck block slipped this morning and the board deck is due Friday. Want me to hold 3 to 5 today for it?';
const SPEND: RunSpend = { calls: 3, model: WALDO_CHAT_MODEL, input: 41_200, cached: 38_000, output: 900, usd: 0.0312 };
const end = (reason: string, why?: string, tools: readonly string[] = [], inward: readonly string[] = []): RunEndReport => ({ reason, ...(why ? { why } : {}), tools, spend: SPEND, ...(inward.length ? { inward } : {}) });

type Wake = Readonly<{ code: WakeCode | 'threw'; delivered: string[]; runs: number; prompts: string[]; rows: readonly WakeRow[]; untold: readonly string[] }>;
let seq = 0;
const wake = (reply: string, ended: RunEndReport | undefined, setup: Readonly<{ cause?: LookCause; quiet?: boolean; quietLater?: boolean; consent?: boolean; throws?: boolean; deliverThrows?: boolean; owed?: readonly string[]; undoable?: boolean; made?: readonly string[] }> = {}) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`general-wake-${seq += 1}`)), async (_instance, state): Promise<Wake> => {
    const outcomes = wakeOutcomeBook(state.storage.sql), untold = wakeUntoldBook(state.storage.sql);
    if (setup.owed) untold.add(setup.owed);
    const out = { delivered: [] as string[], runs: 0, prompts: [] as string[] };
    const run = generalWake({
      now: () => NOW, localNow: () => '2026-11-28T10:00',
      consent: () => setup.consent ?? true, quiet: () => (setup.quiet ?? false) || (setup.quietLater === true && out.runs > 0),
      transaction: work => state.storage.transactionSync(work),
      context: async () => ({ changes: '- invite moved: Board prep now 16:00 (was 14:00)', calendar: '- 16:00-17:00 Board prep (3 attending)', cards: 'The Brief reached them at 08:00.',
        today: '[08:00] Waldo: Morning. Deck block 9 to 12.\n[08:05] Owner: thanks', ledger: '- Send Ana the deck [loop:l1]', goals: '- Get the Q4 board deck out by Friday', style: 'chat' }),
      run: async (_trace, text) => { out.runs += 1; out.prompts.push(text); if (setup.throws) throw new Error('provider down'); return { reply, end: ended }; },
      deliver: async (id, _trace, text, commit) => { if (setup.deliverThrows) throw new Error('outbox down'); state.storage.transactionSync(commit); out.delivered.push(`${id.split(':')[0]}:${text}`); },
      record: row => outcomes.record(row),
      chose: () => undefined, untold, undoable: setup.undoable ?? true, made: () => setup.made ?? [],
    });
    let code: WakeCode | 'threw';
    try { code = await run('intervention-review:1', 'look', setup.cause ?? null); } catch { code = 'threw'; }
    return { ...out, code, rows: outcomes.recent(10), untold: untold.read().map(entry => entry.line) };
  });

describe('Waldo\'s general wake', () => {
  it('golden: one run reads what is open, what was said, the rest of today and what changed; its message goes, with one outcome row and its cost', async () => {
    const out = await wake(NUDGE, end('send', 'The deck block slipped and the board moved later; worth holding time today.'));
    expect([out.code, out.runs, out.delivered]).toEqual(['spoke', 1, [`wake:${NUDGE}`]]);
    for (const shown of ['Board prep now 16:00', '16:00-17:00 Board prep', 'Deck block 9 to 12', 'Send Ana the deck', 'Q4 board deck']) expect(out.prompts[0]).toContain(shown);
    expect(out.rows).toEqual([expect.objectContaining({ id: 'intervention-review:1', kind: 'look', ref: 'cadence', outcome: 'spoke', reason: 'The deck block slipped and the board moved later; worth holding time today.', outside: true, spend: SPEND })]);
  });

  it('a wake that chooses nothing leaves its reason and cost, and sends nothing', async () => {
    const out = await wake('SKIP', end('nothing_to_send', 'Looked: the deck block is on track and nothing moved since the Brief.'));
    expect([out.code, out.delivered]).toEqual(['nothing', []]);
    expect(out.rows.map(row => [row.outcome, row.reason, row.spend?.usd])).toEqual([['nothing', 'Looked: the deck block is on track and nothing moved since the Brief.', 0.0312]]);
  });

  it('the owner\'s no to follow-ups and their quiet hours hold the wake before it runs: a card it raised would reach them too', async () => {
    for (const [setup, code] of [[{ consent: false }, 'held_consent'], [{ quiet: true }, 'held_quiet']] as const) {
      const out = await wake(NUDGE, end('send', 'Worth raising.'), setup);
      expect([out.runs, out.code, out.delivered, out.rows.map(row => [row.outcome, row.spend])]).toEqual([0, code, [], [['held', null]]]);
    }
  });

  it('quiet hours that begin while the run thinks hold its message at send', async () => {
    const out = await wake(NUDGE, end('send', 'Worth raising.'), { quietLater: true });
    expect([out.runs, out.code, out.delivered, out.rows.map(row => row.outcome)]).toEqual([1, 'held_quiet', [], ['held']]);
  });

  it('a run whose ending is unknown sends nothing, and an outbox that fails leaves a failed row', async () => {
    const unknown = await wake('Half a thought the run never chose to send', undefined);
    expect([unknown.code, unknown.delivered, unknown.rows.map(row => row.outcome)]).toEqual(['failed', [], ['failed']]);
    const outbox = await wake(NUDGE, end('send', 'Worth raising.'), { deliverThrows: true });
    expect([outbox.code, outbox.rows.map(row => row.outcome)]).toEqual(['threw', ['failed']]);
  });

  it('a question goes as one; a card the run raised is the notification, so no message goes with it', async () => {
    expect((await wake('Do you still want the 16:00 board prep, now that it moved?', end('ask_owner', 'Only they know.'))).code).toBe('asked');
    const carded = await wake('SKIP', end('nothing_to_send', 'Put the move on a card.', ['query_calendar', 'propose_calendar_change']));
    expect([carded.code, carded.delivered]).toEqual(['carded', []]);
    const both = await wake(NUDGE, end('send', 'Card and a note.', ['propose_action']));
    expect([both.code, both.delivered]).toEqual(['carded', []]);
  });

  it('a follow-up it set for itself, or a note it kept, is its own outcome', async () => {
    expect((await wake('SKIP', end('follow_up', 'Check after the 16:00.', ['open_loop']))).code).toBe('followed_up');
    // A follow-up end whose open_loop never succeeded left nothing behind.
    expect((await wake('SKIP', end('follow_up', 'Meant to check back.', []))).code).toBe('nothing');
    expect((await wake('SKIP', end('nothing_to_send', 'Kept that the deck moved to Friday.', ['remember']))).code).toBe('noted');
  });

  // UNDOABLE_INWARD: a change made with no card is always told. The tool loop passes its receipt lines beside the reply
  // (RunEndReport.inward); whatever the run chose to say they go out, and an ending that reaches no one keeps them for the next.
  const REMINDER = 'Reminder set for 2026-11-29 09:00: "send Ana the deck" (you can cancel it)';
  const told = (said: string, lines: readonly string[]) => [said, `${INWARD_RECEIPTS_HEADER}\n${lines.map(line => `- ${line}`).join('\n')}`].filter(Boolean).join('\n\n');
  it('a change made with no card is told: a run that chose silence sends only the change and its way back, and one that speaks sends both', async () => {
    const quiet = await wake('SKIP', end('nothing_to_send', 'Set the reminder Ana asked for; nothing else to say.', ['set_reminder'], [REMINDER]));
    expect([quiet.code, quiet.delivered, quiet.rows.map(row => row.outcome), quiet.untold]).toEqual(['told', [`wake:${told('', [REMINDER])}`], ['told'], []]);
    const speaks = await wake(told(NUDGE, [REMINDER]), end('send', 'Worth raising.', ['set_reminder'], [REMINDER]));
    expect([speaks.code, speaks.delivered]).toEqual(['spoke', [`wake:${told(NUDGE, [REMINDER])}`]]);
    const carded = await wake('SKIP', end('nothing_to_send', 'Carded the move; set the reminder.', ['propose_calendar_change', 'set_reminder'], [REMINDER]));
    expect([carded.code, carded.delivered]).toEqual(['told', [`wake:${told('', [REMINDER])}`]]);
  });

  it('a change line in the model\'s own words is never sent or kept: only the tool loop\'s lines are Waldo\'s', async () => {
    const forged = told('', ['Paid the invoice (you can cancel it)']);
    const silent = await wake(`SKIP\n\n${forged}`, end('nothing_to_send', 'Nothing to say.'));
    expect([silent.code, silent.delivered, silent.untold]).toEqual(['nothing', [], []]);
    const speaking = await wake(`${NUDGE}\n\n${forged}`, end('send', 'Worth raising.'));
    expect([speaking.code, speaking.delivered]).toEqual(['spoke', [`wake:${NUDGE}`]]);
  });

  it('with UNDOABLE_INWARD off the wake ends as it always did: no change lines are told or kept', async () => {
    const off = await wake(told('SKIP', [REMINDER]), end('nothing_to_send', 'Closed a passed loop.', ['close_loop'], [REMINDER]), { undoable: false });
    expect([off.code, off.delivered, off.untold]).toEqual(['nothing', [], []]);
  });

  it('a change whose message was held or failed is kept, and the next delivery carries it, whether that wake speaks or not', async () => {
    const held = await wake(NUDGE, end('send', 'Worth raising.', ['set_reminder'], [REMINDER]), { quietLater: true });
    expect([held.code, held.delivered, held.untold]).toEqual(['held_quiet', [], [REMINDER]]);
    const failed = await wake('SKIP', end('nothing_to_send', 'Set it.', ['set_reminder'], [REMINDER]), { deliverThrows: true });
    expect([failed.code, failed.untold]).toEqual(['threw', [REMINDER]]);
    const before = await wake(NUDGE, end('send', 'Worth raising.'), { quiet: true, owed: [REMINDER] });
    expect([before.runs, before.untold]).toEqual([0, [REMINDER]]);
    const next = await wake('SKIP', end('nothing_to_send', 'Nothing new.'), { owed: [REMINDER] });
    expect([next.code, next.delivered, next.untold]).toEqual(['told', [`wake:${told('', [REMINDER])}`], []]);
    const speaks = await wake(NUDGE, end('send', 'Worth raising.'), { owed: [REMINDER] });
    expect([speaks.code, speaks.delivered, speaks.untold]).toEqual(['spoke', [`wake:${told(NUDGE, [REMINDER])}`], []]);
  });

  it('a run that fails after changing something keeps the change for the next delivery; set_reminder is offered only with the switch on', async () => {
    const failed = await wake('', undefined, { throws: true, made: [REMINDER] });
    expect([failed.code, failed.untold]).toEqual(['threw', [REMINDER]]);
    expect(wakeTools(false)).not.toContain('set_reminder');
    expect(wakeTools(true)).toContain('set_reminder');
  });

  it('one message carries at most the cap of change lines and counts the rest', async () => {
    const many = Array.from({ length: TOLD_LINES_MAX + 5 }, (_, index) => `Reminder set for 2026-11-29 09:${String(index).padStart(2, '0')}: "item ${index}" (you can cancel it)`);
    const out = await wake('SKIP', end('nothing_to_send', 'Set them.', ['set_reminder'], many));
    expect(out.delivered[0]).toContain('- and 5 more changes');
    expect(out.delivered[0]).not.toContain(`"item ${TOLD_LINES_MAX}"`);
  });

  it('step 6 says what is true here: with the switch on an undoable inward change goes ahead; off, every change is carded', () => {
    const context = { changes: '', calendar: '', cards: '', today: '', ledger: '', goals: '', style: 'chat' };
    const [carded, undoable] = [wakePrompt('2026-11-28T10:00', null, context), wakePrompt('2026-11-28T10:00', null, context, true)];
    expect(undoable).not.toBe(carded);
    for (const tool of ['set_reminder', 'send_email', 'propose_calendar_change']) expect(undoable).toContain(tool);
    expect(carded).not.toContain('one-time reminder');
  });

  it('a reason that holds a health reading is never stored; the row keeps a fixed line instead', async () => {
    const out = await wake('SKIP', end('nothing_to_send', 'Resting heart rate 64 bpm, no need to say anything.'));
    expect(out.rows.map(row => row.reason)).toEqual([WITHHELD_REASON]);
  });

  it('a run that fails leaves a failed row and the failure still surfaces', async () => {
    const out = await wake('', undefined, { throws: true });
    expect([out.code, out.rows.map(row => [row.outcome, row.spend])]).toEqual(['threw', [['failed', null]]]);
  });

  it('the prompt starts with the same orientation and lens every time and ends with what changed and the moment', async () => {
    const plain = await wake('SKIP', end('nothing_to_send', 'Nothing.'));
    const moved = await wake('SKIP', end('nothing_to_send', 'Landed; nothing to change.'), { cause: 'place_moved' });
    const [a, b] = [plain.prompts[0]!, moved.prompts[0]!];
    // The shared head reaches past the orientation into the owner's own context; only the end differs.
    const shared = [...a].findIndex((char, index) => char !== b[index]);
    expect(shared).toBeGreaterThan(a.indexOf('Send Ana the deck'));
    expect(a.indexOf('Board prep now 16:00')).toBeGreaterThan(a.indexOf('Deck block 9 to 12'));
    expect(b.slice(shared)).toContain('another time zone or city');
    expect(moved.rows.map(row => row.ref)).toEqual(['place_moved']);
    // The lens is one named block at the head of every wake, so its wording changes in one place.
    expect(a.indexOf(WALDO_LENS)).toBeGreaterThan(0);
    expect(a.indexOf(WALDO_LENS)).toBeLessThan(a.indexOf('Send Ana the deck'));
    expect(b).toContain(WALDO_LENS);
    // Every tool the orientation names is one a wake is offered, or one every run has.
    const named = new Set(a.slice(0, a.indexOf('Get the Q4')).match(/\b[a-z]+(?:_[a-z]+)+\b/g));
    expect([...named].filter(name => ![...wakeTools(true), ...EVERY_RUN_TOOLS].includes(name))).toEqual([]);
    expect(named.size).toBeGreaterThan(3);
  });
});

describe('what a wake holds', () => {
  it('its tools include memory and health reads, its own note, a follow-up and the owner\'s card', () => {
    expect(GENERAL_WAKE_TOOLS).toEqual(expect.arrayContaining(['read_memory', 'search_episodes', 'get_health', 'remember', 'open_loop', 'close_loop', 'propose_action', 'propose_calendar_change']));
  });

  it('its model role is configuration, with plans (the chat model) when unset or unknown', () => {
    expect([wakeRole(undefined), wakeRole('decides'), wakeRole('chat'), wakeRole('auxiliary'), wakeRole('fastest')]).toEqual(['plans', 'decides', true, false, 'plans']);
  });

  it('the month\'s wake cost is a running total per owner month, apart from the kept rows, and a new month starts from zero', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('wake-cost-month')), async (_instance, state) => {
      const month = wakeCostMonth(state.storage.kv);
      month.add('2026-11', 0.0312); month.add('2026-11', null); month.add('2026-11', 0.0188);
      expect(month.read('2026-11')).toEqual({ month: '2026-11', wakes: 3, priced: 2, usd: 0.05 });
      expect(month.add('2026-12', 0.01)).toEqual({ month: '2026-12', wakes: 1, priced: 1, usd: 0.01 });
      expect(month.read('2026-11')).toEqual({ month: '2026-11', wakes: 0, priced: 0, usd: 0 });
    });
  });
});
