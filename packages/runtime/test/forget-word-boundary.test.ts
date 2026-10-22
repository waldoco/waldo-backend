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
  it('decoded JSON leaves and the LIKE prefilter follow the same rule', () => {
    expect(decodedLeafHit(JSON.stringify({ note: 'team' }), 'tea')).toBe(false);
    expect(decodedLeafHit(JSON.stringify({ note: 'tea' }), 'tea')).toBe(true);
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
      // The forget leaves its own texts in custody for the purge job and does not close the unrelated hold.
      expect(store.pendingTopics()).toEqual(expect.arrayContaining(['steady', 'tea']));
      expect(store.pendingTopics()).not.toContain('Works with a team');
    });
  });
});
