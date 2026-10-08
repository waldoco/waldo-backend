import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { TelegramOwnerInbox } from '../src/channels/telegram-owner-inbox';
import { persistInboxWake } from '../src/scheduler/alarm-slot';
import { claimStore } from '../src/memory/claims';
import { episodeIndex } from '../src/channels/episodes';
const seen = vi.hoisted(() => ({ inputs: [] as string[], outputs: [] as unknown[][], sent: [] as string[], status: undefined as string | undefined }));
vi.mock('../src/channels/telegram-api', async load => ({
  ...await load<typeof import('../src/channels/telegram-api')>(),
  createTelegramCaller: () => async (method: string, params?: unknown) => { if (method === 'sendMessage') seen.sent.push(JSON.stringify(params)); return method === 'getMe' ? { username: 'fixture_bot' } : method === 'sendMessage' ? { message_id: 1, chat: { id: 42 } } : true; },
}));
vi.mock('openai', () => ({ default: class { responses = { create: async (body: unknown) => {
  seen.inputs.push(JSON.stringify(body));
  const name = (body as { text?: { format?: { name?: string } } }).text?.format?.name;
  return { id: 'fixture', ...(seen.status ? { status: seen.status } : {}), output_text: name === 'reaction' ? '{"reaction":null}' : name === 'day_plan' ? '{"cards":[]}' : 'Done', output: name ? [] : seen.outputs.shift() ?? [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
} }; } }));
beforeEach(() => { seen.inputs.length = 0; seen.outputs.length = 0; seen.sent.length = 0; seen.status = undefined; });
const stub = (name: string) => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(name));
const turn = async (name: string, id: number, text: string) => {
  await runInDurableObject(stub(name), async (instance, state) => {
    await state.storage.put({ telegram_subject: '42', do_name: name, origin: 'https://fixture.invalid' });
    const inbox = new TelegramOwnerInbox(state.storage, persistInboxWake);
    await inbox.admit({ bot: env.TELEGRAM_BOT_TOKEN!.split(':')[0]!, subject: '42', doName: name }, id, JSON.stringify({ update_id: id, message: { message_id: id, from: { id: 42, is_bot: false }, chat: { id: 42, type: 'private' }, text } }));
    await (instance as unknown as { drainInbox(): Promise<void> }).drainInbox();
    expect((await inbox.records()).find(row => row.updateId === id)?.reason).toBe('final_committed');
    await state.storage.deleteAlarm();
  });
};
const tool = (name: string, args: unknown) => [{ type: 'function_call', call_id: name, name, arguments: JSON.stringify(args) }];
it('the registered owner DO uses remember, correction and forget tools without a writer', async () => {
  const name = 'memory-do-tool-flow';
  seen.outputs.push(tool('remember', { kind: 'preference', text: 'Favourite coffee is espresso', evidence_quote: 'espresso' }), []);
  await turn(name, 1, 'My favourite coffee is espresso');
  await runInDurableObject(stub(name), (_i, state) => expect(claimStore(state.storage.sql).claims()).toMatchObject([{ text: 'Favourite coffee is espresso', origin: 'owner' }]));
  seen.outputs.push(tool('remember', { kind: 'preference', text: 'Favourite coffee is mocha', evidence_quote: 'mocha', replaces_id: 1 }), []);
  await turn(name, 2, 'Actually my favourite coffee is mocha');
  await runInDurableObject(stub(name), (_i, state) => expect(claimStore(state.storage.sql).claims()).toMatchObject([{ text: 'Favourite coffee is mocha', supersedes_id: 1 }]));
  seen.outputs.push(tool('forget_memory', { topic: 'coffee', scope_note: 'favourite coffee' }), []);
  await turn(name, 3, 'Forget my favourite coffee');
  await runInDurableObject(stub(name), (_i, state) => {
    expect(claimStore(state.storage.sql).claims()).toEqual([]);
    expect(episodeIndex(state.storage.sql).search('mocha', 10)).toEqual([]);
  });
  expect(seen.inputs.some(input => input.includes('claim_ops'))).toBe(false);
});
it('the registered owner DO rejects a fabricated owner quote', async () => {
  seen.outputs.push(tool('remember', { kind: 'fact', text: 'Bank is evilbank', evidence_quote: 'evilbank' }), []);
  await turn('memory-do-forged', 1, 'Read my mail');
  await runInDurableObject(stub('memory-do-forged'), (_i, state) => expect(claimStore(state.storage.sql).claims()).toEqual([]));
  expect(seen.inputs.some(input => input.includes('not grounded'))).toBe(true);
});
it('a held coffee topic keeps unrelated profile available in the registered owner DO', async () => {
  const name = 'memory-do-topic-scope';
  await runInDurableObject(stub(name), (_i, state) => {
    const memory = claimStore(state.storage.sql);
    memory.add({ kind: 'fact', text: 'Works in AI', evidence: 'AI', source: 'stated', origin: 'owner', source_ref: 'owner, tg-old' }, '2026-10-08T00:00:00Z');
    memory.beginTopicCoverage('coffee', '2026-10-08T00:00:00Z');
  });
  await turn(name, 1, 'What is on my calendar?');
  expect(seen.inputs.some(input => input.includes('Works in AI'))).toBe(true);
  expect(seen.inputs.some(input => input.includes('Recall is temporarily limited'))).toBe(false);
});
import { HELDROWS_SCAN_BUDGET, HARNESS_MESSAGE_LIMIT, heldRowShapes } from '../src/memory/held-rows';
import { likePrefilter, projectionPredicate, FORGOTTEN } from '../src/memory/claims';
import { parseHarnessCommand } from '../src/channels/harness';
import { evictDurableObject } from 'cloudflare:test';
import { updateBook } from '../src/channels/update-cards';
it('HELDROWS verdict is the real forgetSources verdict, and the row shapes it lists are the guard\'s own escape/NUL rows (differential)', async () => {
  const label = 'heldrows-differential'; const topic = 'DIFFTOPIC'; const accented = 'Émile';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const add = (changes: string, text: string | null) => sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?,?,?,?)', 1, 'd', changes, text);
    add('[{"note":"plain private text"}]', 'plain card');
    add('[{"note":"odd \\x41 escape PRIVATEWORDS"}]', 'a');
    add('[{"n":"fine"}]', `SECRETTAIL\0nul ${topic}`);
    add('[{"note":"Meeting moved \\u2013 see agenda"}]', 'unrelated');
    sql.exec('CREATE TABLE IF NOT EXISTS day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, card))');
    sql.exec('INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?,?,?,?,?)', '2026-10-05', 'upper', null, 'ÉMILE visited', 0);
    sql.exec('INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?,?,?,?,?)', '2026-10-05', 'neg', null, 'x\\y', 0);
    sql.exec('UPDATE day_plan SET rowid = -5 WHERE card = ?', 'neg');
    const real = realOf(state);
    const topics = [{ topic, state: 'pending' as const }, { topic: accented, state: 'pending' as const }];
    const header = heldRowShapes(sql, '', topics, 25, real);
    for (const [index, { topic: t }] of topics.entries()) {
      const r = real(t);
      expect(header).toContain(`t${index + 1}: pending ${r.incomplete ? 'incomplete' : 'complete'}${r.heldBy?.length ? ` held by ${r.heldBy.map(h => `${h.table}:${h.rule}:${h.rows}`).join(' ')}` : ''}`);
    }
    const cards = heldRowShapes(sql, 'update_cards', topics, 25, real);
    expect(cards).toMatch(/#2 changes .*other=1\].*t1\[guard_escape/);
    expect(cards).toMatch(/#3 text .*nul=1 .*t1\[nul carries=1/);
    // The ordinary \\u2013 row is not held by the real guard for these topics, and the diagnostic does not list it.
    expect(cards).not.toMatch(/^#4 /m);
    expect(cards).not.toMatch(/^#1 /m);
    for (const leak of ['plain private text', 'PRIVATEWORDS', 'SECRETTAIL', 'ÉMILE', 'Meeting moved']) expect(cards).not.toContain(leak);
    // Opposite-case non-ASCII row is not in the escape/NUL set; a negative rowid is still reached.
    const plan = heldRowShapes(sql, 'day_plan', topics, 25, real);
    expect(plan).toMatch(/#-5 reason .*other=1/);
    expect(plan).not.toContain('visited');
    expect(heldRowShapes(sql, 'constructor', topics, 25, real)).toMatch(/Usage:/);
    expect(heldRowShapes(sql, '__proto__', topics, 25, real)).toMatch(/Usage:/);
    state.storage.deleteAlarm();
  });
});

it('HELDROWS budgets the scan, continues from a printed rowid, and keeps its notices inside the harness cap', async () => {
  const label = 'heldrows-budget'; const topic = 'BUDGETTOPIC';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, card))');
    for (let index = 0; index < HELDROWS_SCAN_BUDGET + 50; index++) sql.exec('INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?,?,?,?,?)', '2026-10-05', `c${index}`, null, `a\\q ${index}`, 0);
    const real = realOf(state); const topics = [{ topic, state: 'pending' as const }];
    const first = heldRowShapes(sql, 'day_plan', topics, 25, real);
    expect(first).toMatch(new RegExp(`${HELDROWS_SCAN_BUDGET} rows with a backslash or NUL; PARTIAL, continue with /heldrows day_plan \\d+`));
    expect(first.length).toBeLessThanOrEqual(4000);
    expect(first).toMatch(/truncated: \d+ more rows not shown/);
    const next = Number(/continue with \/heldrows day_plan (\d+)/.exec(first)![1]);
    const second = heldRowShapes(sql, 'day_plan', topics, 25, real, next);
    expect(second).toContain('50 rows with a backslash or NUL');
    expect(heldRowShapes(sql, 'day_plan', topics, 25, real, 'invalid')).toMatch(/^Usage:/);
    expect(second).not.toContain('PARTIAL');
    state.storage.deleteAlarm();
  });
});

it('HELDROWS agrees with the real heldBy for projection and escape holds, including the guard\'s episodes table, and labels count-only holds', async () => {
  const label = 'heldrows-projection'; const topic = 'PROJTOPIC';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, card))');
    sql.exec('INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?,?,?,?,?)', '2026-10-05', 'p', null, JSON.stringify({ k: topic }), 0);
    episodeIndex(sql).add('ep-proj', 'owner', `SECRETEPISODE \\q ${topic}`, Date.now());
    const real = realOf(state); const topics = [{ topic, state: 'pending' as const }];
    const header = heldRowShapes(sql, '', topics, 25, real);
    expect(header).toContain('day_plan:projection');
    expect(header).toContain('episodes:guard_escape');
    const plan = heldRowShapes(sql, 'day_plan', topics, 25, real);
    expect(plan).toContain('0 listed of 0 rows');
    expect(plan).toMatch(/^#\d+ t1\[projection reason len=\d+ json=1 raw=1 val=1 key=0\]/m);
    expect(plan).not.toContain(topic.toLowerCase() + ' ');
    const episodes = heldRowShapes(sql, 'episodes', topics, 25, real);
    expect(episodes).toMatch(/text len=\d+ json=none .*t1\[guard_escape carries=1/);
    expect(episodes).not.toContain('SECRETEPISODE');
    state.storage.deleteAlarm();
  });
});

it('HELDROWS with 128 pending topics bounds the whole reply to the delivery cap and keeps summary and notices', async () => {
  const label = 'heldrows-many-topics';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS day_plan (day TEXT NOT NULL, card TEXT NOT NULL, time TEXT, reason TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, card))');
    for (let index = 0; index < 30; index++) sql.exec('INSERT INTO day_plan (day, card, time, reason, sent) VALUES (?,?,?,?,?)', '2026-10-05', `c${index}`, null, `a\\q ${index} T0001`, 0);
    const topics = Array.from({ length: 128 }, (_, index) => ({ topic: `T${String(index + 1).padStart(4, '0')}`, state: 'pending' as const }));
    const real = () => ({ incomplete: true, heldBy: [{ table: 'update_cards', rule: 'projection', rows: 1 }, { table: 'day_plan', rule: 'guard_escape', rows: 3 }] });
    const header = heldRowShapes(sql, '', topics, 25, real);
    expect(header.length).toBeLessThanOrEqual(4000);
    expect(header).toMatch(/\+\d+ more topics/);
    expect(header).toContain('Usage:');
    const out = heldRowShapes(sql, 'day_plan', topics, 25, real);
    // What the owner receives is the first 4000 characters.
    const delivered = out.slice(0, 4000);
    expect(out.length).toBeLessThanOrEqual(4000);
    expect(delivered).toContain('rows with a backslash or NUL');
    expect(delivered).toContain('row listing: escape/NUL rows');
    expect(delivered).toMatch(/\+\d+ more topics/);
    expect(delivered).toMatch(/truncated: \d+ more rows not shown/);
    state.storage.deleteAlarm();
  });
});

it('HELDROWS lists the held rows of a projection hold and a decoded-leaf hold, chosen by the real predicate, with no backslash needed', async () => {
  const label = 'heldrows-differential-projection'; const topic = 'DIFFPROJTOPIC';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const add = (changes: string, text: string | null) => sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?,?,?,?)', 1, 'd', changes, text);
    add('[{"note":"nothing here"}]', 'clean card');
    add(JSON.stringify([{ note: `SECRETVALUE ${topic}` }]), 'a');
    add(JSON.stringify([{ [topic]: 'x' }]), null);
    sql.exec('CREATE TABLE IF NOT EXISTS memory_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, decision_log TEXT)');
    sql.exec('INSERT INTO memory_blocks (content, decision_log) VALUES (?, ?)', JSON.stringify({ note: 'DIFFPROJ\u0054OPIC' }).replace('\u0054', '\\u0054'), null);
    const real = realOf(state); const topics = [{ topic, state: 'pending' as const }];
    const verdict = real(topic);
    expect(verdict.heldBy?.map(h => `${h.table}:${h.rule}`)).toContain('update_cards:projection');
    const cards = heldRowShapes(sql, 'update_cards', topics, 25, real);
    expect(cards).toMatch(/^#2 t1\[projection changes len=\d+ json=1 raw=1 val=1 key=0 \| text len=1 json=0 raw=0 val=0 key=0\]/m);
    expect(cards).toMatch(/^#3 t1\[projection changes len=\d+ json=1 raw=1 val=0 key=1/m);
    expect(cards).not.toMatch(/^#1 /m);
    expect(cards).not.toContain('SECRETVALUE');
    const blocks = heldRowShapes(sql, 'memory_blocks', topics, 25, real);
    expect(verdict.heldBy?.map(h => h.rule)).toContain('decoded_leaf_or_unreadable');
    expect(blocks).toMatch(/^#1 t1\[decoded_leaf_or_unreadable content len=\d+\]/m);
    state.storage.deleteAlarm();
  });
});

it('HELDROWS continues projection and decoded-leaf listings from the given rowid, announces a partial leaf scan, and bounds a many-topic reply through the real harness path', async () => {
  const label = 'heldrows-review-fixes'; const topic = 'LATEHOLDTOPIC';

  await runInDurableObject(stub(label), async (instance, state) => {
    const sql = state.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS memory_blocks (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT, decision_log TEXT)');
    for (let index = 0; index < HELDROWS_SCAN_BUDGET + 20; index++) sql.exec('INSERT INTO memory_blocks (content) VALUES (?)', JSON.stringify({ n: `plain ${index}` }));
    sql.exec('INSERT INTO memory_blocks (content) VALUES (?)', '{"note":"LATEHOLD\\u0054OPIC"}');
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    for (let index = 0; index < 3; index++) sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?,?,?,?)', 1, 'd', JSON.stringify([{ n: topic }]), null);
    const real = realOf(state); const topics = [{ topic, state: 'pending' as const }];
    // (a) the late decoded-leaf hold is announced as partial, then found by continuing.
    const first = heldRowShapes(sql, 'memory_blocks', topics, 25, real);
    const next = Number(/decoded-leaf scan of content PARTIAL, continue with \/heldrows memory_blocks (\d+)/.exec(first)![1]);
    expect(first).not.toContain('decoded_leaf_or_unreadable content len=');
    expect(heldRowShapes(sql, 'memory_blocks', topics, 25, real, next)).toMatch(/^#\d+ t1\[decoded_leaf_or_unreadable content/m);
    // (b) projection rows honor fromRowid.
    expect(heldRowShapes(sql, 'update_cards', topics, 25, real)).toMatch(/^#1 t1\[projection/m);
    const later = heldRowShapes(sql, 'update_cards', topics, 25, real, 2);
    expect(later).not.toMatch(/^#[12] /m);
    expect(later).toMatch(/^#3 t1\[projection/m);
    // (d) an omitted topic is never evaluated.
    const many = Array.from({ length: 128 }, (_, index) => ({ topic: `M${String(index + 1).padStart(4, '0')}`, state: 'pending' as const }));
    const calls: string[] = [];
    const out = heldRowShapes(sql, '', many, 25, t => { calls.push(t); return real(t); });
    const shown = Number(/^t(\d+): .*$/m.exec(out.split('\n').filter(l => /^t\d+:/.test(l)).at(-1)!)![1]);
    expect(calls.length).toBe(shown);
    // (c) real caller path: 128 pending topics, then the delivery slice.
    for (const t of many) sql.exec('INSERT OR IGNORE INTO topic_purge_pending (fingerprint, topic, created_at) VALUES (?,?,?)', `fp-${t.topic}`, t.topic, '2026-10-05T00:00:00Z');
    sql.exec('UPDATE update_cards SET changes = ?', JSON.stringify([{ n: 'M0001 M0002 M0003 M0004' }]));
    const reply = (await (instance as unknown as { runHarness(c: unknown, id: number): Promise<string> }).runHarness(parseHarnessCommand('/heldrows update_cards'), 1)).slice(0, HARNESS_MESSAGE_LIMIT);
    expect(reply).toMatch(/more topics not shown/);
    expect(reply).toMatch(/projection/);
    expect(reply).toContain('row listing: escape/NUL rows');
    state.storage.deleteAlarm();
  });
});

it('claims projection predicate equals the previous inline predicate on json value, key and raw rows', async () => {
  const label = 'projection-predicate-differential';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql; const topic = 'PREDTOPIC'; const like = likePrefilter(topic);
    sql.exec('CREATE TABLE IF NOT EXISTS pd (id INTEGER PRIMARY KEY, a TEXT, b TEXT)');
    const rows: Array<[string | null, string | null]> = [[`raw ${topic}`, null], [JSON.stringify({ k: topic }), 'x'], [JSON.stringify({ [topic]: 1 }), null], [JSON.stringify([{ deep: { v: `x ${topic} y` } }]), null], ['{"note":"clean"}', 'clean'], [null, JSON.stringify({ n: 5 })], ['not json', `b ${topic}`], ['{bad json', null]];
    for (const [a, b] of rows) sql.exec('INSERT INTO pd (a, b) VALUES (?,?)', a, b);
    const oldSql = (columns: string[]) => columns.map(column => `(${column} LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM json_tree(CASE WHEN json_valid(${column}) THEN ${column} ELSE 'null' END) WHERE (type = 'text' AND value LIKE ? ESCAPE '\\') OR key LIKE ? ESCAPE '\\'))`).join(' OR ');
    for (const columns of [['a'], ['b'], ['a', 'b']]) {
      const ids = (where: string) => sql.exec<{ id: number }>(`SELECT id FROM pd WHERE ${where} ORDER BY id`, ...columns.flatMap(() => [like, like, like])).toArray().map(r => r.id);
      expect(ids(projectionPredicate(columns))).toEqual(ids(oldSql(columns)));
      expect(ids(projectionPredicate(columns)).length).toBeGreaterThan(0);
    }
    state.storage.deleteAlarm();
  });
});

it('REPRO: a long topic purge redacts what the projection hold sees', async () => {
  const label = 'forget-update-cards-long-topic';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const add = (changes: string) => sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', changes);
    add(JSON.stringify([{ kind: 'note', detail: `Owner said ${topic}; keep it` }]));
    add(JSON.stringify([{ kind: 'note', detail: 'The secret code word that I told you about earlier today was discussed in the call' }]));
    const store = claimStore(sql);
    store.purge([], new Date().toISOString(), [topic]);
    const after = store.forgetSources(topic, true);
    const rows = sql.exec<{ changes: string }>('SELECT changes FROM update_cards ORDER BY id').toArray().map(r => r.changes);
    expect(rows[0]).not.toContain('ZEBRA');
    expect({ held: after.heldBy, incomplete: after.incomplete }).toEqual({ held: undefined, incomplete: false });
    state.storage.deleteAlarm();
  });
});

it('REPRO: a BLOB projection value cannot be proven clean and keeps the hold', async () => {
  const label = 'forget-update-cards-blob';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    sql.exec('INSERT INTO update_cards (at, day, changes, text) VALUES (?,?,?,?)', 1, 'd', '[]', new TextEncoder().encode(topic).buffer);
    const after = claimStore(sql).forgetSources(topic, true);
    expect(after.incomplete).toBe(true);
    state.storage.deleteAlarm();
  });
});

it('/heldrows lists prefix candidates and gives a continue-from note when the scan is partial', async () => {
  const label = 'forget-update-cards-decoys';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    for (let i = 0; i < 300; i++) sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify([{ detail: `the secret code word that I told you about earlier today ${i}` }]));
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify([{ detail: topic }]));
    const out = heldRowShapes(sql, 'update_cards', [{ topic, state: 'incomplete' }], 5, t => claimStore(sql).forgetSources(t, true));
    const text = JSON.stringify(out);
    expect(text).toContain('continue with /heldrows update_cards');
  });
});

it.each(['split', 'nul', 'keyvalue'] as const)('REPRO: a topic %s inside a retained card does not leave fragments or an unprovable hold', async kind => {
  const label = `forget-update-cards-frag-${kind}`;

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const at = { split: 46, nul: 41, keyvalue: 45 }[kind];
    const changes = kind === 'keyvalue' ? [{ [topic.slice(0, at)]: topic.slice(at) }] : kind.startsWith('split')
      ? [{ detail: topic.slice(0, at) }, { detail: topic.slice(at) }]
      : [{ detail: `${topic.slice(0, at)}\u0000${topic.slice(at)}` }];
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify(changes));
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify([{ detail: 'Standup moved to 09:30 UTC.' }]));
    const store = claimStore(sql);
    store.purge([], new Date().toISOString(), [topic]);
    const rows = sql.exec<{ changes: string }>('SELECT changes FROM update_cards ORDER BY id').toArray().map(r => r.changes);
    expect(rows[0]).not.toContain('ZEBRA');
    expect(rows[0]).not.toContain('COBALT');
    expect(rows[1]).toContain('Standup moved');
    expect(sql.exec<{ n: number }>('SELECT count(*) AS n FROM update_cards').one().n).toBe(2);
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    state.storage.deleteAlarm();
  });
});

it('REPRO: after a real DO eviction the retried topic purge blanks cards and is idempotent', async () => {
  const label = 'forget-update-cards-evict';

  const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    sql.exec('INSERT INTO update_cards (at, day, changes, pushed) VALUES (?,?,?,1)', 1, 'd', JSON.stringify([{ detail: topic.slice(0, 46) }, { detail: topic.slice(46) }]));
    state.storage.deleteAlarm();
  });
  await evictDurableObject(stub(label));
  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    for (let round = 0; round < 2; round++) {
      const store = claimStore(sql);
      store.purge([], new Date().toISOString(), [topic]);
      const row = sql.exec<{ changes: string; pushed: number }>('SELECT changes, pushed FROM update_cards').one();
      expect(row.changes).not.toContain('COBALT');
      expect(row.pushed).toBe(1);
      expect(store.forgetSources(topic, true).incomplete).toBe(false);
    }
    state.storage.deleteAlarm();
  });
});

it('a blanked card keeps the join keys and send state other consumers use; unrelated cards are untouched', async () => {
  const label = 'forget-update-cards-joinkeys';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const keep = { source: 'mail', kind: 'new', source_ref: 'mail:thread-1', source_message_id: 'msg-1' };
    sql.exec('INSERT INTO update_cards (at, day, changes, pushed, folded) VALUES (?,?,?,1,1)', 1, 'd', JSON.stringify([{ ...keep, detail: topic.slice(0, 46) }, { detail: topic.slice(46) }]));
    const other = JSON.stringify([{ ...keep, source_ref: 'mail:thread-2', source_message_id: 'msg-2', detail: 'Invoice question from the vendor' }]);
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', other);
    claimStore(sql).purge([], new Date().toISOString(), [topic]);
    const rows = sql.exec<{ changes: string; pushed: number; folded: number }>('SELECT changes, pushed, folded FROM update_cards ORDER BY id').toArray();
    const first = JSON.parse(rows[0]!.changes) as Record<string, string>[];
    expect(first[0]).toMatchObject(keep);
    expect(rows[0]!.changes).not.toContain('COBALT');
    expect([rows[0]!.pushed, rows[0]!.folded]).toEqual([1, 1]);
    expect(rows[1]!.changes).toBe(other);
    state.storage.deleteAlarm();
  });
});

it('a fragment-split card keeps the forget held until the purge blanks it, so an empty-inventory retry cannot settle clean', async () => {
  const label = 'forget-update-cards-heldbefore';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify([{ detail: topic.slice(0, 46) }, { detail: topic.slice(46) }]));
    const store = claimStore(sql);
    expect(store.forgetSources(topic, true).incomplete).toBe(true);
    store.purge([], new Date().toISOString(), [topic]);
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    state.storage.deleteAlarm();
  });
});

it.each([['quote', 'the "secret" code word that I told you about earlier today is ZEBRA-COBALT'], ['backslash', 'the C:\\secret code word that I told you about earlier today is ZEBRA-COBALT']] as const)('REPRO: a topic with a %s inside its first 40 chars, split in a card, is blanked as well as held', async (kind, topic) => {
  const label = `forget-update-cards-escape-${kind}`;

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify([{ detail: topic.slice(0, 46) }, { detail: topic.slice(46) }]));
    const store = claimStore(sql);
    expect(store.forgetSources(topic, true).incomplete).toBe(true);
    store.purge([], new Date().toISOString(), [topic]);
    expect(sql.exec<{ changes: string }>('SELECT changes FROM update_cards').one().changes).not.toContain('COBALT');
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    state.storage.deleteAlarm();
  });
});

it.each([['split20', 20], ['nul20', 20], ['split39', 39], ['keyvalue20', 20]] as const)('EXACT-CARD %s: a split or NUL inside the first 40 chars is held before purge and blanked by it', async (kind, at) => {
  const label = `forget-card-exact-${kind}`;

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const changes = kind === 'keyvalue20' ? [{ [topic.slice(0, at)]: topic.slice(at) }]
      : kind.startsWith('nul') ? [{ detail: `${topic.slice(0, at)}\u0000${topic.slice(at)}` }]
      : [{ detail: topic.slice(0, at) }, { detail: topic.slice(at) }];
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify(changes));
    const store = claimStore(sql);
    expect(store.forgetSources(topic, true).incomplete).toBe(true);
    store.purge([], new Date().toISOString(), [topic]);
    expect(sql.exec<{ changes: string }>('SELECT changes FROM update_cards').one().changes).not.toContain('COBALT');
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    state.storage.deleteAlarm();
  });
});

it('EXACT-CARD a card that only shares the topic prefix is held and blanked (fail-closed floor, join keys kept), and a blanked mail card keeps its detail key and join keys', async () => {
  const label = 'forget-card-exact-decoy';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const decoy = JSON.stringify([{ source: 'mail', kind: 'new', source_ref: 'mail:t9', source_message_id: 'm9', detail: 'the secret code word that I told you about earlier today was a joke' }]);
    const keep = { source: 'mail', kind: 'new', source_ref: 'mail:t1', source_message_id: 'm1' };
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', decoy);
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify([{ ...keep, detail: topic.slice(0, 30) }, { detail: topic.slice(30) }]));
    const store = claimStore(sql);
    expect(store.forgetSources(topic, true).incomplete).toBe(true);
    store.purge([], new Date().toISOString(), [topic]);
    const rows = sql.exec<{ changes: string }>('SELECT changes FROM update_cards ORDER BY id').toArray();
    expect(JSON.parse(rows[0]!.changes)).toEqual([{ source: 'mail', kind: 'new', source_ref: 'mail:t9', source_message_id: 'm9', detail: '[forgotten]' }]);
    const blanked = JSON.parse(rows[1]!.changes) as Record<string, string>[];
    expect(blanked[0]).toMatchObject({ ...keep, detail: FORGOTTEN });
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    state.storage.deleteAlarm();
  });
});

it.each([['mixed46', 46], ['mixed20', 20]] as const)('EXACT-CARD %s: real mail metadata rows between the fragments do not break the match', async (kind, at) => {
  const label = `forget-card-exact-${kind}`;

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const meta = (n: number) => ({ source: 'mail', kind: 'new', source_ref: `mail:t${n}`, source_message_id: `m${n}` });
    sql.exec('INSERT INTO update_cards (at, day, changes) VALUES (?,?,?)', 1, 'd', JSON.stringify([{ ...meta(0), detail: topic.slice(0, at) }, { ...meta(1), detail: topic.slice(at) }, { ...meta(2), detail: 'Invoice question from the vendor' }]));
    const store = claimStore(sql);
    expect(store.forgetSources(topic, true).incomplete).toBe(true);
    store.purge([], new Date().toISOString(), [topic]);
    const after = sql.exec<{ changes: string }>('SELECT changes FROM update_cards').one().changes;
    expect(after).not.toContain('COBALT');
    expect(JSON.parse(after)[1]).toMatchObject(meta(1));
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    state.storage.deleteAlarm();
  });
});

it('EXACT-CARD only the fragment leaves are blanked: an unrelated sibling leaf and a clean summary text stay readable', async () => {
  const label = 'forget-card-exact-siblings';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const meta = (n: number) => ({ source: 'mail', kind: 'new', source_ref: `mail:t${n}`, source_message_id: `m${n}` });
    const unrelated = { ...meta(2), detail: 'Invoice question from the vendor' };
    sql.exec('INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (?,?,?,?,1)', 1, 'd', JSON.stringify([{ detail: topic.slice(0, 20) }, { detail: topic.slice(20) }, unrelated]), 'Two updates today.');
    const store = claimStore(sql);
    store.purge([], new Date().toISOString(), [topic]);
    const row = sql.exec<{ changes: string; text: string; pushed: number }>('SELECT changes, text, pushed FROM update_cards').one();
    const after = JSON.parse(row.changes) as Record<string, string>[];
    expect(row.changes).not.toContain('COBALT');
    expect(after[2]).toEqual(unrelated);
    expect(row.text).toBe('Two updates today.');
    expect(row.pushed).toBe(1);
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    state.storage.deleteAlarm();
  });
});

it('DUPKEY an unrelated duplicate-key card keeps the exact bytes SQLite reads (first duplicate), and a duplicate that hides the topic is still removed', async () => {
  const label = 'forget-card-dupkey-unrelated';

  await runInDurableObject(stub(label), (_instance, state) => {
    const sql = state.storage.sql;
    const topic = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
    sql.exec(`CREATE TABLE IF NOT EXISTS update_cards (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, changes TEXT NOT NULL, text TEXT, pushed INTEGER NOT NULL DEFAULT 0, folded INTEGER NOT NULL DEFAULT 0, feedback TEXT)`);
    const detailDup = '[{"source":"mail","kind":"new","source_ref":"mail:invoice","detail":"invoice2719","detail":"lunch agenda"}]';
    const refDup = '[{"source":"mail","kind":"new","source_ref":"mail:invoice","source_ref":"mail:lunch","detail":"Invoice question"}]';
    const collide = `[{"detail":"the secret code word","detail":" that I told you about earlier today is ZEBRA-COBALT","detail\\u00001":"clean"}]`;
    const hidden = `[{"source":"mail","kind":"new","source_ref":"mail:h","detail":"${topic}","detail":"x"}]`;
    for (const changes of [detailDup, refDup, hidden]) sql.exec('INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (?,?,?,?,1)', 1, 'd', changes, null);
    const store = claimStore(sql);
    store.purge([], new Date().toISOString(), [topic]);
    const rows = sql.exec<{ changes: string }>('SELECT changes FROM update_cards ORDER BY id').toArray().map(r => r.changes);
    expect(rows[0]).toBe(detailDup);
    expect(rows[1]).toBe(refDup);
    expect(sql.exec<{ v: string }>("SELECT json_extract(changes, '$[0].detail') AS v FROM update_cards WHERE id = 1").one().v).toBe('invoice2719');
    expect(rows[2]).not.toContain('COBALT');
    expect(store.forgetSources(topic, true).incomplete).toBe(false);
    // A renamed duplicate must not collide with a real key: this card keeps the topic split over duplicates and is held, not judged clean.
    sql.exec('INSERT INTO update_cards (at, day, changes, text, pushed) VALUES (?,?,?,?,1)', 1, 'd', collide, null);
    expect(store.forgetSources(topic, true).incomplete).toBe(true);
    state.storage.deleteAlarm();
  });
});

const MAIL_T = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';

const MAIL_D = MAIL_T.slice(0,40) + ' the public lunch agenda says AMBER';

const MAIL_U = 'Invoice question from the vendor, unrelated and due tomorrow';

const mailM = (i: number, detail: string) => ({source:'mail' as const,kind:'new' as const,source_ref:`mail:review-${i}`,source_message_id:`msg-mail:review-${i}`,detail});

it.each(['decoy','mixed','consumers','literal'] as const)('MAIL-FIXTURE %s', async kind => {
 const label = `mail-fixture-${kind}`;

 await runInDurableObject(stub(label), (_instance,state) => {
  const sql = state.storage.sql; const updates = updateBook(sql);
  const changes = kind === 'decoy' ? [mailM(0,MAIL_D)] : kind === 'literal' ? [mailM(0,MAIL_T),mailM(1,MAIL_U)] : [mailM(0,MAIL_T.slice(0,46)),mailM(1,MAIL_T.slice(46)),mailM(2,MAIL_U)];
  const summary = 'Invoice summary unrelated to the secret';
  changes.forEach((c,i) => updates.observeMail(c.source_ref,`thread-${i}`,i,c.source_message_id));
  const id = updates.record('d',1,changes,summary);
  const loops = loopBook(sql,{newId:()=> String(Math.random()),now:()=>1});
  changes.forEach(c=>loops.open({title:MAIL_U,due:'2026-10-05T00:00',source_ref:c.source_ref}));
  claimStore(sql).purge([],new Date().toISOString(),[MAIL_T]);
  const row = sql.exec<{changes:string;text:string;pushed:number;folded:number}>('SELECT changes,text,pushed,folded FROM update_cards WHERE id = ?',id).one();
  const after = JSON.parse(row.changes);
  const pending = updates.pendingMail(); const due = loops.reviewDue('2026-10-06T00:00');
  console.log('MAIL-EVIDENCE',kind,JSON.stringify({row,pending,due}));
  expect(row.changes).not.toContain('COBALT');
  if(kind==='decoy') expect(JSON.parse(row.changes)[0]).toMatchObject({source:'mail',kind:'new',detail:'[forgotten]'});
  if(kind==='mixed'||kind==='literal') { expect(after.at(-1)).toEqual(changes.at(-1)); expect(row.text).toBe(summary); }
  if(kind==='consumers') { expect(pending).toHaveLength(3); expect(due).toHaveLength(3); expect(pending.every(c=>typeof c.detail==='string')).toBe(true); expect(due.every(c=>typeof c.source_detail==='string')).toBe(true); expect(pending.at(-1)!.detail).toBe(MAIL_U); }
  state.storage.deleteAlarm();
 });
});

it('REVIEW798 mixed matching card still erases unrelated sibling and summary', async () => {
 const label='review798-collateral';
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql;const updates=updateBook(sql);
  const sibling=mailM(2,MAIL_U); const summary='Invoice summary unrelated to the secret';
  updates.observeMail(sibling.source_ref,'thread-2',1,sibling.source_message_id);
  updates.record('d',1,[{detail:MAIL_T.slice(0,20)},{detail:MAIL_T.slice(20)},sibling] as any,summary);
  const store=claimStore(sql); expect(store.forgetSources(MAIL_T,true).incomplete).toBe(true);
  console.log('REVIEW798-HELDROWS',heldRowShapes(sql,'update_cards',[{topic:MAIL_T,state:'incomplete'}],5,t=>store.forgetSources(t,true)));
  store.purge([],new Date().toISOString(),[MAIL_T]);
  const row=sql.exec<{changes:string;text:string}>('SELECT changes,text FROM update_cards').one();
  console.log('REVIEW798-COLLATERAL',JSON.stringify({row,pending:updates.pendingMail()})); state.storage.deleteAlarm();
  expect(JSON.parse(row.changes).at(-1)).toEqual(sibling); expect(row.text).toBe(summary);
 });
});

it('REVIEW798 mail split20 /heldrows incorrectly says no holding rows',async()=> {
 const label='review798-shapes';
 await runInDurableObject(stub(label),(_instance,state)=> {
 const sql=state.storage.sql;updateBook(sql).record('d',1,[mailM(0,MAIL_T.slice(0,20)),mailM(1,MAIL_T.slice(20))],null);
 const store=claimStore(sql);const shape=heldRowShapes(sql,'update_cards',[{topic:MAIL_T,state:'incomplete'}],5,t=>store.forgetSources(t,true));
 console.log('REVIEW798-MAIL-SHAPE',shape);state.storage.deleteAlarm();expect(shape).toMatch(/^#1 t1\[projection/m);
 });
});

it('ADVERSARIAL798 preserves unrelated preceding sibling as well as following sibling', async () => {
 const label='adv798-leading';
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql; const updates=updateBook(sql); const changes=[mailM(0,MAIL_U),mailM(1,MAIL_T.slice(0,20)),mailM(2,MAIL_T.slice(20)),mailM(3,'Other unrelated tail')];
  updates.record('d',1,changes,'Clean summary'); const store=claimStore(sql);
  expect(store.forgetSources(MAIL_T,true).incomplete).toBe(true);
  store.purge([],new Date().toISOString(),[MAIL_T]);
  const row=sql.exec<{changes:string;text:string}>('SELECT changes,text FROM update_cards').one();
  console.log('ADVERSARIAL798-LEADING',row); state.storage.deleteAlarm();
  expect(JSON.parse(row.changes)[0]).toEqual(changes[0]); expect(JSON.parse(row.changes)[3]).toEqual(changes[3]);
 });
});

it.each(['quote','backslash','space','keyvalue','upper','sigma','nested'] as const)('ADVERSARIAL798 topic variants %s hold purge shapes',async kind=> {
 const label=`adv798-variant-${kind}`;
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql;const updates=updateBook(sql);const T=kind==='quote'?'the private word is "ZEBRA" today':kind==='backslash'?'the private path is C:\\zebra today':kind==='sigma'?'private ΟΣ value':MAIL_T;
  const k=Math.floor(T.length/2); let a=T.slice(0,k),b=T.slice(k);
  if(kind==='upper'){a=a.toUpperCase();b=b.toUpperCase();}
  const changes=kind==='keyvalue'?[{[a]:b},mailM(2,MAIL_U)]:kind==='nested'?[{payload:{detail:a}},{payload:{detail:b}},mailM(2,MAIL_U)]:[mailM(0,kind==='space'?a.trimEnd():a),mailM(1,kind==='space'?b.trimStart():b),mailM(2,MAIL_U)];
  updates.record('d',1,changes as any,'Clean summary');const store=claimStore(sql);
  const before=store.forgetSources(T,true);const shape=heldRowShapes(sql,'update_cards',[{topic:T,state:'incomplete'}],5,t=>store.forgetSources(t,true));
  store.purge([],new Date().toISOString(),[T]); const row=sql.exec<{changes:string;text:string}>('SELECT changes,text FROM update_cards').one();const after=store.forgetSources(T,true);
  console.log('ADVERSARIAL798-VARIANT',kind,JSON.stringify({before,shape,row,after}));state.storage.deleteAlarm();
  expect(before.incomplete).toBe(true);expect(shape).toMatch(/^#1 t1\[projection/m);expect(after.incomplete).toBe(false);expect(JSON.parse(row.changes).at(-1)).toEqual(changes.at(-1));expect(row.text).toBe('Clean summary');
 });
});

it.each(['quote','backslash'] as const)('ADVERSARIAL798 unrelated escaped %s card remains identical',async kind=> {
 const label=`adv798-clean-${kind}`;
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql;const updates=updateBook(sql);const topic=kind==='quote'?'my secret is "ZEBRA"':'my secret is C:\\zebra';
  const changes=[mailM(0,kind==='quote'?'Invoice says "AMBER" only':'Invoice file C:\\amber only')];updates.record('d',1,changes,'Clean summary');
  const store=claimStore(sql);const before=store.forgetSources(topic,true);store.purge([],new Date().toISOString(),[topic]);const row=sql.exec<{changes:string}>('SELECT changes FROM update_cards').one();
  console.log('ADVERSARIAL798-CLEAN',kind,JSON.stringify({before,row}));state.storage.deleteAlarm();expect(row.changes).toBe(JSON.stringify(changes));
 });
});

it('ADVERSARIAL798 duplicate topic copies and literal plus split are not reconstructable after purge',async()=> {
 const label='adv798-repeat';
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql;const updates=updateBook(sql);updates.record('d',1,[mailM(0,MAIL_T),mailM(1,MAIL_T.slice(0,20)),mailM(2,MAIL_T.slice(20)),mailM(3,MAIL_U),mailM(4,MAIL_T.slice(0,46)),mailM(5,MAIL_T.slice(46))],'Clean summary');
  const store=claimStore(sql);store.purge([],new Date().toISOString(),[MAIL_T]);const first=sql.exec<{changes:string}>('SELECT changes FROM update_cards').one();store.purge([],new Date().toISOString(),[MAIL_T]);const second=sql.exec<{changes:string}>('SELECT changes FROM update_cards').one();
  console.log('ADVERSARIAL798-REPEAT',first);state.storage.deleteAlarm();expect(store.forgetSources(MAIL_T,true).incomplete).toBe(false);expect(second).toEqual(first);expect(first.changes).not.toContain('COBALT');
 });
});

it.each(['literal+spacesplit','valuesplit+kvspace','nestedarray'] as const)('NEW798 %s', async kind => {
 const label=`new798-${kind}`;
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql; const updates=updateBook(sql); const store=claimStore(sql);
  const U=mailM(9,MAIL_U);
  if(kind==='literal+spacesplit') updates.record('d',1,[mailM(0,T8),mailM(1,T8.slice(0,sp)),mailM(2,T8.slice(sp+1)),U],'S');
  if(kind==='valuesplit+kvspace') updates.record('d',1,[mailM(0,T8.slice(0,20)),mailM(1,T8.slice(20)),{[T8.slice(0,sp)]:T8.slice(sp+1)},U] as any,'S');
  if(kind==='nestedarray') updates.record('d',1,[{a:[[T8.slice(0,30)],{b:[T8.slice(30)]}]},U] as any,'S');
  const before=store.forgetSources(T8,true).incomplete;
  store.purge([],new Date().toISOString(),[T8]);
  const rows=sql.exec<{changes:string;text:string}>('SELECT changes,text FROM update_cards ORDER BY id').toArray();
  const after=store.forgetSources(T8,true).incomplete;
  const joined=rows.map(r=>r.changes+r.text).join('|');
  console.log('NEW798',kind,JSON.stringify({before,after,rows}));
  state.storage.deleteAlarm();
  expect(after).toBe(false); expect(joined).not.toContain('COBALT'); expect(joined).not.toContain('ZEBRA');
  expect(joined).toContain(MAIL_U);
 });
});

it('NEW798 perf big card', async()=> {
 const label='new798-perf';
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql; const updates=updateBook(sql); const store=claimStore(sql);
  updates.record('d',1,Array.from({length:400},(_,i)=>mailM(i,`unrelated filler text number ${i} `.repeat(3))),'S');
  for(let i=0;i<300;i++) updates.record('d',1,[mailM(500+i,'other')],'S');
  const t0=Date.now(); store.forgetSources(T8,true); const t1=Date.now();
  updates.record('d',1,[mailM(1000,T8.slice(0,20)),...Array.from({length:400},(_,i)=>mailM(2000+i,`filler ${i}`)),mailM(1001,T8.slice(20))],'S');
  const t2=Date.now(); store.purge([],new Date().toISOString(),[T8]); const t3=Date.now();
  console.log('NEW798-PERF',JSON.stringify({hold:t1-t0,purge:t3-t2})); state.storage.deleteAlarm();
 });
});

it.each(['changes-vs-summary','across-cards','inline-unrelated'] as const)('CUSTODY %s', async kind => {
 const label=`custody-${kind}`;
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql; const updates=updateBook(sql); const store=claimStore(sql);
  const a=MAIL_T.slice(0,46), b=MAIL_T.slice(46);
  if(kind==='changes-vs-summary') updates.record('d',1,[mailM(0,a)],b);
  if(kind==='across-cards'){ updates.record('d',1,[mailM(0,a)],'S1'); updates.record('d',1,[mailM(1,b)],'S2'); }
  if(kind==='inline-unrelated') updates.record('d',1,[mailM(0,`${MAIL_T} and ${MAIL_U}`),mailM(1,a),mailM(2,b)],'S');
  const before=store.forgetSources(MAIL_T,true).incomplete;
  store.purge([],new Date().toISOString(),[MAIL_T]);
  const rows=sql.exec<{changes:string;text:string}>('SELECT changes,text FROM update_cards ORDER BY id').toArray();
  const after=store.forgetSources(MAIL_T,true).incomplete;
  const joined=rows.map(r=>r.changes+'|'+r.text).join('#');
  state.storage.deleteAlarm();
  if(kind!=='inline-unrelated') expect(before).toBe(true);
  expect(after).toBe(false);
  // The first fragment (the part that carries the prefix) is gone, so the topic cannot be rebuilt; a prefix-free tail row is not detectable (#794).
  expect(joined).not.toContain(a.slice(0,40)); expect(joined).not.toContain(MAIL_T);
  if(kind==='inline-unrelated') expect(joined).toContain(MAIL_U);
 });
});

it.each(['rename-collision','duplicate-key','big-card'] as const)('CUSTODY2 %s', async kind => {
 const label=`custody2-${kind}`;
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql; const updates=updateBook(sql); const store=claimStore(sql);
  const a=MAIL_T.slice(0,46), b=MAIL_T.slice(46);
  let t0=0, t1=0;
  if(kind==='rename-collision') updates.record('d',1,[{[a]:'one',['[forgotten]']:'two',other:'three'},{[b]:'four'}] as any,'S');
  if(kind==='duplicate-key'){ updates.record('d',1,[mailM(0,a)],'S'); sql.exec('UPDATE update_cards SET changes = ?', `[{"source":"mail","kind":"new","source_ref":"mail:r0","source_message_id":"m0","detail":"${a}","detail":"${b}"}]`); }
  if(kind==='big-card') updates.record('d',1,[mailM(0,a),...Array.from({length:400},(_,i)=>mailM(i+1,`filler ${i}`))],'S');
  const before=store.forgetSources(MAIL_T,true).incomplete;
  t0=Date.now(); store.purge([],new Date().toISOString(),[MAIL_T]); t1=Date.now();
  const rows=sql.exec<{changes:string}>('SELECT changes FROM update_cards ORDER BY id').toArray();
  const after=store.forgetSources(MAIL_T,true).incomplete;
  state.storage.deleteAlarm();
  expect(before).toBe(true); expect(after).toBe(false);
  if(kind==='rename-collision'){ const first=JSON.parse(rows[0]!.changes)[0]; expect(Object.keys(first)).toHaveLength(3); expect(rows[0]!.changes).toContain('"three"'); }
  if(kind==='duplicate-key') { expect(rows[0]!.changes).not.toContain(b); expect(rows[0]!.changes).not.toContain(a); }
  if(kind==='big-card') expect(t1-t0).toBeLessThan(2000);
 });
});

it('CUSTODY3 a split topic in a card of 70 leaves blanks only its pieces, and an unrelated card keeps its exact bytes', async () => {
 const label='custody3-big';
 await runInDurableObject(stub(label),(_instance,state)=> {
  const sql=state.storage.sql; const updates=updateBook(sql); const store=claimStore(sql);
  const a=MAIL_T.slice(0,46), b=MAIL_T.slice(46);
  const filler=Array.from({length:34},(_,i)=>mailM(i+10,`unrelated invoice detail ${i}`));
  updates.record('d',1,[...filler.slice(0,17),mailM(0,a),mailM(1,b),...filler.slice(17)],'S');
  updates.record('d',1,[mailM(90,'plain')],'S2');
  const exactBytes='[{"n":9007199254740993,"big":1e400,"detail":"keep me"}]';
  sql.exec('UPDATE update_cards SET changes = ? WHERE id = (SELECT MAX(id) FROM update_cards)',exactBytes);
  const t0=Date.now(); store.purge([],new Date().toISOString(),[MAIL_T]); const ms=Date.now()-t0;
  const rows=sql.exec<{changes:string}>('SELECT changes FROM update_cards ORDER BY id').toArray();
  state.storage.deleteAlarm();
  const first=rows[0]!.changes;
  expect(first).not.toContain(a.slice(0,40)); expect(first).not.toContain(b);
  for(let i=0;i<34;i++) expect(first).toContain(`unrelated invoice detail ${i}`);
  expect(rows[1]!.changes).toBe(exactBytes);
  expect(ms).toBeLessThan(2000);
 });
});

it('OWNERCACHE a runtime built before the Telegram binding is rebuilt once the binding changes, and reused while it does not', async () => {
 const label='owner-cache-binding';
 await runInDurableObject(stub(label),(instance,state)=> {
  const setup=()=> (instance as unknown as { setup(channel: string): unknown }).setup('telegram');
  state.storage.kv.delete('telegram_subject');
  const before=setup();
  expect(setup()).toBe(before);
  state.storage.kv.put('telegram_subject','777001');
  const after=setup();
  expect(after).not.toBe(before);
  expect(setup()).toBe(after);
  state.storage.deleteAlarm();
 });
});

it('FRESH804 unrelated noncanonical JSON must remain byte-identical',async()=> {
 const label='fresh804-numbers';
 await runInDurableObject(stub(label),(_instance,state)=> {
 const sql=state.storage.sql;const updates=updateBook(sql); updates.record('d',1,[mailM(0,MAIL_U)],'S');
 const original='[{"source":"mail","kind":"new","source_ref":"mail:large-number","source_message_id":"9007199254740993","detail":"Invoice unrelated","invoice_id":9007199254740993,"amount":1e400}]';
 sql.exec('UPDATE update_cards SET changes = ?',original);const store=claimStore(sql);expect(store.forgetSources(MAIL_T,true).incomplete).toBe(false);
 store.purge([],new Date().toISOString(),[MAIL_T]);const after=sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes;
 console.log('FRESH804-NUMBERS',JSON.stringify({original,after}));state.storage.deleteAlarm();expect(after).toBe(original);
 });
});

it.each([64,65])('FRESH804 cap %s preserves unrelated content',async n=> {
 const label=`fresh804-cap-${n}`;
 await runInDurableObject(stub(label),(_instance,state)=> {
 const sql=state.storage.sql;const updates=updateBook(sql);updates.record('d',1,[],'S'); const p=[MAIL_T.slice(0,46),...Array.from({length:n-1},(_,i)=>`Invoice ${i}`)];sql.exec('UPDATE update_cards SET changes = ?',JSON.stringify(p));const store=claimStore(sql);
 const shape=heldRowShapes(sql,'update_cards',[{topic:MAIL_T,state:'incomplete'}],5,t=>store.forgetSources(t,true));expect(shape).toMatch(/^#1 t1\[projection/m);
 store.purge([],new Date().toISOString(),[MAIL_T]);const first=sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes;store.purge([],new Date().toISOString(),[MAIL_T]);const second=sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes;
 console.log('FRESH804-CAP',n,JSON.stringify({remaining:JSON.parse(first).filter((s:string)=>s.startsWith('Invoice')).length,incomplete:store.forgetSources(MAIL_T,true).incomplete}));state.storage.deleteAlarm();expect(second).toBe(first);expect(store.forgetSources(MAIL_T,true).incomplete).toBe(false);expect(JSON.parse(first).at(-1)).toBe(`Invoice ${n-2}`);
 });
});

it('FRESH804 full split beyond cap preserves unrelated mail siblings',async()=>{
 const label='fresh804-fullcap';await runInDurableObject(stub(label),(_instance,state)=>{
 const sql=state.storage.sql;const changes=[mailM(0,MAIL_T.slice(0,20)),mailM(1,MAIL_T.slice(20)),...Array.from({length:31},(_,i)=>mailM(i+2,`Invoice ${i}`))];updateBook(sql).record('d',1,changes,'S');const store=claimStore(sql);store.purge([],new Date().toISOString(),[MAIL_T]);const after=JSON.parse(sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes);console.log('FRESH804-FULLCAP',JSON.stringify({last:after.at(-1),incomplete:store.forgetSources(MAIL_T,true).incomplete}));state.storage.deleteAlarm();expect(after.at(-1)).toEqual(changes.at(-1));
 });
});

it('ADV804 unicode-expanded interior preserves unrelated siblings',async()=>{
 const label='adv804-unicode';await runInDurableObject(stub(label),(_instance,state)=>{
 const sql=state.storage.sql;const topic='AİİİİB';const items=['Unrelated invoice','A','i\u0307'.repeat(4),'B','Unrelated footer'];updateBook(sql).record('d',1,[],'S');sql.exec('UPDATE update_cards SET changes = ?',JSON.stringify(items));const store=claimStore(sql);expect(store.forgetSources(topic,true).incomplete).toBe(true);console.log('ADV804-HELDROWS',heldRowShapes(sql,'update_cards',[{topic,state:'incomplete'}],5,t=>store.forgetSources(t,true)));store.purge([],new Date().toISOString(),[topic]);const after=JSON.parse(sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes);console.log('ADV804-UNICODE',after);state.storage.deleteAlarm();expect(store.forgetSources(topic,true).incomplete).toBe(false);expect(after[0]).toBe(items[0]);expect(after[4]).toBe(items[4]);});
});

it('ADV804 full split plus lone prefix settles',async()=>{
 const label='adv804-prefixcopy';await runInDurableObject(stub(label),(_instance,state)=>{
 const sql=state.storage.sql;const items=[MAIL_T.slice(0,20),MAIL_T.slice(20),'Invoice divider',MAIL_T.slice(0,46),'Invoice footer'];updateBook(sql).record('d',1,[],'S');sql.exec('UPDATE update_cards SET changes = ?',JSON.stringify(items));const store=claimStore(sql);store.purge([],new Date().toISOString(),[MAIL_T]);const after=sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes;console.log('ADV804-PREFIXCOPY',after,store.forgetSources(MAIL_T,true));expect(store.forgetSources(MAIL_T,true).incomplete).toBe(true);store.purge([],new Date().toISOString(),[MAIL_T]);console.log('ADV804-PREFIXSECOND',store.forgetSources(MAIL_T,true).incomplete);state.storage.deleteAlarm();expect(store.forgetSources(MAIL_T,true).incomplete).toBe(false);});
});

it.each(['empty','nul','long'] as const)('ADV804COST %s real purge',async mode=>{
 const label=`adv804-cost-${mode}`;await runInDurableObject(stub(label),(_instance,state)=>{
 const sql=state.storage.sql;const topic=mode==='long'?'a'.repeat(400)+'Z':MAIL_T;const items=mode==='long'?['a'.repeat(40),...Array(360).fill('a'),'Z','Invoice footer']:[MAIL_T.slice(0,20),...Array(800).fill(mode==='nul'?'\0':''),MAIL_T.slice(20),'Invoice footer'];updateBook(sql).record('d',1,[],'S');sql.exec('UPDATE update_cards SET changes = ?',JSON.stringify(items));const store=claimStore(sql);const before=Date.now();store.purge([],new Date().toISOString(),[topic]);const elapsed=Date.now()-before;console.log('ADV804-COST',mode,elapsed);state.storage.deleteAlarm();expect(store.forgetSources(topic,true).incomplete).toBe(false);const after=JSON.parse(sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes);expect(after.at(-1)).toBe('Invoice footer');});
});

it.each([
 '[ { "detail" : "Invoice", "n": -0, "big":9007199254740993, "overflow":1e400 } ]',
 '[{"z":"\\u0049nvoice","a":"slash\\/back\\\\quote\\\"","negative":-1e-400}]',
 '[{"emoji":"😀","unicode":"İΣßé","array":[true,null,1.00000]}]',
 ' { "b" : 2, "a" : [ "Invoice", -0.0, 1E+6 ] } '
])('ADV804BYTES %s',async original=>{
 const label='adv804-bytes-'+original.length;await runInDurableObject(stub(label),(_instance,state)=>{const sql=state.storage.sql;updateBook(sql).record('d',1,[],'S');sql.exec('UPDATE update_cards SET changes = ?',original);const store=claimStore(sql);store.purge([],new Date().toISOString(),[MAIL_T]);state.storage.deleteAlarm();expect(sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes).toBe(original);});
});

it.each(['', '\0'])('ROUND4 empty separator collateral %j',async gap=>{
 const label='round4-space-'+gap.length;
 await runInDurableObject(stub(label),(_instance,state)=>{
 const sql=state.storage.sql; const topic='Alpha  Beta'; const items=['Unrelated invoice','Alpha',gap,'Beta','Unrelated footer'];
 updateBook(sql).record('d',1,[],'S');sql.exec('UPDATE update_cards SET changes = ?',JSON.stringify(items));const store=claimStore(sql);
 expect(store.forgetSources(topic,true).incomplete).toBe(true);store.purge([],new Date().toISOString(),[topic]);
 const after=JSON.parse(sql.exec<{changes:string}>('SELECT changes FROM update_cards').one().changes);console.log('ROUND4-SPACE',JSON.stringify({gap,after}));
 state.storage.deleteAlarm();expect(store.forgetSources(topic,true).incomplete).toBe(false);expect(after[0]).toBe(items[0]);expect(after[4]).toBe(items[4]);
 });
});import { loopBook } from '../src/channels/loops';
const realOf = (state: DurableObjectState) => (topic: string) => claimStore(state.storage.sql).forgetSources(topic, true);
const T8 = 'the secret code word that I told you about earlier today is ZEBRA-COBALT';
const sp = T8.indexOf(' about');

// Regression proofs for all eight derived stores named PURGED by forget-store-table.
// Keep failures visible: a successful forget receipt must not silently leave these copies.
const positiveStore = (table: string, topic: string, seed: (sql: SqlStorage, text: string) => void, read: (sql: SqlStorage) => string) => {
  it(`forget_memory removes its literal topic from ${table} and preserves unrelated history`, async () => {
    const name = `memory-do-derived-${table}`;
    await turn(name, 1, 'Unrelated standup is at 09:10 UTC');
    await runInDurableObject(stub(name), (_instance, state) => {
      seed(state.storage.sql, `Private ${topic} note; unrelated context`);
      expect(read(state.storage.sql)).toContain(topic);
    });
    seen.outputs.push(tool('forget_memory', { topic, scope_note: `remove ${topic}` }), []);
    await turn(name, 2, `Forget ${topic}`);
    expect(seen.inputs.some(input => input.includes('removed from memory and recall'))).toBe(true);
    await evictDurableObject(stub(name));
    await turn(name, 3, 'What time is my standup?');
    await runInDurableObject(stub(name), (_instance, state) => {
      const episodes = episodeIndex(state.storage.sql);
      expect(episodes.search('standup', 10).map(hit => episodes.get(hit.ref)?.text)).toContain('Unrelated standup is at 09:10 UTC');
      expect(claimStore(state.storage.sql).barriers()).not.toEqual([]);
      expect(read(state.storage.sql), `${table} still holds a topic after a successful forget tool and eviction`).not.toContain(topic);
    });
  });
};
positiveStore('patrol_log', 'POSPATROL769', (sql, text) => {
  sql.exec('CREATE TABLE IF NOT EXISTS patrol_log (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, observed_at TEXT NOT NULL, entry_type TEXT NOT NULL, summary TEXT NOT NULL, source_ref TEXT, created_at TEXT NOT NULL)');
  sql.exec('INSERT INTO patrol_log (id, user_id, observed_at, entry_type, summary, source_ref, created_at) VALUES (?,?,?,?,?,?,?)', 'pos-769-patrol', 'u', 't', 'x', text, null, 't');
}, sql => JSON.stringify(sql.exec('SELECT id, summary FROM patrol_log').toArray()));
positiveStore('goals', 'POSGOAL769', (sql, text) => {
  sql.exec('CREATE TABLE IF NOT EXISTS goals (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, description TEXT NOT NULL, baseline TEXT, target TEXT, progress TEXT, deadline TEXT, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)');
  sql.exec('INSERT INTO goals (id, user_id, description, created_at, updated_at) VALUES (?,?,?,?,?)', 'pos-769-goal', 'u', text, 't', 't');
}, sql => JSON.stringify(sql.exec('SELECT id, description FROM goals').toArray()));

positiveStore('loops', 'POSLOOP769', (sql, text) => { loopBook(sql, { now: () => Date.now(), newId: () => 'pos-769-loop' }).open({ title: text, due: null }); }, sql => JSON.stringify(sql.exec('SELECT title FROM loops').toArray()));
positiveStore('background_runs', 'POSBG769', (sql, text) => { sql.exec('INSERT INTO background_runs (id,kind,status,summary,parent_id,started_at,ended_at) VALUES (?,?,?,?,?,?,?)', 'pos-769-bg', 'event', 'completed', text, null, 1, 2); }, sql => JSON.stringify(sql.exec('SELECT summary FROM background_runs').toArray()));
positiveStore('reminder_notes', 'POSNOTE769', (sql, text) => { sql.exec('CREATE TABLE IF NOT EXISTS reminder_notes (id TEXT PRIMARY KEY, note TEXT NOT NULL, created_at INTEGER NOT NULL)'); sql.exec('INSERT INTO reminder_notes (id, note, created_at) VALUES (?, ?, ?)', 'pos-769-note', text, 1); }, sql => JSON.stringify(sql.exec('SELECT note FROM reminder_notes').toArray()));
positiveStore('thread_topic_index', 'POSTOPIC769', (sql, text) => { sql.exec('CREATE TABLE IF NOT EXISTS thread_topic_index (user_id TEXT NOT NULL, topic TEXT NOT NULL, thread_id TEXT NOT NULL, last_user_message_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1, updated_at TEXT NOT NULL, PRIMARY KEY (user_id, topic, thread_id))'); sql.exec('INSERT INTO thread_topic_index (user_id, topic, thread_id, last_user_message_at, is_active, updated_at) VALUES (?,?,?,?,?,?)', 'u', text, 't1', 't', 1, 't'); }, sql => JSON.stringify(sql.exec('SELECT topic FROM thread_topic_index').toArray()));
positiveStore('memory_blocks', 'POSBLOCK769', (sql, text) => { sql.exec('CREATE TABLE IF NOT EXISTS memory_blocks (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, hall_type TEXT NOT NULL, content TEXT NOT NULL, decision_log TEXT NOT NULL DEFAULT \'[]\', confidence REAL NOT NULL, created_at TEXT NOT NULL, valid_from TEXT NOT NULL, source_trust TEXT NOT NULL)'); sql.exec('INSERT INTO memory_blocks (id, user_id, hall_type, content, decision_log, confidence, created_at, valid_from, source_trust) VALUES (?,?,?,?,?,?,?,?,?)', 'pos-769-block', 'u', 'facts', text, '[]', 0.9, 't', 't', 'user_stated'); }, sql => JSON.stringify(sql.exec('SELECT content, decision_log FROM memory_blocks').toArray()));
positiveStore('memory_inbox', 'POSINBOX769', (sql, text) => { sql.exec('CREATE TABLE IF NOT EXISTS memory_inbox (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, operation TEXT NOT NULL, hall TEXT NOT NULL, claim TEXT NOT NULL, content TEXT NOT NULL, proposed_pattern_id TEXT NOT NULL, observed_at TEXT NOT NULL, source_trust TEXT NOT NULL, rationale TEXT NOT NULL, source TEXT NOT NULL)'); sql.exec('INSERT INTO memory_inbox (id, user_id, operation, hall, claim, content, proposed_pattern_id, observed_at, source_trust, rationale, source) VALUES (?,?,?,?,?,?,?,?,?,?,?)', 'pos-769-inbox', 'u', 'ADD', 'facts', text, text, 'p', 't', 'user_stated', 'r', 's'); }, sql => JSON.stringify(sql.exec('SELECT claim, content FROM memory_inbox').toArray()));

// Full-store scan: after a successful forget and a DO eviction, no table or text column in the owner DO SQLite holds the forgotten text.
// An exemption must name why the table cannot hold owner text; there is no skip.
const SCAN_EXEMPT: Readonly<Record<string, string>> = {};
const scanForText = (sql: SqlStorage, needle: string): string[] => {
  const hits: string[] = [];
  for (const { name } of sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'").toArray()) {
    if (SCAN_EXEMPT[name]) continue;
    const columns = sql.exec<{ name: string }>(`PRAGMA table_info("${name.replaceAll('"', '""')}")`).toArray().map(column => column.name);
    for (const column of columns) {
      const quoted = `"${column.replaceAll('"', '""')}"`;
      const count = sql.exec<{ n: number }>(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}" WHERE instr(lower(CAST(${quoted} AS TEXT)), lower(?)) > 0`, needle).one().n;
      if (count > 0) hits.push(`${name}.${column}`);
    }
  }
  return hits;
};
const scanKv = async (storage: DurableObjectStorage, needle: string): Promise<string[]> => {
  const hits: string[] = [];
  for (const [key, value] of await storage.list()) if (JSON.stringify(value)?.toLowerCase().includes(needle.toLowerCase()) || key.toLowerCase().includes(needle.toLowerCase())) hits.push(`kv:${key}`);
  return hits;
};
it('SCAN after forget_memory and eviction no table or column of the owner DO holds the forgotten text', async () => {
  const name = 'memory-do-full-scan';
  const secret = 'XQZ-ZEBRA-4821';
  seen.outputs.push(tool('remember', { kind: 'fact', text: `The vault code word is ${secret}`, evidence_quote: secret }), []);
  await turn(name, 1, `Remember that the vault code word is ${secret}`);
  await runInDurableObject(stub(name), async (_i, state) => expect(scanForText(state.storage.sql, secret).length + (await scanKv(state.storage, secret)).length).toBeGreaterThan(0));
  seen.outputs.push(tool('forget_memory', { topic: secret, scope_note: 'vault code word' }), []);
  await turn(name, 2, `Forget ${secret}`);
  expect(seen.inputs.some(input => input.includes('removed from memory and recall'))).toBe(true);
  await evictDurableObject(stub(name));
  await turn(name, 3, 'What time is my standup?');
  await runInDurableObject(stub(name), async (_i, state) => expect([...scanForText(state.storage.sql, secret), ...await scanKv(state.storage, secret)]).toEqual([]));
});

it('an incomplete model reply with no tool calls tells the owner it stopped early', async () => {
  const name = 'memory-do-stopped-early';
  seen.status = 'incomplete';
  await turn(name, 1, 'Write me a very long essay');
  expect((await runInDurableObject(stub(name), (_i, state) => scanKv(state.storage, 'I stopped early'))).length).toBeGreaterThan(0);
});
it('a complete model reply carries no stop note', async () => {
  const name = 'memory-do-not-stopped';
  await turn(name, 1, 'Say hi');
  expect((await runInDurableObject(stub(name), (_i, state) => scanKv(state.storage, 'I stopped early'))).length).toBe(0);
  expect((await runInDurableObject(stub(name), (_i, state) => scanKv(state.storage, 'Done'))).length).toBeGreaterThan(0);
});

it('HELD-TEXT after forget_memory the next turn on the same live instance sends the model no copy of the forgotten text', async () => {
  const name = 'memory-do-held-text';
  const secret = 'QWX-OCELOT-7730';
  seen.outputs.push(tool('remember', { kind: 'fact', text: `The locker code is ${secret}`, evidence_quote: secret }), []);
  await turn(name, 1, `Remember that the locker code is ${secret}`);
  seen.outputs.push(tool('forget_memory', { topic: secret, scope_note: 'locker code' }), []);
  await turn(name, 2, `Forget ${secret}`);
  seen.inputs.length = 0;
  await turn(name, 3, 'What time is my standup?');
  expect(seen.inputs.filter(input => input.includes(secret))).toEqual([]);
});
