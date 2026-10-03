import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';
import { forgetSnapshot, selectedForgetTexts, SELECTIVE_FORGET_INSTRUCTION, SELECTIVE_FORGET_SCHEMA } from '../src/memory/selective-forget';
import { conversationForgetSources } from '../src/channels/conversation-store';

// Real owner-local SQL and retrieval. This is a desired-behaviour regression,
// intentionally red until topic-associated source clauses have been selected.
it('forgets a topic-associated preference while preserving mixed-source and unrelated preferences', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selective-forget-mixed-source')), (_instance, state) => {
    const store = claimStore(state.storage.sql, work => state.storage.transactionSync(work));
    const episodes = episodeIndex(state.storage.sql);
    episodes.add('tg-fixture-reply', 'waldo', 'Saved fictional DLD-20261002-M3 workshop preference: Friday at 09:10 UTC. Unrelated preference: tea after lunch.', 1);
    episodes.add('tg-unrelated', 'owner', 'For my unrelated workshop, I prefer Friday at 09:10 UTC.', 2);

    const topic = 'DLD-20261002-M3';
    const at = '2026-10-03T12:00:00Z';
    store.beginTopicCoverage(topic, at);
    const supplied = store.forgetSources(topic);
    const snapshot = forgetSnapshot(topic, supplied.sources);
    const raw = JSON.stringify({ spans: [{ ref: 'episodes:1:text', text: 'DLD-20261002-M3 workshop preference: Friday at 09:10 UTC' }], reviewed_refs: snapshot.sources.map(row => row.ref), complete: true });
    const selected = selectedForgetTexts(topic, snapshot, raw, forgetSnapshot(topic, store.forgetSources(topic).sources));
    expect(selected).not.toBeNull();
    store.authoriseTopicCoverage(topic, selected!, at);
    const topics = store.pendingTopics();
    expect(store.purge([], at, topics).ready).toBe(true);
    store.settle([], topics, topic);

    const retained = episodes.get('1')!.text;
    expect(retained).not.toContain('09:10 UTC');
    expect(retained).toContain('Unrelated preference: tea after lunch.');
    expect(episodes.get('2')!.text).toContain('Friday at 09:10 UTC');
    expect(episodes.search('workshop preference', 10).find(hit => hit.ref === '1')?.snippet ?? '').not.toContain('09:10');
    expect(store.pendingTopics()).toEqual([]);
    expect(store.incompleteTopics()).toEqual([]);
  });
});

it('bounds escaped sources beneath the complete selector request budget', () => {
  const topic = 'DLD-20261002-M3';
  const sources = Array.from({ length: 64 }, (_, i) => ({ ref: `episodes:${i}:text`, text: `${topic} ${'"\\'.repeat(300)}` }));
  const snapshot = forgetSnapshot(topic, sources);
  expect(snapshot.incomplete).toBe(true);
  const input = JSON.stringify({ topic, sources: snapshot.sources });
  const request = JSON.stringify({ instructions: SELECTIVE_FORGET_INSTRUCTION, input, text: { format: { type: 'json_schema', name: 'forget_source_spans', schema: SELECTIVE_FORGET_SCHEMA } }, max_output_tokens: 4096 });
  expect(new TextEncoder().encode(input).byteLength).toBeLessThanOrEqual(8192);
  expect(new TextEncoder().encode(request).byteLength).toBeLessThan(32768);
});

it('rejects colliding custody and the real maximum span-byte budget before any destructive write', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selective-forget-collision-budget')), (_instance, state) => {
    const store = claimStore(state.storage.sql);
    const at = '2026-10-03T12:00:00Z';
    const topic = 'DLD-20261002-M3';
    const collisionA = `${topic} workshop preference: 6Eo93zet8o`;
    const collisionB = `${topic} workshop preference: PasawsjPb7`;
    store.beginTopicCoverage(collisionA, at);
    expect(() => store.beginTopicCoverage(collisionB, at)).toThrow('fingerprint conflict');
    store.beginTopicCoverage(topic, at);
    const source = topic + 'x'.repeat(4095 - topic.length);
    episodeIndex(state.storage.sql).add('tg-large-source', 'owner', source, 1);
    const spans = Array.from({ length: 32 }, (_, i) => source.slice(0, source.length - i));
    expect(() => store.authoriseTopicCoverage(topic, spans, at)).toThrow('budget exceeded');
    expect(store.pendingTopics()).toEqual([]);
    expect(store.incompleteTopics()).toContain(topic);
    expect(store.barriers()).toEqual([]);
    expect(episodeIndex(state.storage.sql).get('1')!.text).toBe(source);
  });
});

it('redacts and independently verifies topic-bearing source references before settling custody', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selective-forget-source-ref')), (_instance, state) => {
    const store = claimStore(state.storage.sql);
    const topic = 'DLD-20261002-M3';
    const fact = `${topic} workshop preference: Friday at 09:10 UTC`;
    const at = '2026-10-03T12:00:00Z';
    store.add({ kind: 'preference', text: 'Unrelated preference: tea after lunch', source: 'stated', evidence: 'tea after lunch', origin: 'owner', source_ref: fact }, at);
    store.beginTopicCoverage(topic, at);
    expect(store.forgetSources(topic).sources.map(row => row.ref)).toEqual(['claims:1:source_ref']);
    store.authoriseTopicCoverage(topic, [fact], at);
    const topics = store.pendingTopics();
    expect(store.purge([], at, topics).ready).toBe(true);
    store.settle([], topics, topic);
    expect(store.claims()[0]!.source_ref).not.toContain('09:10');
    expect(turnMemoryPrompt(store, 'tea after lunch')).not.toContain('09:10');
    expect(store.claims()[0]!.text).toContain('tea after lunch');
  });
});

it('preserves unsupported JSON projections with escaped topic text instead of destroying their association marker', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selective-forget-escaped-projection')), (_instance, state) => {
    const store = claimStore(state.storage.sql);
    const topic = 'DLD "workshop"';
    const at = '2026-10-03T12:00:00Z';
    store.backup('fixture', { detail: `${topic} preference: tea after lunch` }, at);
    store.beginTopicCoverage(topic, at);
    expect(store.forgetSources(topic).incomplete).toBe(true);
    expect(store.purge([], at, [topic]).ready).toBe(false);
    expect(store.backups()[0]!.payload).toContain('tea after lunch');
    expect(JSON.parse(store.backups()[0]!.payload).detail).toContain(topic);
    expect(store.incompleteTopics()).toEqual([topic]);
  });
});

it('does not admit same-principal foreign-tenant history or forged witness labels to source selection', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selective-forget-source-tenant')), async (_instance, state) => {
    const topic = 'DLD-20261002-M3';
    const entry = { id: 'old', parentId: null, threadAnchorId: null, ownerId: 'owner', chatId: 'owner', createdAt: 1, role: 'user' as const, modelPayload: `${topic} workshop at 09:10 UTC`, appPayload: `${topic} workshop at 09:10 UTC`, modelProjection: { mode: 'include' as const } };
    await state.storage.put({
      'canonical-owner-v1:owner:foreign:conv:0000000000': entry,
      'canonical-owner-v1:owner:tenant:conv:0000000000': entry,
      'canonical-owner-v1:owner:tenant:witness:old': { lineage: 'canonical_v1', principal_ref: 'foreign-owner', tenant_ref: 'tenant', entry },
    });
    const source = await conversationForgetSources(state.storage, topic, { principal_ref: 'owner', tenant_ref: 'tenant' });
    expect(source.incomplete).toBe(true);
    expect(source.sources).toEqual([]);
    expect(await state.storage.get('canonical-owner-v1:owner:foreign:conv:0000000000')).toEqual(entry);
  });
});

it('preserves originals and incomplete custody when source coverage changes or cannot be proved', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selective-forget-incomplete')), (_instance, state) => {
    const store = claimStore(state.storage.sql);
    const episodes = episodeIndex(state.storage.sql);
    const topic = 'DLD-20261002-M3';
    const text = `${topic} preference: Friday at 09:10 UTC`;
    episodes.add('tg-first', 'owner', text, 1);
    store.beginTopicCoverage(topic, '2026-10-03T12:00:00Z');
    const snapshot = forgetSnapshot(topic, store.forgetSources(topic).sources);
    const raw = JSON.stringify({ spans: [{ ref: 'episodes:1:text', text }], reviewed_refs: ['episodes:1:text'], complete: true });
    episodes.add('tg-arrived-during-selector', 'owner', text, 2);
    expect(selectedForgetTexts(topic, snapshot, raw, forgetSnapshot(topic, store.forgetSources(topic).sources))).toBeNull();
    expect(store.purge([], '2026-10-03T12:00:01Z', [topic]).ready).toBe(false);
    store.settle([], [topic]);
    expect(store.incompleteTopics()).toEqual([topic]);
    expect(store.pendingTopics()).toEqual([]);
    expect(episodes.get('1')!.text).toBe(text);
    expect(episodes.get('2')!.text).toBe(text);
  });
});

it('rejects foreign refs, altered substrings, markerless targets, truncated rows and unsupported Unicode proof', () => {
  const topic = 'DLD-20261002-M3';
  const row = { ref: 'episodes:1:text', text: `${topic} workshop preference: Friday at 09:10 UTC` };
  const snapshot = forgetSnapshot(topic, [row]);
  for (const span of [{ ref: 'foreign-owner:1', text: row.text }, { ref: row.ref, text: row.text + ' invented' }, { ref: row.ref, text: 'Friday at 09:10 UTC' }]) {
    expect(selectedForgetTexts(topic, snapshot, JSON.stringify({ spans: [span], reviewed_refs: [row.ref], complete: true }), snapshot)).toBeNull();
  }
  expect(forgetSnapshot(topic, Array.from({ length: 65 }, (_, i) => ({ ...row, ref: String(i) }))).incomplete).toBe(true);
  expect(forgetSnapshot('Élan', [{ ref: '1', text: 'Élan workshop at 09:10 UTC' }]).incomplete).toBe(true);
});

it('canonicalises pending topic custody and never makes a failed barrier write literal-ready', async () => {
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('selective-forget-custody-failure')), (_instance, state) => {
    let failBarrier = false;
    const sql = { exec: (...args: Parameters<SqlStorage['exec']>) => {
      if (failBarrier && String(args[0]).startsWith('INSERT INTO forget_barriers')) throw new Error('fixture barrier failure');
      return state.storage.sql.exec(...args);
    } } as Pick<SqlStorage, 'exec'>;
    const store = claimStore(sql);
    const topic = 'DLD-20261002-M3';
    const text = `${topic} workshop preference: Friday at 09:10 UTC`;
    episodeIndex(state.storage.sql).add('tg-custody', 'owner', text, 1);
    store.beginTopicCoverage(` ${topic} `, '2026-10-03T12:00:00Z');
    expect(store.purge([], '2026-10-03T12:00:00Z', [topic]).ready).toBe(false);
    failBarrier = true;
    expect(() => store.authoriseTopicCoverage(topic, [text], '2026-10-03T12:00:00Z')).toThrow('fixture barrier failure');
    expect(store.incompleteTopics()).toEqual([topic]);
    expect(store.pendingTopics()).toEqual([]);
    expect(episodeIndex(state.storage.sql).get('1')!.text).toBe(text);
  });
});
