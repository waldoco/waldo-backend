import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { armNightly, backfillEpisodes, episodeIndex, ftsQuery, indexedConversationStore, NIGHTLY_ID, speakerOf, transcript } from '../src/channels/episodes';
import { durableConversationStore } from '../src/channels/conversation-store';
import { ensureSchema } from '../src/tracer/schema';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { searchEpisodesHandler } from '../src/tools/live/search-episodes';

const entry = (id: string, text: string, parentId: string | null = null) => ({
  id, ownerId: 'o', chatId: 'telegram-1', parentId, threadAnchorId: null, surface: 'telegram', modelPayload: text, appPayload: text, modelProjection: { mode: 'include' as const },
});

describe('episode history', () => {
  it('names speakers from entry ids and quotes model queries safely', () => {
    expect([speakerOf('tg-5'), speakerOf('tg-5-reply'), speakerOf('reminder:ab:1:0'), speakerOf('reminder:ab:1:0-reply')]).toEqual(['owner', 'waldo', 'system', 'waldo']);
    expect(ftsQuery('Knee "pain" OR NEAR(run*)')).toBe('"knee" OR "pain" OR "or" OR "near" OR "run"');
    expect(ftsQuery(' ?! ')).toBeNull();
  });

  it('indexes saved turns, backfills old ones, searches and reads a day back', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('episodes'));
    await runInDurableObject(stub, async (_instance, state) => {
      const kv = durableConversationStore(state.storage);
      await kv.save([entry('tg-1', 'My knee hurts after running')], 'tg-1');
      const index = episodeIndex(state.storage.sql);
      expect(await backfillEpisodes(kv, index)).toBe(1);
      expect(await backfillEpisodes(kv, index)).toBe(0);
      let now = Date.parse('2026-09-22T10:00:00Z');
      const store = indexedConversationStore(kv, index, () => now);
      await store.save([entry('tg-2', 'Booked physio for Friday, Dr Mehta', 'tg-1'), entry('tg-2-reply', 'Good call on the physio', 'tg-2')], 'tg-2-reply');
      now = Date.parse('2026-09-23T09:00:00Z');
      await store.save([entry('tg-3', 'Chai with Riya at 5', 'tg-2-reply')], 'tg-3');
      expect((await store.load()).entries).toHaveLength(4);

      const knee = index.search('knee', 5);
      expect(knee).toEqual([{ ref: expect.any(String), entry_id: 'tg-1', speaker: 'owner', at: null, snippet: 'My [knee] hurts after running' }]);
      expect(index.search('physio', 5).map((hit) => hit.speaker)).toEqual(expect.arrayContaining(['owner', 'waldo']));
      expect(index.search('physio riya', 5, Date.parse('2026-09-23T00:00:00Z'))).toEqual([{ ref: expect.any(String), entry_id: 'tg-3', speaker: 'owner', at: '2026-09-23T09:00:00.000Z', snippet: 'Chai with [Riya] at 5' }]);
      expect(index.search('"; DROP TABLE episodes; --', 5)).toEqual([]);

      const day = index.since(Date.parse('2026-09-22T12:00:00Z'), 10_000);
      expect(transcript(day, 'Asia/Kolkata')).toBe('[2026-09-23T14:30] owner: Chai with Riya at 5');
      expect(index.since(0, 30).map((row) => row.entry_id)).toEqual(['tg-3']);

      const handler = searchEpisodesHandler(index);
      expect(handler.trigger_allowlist).toContain('user_message');
      const result = await handler.handle(handler.schema.parse({ query: 'physio' }), {} as never);
      expect(result.ok && result.data.hits?.length).toBe(2);
    });
  });

  it('retains only metadata for a protected assistant response across storage and episodes', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('episodes-protected'));
    await runInDurableObject(stub, async (_instance, state) => {
      const index = episodeIndex(state.storage.sql);
      const store = indexedConversationStore(durableConversationStore(state.storage), index, () => 100);
      await store.save([{ ...entry('app-reply', 'Synthetic raw physiology 420'), role: 'assistant' as const }], 'app-reply', undefined, 'volatile_owner_health');
      expect(JSON.stringify(await store.load())).not.toContain('420');
      expect(JSON.stringify(index.since(0, 10000))).not.toContain('420');
      expect(index.search('physiology', 5)).toEqual([]);
    });
  });

  it('re-anchors a future stale-zone nightly row without replaying an occurrence', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('nightly-zone-reconcile'));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const before = Date.parse('2026-09-29T02:00:00Z');
      await armNightly(scheduler, 'UTC', before);
      expect(scheduler.read(NIGHTLY_ID)?.due_at).toBe(Date.parse('2026-09-29T03:00:00Z'));
      // Preserve an already-due row so normal dispatch can record it first.
      await armNightly(scheduler, 'Asia/Kolkata', Date.parse('2026-09-29T02:59:59Z'));
      expect(scheduler.read(NIGHTLY_ID)?.recurrence).toEqual({ type: 'daily_local', time: '03:00', timezone: 'UTC' });
      await armNightly(scheduler, 'Asia/Kolkata', Date.parse('2026-09-29T03:00:01Z'));
      expect(scheduler.read(NIGHTLY_ID)?.recurrence).toEqual({ type: 'daily_local', time: '03:00', timezone: 'UTC' });
      // On the next setup the future UTC row is replaced with the correct local anchor.
      const after = Date.parse('2026-09-29T04:00:00Z');
      await scheduler.schedule({ id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID },
        occurrenceAt: Date.parse('2026-09-30T03:00:00Z'), dueAt: Date.parse('2026-09-30T03:00:00Z'),
        recurrence: { type: 'daily_local', time: '03:00', timezone: 'UTC' } });
      await armNightly(scheduler, 'Asia/Kolkata', after);
      const corrected = scheduler.read(NIGHTLY_ID)!;
      expect(corrected.recurrence).toEqual({ type: 'daily_local', time: '03:00', timezone: 'Asia/Kolkata' });
      expect(corrected.due_at).toBe(Date.parse('2026-09-29T21:30:00Z'));
      await armNightly(scheduler, 'Asia/Kolkata', after);
      expect(scheduler.read(NIGHTLY_ID)?.due_at).toBe(corrected.due_at);
      await scheduler.cancel(NIGHTLY_ID);
    });
  });

  it('arms one nightly memory pass at 03:00 owner time', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('nightly'));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      const now = Date.parse('2026-09-23T09:00:00Z');
      await armNightly(scheduler, 'Asia/Kolkata', now);
      await armNightly(scheduler, 'Asia/Kolkata', now);
      const nightly = scheduler.read(NIGHTLY_ID)!;
      expect([nightly.kind, nightly.due_at, nightly.recurrence]).toEqual(['dreaming', Date.parse('2026-09-23T21:30:00Z'), { type: 'daily_local', time: '03:00', timezone: 'Asia/Kolkata' }]);
      await scheduler.cancel(NIGHTLY_ID);
    });
  });

  // Recall diagnostic (staging 2026-10-01): a snippet is a 16-token fragment, so an exact value
  // (price, time) outside the fragment was unrecoverable, and the model asserted an older
  // answer as the latest. The hit now names its source turn and the full text is retrievable.
  it('a hit names its exact row and the full text behind a truncated snippet is retrievable', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('episodes-source'));
    await runInDurableObject(stub, async (_instance, state) => {
      const index = episodeIndex(state.storage.sql);
      const full = `latest options test arrive ${'so '.repeat(30)}A leaves 16:30 for 22k, B leaves 17:45 for 18.5k, C leaves 19:10 for 15k`;
      index.add('tg-9', 'owner', full, Date.parse('2026-10-01T02:31:18Z'));
      const [hit] = index.search('latest options test arrive', 5);
      expect(hit!.entry_id).toBe('tg-9');
      expect(hit!.snippet).not.toContain('18.5k');
      expect(index.get(hit!.ref)!.text).toBe(full);
      expect(index.get('999999')).toBeNull();
      expect(index.get('1; DROP')).toBeNull();
      for (const bad of ['0', '-1', '007', '1.5', '']) expect(index.get(bad)).toBeNull();
    });
  });

  it('the same entry_id indexed twice keeps both rows, and each hit recovers its own body', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('episodes-dup'));
    await runInDurableObject(stub, async (_instance, state) => {
      const index = episodeIndex(state.storage.sql);
      index.add('tg-5', 'owner', 'budget is 22k for the trip', 100);
      index.add('tg-5', 'owner', 'budget is 18.5k for the trip after all', 200);
      const hits = index.search('budget trip', 5);
      expect(hits).toHaveLength(2);
      expect(new Set(hits.map((hit) => hit.ref)).size).toBe(2);
      // Each hit's ref returns that hit's own row, never the earlier row sharing its entry_id.
      for (const hit of hits) expect(index.get(hit.ref)!.text.toLowerCase()).toContain(hit.snippet.replace(/[\[\]]/g, '').toLowerCase().split(' ').slice(-1)[0]!.replace('...', ''));
      const bodies = hits.map((hit) => index.get(hit.ref)!.text).sort();
      expect(bodies).toEqual(['budget is 18.5k for the trip after all', 'budget is 22k for the trip']);
    });
  });

  it('search stays relevance-ranked: a newer, less relevant turn is not promoted', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('episodes-order'));
    await runInDurableObject(stub, async (_instance, state) => {
      const index = episodeIndex(state.storage.sql);
      index.add('tg-1', 'owner', 'flight options', Date.parse('2026-09-30T10:00:00Z'));
      index.add('tg-2', 'owner', 'flight options flight options flight', Date.parse('2026-09-30T11:00:00Z'));
      index.add('tg-3', 'owner', 'any of the flight options is fine as long as I arrive by six', Date.parse('2026-10-01T02:00:00Z'));
      const ids = index.search('flight options', 3).map((hit) => hit.entry_id);
      expect(ids[0]).not.toBe('tg-3');
      expect(ids).toContain('tg-3');
    });
  });
});
