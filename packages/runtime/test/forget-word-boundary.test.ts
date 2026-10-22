// A forget matches the topic as a whole word in every redactor and every verifier, so a short topic never rewrites or
// holds on unrelated words that contain it ("tea" inside "team", "steady", "instead"), and the redaction and the
// readback can never disagree. Synthetic topics only.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { blankCardPieces, cardCarriesTopic, claimStore, decodedLeafHit, FORGOTTEN, likePrefilter } from '../src/memory/claims';
import { carriesTopic, hidesTopic } from '../src/memory/forget-guard';
import { heldRowShapes } from '../src/memory/held-rows';
import { episodeIndex } from '../src/channels/episodes';
import { conversationForgetSources, redactConversationEntries } from '../src/channels/conversation-store';
import { forgetSourceBatch } from '../src/memory/selective-forget';
import { FINAL_OUTBOX_KEY, redactJobReportEntries } from '../src/channels/telegram-final-outbox';
import { redactThreadTitles } from '../src/channels/app-threads';
import { redactIMessageEntries } from '../src/channels/imessage/forget';
import { forgetHeldWhatsApp, WA_HELD_PREFIX } from '../src/channels/whatsapp-window';
import { redactToolOutputLedger, toolOutputLedger } from '../src/conversation/tool-output-ledger';
import { memoryHandlers } from '../src/tools/live/memory';
import { ensureSchema } from '../src/tracer/schema';
import { holdTopic } from './helpers/pending-topic';

const AT = '2026-10-22T08:00:00Z';
const UNRELATED = 'residency banglore team. Steady the rest instead';
const inDo = <T>(name: string, work: (state: DurableObjectState) => T | Promise<T>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), (_i, state) => work(state));

describe('the shared guard', () => {
  it('carries a topic only as a whole word, in any case', () => {
    expect(carriesTopic(UNRELATED, 'tea')).toBe(false);
    expect(carriesTopic('Green TEA, please', 'tea')).toBe(true);
    expect(carriesTopic('ΟΔΟΣ', 'οδος')).toBe(true);
  });
  it('a JSON escape before the word is read as the boundary it decodes to, so raw redaction can reach it', () => {
    // Raw text the literal redactor rewrites is not "hidden": the guard would otherwise hold it forever.
    expect(hidesTopic(String.raw`{"t":"x\ntea"}`, 'tea')).toBe(false);
    expect(carriesTopic(String.raw`{"t":"x\ntea"}`, 'tea')).toBe(true);
    // An escape that spells the topic itself still holds; one that only spells a longer word does not.
    expect(hidesTopic(String.raw`{"t":"\u0074ea"}`, 'tea')).toBe(true);
    expect(hidesTopic(String.raw`{"t":"\u0074eam"}`, 'tea')).toBe(false);
  });
  it('an escape that spells the topic holds under any reading; a backslash that only sits in prose does not', () => {
    expect(hidesTopic(String.raw`green \x74ea`, 'tea')).toBe(true);
    expect(hidesTopic(String.raw`green t\ea`, 'tea')).toBe(true);
    expect(hidesTopic(String.raw`team at C:\Users`, 'tea')).toBe(false);
    expect(hidesTopic(String.raw`backup at C:\Users\Sarahs`, 'Sarah')).toBe(false);
  });
  it('decoded JSON leaves and the LIKE prefilter follow the same rule', () => {
    expect(decodedLeafHit(JSON.stringify({ note: 'team' }), 'tea')).toBe(false);
    expect(decodedLeafHit(JSON.stringify({ note: 'tea' }), 'tea')).toBe(true);
    // A decoded leaf is text, not JSON: its backslash is a character, so the name after it is found.
    expect(decodedLeafHit(JSON.stringify({ path: String.raw`D:\budget.xlsx` }), 'budget')).toBe(true);
    // SQLite LIKE folds ASCII only: the prefilter keeps the run every case variant shares, never a non-ASCII letter, k or s.
    expect(likePrefilter('Café Zürich')).toBe('%rich%');
    expect(likePrefilter('Steak')).toBe('%tea%');
    expect(likePrefilter('οδος')).toBe('%%');
    expect(likePrefilter('50%_off')).toBe('%50\\%\\_off%');
  });
  it('the update-card prefix floor matches whole words, and an open end only for a cut prefix', () => {
    expect(cardCarriesTopic(JSON.stringify([{ detail: 'team sync' }]), 'steady pace', 'tea')).toBe(false);
    expect(cardCarriesTopic(JSON.stringify([{ detail: 'tea sync' }]), null, 'tea')).toBe(true);
    // A topic split across leaves still holds when an unrelated leaf follows: a run of leaves ends at a leaf edge.
    expect(cardCarriesTopic(JSON.stringify([{ detail: 'green t' }, { detail: 'ea time' }, { detail: 'Invoice' }]), null, 'green tea time')).toBe(true);
    // A topic longer than the floor is cut mid-word: the floor's end is open, its start is still a word start.
    const long = `${'a'.repeat(38)} tea ceremony`;
    expect(cardCarriesTopic(JSON.stringify([{ detail: `${'a'.repeat(38)} teapot` }]), null, long)).toBe(true);
    expect(cardCarriesTopic(JSON.stringify([{ detail: `b${'a'.repeat(38)} teapot` }]), null, long)).toBe(false);
    expect(blankCardPieces([{ detail: 'team sync' }, { detail: 'tea' }], 'tea')).toEqual([{ detail: 'team sync' }, { detail: FORGOTTEN }]);
    // A card held only by the floor blanks just the leaves that start the topic, never one that holds it inside a word.
    const inside = `b${'a'.repeat(38)} teapot`, starts = `${'a'.repeat(38)} teapot`;
    expect(blankCardPieces([{ detail: inside }, { detail: starts }], long)).toEqual([{ detail: inside }, { detail: FORGOTTEN }]);
  });
  it('the source inventories (selector batch, conversation, ledger, SQL stores) list only whole-word rows', async () => {
    expect(forgetSourceBatch('tea', [{ ref: 'a', text: UNRELATED }, { ref: 'b', text: 'Tea at four' }]).sources).toEqual([{ ref: 'b', text: 'Tea at four' }]);
    await inDo('boundary-sources', async (state) => {
      await state.storage.put('conv:1', { id: 'c1', ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: UNRELATED, appPayload: 'x', modelProjection: { mode: 'include' }, role: 'user' });
      expect(await conversationForgetSources(state.storage, 'tea')).toEqual({ sources: [], incomplete: false });
      await state.storage.put('toolout:0001', { tool: 'search_episodes', ok: true, taint: null, at: 1, summary: JSON.stringify({ team: UNRELATED }) });
      expect(await toolOutputLedger(state.storage).forgetSources('tea')).toEqual({ sources: [], incomplete: false });
      const store = claimStore(state.storage.sql);
      episodeIndex(state.storage.sql).add('tg-1', 'owner', UNRELATED, 1);
      expect(store.forgetSources('tea')).toMatchObject({ sources: [], incomplete: false });
    });
  });
});

describe('the SQL purge', () => {
  it('a short topic completes and leaves unrelated words whole', async () => {
    await inDo('boundary-purge', (state) => {
      const sql = state.storage.sql;
      const store = claimStore(sql, work => state.storage.transactionSync(work));
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', UNRELATED, 1);
      episodes.add('tg-2', 'owner', 'Green tea after lunch', 2);
      store.add({ kind: 'fact', text: 'Works with a team', source: 'stated', evidence: 'Steady the rest', origin: 'owner', source_ref: 'owner, tg-1' }, AT);
      store.backup('fixture', { note: 'x\ntea and the team' }, AT);
      const purge = store.purge([], AT, ['tea']);
      expect(purge).toMatchObject({ ready: true, remaining: {}, failed: [] });
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map(row => row.text)).toEqual([UNRELATED, `Green ${FORGOTTEN} after lunch`]);
      expect(store.allClaims().map(claim => [claim.text, claim.evidence])).toEqual([['Works with a team', 'Steady the rest']]);
      expect(JSON.parse(store.backups()[0]!.payload)).toEqual({ note: `x\n${FORGOTTEN} and the team` });
    });
  });
  it('an outbox payload that only contains the topic inside a word is not replaced, and its run is not terminalised', async () => {
    await inDo('boundary-outbox', (state) => {
      const sql = state.storage.sql;
      ensureSchema(state.storage);
      sql.exec(`INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload, created_at) VALUES ('o1', 'r1', 'push', 'k1', ?, 1)`, JSON.stringify({ text: 'the team is steady' }));
      const store = claimStore(sql);
      expect(store.purge([], AT, ['tea'])).toMatchObject({ ready: true, receipt: { redacted: {}, terminalised: {} } });
      expect(sql.exec<{ payload: string }>('SELECT payload FROM outbox').one().payload).toBe(JSON.stringify({ text: 'the team is steady' }));
    });
  });
  it('a non-ASCII case variant is fetched, redacted and read back (#794)', async () => {
    await inDo('boundary-purge-unicode', (state) => {
      const sql = state.storage.sql;
      const store = claimStore(sql);
      episodeIndex(sql).add('tg-1', 'owner', 'Lunch at CAFÉ ZÜRICH today', 1);
      expect(store.purge([], AT, ['Café Zürich']).ready).toBe(true);
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes').one().text).toBe(`Lunch at ${FORGOTTEN} today`);
    });
  });
  it('a script without spaces, a suffixed Indic word and a number inside a number are still forgotten and read back clean', async () => {
    await inDo('boundary-purge-scripts', (state) => {
      const sql = state.storage.sql;
      const store = claimStore(sql, work => state.storage.transactionSync(work));
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', '我住在北京市朝阳区', 1);
      episodes.add('tg-2', 'owner', 'मुंबईत भेटू', 2);
      episodes.add('wa-3', 'owner', 'Call +919876543210 today', 3);
      for (const topic of ['北京市', 'मुंबई', '9876543210']) expect(store.purge([], AT, [topic])).toMatchObject({ ready: true, remaining: {}, failed: [] });
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map(row => row.text))
        .toEqual([`我住在${FORGOTTEN}朝阳区`, `${FORGOTTEN}त भेटू`, `Call +91${FORGOTTEN} today`]);
    });
  });
  it('a backslash in prose that starts no JSON escape never holds a forget', async () => {
    await inDo('boundary-purge-prose-backslash', (state) => {
      const sql = state.storage.sql;
      const store = claimStore(sql);
      const episodes = episodeIndex(sql);
      episodes.add('tg-1', 'owner', String.raw`the team keeps C:\Users\Nina\Docs`, 1);
      episodes.add('tg-2', 'owner', String.raw`saved to C:\Users\Sarah\docs`, 2);
      episodes.add('tg-3', 'owner', String.raw`backup at C:\Users\Sarahs`, 3);
      episodes.add('tg-4', 'owner', String.raw`notes in C:\Tea`, 4);
      episodes.add('tg-5', 'owner', String.raw`saved to C:\Users\tom\Docs`, 5);
      expect(store.purge([], AT, ['tea'])).toMatchObject({ ready: true, remaining: {} });
      expect(store.purge([], AT, ['Sarah'])).toMatchObject({ ready: true, remaining: {} });
      expect(store.purge([], AT, ['tom'])).toMatchObject({ ready: true, remaining: {} });
      expect(sql.exec<{ text: string }>('SELECT text FROM episodes ORDER BY rowid').toArray().map(row => row.text)).toEqual([
        String.raw`the team keeps C:\Users\Nina\Docs`, String.raw`saved to C:\Users\@\docs`.replace('@', FORGOTTEN),
        String.raw`backup at C:\Users\Sarahs`, String.raw`notes in C:\@`.replace('@', FORGOTTEN),
        String.raw`saved to C:\Users\@\Docs`.replace('@', FORGOTTEN),
      ]);
    });
  });
  it('a path inside stored JSON is forgotten in every store the purge reads decoded', async () => {
    await inDo('boundary-purge-decoded-path', (state) => {
      const sql = state.storage.sql;
      ensureSchema(state.storage);
      const store = claimStore(sql, work => state.storage.transactionSync(work));
      const PATH = String.raw`D:\budget.xlsx`;
      store.add({ kind: 'fact', text: `Keeps the plan in ${PATH}`, source: 'stated', evidence: PATH, origin: 'owner', source_ref: 'owner, tg-1' }, AT);
      store.backup('fixture', { note: PATH }, AT);
      sql.exec(`INSERT INTO outbox (outbox_id, run_id, kind, idempotency_key, payload, created_at) VALUES ('o1', 'r1', 'push', 'k1', ?, 1)`, JSON.stringify({ text: `open ${PATH}` }));
      expect(store.purge([], AT, ['budget'])).toMatchObject({ ready: true, remaining: {}, failed: [] });
      const stored = [...store.allClaims().flatMap(claim => [claim.text, claim.evidence]), JSON.parse(store.backups()[0]!.payload).note as string,
        sql.exec<{ payload: string }>('SELECT payload FROM outbox').one().payload];
      expect(stored.filter(value => /budget/i.test(value))).toEqual([]);
      expect(JSON.parse(store.backups()[0]!.payload)).toEqual({ note: String.raw`D:\@.xlsx`.replace('@', FORGOTTEN) });
    });
  });
  it('claim evidence in its quoted form is forgotten by the purge', async () => {
    await inDo('boundary-purge-quoted-evidence', (state) => {
      const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      store.add({ kind: 'fact', text: 'Keeps the plan in a spreadsheet', source: 'stated', evidence: String.raw`"it is at D:\budget.xlsx"`, origin: 'owner', source_ref: 'owner, tg-1' }, AT);
      store.add({ kind: 'fact', text: 'Keeps notes in a folder', source: 'stated', evidence: String.raw`"notes in C:\tea"`, origin: 'owner', source_ref: 'owner, tg-2' }, AT);
      expect(store.purge([], AT, ['budget'])).toMatchObject({ ready: true, remaining: {}, failed: [] });
      expect(store.purge([], AT, ['tea'])).toMatchObject({ ready: true, remaining: {}, failed: [] });
      expect(store.allClaims().map(claim => claim.evidence)).toEqual([
        String.raw`"it is at D:\@.xlsx"`.replace('@', FORGOTTEN), String.raw`"notes in C:\@"`.replace('@', FORGOTTEN),
      ]);
    });
  });
  it('a genuinely remaining copy still holds the forget', async () => {
    await inDo('boundary-purge-holds', (state) => {
      const store = claimStore(state.storage.sql);
      store.backup('fixture', { note: 'x' }, AT);
      // The topic spelled with a JSON escape: the literal redaction cannot reach it, and a JSON reader would see it.
      state.storage.sql.exec('UPDATE memory_backups SET payload = ?', String.raw`{"note":"green \u0074ea"}`);
      expect(store.purge([], AT, ['tea'])).toMatchObject({ ready: false, remaining: { memory_backups: 1 } });
      expect(store.pendingTopics()).toEqual(['tea']);
    });
  });
});

describe('the held-rows diagnostic and forgetSources agree with the purge', () => {
  it('a projection row with the topic only inside words does not hold', async () => {
    await inDo('boundary-projection', (state) => {
      const sql = state.storage.sql;
      const store = claimStore(sql);
      store.backup('team', { note: 'the team holds steady' }, AT);
      holdTopic(sql, 'tea', AT);
      expect(store.forgetSources('tea')).toMatchObject({ incomplete: false });
      expect(heldRowShapes(sql, 'memory_backups', [{ topic: 'tea', state: 'pending' }], 25, topic => store.forgetSources(topic, true))).not.toMatch(/t1\[projection/);
      store.backup('tea', { note: 'tea at four' }, AT);
      expect(store.forgetSources('tea')).toMatchObject({ incomplete: true, heldBy: [{ table: 'memory_backups', rule: 'projection', rows: 1 }] });
      expect(heldRowShapes(sql, 'memory_backups', [{ topic: 'tea', state: 'pending' }], 25, topic => store.forgetSources(topic, true))).toMatch(/#2 t1\[projection/);
    });
  });
});

describe('every KV redactor and its readback', () => {
  it('conversation rows', async () => {
    await inDo('boundary-conversation', async (state) => {
      await state.storage.put('conv:1', { id: 'c1', ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: UNRELATED, appPayload: 'tea at four', modelProjection: { mode: 'include' }, role: 'user' });
      expect(await redactConversationEntries(state.storage, ['tea'], FORGOTTEN)).toEqual({ rewritten: 1, remaining: 0 });
      expect(await state.storage.get('conv:1')).toMatchObject({ modelPayload: UNRELATED, appPayload: `${FORGOTTEN} at four` });
    });
  });
  it('a path in a conversation payload', async () => {
    await inDo('boundary-conversation-path', async (state) => {
      await state.storage.put('conv:1', { id: 'c1', ownerId: 'o', chatId: 'c', parentId: null, threadAnchorId: null, surface: 'app', modelPayload: 'see the file', appPayload: String.raw`see D:\budget.xlsx`, modelProjection: { mode: 'include' }, role: 'user' });
      expect(await redactConversationEntries(state.storage, ['budget'], FORGOTTEN)).toEqual({ rewritten: 1, remaining: 0 });
      expect(await state.storage.get('conv:1')).toMatchObject({ appPayload: String.raw`see D:\@.xlsx`.replace('@', FORGOTTEN) });
    });
  });
  it('waiting job reports in the final outbox', async () => {
    await inDo('boundary-final-outbox', (state) => {
      const kv = state.storage.kv;
      kv.put(FINAL_OUTBOX_KEY, [{ id: 'f1', trace: 't', payload: { chat_id: 1, text: UNRELATED }, digest: 'd', ownerSubject: '1', doName: 'x', status: 'delivered', dueAt: 0, createdAt: 0, attempts: 1, settled: true, dayCard: { day: '2026-10-22' } }]);
      expect(redactJobReportEntries(kv, ['tea'], FORGOTTEN)).toEqual({ rewritten: 0, remaining: 0 });
      expect(kv.get<{ payload: { text: string } }[]>(FINAL_OUTBOX_KEY)![0]!.payload.text).toBe(UNRELATED);
    });
  });
  it('thread titles', async () => {
    await inDo('boundary-threads', (state) => {
      const kv = state.storage.kv;
      kv.put('app:thread:t1', { thread_id: 't1', title: 'Team offsite', revision: 1, title_revision: 1, state: 'open', created_at: 0, last_activity_at: 0 });
      expect(redactThreadTitles(kv, ['tea'], FORGOTTEN)).toEqual({ rewritten: 0, remaining: 0 });
      expect(kv.get<{ title: string }>('app:thread:t1')!.title).toBe('Team offsite');
    });
  });
  it('iMessage inbox records', async () => {
    await inDo('boundary-imessage', (state) => {
      state.storage.kv.put('imessage:inbox-record:r1', { id: 'r1', updateId: 1, state: 'admitted', text: UNRELATED });
      state.storage.kv.put('imessage:inbox-record:r2', { id: 'r2', updateId: 2, state: 'completed', text: 'the team' });
      expect(redactIMessageEntries(state.storage, ['tea'], FORGOTTEN)).toEqual({ rewritten: 0, remaining: 0 });
      expect(state.storage.kv.get<{ text: string }>('imessage:inbox-record:r1')!.text).toBe(UNRELATED);
    });
  });
  it('held WhatsApp messages are deleted only for the whole word', async () => {
    await inDo('boundary-whatsapp', (state) => {
      const kv = state.storage.kv;
      kv.put(`${WA_HELD_PREFIX}1`, { heldAt: 1, body: { text: UNRELATED } });
      kv.put(`${WA_HELD_PREFIX}2`, { heldAt: 2, body: { text: 'tea at four' } });
      expect(forgetHeldWhatsApp(kv, ['tea'])).toEqual({ rewritten: 1, remaining: 0 });
      expect([...kv.list({ prefix: WA_HELD_PREFIX })].map(([key]) => key)).toEqual([`${WA_HELD_PREFIX}1`]);
    });
  });
  it('tool-output ledger summaries', async () => {
    await inDo('boundary-ledger', async (state) => {
      await state.storage.put('toolout:0001', { tool: 'search_episodes', ok: true, taint: null, at: 1, summary: JSON.stringify({ data: UNRELATED }) });
      expect(await redactToolOutputLedger(state.storage, ['tea'], FORGOTTEN)).toBe(0);
      expect(await toolOutputLedger(state.storage).remaining(['tea'])).toBe(0);
    });
  });
  it('a path in a ledger summary, whole or cut short, is forgotten and never holds the forget', async () => {
    await inDo('boundary-ledger-path', async (state) => {
      const whole = JSON.stringify({ data: String.raw`D:\budget.xlsx` });
      await state.storage.put('toolout:0001', { tool: 'read_file', ok: true, taint: null, at: 1, summary: whole });
      // A capped summary is not valid JSON; it is matched as text, and nothing about it can stick the forget.
      await state.storage.put('toolout:0002', { tool: 'read_file', ok: true, taint: null, at: 2, summary: whole.slice(0, -4) });
      expect(await redactToolOutputLedger(state.storage, ['budget'], FORGOTTEN)).toBe(2);
      expect(await toolOutputLedger(state.storage).remaining(['budget'])).toBe(0);
      const summaries = [...(await state.storage.list<{ summary: string }>({ prefix: 'toolout:' })).values()].map(row => row.summary);
      expect(summaries.filter(summary => /budget/i.test(summary))).toEqual([]);
    });
  });
});

describe('the forget tool', () => {
  const owner = (text: string) => ({ authenticatedUserId: 'owner', memoryTurn: { ownerId: 'owner', conversationRef: 'owner', current: { message_ref: 'tg-9', text }, recent: [] } });
  it('forgetting "tea" removes the tea claim, keeps the team claim, and does not close an unrelated pending topic', async () => {
    await inDo('boundary-tool', async (state) => {
      const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      store.add({ kind: 'fact', text: 'Works with a team', source: 'stated', evidence: 'my team', origin: 'owner', source_ref: 'owner, tg-1' }, AT);
      store.add({ kind: 'preference', text: 'Drinks tea at four', source: 'stated', evidence: 'tea at four', origin: 'owner', source_ref: 'owner, tg-2' }, AT);
      holdTopic(state.storage.sql, 'steady', AT);
      const [, , forget] = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', transaction: work => state.storage.transactionSync(work), hideHistory: async () => undefined });
      const result = await forget!.handle({ topic: 'tea', scope_note: 'tea' }, owner('forget tea') as never);
      expect(result).toMatchObject({ ok: true });
      expect(store.allClaims().map(claim => claim.text)).toEqual(['Works with a team']);
      expect(store.pendingTopics()).toEqual(['steady']);
    });
  });
  it('forgetting a name that follows a backslash in a path removes the claim that names it', async () => {
    await inDo('boundary-tool-path', async (state) => {
      const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      store.add({ kind: 'fact', text: String.raw`Keeps the plan in D:\budget.xlsx`, source: 'stated', evidence: String.raw`D:\budget.xlsx`, origin: 'owner', source_ref: 'owner, tg-1' }, AT);
      const [, , forget] = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', transaction: work => state.storage.transactionSync(work), hideHistory: async () => undefined });
      expect(await forget!.handle({ topic: 'budget', scope_note: 'budget' }, owner('forget the budget') as never)).toMatchObject({ ok: true });
      expect(store.allClaims()).toEqual([]);
    });
  });
  it('forgetting a name in quoted claim evidence removes the claim', async () => {
    for (const [topic, evidence] of [['budget', String.raw`"it is at D:\budget.xlsx"`], ['tea', String.raw`"notes in C:\tea"`]] as const) {
      await inDo(`boundary-tool-quoted-${topic}`, async (state) => {
        const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
        store.add({ kind: 'fact', text: 'Keeps a file', source: 'stated', evidence, origin: 'owner', source_ref: 'owner, tg-1' }, AT);
        const [, , forget] = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', transaction: work => state.storage.transactionSync(work), hideHistory: async () => undefined });
        expect(await forget!.handle({ topic, scope_note: topic }, owner(`forget ${topic}`) as never), topic).toMatchObject({ ok: true });
        expect(store.allClaims(), topic).toEqual([]);
      });
    }
  });
  it('forgetting a place written without spaces removes the claim that names it, and says so', async () => {
    await inDo('boundary-tool-cjk', async (state) => {
      const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
      store.add({ kind: 'fact', text: '明日新宿駅で会う', source: 'stated', evidence: '明日新宿駅で会う', origin: 'owner', source_ref: 'owner, tg-1' }, AT);
      const [, , forget] = memoryHandlers({ sql: state.storage.sql, store, conversationRef: 'owner', transaction: work => state.storage.transactionSync(work), hideHistory: async () => undefined });
      expect(await forget!.handle({ topic: '新宿駅', scope_note: '新宿駅' }, owner('新宿駅を忘れて') as never)).toMatchObject({ ok: true });
      expect(store.allClaims()).toEqual([]);
    });
  });
});
