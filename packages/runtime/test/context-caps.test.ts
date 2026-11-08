import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { STANDING_ORDERS_PROMPT_CHARS, standingOrdersPrompt, type StandingOrder } from '../src/channels/standing-orders';
import { QUESTS_PROMPT_CHARS, questBook, questsPrompt } from '../src/channels/quests';

const order = (n: number, trigger: StandingOrder['trigger']): StandingOrder => ({
  id: `so${n}`, scope: `Order ${n}: ${'keep the mornings clear of calls unless the owner says otherwise. '.repeat(8)}`, trigger,
  at: trigger === 'every_turn' ? null : '07:00', gate: 'act_and_report', escalation: 'message_owner', created_at: n,
} as StandingOrder);
const book = (orders: readonly StandingOrder[]) => ({ list: () => orders }) as unknown as Parameters<typeof standingOrdersPrompt>[0];

describe('the standing orders every turn reads', () => {
  const orders = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => order(n, n % 3 === 0 ? 'every_turn' : 'daily'));
  const ids = (prompt: string) => prompt.split('\n').filter((line) => line.startsWith('- [')).map((line) => line.slice(3, line.indexOf(']')));

  it('without a cap, or within it, lists every order in its stored order', () => {
    expect(ids(standingOrdersPrompt(book(orders)))).toEqual(orders.map(({ id }) => id));
    const few = orders.slice(0, 3);
    expect(standingOrdersPrompt(book(few), STANDING_ORDERS_PROMPT_CHARS)).toBe(standingOrdersPrompt(book(few)));
  });

  it('past the cap keeps every order that applies every turn, fills the rest with scheduled ones, and counts the others', () => {
    const prompt = standingOrdersPrompt(book(orders), STANDING_ORDERS_PROMPT_CHARS);
    const shown = ids(prompt);
    expect(shown.slice(0, 3)).toEqual(['so3', 'so6', 'so9']);
    expect(shown.length).toBeLessThan(orders.length);
    expect(prompt.split('\n').filter((line) => line.startsWith('- [')).join('\n').length).toBeLessThanOrEqual(STANDING_ORDERS_PROMPT_CHARS);
    expect(prompt).toContain(`${orders.length - shown.length} more scheduled standing orders are not shown here; each runs with its own instructions when it fires, and in a chat with the owner list_standing_orders reads every one.`);
  });

  it('every-turn orders longer than the cap all still show, with no scheduled order beside them', () => {
    const long = [1, 2].map((n) => ({ ...order(n, 'every_turn'), scope: 'x'.repeat(STANDING_ORDERS_PROMPT_CHARS) }));
    const prompt = standingOrdersPrompt(book([...long, order(3, 'daily')]), STANDING_ORDERS_PROMPT_CHARS);
    expect(ids(prompt)).toEqual(['so1', 'so2']);
    expect(prompt).toContain('1 more scheduled standing order is not shown here');
  });

  it('a scheduled order that ends exactly at the cap shows', () => {
    const first = order(1, 'every_turn');
    const firstLine = standingOrdersPrompt(book([first])).split('\n')[1]!;
    const filler = order(2, 'daily');
    const fillerLine = standingOrdersPrompt(book([filler])).split('\n')[1]!;
    const cap = firstLine.length + 1 + fillerLine.length;
    expect(ids(standingOrdersPrompt(book([first, filler, order(3, 'daily')]), cap))).toEqual(['so1', 'so2']);
  });
});

describe('the open quests every turn reads', () => {
  const clock = { timezone: 'Europe/London', now: () => new Date('2026-11-06T10:00:00Z') };
  const long = (n: number) => `step ${n} ${'one small change at a time, checked weekly with the owner. '.repeat(5)}`;
  const seeded = (state: DurableObjectState) => {
    let id = 0;
    const quests = questBook(state.storage.sql, clock as never, () => `q${++id}`);
    for (let n = 1; n <= 12; n += 1) quests.set({ title: `Quest ${n}`, plan: long(n), usual: long(n), check_in_days: 7 }, 'owner-1');
    return quests;
  };

  it('with a cap shows whole lines within it and the rest by id and title, so set_quest can still name each', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('context-caps-quests')), (_instance, state) => {
      const quests = seeded(state);
      const full = questsPrompt(quests);
      const capped = questsPrompt(quests, QUESTS_PROMPT_CHARS);
      expect(full.length).toBeGreaterThan(QUESTS_PROMPT_CHARS);
      const whole = capped.split('\n').filter((line) => line.includes('plan:'));
      expect(whole.join('\n').length).toBeLessThanOrEqual(QUESTS_PROMPT_CHARS);
      for (let n = 1; n <= 12; n += 1) expect(capped).toContain(`[quest:q${n}] Quest ${n}`);
      expect(capped.length).toBeLessThan(full.length);
      expect(questsPrompt(quests, full.length + 1_000)).toBe(full);
    });
  });
});
