import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { LookCause } from '../src/channels/interventions';
import type { RunEndReport, RunSpend } from '../src/channels/owner-turn';
import { GENERAL_WAKE_TOOLS, generalWake, wakeOutcomeBook, wakeRole, WITHHELD_REASON, type WakeCode, type WakeRow } from '../src/channels/wake';

// GENERAL_WAKE: Waldo's general wake replaces the look. The model judges; code holds a message only for the owner's no to
// follow-ups and their quiet hours, and only when the run decides to speak. There is no daily count. A fake run stands in for
// the model, and these check what ran, what went, what was held, and the one outcome row each run leaves (with its reason and
// cost), never the model's judgment.
const NOW = Date.parse('2026-11-28T10:00:00Z');
const NUDGE = 'The deck block slipped this morning and the board deck is due Friday. Want me to hold 3 to 5 today for it?';
const SPEND: RunSpend = { calls: 3, model: 'claude-sonnet-5-5', input: 41_200, cached: 38_000, output: 900, usd: 0.0312 };
const end = (reason: string, why?: string, tools: readonly string[] = []): RunEndReport => ({ reason, ...(why ? { why } : {}), tools, spend: SPEND });

type Wake = Readonly<{ code: WakeCode | 'threw'; delivered: string[]; runs: number; prompts: string[]; rows: readonly WakeRow[] }>;
let seq = 0;
const wake = (reply: string, ended: RunEndReport | undefined, setup: Readonly<{ cause?: LookCause; quiet?: boolean; consent?: boolean; cards?: number; throws?: boolean }> = {}) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`general-wake-${seq += 1}`)), async (_instance, state): Promise<Wake> => {
    const outcomes = wakeOutcomeBook(state.storage.sql);
    const out = { delivered: [] as string[], runs: 0, prompts: [] as string[] };
    const run = generalWake({
      now: () => NOW, localNow: () => '2026-11-28T10:00',
      consent: () => setup.consent ?? true, quiet: () => setup.quiet ?? false,
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
    return { ...out, code, rows: outcomes.recent(10) };
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

  it('the owner\'s no to follow-ups and their quiet hours hold the message, not the look', async () => {
    for (const [setup, code] of [[{ consent: false }, 'held_consent'], [{ quiet: true }, 'held_quiet']] as const) {
      const out = await wake(NUDGE, end('send', 'Worth raising.'), setup);
      expect([out.runs, out.code, out.delivered, out.rows.map(row => row.outcome)]).toEqual([1, code, [], ['held']]);
    }
  });

  it('a question goes as one; a card it raised is the notification, with no message', async () => {
    expect((await wake('Do you still want the 16:00 board prep, now that it moved?', end('ask_owner', 'Only they know.'))).code).toBe('asked');
    const carded = await wake('SKIP', end('nothing_to_send', 'Put the move on a card.', ['propose_calendar_change']), { cards: 1 });
    expect([carded.code, carded.delivered]).toEqual(['carded', []]);
  });

  it('a follow-up it set for itself, or a note it kept, is its own outcome', async () => {
    expect((await wake('SKIP', end('follow_up', 'Check after the 16:00.', ['open_loop']))).code).toBe('followed_up');
    expect((await wake('SKIP', end('nothing_to_send', 'Kept that the deck moved to Friday.', ['remember']))).code).toBe('noted');
  });

  it('a reason that holds a health reading is never stored; the row keeps a fixed line instead', async () => {
    const out = await wake('SKIP', end('nothing_to_send', 'Resting heart rate 64 bpm, no need to say anything.'));
    expect(out.rows.map(row => row.reason)).toEqual([WITHHELD_REASON]);
  });

  it('a run that fails leaves a failed row and the failure still surfaces', async () => {
    const out = await wake('', undefined, { throws: true });
    expect([out.code, out.rows.map(row => [row.outcome, row.spend])]).toEqual(['threw', [['failed', null]]]);
  });

  it('the prompt starts with the same orientation every time and ends with what changed and the moment; it sets its own next look', async () => {
    const plain = await wake('SKIP', end('nothing_to_send', 'Nothing.'));
    const moved = await wake('SKIP', end('nothing_to_send', 'Landed; nothing to change.'), { cause: 'place_moved' });
    const [a, b] = [plain.prompts[0]!, moved.prompts[0]!];
    // The shared head reaches past the orientation into the owner's own context; only the end differs.
    const shared = [...a].findIndex((char, index) => char !== b[index]);
    expect(shared).toBeGreaterThan(a.indexOf('Send Ana the deck'));
    expect(a.indexOf('Board prep now 16:00')).toBeGreaterThan(a.indexOf('Deck block 9 to 12'));
    expect(b.slice(shared)).toContain('another time zone or city');
    expect(moved.rows.map(row => row.ref)).toEqual(['place_moved']);
    expect(a).toContain('open_loop');
    expect(a).not.toMatch(/most looks end in nothing|nothing is normal|volume/i);
    expect(a).toContain('end_run');
  });
});

describe('what a wake holds', () => {
  it('its tools include memory and health reads, its own note, a follow-up and the owner\'s card', () => {
    expect(GENERAL_WAKE_TOOLS).toEqual(expect.arrayContaining(['read_memory', 'search_episodes', 'get_health', 'remember', 'open_loop', 'close_loop', 'propose_action', 'propose_calendar_change']));
  });

  it('its model role is configuration, with plans (the chat model) when unset or unknown', () => {
    expect([wakeRole(undefined), wakeRole('decides'), wakeRole('chat'), wakeRole('auxiliary'), wakeRole('fastest')]).toEqual(['plans', 'decides', true, false, 'plans']);
  });
});
