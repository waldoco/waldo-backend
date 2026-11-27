import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { loopBook } from '../src/channels/loops';
import { claimStore, outcomesInput, BODY_PATTERN_RULE, type OutcomesPolicy } from '../src/memory/claims';
import { consolidateOutcomes, outcomeBook, outcomeReadsSection, OUTCOME_CLAIMS_KEY, OUTCOME_OUTSIDE_CLAIMS_KEY, OUTCOMES_THROUGH_KEY, type OutcomesDeps } from '../src/memory/outcomes';

// The learning loop: what Waldo did on its own initiative and what became of it, read by the nightly pass. The model may only
// add; what it adds from Waldo's own rows is Waldo's own read, and from rows drawn from outside content an untrusted note.
// Synthetic owner, Kolkata.
const HOUR = 3_600_000, DAY = 24 * HOUR;
const NOW = Date.parse('2026-11-16T21:30:00Z');
const add = (text: string, evidence: string, kind = 'routine') => ({ kind, text, source: 'inferred', evidence, touches_forgotten: false, aliases: [], aliases_touch_forgotten: false });
const PATTERN = add('Takes Waldo\'s suggestions to move workouts to the morning, and declines evening ones', '"Move the evening run to 07:00 tomorrow"');
const HEALTH = add('Sleeps badly after late meetings', '"Move the gym block"', 'health');
const FROM_MAIL = add('Lets landlord follow-ups close once a reply comes', '"Check the reply from the landlord came"');

const owner = (name: string, work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => work(state));

// A ledger with the approval desk's columns, the loop book's tables, a day card the owner never answered, and an update card
// the owner marked not useful. raised_outside 0 is Waldo's own card; a loop with a mail source came from outside content.
const seed = (state: DurableObjectState) => {
  const sql = state.storage.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, raised_outside INTEGER)');
  const card = (id: string, status: string, summary: string, created: number, decided: number | null, outside: number | null = 0) =>
    sql.exec("INSERT INTO ledger (id, kind, status, summary, payload_json, created_at, decided_at, raised_outside) VALUES (?, 'calendar_move', ?, ?, '{}', ?, ?, ?)", id, status, summary, created, decided, outside);
  card('c1', 'done', 'Move the evening run to 07:00 tomorrow', NOW - 3 * DAY, NOW - 3 * DAY + HOUR);
  card('c2', 'rejected', 'Move the gym block to 19:30', NOW - 2 * DAY, NOW - 2 * DAY + 2 * HOUR);
  card('c3', 'undone', 'Push the design review to Friday', NOW - DAY, NOW - DAY + HOUR);
  card('c4', 'open', 'Block an hour for the board deck', NOW - HOUR, null);
  card('c5', 'expired', 'Move the dentist call to Monday', NOW - 20 * DAY, NOW - 19 * DAY);
  loopBook(sql, { newId: () => crypto.randomUUID(), now: () => NOW });
  sql.exec("INSERT INTO loops (id, title, due, status, created_at, closed_at) VALUES ('l1', 'Check the reply from the landlord came', NULL, 'done', ?, ?)", NOW - 2 * DAY, NOW - DAY);
  sql.exec("INSERT INTO loops (id, title, due, status, created_at, closed_at) VALUES ('l2', 'Chase the visa letter', NULL, 'open', ?, NULL)", NOW - DAY);
  sql.exec("INSERT INTO loop_mail_sources (loop_id, source_ref) VALUES ('l1', 'mail:landlord')");
};

const pass = (state: DurableObjectState, reply: string | Error | ((policy: OutcomesPolicy) => string), health = true, readZones?: OutcomesDeps['readZones']) => {
  const asked: Readonly<{ text: string; policy: OutcomesPolicy }>[] = [];
  const logs: Record<string, unknown>[] = [];
  const deps: OutcomesDeps = {
    kv: state.storage.kv, outcomes: outcomeBook(state.storage.sql), claims: claimStore(state.storage.sql, work => state.storage.transactionSync(work)),
    transaction: work => state.storage.transactionSync(work), timezone: 'Asia/Kolkata', now: () => NOW, health,
    ask: async (text, policy) => { asked.push({ text, policy }); if (reply instanceof Error) throw reply; return typeof reply === 'function' ? reply(policy) : reply; },
    ...(readZones ? { readZones } : {}),
    log: entry => logs.push(entry as never),
  };
  return { deps, asked, logs };
};
const reads = (state: DurableObjectState) => outcomeReadsSection(claimStore(state.storage.sql), state.storage.kv.get<number[]>(OUTCOME_CLAIMS_KEY));

it('reads what ended since the mark once, in order and in words, apart from outside rows, and keeps Waldo\'s own reads for every later turn', async () => {
  await owner('outcomes-read', async state => {
    seed(state);
    const { deps, asked } = pass(state, policy => JSON.stringify(policy.outside ? { add: [FROM_MAIL] } : { add: [PATTERN], seen: [1], confirm: [1], dismiss: [1], forget_claims: [1], pin: [{ id: 1, block: 'profile', order: 0 }] }));
    expect(await consolidateOutcomes(deps, 'trace-1')).toBe('consolidated');
    expect(asked).toEqual([{ policy: { health: true, body: false, outside: false }, text: [
      '[2026-11-14T03:00] Waldo suggested: Move the evening run to 07:00 tomorrow\n[2026-11-14T04:00] Then the owner approved it and it was done.',
      '[2026-11-15T03:00] Waldo suggested: Move the gym block to 19:30\n[2026-11-15T05:00] Then the owner declined it.',
      '[2026-11-16T03:00] Waldo suggested: Push the design review to Friday\n[2026-11-16T04:00] Then the owner approved it, it was done, then the owner undid it.',
    ].join('\n') }, { policy: { health: true, body: false, outside: true },
      text: '[2026-11-15T03:00] Waldo set itself to follow up on: Check the reply from the landlord came\n[2026-11-16T03:00] Then it was finished.' }]);
    const written = claimStore(state.storage.sql).claims().map(claim => [claim.text, claim.origin, claim.source, claim.pinned ?? null]).sort();
    expect(written).toEqual([[FROM_MAIL.text, 'untrusted', 'inferred', null], [PATTERN.text, 'agent', 'inferred', null]]);
    expect(state.storage.kv.get(OUTCOMES_THROUGH_KEY)).toBe(NOW - DAY + HOUR);
    // Every later turn reads Waldo's own read, by id so the model can correct it; the untrusted note waits for recall.
    expect(reads(state)).toContain(PATTERN.text);
    expect(reads(state)).toMatch(/^- \[c\d+ /m);
    expect(reads(state)).not.toContain(FROM_MAIL.text);
    // The untrusted note is for runs Waldo starts over outside content, and says so.
    const outsideReads = outcomeReadsSection(claimStore(state.storage.sql), state.storage.kv.get<number[]>(OUTCOME_OUTSIDE_CLAIMS_KEY), true);
    expect(outsideReads).toContain(FROM_MAIL.text);
    expect(outsideReads).not.toContain(PATTERN.text);
    expect(outsideReads).toContain('outside content');
    expect(await consolidateOutcomes(pass(state, '{"add":[]}').deps, 'trace-2')).toBe('empty');
  });
});

it('a dismissed suggestion and an unanswered message reach the pass as what happened, and the read is seen next time; dismissing the read takes it out', async () => {
  await owner('outcomes-unanswered', async state => {
    const sql = state.storage.sql, episodes = episodeIndex(sql);
    sql.exec('CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, raised_outside INTEGER)');
    sql.exec("INSERT INTO ledger VALUES ('n1', 'calendar_change', 'rejected', 'Add a short walk after lunch', '{}', NULL, ?, ?, 0)", NOW - 2 * DAY, NOW - 2 * DAY + HOUR);
    sql.exec('CREATE TABLE day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, delivered_message_id TEXT, delivered_at INTEGER, PRIMARY KEY (day, card))');
    sql.exec("INSERT INTO day_plan (day, card, reason, sent, delivered_message_id, delivered_at) VALUES ('2026-11-15', 'card:midday', 'sent', 1, 'app-checkin-15', ?)", NOW - DAY - 6 * HOUR);
    sql.exec("INSERT INTO day_plan (day, card, reason, sent, delivered_message_id, delivered_at) VALUES ('2026-11-16', 'card:midday', 'sent', 1, 'app-checkin-16', ?)", NOW - 6 * HOUR);
    episodes.add('app-checkin-15', 'waldo', 'How did the afternoon go? A ten minute stretch before the 4pm call could help.', NOW - DAY - 6 * HOUR);
    episodes.add('app-owner-15', 'owner_said', 'Busy, skipped it.', NOW - DAY - 4 * HOUR);
    episodes.add('app-checkin-16', 'waldo', 'Quick check-in: a ten minute stretch before your next call?', NOW - 6 * HOUR);
    const NUDGES = add('Tends to pass on short movement breaks Waldo offers in the afternoon', '"Then the owner declined it."');
    const { deps, asked } = pass(state, JSON.stringify({ add: [NUDGES] }));
    await consolidateOutcomes(deps, 'trace-1');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.text).toContain('[2026-11-15T03:00] Waldo suggested: Add a short walk after lunch\n[2026-11-15T04:00] Then the owner declined it.');
    expect(asked[0]!.text).toContain('Waldo sent the owner its day card "Check-in" unasked:\nHow did the afternoon go? A ten minute stretch before the 4pm call could help.\nThe owner next wrote to Waldo at 2026-11-15T23:00.');
    expect(asked[0]!.text).toContain('Quick check-in: a ten minute stretch before your next call?\nThe owner has not written to Waldo since (as of 2026-11-17T03:00).');
    expect(reads(state)).toContain(NUDGES.text);
    const id = claimStore(state.storage.sql).claims().find(claim => claim.text === NUDGES.text)!.id;
    claimStore(state.storage.sql).setStatus(id, 'dismissed');
    expect(reads(state)).toBe('');
  });
});

it('keeps a health pattern out unless the owner shares health with memory, and never shows one in the turn section', async () => {
  await owner('outcomes-health', async state => {
    seed(state);
    await consolidateOutcomes(pass(state, JSON.stringify({ add: [PATTERN, HEALTH] }), false).deps, 'trace-1');
    expect(claimStore(state.storage.sql).claims().map(claim => claim.text)).toEqual([PATTERN.text]);
  });
  await owner('outcomes-health-shared', async state => {
    seed(state);
    await consolidateOutcomes(pass(state, policy => JSON.stringify({ add: policy.outside ? [] : [PATTERN, HEALTH] })).deps, 'trace-1');
    expect(claimStore(state.storage.sql).claims().map(claim => claim.text).sort()).toEqual([HEALTH.text, PATTERN.text]);
    expect(reads(state)).not.toContain(HEALTH.text);
  });
});

it('never keeps a raw health value in memory, the mark, the read ids or a log line', async () => {
  await owner('outcomes-no-values', async state => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS ledger (id TEXT PRIMARY KEY, kind TEXT NOT NULL, status TEXT NOT NULL, summary TEXT NOT NULL, payload_json TEXT NOT NULL, undo_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER, raised_outside INTEGER)');
    sql.exec("INSERT INTO ledger VALUES ('h1', 'calendar_change', 'expired', 'Move the run: resting heart rate 71 bpm this morning', '{}', NULL, ?, ?, 0)", NOW - DAY, NOW - DAY + HOUR);
    const READING = add('Resting heart rate 71 bpm on days Waldo moves the run', '"resting heart rate 71 bpm this morning"', 'health');
    const { deps, asked, logs } = pass(state, JSON.stringify({ add: [READING, PATTERN] }));
    expect(await consolidateOutcomes(deps, 'trace-1')).toBe('consolidated');
    expect(asked[0]!.text).toContain('71 bpm');
    const kept = JSON.stringify([claimStore(sql).allClaims(), [...state.storage.kv.list()], logs, reads(state)]);
    expect(kept).not.toMatch(/71/);
    expect(claimStore(sql).holds().map(hold => hold.reason)).toContain('numeric-health');
  });
});

it('never shows the model a card or loop on a topic a forget still holds', async () => {
  await owner('outcomes-held', async state => {
    seed(state);
    claimStore(state.storage.sql, work => state.storage.transactionSync(work)).purge([], new Date(NOW - DAY).toISOString(), ['design review']);
    const { deps, asked } = pass(state, '{"add":[]}');
    await consolidateOutcomes(deps, 'trace-1');
    expect(asked.map(call => call.text).join('\n')).not.toMatch(/design review/i);
    expect(asked[0]!.text).toContain('gym block');
  });
});

it('writes nothing and moves no mark when either call fails, so the next night reads the same rows', async () => {
  await owner('outcomes-fail', async state => {
    seed(state);
    const { deps, logs } = pass(state, policy => { if (policy.outside) throw new Error('synthetic outage'); return JSON.stringify({ add: [PATTERN] }); });
    expect(await consolidateOutcomes(deps, 'trace-1')).toBe('failed');
    expect(state.storage.kv.get(OUTCOMES_THROUGH_KEY)).toBe(NOW - 7 * DAY);
    expect(claimStore(state.storage.sql).claims()).toEqual([]);
    expect(logs).toEqual([expect.objectContaining({ hop: 'nightly_memory', ok: false, code: 'provider_error' })]);
    const retry = pass(state, '{"add":[]}');
    await consolidateOutcomes(retry.deps, 'trace-2');
    expect(retry.asked[0]!.text).toContain('evening run');
  });
});

it('reads nothing from an owner object that never raised a card, set a loop or sent a card', async () => {
  await owner('outcomes-none', async state => {
    expect(await consolidateOutcomes(pass(state, '{"add":[]}').deps, 'trace-1')).toBe('empty');
  });
});

// The body around each of Waldo's own outcomes, in zone words, from the model-consented zones read. Row words as the read
// returns them (low, moderate, good, high), shown to the model as the pillar's own zone words.
const ZONES = { zones: { from: '2026-11-09', to: '2026-11-17', days: [
  { day: '2026-11-14', recovery: 'moderate', form: 'good' }, { day: '2026-11-15', recovery: 'high', form: null },
  { day: '2026-11-16', recovery: null, form: 'low' }, { day: '2026-11-17', recovery: 'low', form: 'low' },
] } };

it('gives each of Waldo\'s own outcomes the owner\'s Recovery and Form that day and the next in zone words, and never an outside row', async () => {
  await owner('outcomes-body', async state => {
    seed(state);
    const windows: string[][] = [];
    const { deps, asked } = pass(state, '{"add":[]}', true, async (from, to) => { windows.push([from, to]); return ZONES; });
    await consolidateOutcomes(deps, 'trace-1');
    expect(windows).toEqual([['2026-11-14', '2026-11-17']]);
    expect(asked.map(call => call.policy)).toEqual([{ health: true, body: true, outside: false }, { health: true, body: false, outside: true }]);
    expect(asked[0]!.text).toContain('[2026-11-14T04:00] Then the owner approved it and it was done.\nThe owner\'s body: that day Recovery mixed, Form steady; the next day Recovery excellent.');
    expect(asked[0]!.text).toContain('Then the owner declined it.\nThe owner\'s body: that day Recovery excellent; the next day Form depleted.');
    expect(asked[0]!.text).not.toMatch(/\b(?:low|moderate|good|high)\b/);
    expect(asked[1]!.text).not.toContain('body');
    // The rule goes to the model only beside Waldo's own rows, never beside outside content.
    expect(outcomesInput(claimStore(state.storage.sql), 'x', asked[0]!.policy)).toContain(BODY_PATTERN_RULE);
    expect(outcomesInput(claimStore(state.storage.sql), 'x', { health: true, body: true, outside: true })).not.toContain(BODY_PATTERN_RULE);
  });
});

it('reads no body when the owner does not share health with memory, and goes on without it when the read fails', async () => {
  await owner('outcomes-body-off', async state => {
    seed(state);
    let read = 0;
    const off = pass(state, '{"add":[]}', false, async () => { read++; return ZONES; });
    await consolidateOutcomes(off.deps, 'trace-1');
    expect([read, off.asked[0]!.policy.body]).toEqual([0, false]);
    expect(off.asked[0]!.text).not.toContain('body');
  });
  await owner('outcomes-body-failed', async state => {
    seed(state);
    const failed = pass(state, '{"add":[]}', true, async () => { throw new Error('synthetic outage'); });
    expect(await consolidateOutcomes(failed.deps, 'trace-1')).toBe('consolidated');
    expect(failed.asked[0]!.policy.body).toBe(false);
    expect(failed.logs).toContainEqual(expect.objectContaining({ code: 'body_unread', ok: false }));
  });
});
