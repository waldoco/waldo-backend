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
      expect(knee).toEqual([{ speaker: 'owner', at: null, snippet: 'My [knee] hurts after running' }]);
      expect(index.search('physio', 5).map((hit) => hit.speaker)).toEqual(expect.arrayContaining(['owner', 'waldo']));
      expect(index.search('physio riya', 5, Date.parse('2026-09-23T00:00:00Z'))).toEqual([{ speaker: 'owner', at: '2026-09-23T09:00:00.000Z', snippet: 'Chai with [Riya] at 5' }]);
      expect(index.search('"; DROP TABLE episodes; --', 5)).toEqual([]);

      const day = index.since(Date.parse('2026-09-22T12:00:00Z'), 10_000);
      expect(transcript(day, 'Asia/Kolkata')).toBe('[2026-09-23T14:30] owner: Chai with Riya at 5');
      expect(index.since(0, 30).map((row) => row.entry_id)).toEqual(['tg-3']);

      const handler = searchEpisodesHandler(index);
      expect(handler.trigger_allowlist).toContain('user_message');
      const result = await handler.handle(handler.schema.parse({ query: 'physio' }), {} as never);
      expect(result.ok && result.data.hits.length).toBe(2);
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
});
