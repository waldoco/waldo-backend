import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { episodeIndex } from '../src/channels/episodes';
import { textFingerprint, claimStore, turnMemoryPrompt } from '../src/memory/claims';
import { forgetSnapshot, forgetSourceBatch, selectedForgetResult, selectedForgetTexts, unspannedEpisodeRows, SELECTIVE_FORGET_INSTRUCTION, SELECTIVE_FORGET_SCHEMA } from '../src/memory/selective-forget';
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

for (const count of [32,33,64]) {
  it(`admits and authorises exact coverage for ${count} distinct source clauses`, async()=>{
    await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`forget-boundary-${count}`)),(_instance,state)=>{
      const topic='CAP'; const at='2026-10-05T00:00:00Z';
      const rows=Array.from({length:count},(_,i)=>({ref:`episodes:${i+1}:text`,text:`CAP note ${String(i).padStart(3,'0')}`}));
      const snapshot=forgetSnapshot(topic,rows);
      expect(snapshot.incomplete).toBe(false); expect(snapshot.sources).toHaveLength(count);
      const raw=JSON.stringify({spans:rows,reviewed_refs:rows.map(row=>row.ref),complete:true});
      const selected=selectedForgetTexts(topic,snapshot,raw,snapshot);
      expect(selected).toHaveLength(count);
      const store=claimStore(state.storage.sql); store.beginTopicCoverage(topic,at);
      expect(()=>store.authoriseTopicCoverage(topic,selected!,at)).not.toThrow();
      expect(store.pendingTopics()).toHaveLength(count);
      expect(SELECTIVE_FORGET_SCHEMA.properties.spans.maxItems).toBe(64);
      expect(SELECTIVE_FORGET_SCHEMA.properties.reviewed_refs.maxItems).toBe(64);
      expect(selectedForgetTexts(topic,snapshot,JSON.stringify({spans:rows.slice(1),reviewed_refs:rows.map(row=>row.ref),complete:true}),snapshot)).toBeNull();
    });
  });
}
it('does not authorise an over-limit source set or selected text set', async()=>{
  const rows=Array.from({length:65},(_,i)=>({ref:String(i),text:`CAP note ${String(i).padStart(3,'0')}`}));
  const snapshot=forgetSnapshot('CAP',rows);
  expect(snapshot).toMatchObject({incomplete:true}); expect(snapshot.sources).toHaveLength(64);
  expect(selectedForgetTexts('CAP',snapshot,JSON.stringify({spans:rows,reviewed_refs:rows.map(row=>row.ref),complete:true}),snapshot)).toBeNull();
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-boundary-over')),(_instance,state)=>{
    const store=claimStore(state.storage.sql); const at='2026-10-05T00:00:00Z'; store.beginTopicCoverage('CAP',at);
    expect(()=>store.authoriseTopicCoverage('CAP',rows.map(row=>row.text),at)).toThrow('selected topic scope');
    expect(store.incompleteTopics()).toEqual(['CAP']); expect(store.pendingTopics()).toEqual([]);
  });
});

it('keeps ordinary page exhaustion separate from unreadable inventory and never skips an oversized first row',()=>{
  const rows=Array.from({length:65},(_,i)=>({ref:String(i),text:`BAT note ${String(i).padStart(3,'0')}`}));
  const page=forgetSourceBatch('BAT',rows);
  expect(page).toMatchObject({more:true,incomplete:false});expect(page.sources).toHaveLength(64);
  const tooLarge={ref:'large',text:`BAT ${'x'.repeat(9000)}`};
  expect(forgetSourceBatch('BAT',[tooLarge,...rows])).toEqual({sources:[],more:true,incomplete:true});
  expect(forgetSourceBatch('BAT',[rows[0]!,{...rows[0]!,text:'BAT changed note'}]).incomplete).toBe(true);
});
it('partial batch authorization settles only literals and retains original topic custody',async()=>{
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-partial-custody')),(_instance,state)=>{
    const memory=claimStore(state.storage.sql);const topic='BAT';const fact='BAT synthetic note';const at='2026-10-05T00:00:00Z';
    episodeIndex(state.storage.sql).add('partial','owner',fact,1);memory.beginTopicCoverage(topic,at);
    memory.authoriseTopicCoverage(topic,[fact],at,false);
    expect(memory.topicCoverage(topic)).toBe(1);expect(memory.pendingTopics()).toEqual([fact]);
    expect(memory.purge([],at,[fact]).ready).toBe(true);memory.settle([],[fact]);
    expect(memory.pendingTopics()).toEqual([]);expect(memory.incompleteTopics()).toEqual([topic]);
    expect(memory.forgetSources(topic)).toEqual({sources:[],incomplete:false});
    memory.verifyEmptyTopicCoverage(topic,at);memory.settle([],[],topic);
    expect(memory.incompleteTopics()).toEqual([]);
  });
});

it('empty inventory recovery after interrupted admission preserves the forget barrier',async()=>{
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-empty-crash')),(_instance,state)=>{
    const memory=claimStore(state.storage.sql);const topic='BAT';const at='2026-10-05T00:00:00Z';
    memory.beginTopicCoverage(topic,at);
    expect(memory.barriers()).toEqual([]);
    memory.verifyEmptyTopicCoverage(topic,at);memory.settle([],[],topic);
    expect(memory.incompleteTopics()).toEqual([]);
    expect(memory.barriers().some(row=>row.topic_hash===textFingerprint(topic))).toBe(true);
  });
});

it('a failed empty recovery barrier leaves original custody incomplete',async()=>{
  await runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('forget-empty-barrier-failure')),(_instance,state)=>{
    const at='2026-10-05T00:00:00Z';const topic='BAT';let failing=false;
    const sql={exec:(...args:Parameters<SqlStorage['exec']>)=>{
      if(failing && args[0].includes('INTO forget_barriers'))throw new Error('synthetic barrier failure');
      return state.storage.sql.exec(...args);
    }} as Pick<SqlStorage,'exec'>;
    const memory=claimStore(sql);memory.beginTopicCoverage(topic,at);failing=true;
    expect(()=>memory.verifyEmptyTopicCoverage(topic,at)).toThrow('synthetic barrier failure');
    expect(memory.topicCoverage(topic)).toBe(1);expect(memory.barriers()).toEqual([]);
  });
});

it('deduplicates identical source receipts but holds conflicting receipts even beyond the selected page',()=>{
  const row={ref:'same',text:'BAT synthetic note'};
  expect(forgetSourceBatch('BAT',[row,row])).toEqual({sources:[row],incomplete:false,more:false});
  const rows=Array.from({length:64},(_,i)=>({ref:`r${i}`,text:`BAT note ${String(i).padStart(3,'0')}`}));
  expect(forgetSourceBatch('BAT',[...rows,...rows])).toMatchObject({more:false,incomplete:false});
  expect(forgetSourceBatch('BAT',[...rows,{ref:'other',text:'BAT next note'},{...rows[0]!,text:'BAT changed note'}])).toMatchObject({more:true,incomplete:true});
});

it('one ref carrying a matching and a non-matching text is a conflict even when the non-matching row comes first', () => {
  const topic = 'CONFLICT-769';
  expect(forgetSourceBatch(topic, [{ ref: 'episodes:1:text', text: 'unrelated text' }, { ref: 'episodes:1:text', text: `${topic} private` }]).incomplete).toBe(true);
  expect(forgetSourceBatch(topic, [{ ref: 'episodes:1:text', text: `${topic} private` }, { ref: 'episodes:1:text', text: 'unrelated text' }]).incomplete).toBe(true);
  expect(forgetSourceBatch(topic, [{ ref: 'episodes:1:text', text: `${topic} private` }, { ref: 'episodes:1:text', text: `${topic} private` }]).incomplete).toBe(false);
});

it('a ref conflict is found across a batch boundary in either order, and identical duplicates stay valid', () => {
  const topic = 'BOUNDARY-769';
  const rows = Array.from({ length: 70 }, (_, i) => ({ ref: `episodes:${i}:text`, text: `${topic} row ${i}` }));
  expect(forgetSourceBatch(topic, rows).more).toBe(true);
  expect(forgetSourceBatch(topic, [...rows, { ref: 'episodes:3:text', text: 'a different text' }]).incomplete).toBe(true);
  expect(forgetSourceBatch(topic, [{ ref: 'episodes:3:text', text: 'a different text' }, ...rows]).incomplete).toBe(true);
  expect(forgetSourceBatch(topic, [...rows, rows[3]!, rows[69]!]).incomplete).toBe(false);
});

it.each([['non-ascii letters','ZEBRA-COBALT 東京'],['emoji','ZEBRA-COBALT 🙂'],['4096 punctuation',`ZEBRA-COBALT ${'.'.repeat(4096)}`]])('an unspanned episodes row with only the topic plus %s is held, not skipped', (_name, text) => {
  const topic = 'ZEBRA-COBALT';
  const snapshot = forgetSnapshot(topic, [{ ref: 'episodes:1:text', text }]);
  const raw = JSON.stringify({ spans: [], reviewed_refs: ['episodes:1:text'], complete: true });
  expect(selectedForgetResult(topic, snapshot, raw, snapshot)).toEqual({ reason: 'row_without_span:episodes' });
});

it('an unspanned episodes line with other words is held for the second look, never purged whole', () => {
  const topic = 'ZEBRA-COBALT';
  const rows = [{ ref: 'episodes:1:text', text: 'ZEBRA-COBALT is the code word' }, { ref: 'episodes:2:text', text: 'ZEBRA-COBALT again with other words' }];
  const snapshot = forgetSnapshot(topic, rows);
  const raw = JSON.stringify({ spans: [], reviewed_refs: rows.map(row => row.ref), complete: true });
  expect(selectedForgetResult(topic, snapshot, raw, snapshot)).toEqual({ reason: 'row_without_span:episodes' });
  expect(unspannedEpisodeRows(snapshot, raw).map(row => row.ref)).toEqual(rows.map(row => row.ref));
});
