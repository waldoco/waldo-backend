import type { ConversationStore } from './conversation-store';
import { localIso, localToEpoch, nextAfter } from './reminders';
import type { Scheduler } from '../scheduler/multiplexer';

// Full-text history of the owner's chat (SQLite FTS5 in the owner's Durable Object). Every
// saved turn is indexed; search_episodes ranks by BM25 and the nightly pass reads a day back.
export type Speaker = 'owner' | 'waldo' | 'reminder';
export type Episode = Readonly<{ entry_id: string; speaker: Speaker; at: number; text: string }>;
export type EpisodeHit = Readonly<{ speaker: Speaker; at: string | null; snippet: string }>;

export type EpisodeIndex = Readonly<{
  add(entryId: string, speaker: Speaker, text: string, at: number): void;
  count(): number;
  search(query: string, limit: number, from?: number, to?: number): readonly EpisodeHit[];
  since(at: number, maxChars: number): readonly Episode[];
}>;

export const speakerOf = (entryId: string): Speaker => (entryId.endsWith('-reply') ? 'waldo' : entryId.startsWith('tg-') ? 'owner' : 'reminder');

// Model text becomes plain quoted terms, so FTS5 operators and quotes in a question can't
// break the query; OR keeps recall and BM25 does the ranking.
export const ftsQuery = (text: string): string | null => {
  const terms = [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16);
  return terms.length ? terms.map((term) => `"${term}"`).join(' OR ') : null;
};

export const episodeIndex = (sql: SqlStorage): EpisodeIndex => {
  sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS episodes USING fts5(entry_id UNINDEXED, speaker UNINDEXED, at UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')");
  return {
    add(entryId, speaker, text, at) {
      if (text.trim()) sql.exec('INSERT INTO episodes (entry_id, speaker, at, text) VALUES (?, ?, ?, ?)', entryId, speaker, at, text);
    },
    count: () => sql.exec<{ n: number }>('SELECT count(*) AS n FROM episodes').one().n,
    search(query, limit, from, to) {
      const match = ftsQuery(query);
      if (match === null) return [];
      return sql.exec<{ speaker: Speaker; at: number; snippet: string }>(
        `SELECT speaker, at, snippet(episodes, 3, '[', ']', '...', 16) AS snippet FROM episodes
         WHERE episodes MATCH ? AND (? IS NULL OR at >= ?) AND (? IS NULL OR at <= ?)
         ORDER BY bm25(episodes) LIMIT ?`,
        match, from ?? null, from ?? null, to ?? null, to ?? null, limit,
      ).toArray().map((row) => ({ speaker: row.speaker, at: row.at > 0 ? new Date(row.at).toISOString() : null, snippet: row.snippet }));
    },
    since(at, maxChars) {
      const rows = sql.exec<Episode>('SELECT entry_id, speaker, at, text FROM episodes WHERE at > ? ORDER BY at DESC', at).toArray();
      const kept: Episode[] = [];
      let total = 0;
      for (const row of rows) {
        total += row.text.length;
        if (total > maxChars) break;
        kept.push(row);
      }
      return kept.reverse();
    },
  };
};

export const indexedConversationStore = (store: ConversationStore, index: EpisodeIndex, now: () => number): ConversationStore => ({
  load: () => store.load(),
  async save(entries, leafId) {
    await store.save(entries, leafId);
    const at = now();
    for (const entry of entries) index.add(entry.id, speakerOf(entry.id), entry.appPayload, at);
  },
});

// Turns saved before the index existed carry no time, so they come back undated.
export const backfillEpisodes = async (store: ConversationStore, index: EpisodeIndex): Promise<number> => {
  if (index.count() > 0) return 0;
  const { entries } = await store.load();
  for (const entry of entries) index.add(entry.id, speakerOf(entry.id), entry.appPayload, 0);
  return entries.length;
};

export const NIGHTLY_ID = 'nightly-memory';
export const NIGHTLY_TIME = '03:00';

export const armNightly = async (scheduler: Scheduler, timezone: string, now: number): Promise<void> => {
  if (scheduler.read(NIGHTLY_ID)) return;
  const at = nextAfter(localToEpoch(`${localIso(now, timezone).slice(0, 10)}T${NIGHTLY_TIME}`, timezone), now);
  await scheduler.schedule({
    id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: at, dueAt: at,
    recurrence: { type: 'daily_local', time: NIGHTLY_TIME, timezone },
  });
};

export const transcript = (episodes: readonly Episode[], timezone: string): string =>
  episodes.map((episode) => `[${episode.at > 0 ? localIso(episode.at, timezone) : 'undated'}] ${episode.speaker}: ${episode.text}`).join('\n');
