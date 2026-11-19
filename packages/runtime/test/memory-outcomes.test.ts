import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { loopBook } from '../src/channels/loops';
import { claimStore } from '../src/memory/claims';
import { consolidateOutcomes, outcomeBook, OUTCOMES_THROUGH_KEY, type OutcomesDeps } from '../src/memory/outcomes';

// The learning loop's first source: cards Waldo raised and loops it set, and what became of each, read by the nightly pass. The
// model may only add, and what it adds is Waldo's untrusted read until the owner confirms it. Synthetic owner, Kolkata.
const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-16T21:30:00Z');
const add = (text: string, evidence: string, kind = 'routine') => ({ kind, text, source: 'inferred', evidence, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false });
const PATTERN = add('Takes Waldo\'s suggestions to move workouts to the morning, and declines evening ones', '"move the evening run to 07:00"');
const HEALTH = add('Sleeps badly after late meetings', '"sleep"', 'health');

const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => work(state));

// A ledger with the approval desk's base columns, and the loop book's own table, holding cards and loops of every state.
const seed = (state: DurableObjectState) => {
  const sql = state.storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER)');
  const card = (id: string, status: string, summary: string, created: number, decided: number | null) =>
    sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at) VALUES (?, 'calendar_move', ?, ?, '{}', ?, ?)", id, status, summary, created, decided);
  card('c1', 'done', 'Move the evening run to 07:00 tomorrow', NOW - 3 * DAY, NOW - 3 * DAY + HOUR);
  card('c2', 'rejected', 'Move the gym block to 19:30', NOW - 2 * DAY, NOW - 2 * DAY + 2 * HOUR);
  card('c3', 'undone', 'Push the design review to Friday', NOW - DAY, NOW - DAY + HOUR);
  card('c4', 'open', 'Block an hour for the board deck', NOW - HOUR, null);
  card('c5', 'expired', 'Move the dentist call to Monday', NOW - 20 * DAY, NOW - 19 * DAY);
  const loops = loopBook(sql, { newId: () => crypto.randomUUID(), now: () => NOW });
  sql.exec("INSERT INTO loops (id, title, due, status, created_at, closed_at) VALUES ('l1', 'Check the reply from the landlord came', NULL, 'done', ?, ?)", NOW - 2 * DAY, NOW - DAY);
  sql.exec("INSERT INTO loops (id, title, due, status, created_at, closed_at) VALUES ('l2', 'Chase the visa letter', NULL, 'open', ?, NULL)", NOW - DAY);
  return loops;
};

const pass = (state: DurableObjectState, reply: string | Error, health = true) => {
  const asked: string[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: OutcomesDeps = {
    kv: state.storage.kv, outcomes: outcomeBook(state.storage.sql), claims: claimStore(state.storage.sql, work => state.storage.transactionSync(work)),
    transaction: work => state.storage.transactionSync(work), timezone: 'Asia/Kolkata', now: () => NOW, health,
    ask: async text => { asked.push(text); if (reply instanceof Error) throw reply; return reply; },
    log: entry => logs.push(entry as never),
  };
  return { deps, asked, logs };
};

it('reads the week\'s decided cards and closed loops once, in the order they ended, in words, and adds only Waldo\'s untrusted reads', async () => {
  await owner('outcomes-read', async state => {
    seed(state);
    const { deps, asked } = pass(state, JSON.stringify({ add: [PATTERN], seen: [1], confirm: [1], dismiss: [1], forget_claims: [1], pin: [{ id: 1, block: 'profile', order: 0 }] }));
    expect(await consolidateOutcomes(deps, 'trace-1')).toBe('consolidated');
    expect(asked).toEqual([[
      '[2026-11-14T03:00] Waldo suggested: Move the evening run to 07:00 tomorrow\n[2026-11-14T04:00] Then the owner approved it and it was done.',
      '[2026-11-15T03:00] Waldo suggested: Move the gym block to 19:30\n[2026-11-15T05:00] Then the owner declined it.',
      '[2026-11-15T03:00] Waldo set itself to follow up on: Check the reply from the landlord came\n[2026-11-16T03:00] Then it was finished.',
      '[2026-11-16T03:00] Waldo suggested: Push the design review to Friday\n[2026-11-16T04:00] Then the owner approved it, it was done, then the owner undid it.',
    ].join('\n')]);
    const written = claimStore(state.storage.sql).claims().map(claim => [claim.text, claim.origin, claim.source, claim.pinned ?? null]);
    expect(written).toEqual([[PATTERN.text, 'untrusted', 'inferred', null]]);
    expect(state.storage.kv.get(OUTCOMES_THROUGH_KEY)).toBe(NOW - DAY + HOUR);
    expect(await consolidateOutcomes(pass(state, '{"add":[]}').deps, 'trace-2')).toBe('empty');
  });
});

it('keeps a health pattern out unless the owner shares health with memory', async () => {
  await owner('outcomes-health', async state => {
    seed(state);
    await consolidateOutcomes(pass(state, JSON.stringify({ add: [PATTERN, HEALTH] }), false).deps, 'trace-1');
    expect(claimStore(state.storage.sql).claims().map(claim => claim.text)).toEqual([PATTERN.text]);
  });
});

it('never shows the model a card or loop on a topic a forget still holds', async () => {
  await owner('outcomes-held', async state => {
    seed(state);
    claimStore(state.storage.sql, work => state.storage.transactionSync(work)).purge([], new Date(NOW - DAY).toISOString(), ['design review']);
    const { deps, asked } = pass(state, '{"add":[]}');
    await consolidateOutcomes(deps, 'trace-1');
    expect(asked[0]).not.toMatch(/design review/i);
    expect(asked[0]).toContain('gym block');
  });
});

it('moves no mark when the model call fails, so the next night reads the same rows', async () => {
  await owner('outcomes-fail', async state => {
    seed(state);
    const { deps, logs } = pass(state, new Error('synthetic outage'));
    expect(await consolidateOutcomes(deps, 'trace-1')).toBe('failed');
    expect(state.storage.kv.get(OUTCOMES_THROUGH_KEY)).toBe(NOW - 7 * DAY);
    expect(logs).toEqual([expect.objectContaining({ hop: 'nightly_memory', ok: false, code: 'provider_error' })]);
    const retry = pass(state, '{"add":[]}');
    await consolidateOutcomes(retry.deps, 'trace-2');
    expect(retry.asked[0]).toContain('evening run');
  });
});

it('reads nothing from an owner object that never raised a card or set a loop', async () => {
  await owner('outcomes-none', async state => {
    expect(await consolidateOutcomes(pass(state, '{"add":[]}').deps, 'trace-1')).toBe('empty');
  });
});
