import type { ConversationEntry } from '@waldo/contracts';
import type { ConversationStore } from './conversation-store';
import type { RunEffectScope } from './run-effect-scope';
import { localIso, localToEpoch, nextAfter } from './reminders';
import type { Scheduler } from '../scheduler/multiplexer';

// Full-text history of the owner's chat (SQLite FTS5 in the owner's Durable Object). Every
// saved turn is indexed; search_episodes ranks by BM25 and the nightly pass reads a day back.
// 'quoted' is text the owner pasted inside a quote (a Telegram blockquote, pre or code range): searchable, but never the
// owner's own words.
export type Speaker = 'owner' | 'waldo' | 'system' | 'quoted';
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
  after(at: number, maxChars: number): readonly Episode[];
}>;

export const speakerOf = (entryId: string): Speaker => (entryId.endsWith('-reply') ? 'waldo' : entryId.startsWith('tg-') ? 'owner' : 'system');
// A row stamped by the conversation path says who spoke, on any surface; an older, unstamped row
// falls back to the Telegram-era id convention.
export const speakerOfEntry = (entry: Pick<ConversationEntry, 'id' | 'role' | 'inputOrigin'>): Speaker =>
  entry.role === 'assistant' ? 'waldo' : entry.inputOrigin === 'owner' ? 'owner' : entry.inputOrigin === 'machine' ? 'system' : speakerOf(entry.id);

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
    // Oldest first, so a reader that moves past what it read never skips a row: rows that share a time stay together,
    // and the first row always comes, so one long row cannot stall it.
    after(at, maxChars) {
      const kept: Episode[] = [];
      let total = 0;
      for (const row of sql.exec<Episode>('SELECT entry_id, speaker, at, text FROM episodes WHERE at > ? ORDER BY at, rowid', at)) {
        const last = kept.at(-1);
        if (last && row.at !== last.at && total + row.text.length > maxChars) break;
        kept.push(row); total += row.text.length;
      }
      return kept;
    },
  };
};

type QuoteRanges = readonly Readonly<{ start: number; end: number }>[];
// An owner message as index rows: its own words as 'owner', each quoted range as 'quoted', in order. The ranges index the
// message as received; what was stored after it (a media note, which can carry someone else's speech) is 'quoted' too.
// When the stored text no longer starts with the message as received (a forgotten topic was redacted), or a range is
// malformed, the whole message is 'quoted', so it can never ground a claim as the owner's own words.
export const ownerRows = (stored: string, received: string, ranges: QuoteRanges): readonly Readonly<{ speaker: Speaker; text: string }>[] => {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  if (!stored.startsWith(received) || sorted.some(range => !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end < range.start || range.end > received.length)) {
    return [{ speaker: 'quoted', text: stored }];
  }
  const rows: { speaker: Speaker; text: string }[] = [];
  const push = (speaker: Speaker, text: string) => { if (text.trim()) rows.push({ speaker, text }); };
  let end = 0;
  for (const range of sorted) {
    if (range.start > end) push('owner', stored.slice(end, range.start));
    if (range.end > end) push('quoted', stored.slice(Math.max(end, range.start), range.end));
    end = Math.max(end, range.end);
  }
  push('owner', stored.slice(end, received.length));
  push('quoted', stored.slice(received.length));
  return rows;
};

// The owner's input is indexed when it is stored, before the turn runs, so it is searchable even if the turn never
// finishes; the turn's save then skips it.
export const indexedConversationStore = (store: ConversationStore, index: EpisodeIndex, now: () => number): ConversationStore => {
  const indexedInputs = new Set<string>();
  const quoted = new Map<string, Readonly<{ text: string; ranges: QuoteRanges }>>();
  const add = (entry: ConversationEntry, at: number) => {
    const speaker = speakerOfEntry(entry), noted = quoted.get(entry.id);
    quoted.delete(entry.id);
    if (speaker !== 'owner' || !noted) { index.add(entry.id, speaker, entry.appPayload, at); return; }
    for (const row of ownerRows(entry.appPayload, noted.text, noted.ranges)) index.add(entry.id, row.speaker, row.text, at);
  };
  const persistOwnerInput = store.persistOwnerInput;
  return {
    ...store,
    load: () => store.load(),
    noteQuoteRanges(entryId, text, ranges) { quoted.set(entryId, { text, ranges }); },
    ...(persistOwnerInput ? { async persistOwnerInput(entry: ConversationEntry, scope: RunEffectScope) {
      await persistOwnerInput(entry, scope);
      scope.commit(() => add(entry, now()));
      indexedInputs.add(entry.id);
    } } : {}),
    async save(entries, leafId, scope) {
      await store.save(entries, leafId, scope);
      const at = now();
      const unindexed = entries.filter(entry => !indexedInputs.delete(entry.id));
      const commit = () => { for (const entry of unindexed) add(entry, at); };
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

// When this owner's index began splitting owner messages into their own words and what they quote. An 'owner' row from
// before it is a whole message, quotes and media notes included, so it is only ever shared text, never the owner's words.
export const OWNER_ROWS_SINCE_KEY = 'episode_owner_rows_since_v1';
export const consolidationSides = (day: readonly Episode[], ownerRowsSince: number) => {
  const owner = day.filter((episode) => episode.speaker === 'owner' && episode.at >= ownerRowsSince);
  const texts = (keep: (episode: Episode) => boolean) => day.filter(keep).map((episode) => episode.text).join('\n');
  return {
    owner: owner.map((episode) => episode.text).join('\n'),
    shared: texts((episode) => episode.speaker === 'quoted' || (episode.speaker === 'owner' && episode.at < ownerRowsSince)),
    waldo: texts((episode) => episode.speaker === 'waldo'),
    ownerMessages: owner.map((episode) => ({ ref: episode.entry_id, text: episode.text })),
  };
};

export const NIGHTLY_ID = 'nightly-memory';
export const NIGHTLY_TIME = '03:00';
// A one-off pass that only consolidates, armed when a night could not finish its backlog.
export const NIGHTLY_CATCH_UP_ID = 'nightly-memory-catch-up';
export const NIGHTLY_CATCH_UP_DELAY_MS = 15 * 60_000;
// The time of the last episode a finished pass consolidated. A pass looks back at most a week and reads at most three chunks.
export const NIGHTLY_THROUGH_KEY = 'nightly_consolidated_through_v1';
export const NIGHTLY_BACKLOG_DAYS = 7;
export const NIGHTLY_CHUNKS = 3;

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
