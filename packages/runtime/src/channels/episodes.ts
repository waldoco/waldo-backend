import type { ConversationEntry } from '@waldo/contracts';
import type { ConversationStore } from './conversation-store';
import type { RunEffectScope } from './run-effect-scope';
import { localIso, localToEpoch, nextAfter } from './reminders';
import type { Scheduler } from '../scheduler/multiplexer';

// Full-text history of the owner's chat (SQLite FTS5 in the owner's Durable Object). Every
// saved turn is indexed; search_episodes ranks by BM25 and the nightly pass reads a day back.
export type Speaker = 'owner' | 'waldo' | 'system';
export type Episode = Readonly<{ entry_id: string; speaker: Speaker; at: number; text: string }>;
// ref is the index row's own id: unique per stored row, so a snippet traces to exactly its row
// even if the same entry_id was indexed twice (entry_id is informational, not unique).
export type EpisodeHit = Readonly<{ ref: string; entry_id: string; speaker: Speaker; at: string | null; snippet: string }>;

export type EpisodeIndex = Readonly<{
  add(entryId: string, speaker: Speaker, text: string, at: number): void;
  count(): number;
  get(ref: string): Episode | null;
  search(query: string, limit: number, from?: number, to?: number): readonly EpisodeHit[];
  since(at: number, maxChars: number): readonly Episode[];
}>;

export const speakerOf = (entryId: string): Speaker => (entryId.endsWith('-reply') ? 'waldo' : entryId.startsWith('tg-') ? 'owner' : 'system');
// A row stamped by the conversation path says who spoke, on any surface; an older, unstamped row
// falls back to the Telegram-era id convention.
export const speakerOfEntry = (entry: Pick<ConversationEntry, 'id' | 'role' | 'inputOrigin'>): Speaker =>
  entry.role === 'assistant' ? 'waldo' : entry.inputOrigin === 'owner' ? 'owner' : entry.inputOrigin === 'machine' ? 'system' : speakerOf(entry.id);

// Model text becomes plain terms (letters and digits, first occurrence order, at most 16), so FTS5
// operators and quotes in a question can't break the query.
export const ftsTerms = (text: string): readonly string[] => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])].slice(0, 16);
// Each term quoted; OR keeps recall and BM25 does the ranking.
export const ftsQuery = (text: string): string | null => {
  const terms = ftsTerms(text);
  return terms.length ? terms.map((term) => `"${term}"`).join(' OR ') : null;
};

export const episodeIndex = (sql: SqlStorage): EpisodeIndex => {
  sql.exec("CREATE VIRTUAL TABLE IF NOT EXISTS episodes USING fts5(entry_id UNINDEXED, speaker UNINDEXED, at UNINDEXED, text, tokenize = 'unicode61 remove_diacritics 2')");
  return {
    add(entryId, speaker, text, at) {
      if (text.trim()) sql.exec('INSERT INTO episodes (entry_id, speaker, at, text) VALUES (?, ?, ?, ?)', entryId, speaker, at, text);
    },
    count: () => sql.exec<{ n: number }>('SELECT count(*) AS n FROM episodes').one().n,
    get(ref) {
      const row = Number(ref);
      if (!Number.isSafeInteger(row) || row < 1 || String(row) !== ref) return null;
      return sql.exec<Episode>('SELECT entry_id, speaker, at, text FROM episodes WHERE rowid = ?', row).toArray()[0] ?? null;
    },
    search(query, limit, from, to) {
      const match = ftsQuery(query);
      if (match === null) return [];
      return sql.exec<{ ref: number; entry_id: string; speaker: Speaker; at: number; snippet: string }>(
        `SELECT rowid AS ref, entry_id, speaker, at, snippet(episodes, 3, '[', ']', '...', 16) AS snippet FROM episodes
         WHERE episodes MATCH ? AND (? IS NULL OR at >= ?) AND (? IS NULL OR at <= ?)
         ORDER BY bm25(episodes) LIMIT ?`,
        match, from ?? null, from ?? null, to ?? null, to ?? null, limit,
      ).toArray().map((row) => ({ ref: String(row.ref), entry_id: row.entry_id, speaker: row.speaker, at: row.at > 0 ? new Date(row.at).toISOString() : null, snippet: row.snippet }));
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

// The owner's input is indexed when it is stored, before the turn runs, so it is searchable even if the turn never
// finishes; the turn's save then skips it.
export const indexedConversationStore = (store: ConversationStore, index: EpisodeIndex, now: () => number): ConversationStore => {
  const indexedInputs = new Set<string>();
  const persistOwnerInput = store.persistOwnerInput;
  return {
    ...store,
    load: () => store.load(),
    ...(persistOwnerInput ? { async persistOwnerInput(entry: ConversationEntry, scope: RunEffectScope) {
      await persistOwnerInput(entry, scope);
      scope.commit(() => index.add(entry.id, speakerOfEntry(entry), entry.appPayload, now()));
      indexedInputs.add(entry.id);
    } } : {}),
    async save(entries, leafId, scope) {
      await store.save(entries, leafId, scope);
      const at = now();
      const unindexed = entries.filter(entry => !indexedInputs.delete(entry.id));
      const commit = () => { for (const entry of unindexed) index.add(entry.id, speakerOfEntry(entry), entry.appPayload, at); };
      if (scope) scope.commit(commit); else commit();
    },
  };
};

// Turns saved before the index existed carry no time, so they come back undated.
export const backfillEpisodes = async (store: ConversationStore, index: EpisodeIndex): Promise<number> => {
  if (index.count() > 0) return 0;
  const { entries } = await store.load();
  for (const entry of entries) index.add(entry.id, speakerOfEntry(entry), entry.appPayload, 0);
  return entries.length;
};

// Nightly consolidation learns from what the owner and Waldo said. Machine-written entries
// (reminder and scheduled prompts) are not the owner's words and never become memory.
export const consolidationDay = (episodes: readonly Episode[]): readonly Episode[] => episodes.filter((episode) => episode.speaker !== 'system');

export const NIGHTLY_ID = 'nightly-memory';
export const NIGHTLY_TIME = '03:00';

export const armNightly = async (scheduler: Scheduler, timezone: string, now: number): Promise<void> => {
  const found = scheduler.lookup(NIGHTLY_ID);
  if (found.state === 'unreadable') return;
  const existing = found.state === 'entry' ? found.entry : null;
  if (existing?.recurrence?.type === 'daily_local' && existing.recurrence.time === NIGHTLY_TIME && existing.recurrence.timezone === timezone) return;
  // A due occurrence must be dispatched (or recorded as missed) before replacing its row.
  // Keep the scheduler's one-second due lookahead intact; no manual fire or duplicate pass.
  if (existing && (existing.status !== 'armed' || existing.due_at <= now + 1_000)) return;
  const at = nextAfter(localToEpoch(`${localIso(now, timezone).slice(0, 10)}T${NIGHTLY_TIME}`, timezone), now);
  await scheduler.schedule({
    id: NIGHTLY_ID, kind: 'dreaming', payloadRefs: { id: NIGHTLY_ID }, occurrenceAt: at, dueAt: at,
    recurrence: { type: 'daily_local', time: NIGHTLY_TIME, timezone },
  });
};

export const transcript = (episodes: readonly Episode[], timezone: string): string =>
  episodes.map((episode) => `[${episode.at > 0 ? localIso(episode.at, timezone) : 'undated'}] ${episode.speaker}: ${episode.text}`).join('\n');
