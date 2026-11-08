import { sha256Hex } from '../context-composer/canonical';
import type { Change } from './update-cards';

// What triage told the owner, by source, so it never tells the same thing twice. A row is one change a tell or a card was about:
// the source it came from (a mail's thread or message, an event), the version of it that was told, when, and the cards it
// raised. Ids, digests and times only, never text. The triage settle is its one writer.
export type ToldChange = Readonly<{ source_ref: string; version: string }>;
export type Told = Readonly<{ at: number; cards: readonly string[] }>;
// Rows older than this are dropped on the next write: a month bounds the table, and a repeat that old is news again.
export const TOLD_KEPT_MS = 30 * 24 * 3_600_000;

const refOf = (change: Change): string | undefined => change.source_ref ?? change.ref;
// A mail is told once per message; an event once per version of what the owner is shown of it.
export const toldChange = async (change: Change): Promise<ToldChange | null> => {
  const ref = refOf(change);
  if (!ref) return null;
  if (change.source === 'mail') return { source_ref: ref, version: `message:${change.source_message_id ?? ref.replace(/^message:/, '')}` };
  return { source_ref: ref, version: `${change.kind}:${(await sha256Hex(change.detail)).slice(0, 32)}` };
};
// The changes a tell or a card was about: the batch changes it names by ref, or the whole batch when it names none it holds.
export const aboutChanges = (changes: readonly Change[], about: readonly string[] | undefined): readonly Change[] => {
  const named = about ? changes.filter(change => about.includes(refOf(change) ?? '')) : [];
  return named.length ? named : changes;
};

export const toldBook = (sql: Pick<SqlStorage, 'exec'>) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS triage_told (
    source_ref TEXT NOT NULL, version TEXT NOT NULL, at INTEGER NOT NULL, update_id INTEGER NOT NULL, cards TEXT NOT NULL DEFAULT '[]',
    PRIMARY KEY (source_ref, version))`);
  return {
    // Run inside the settle's transaction, with the delivery or the card it records.
    record(told: readonly ToldChange[], updateId: number, now: number, cards: readonly string[] = []): void {
      sql.exec('DELETE FROM triage_told WHERE at < ?', now - TOLD_KEPT_MS);
      for (const change of told) sql.exec(`INSERT INTO triage_told (source_ref, version, at, update_id, cards) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (source_ref, version) DO UPDATE SET at = excluded.at, update_id = excluded.update_id, cards = excluded.cards`,
        change.source_ref, change.version, now, updateId, JSON.stringify(cards));
    },
    // When the owner was last told about this source, whatever version: the turn judges whether what is new is worth saying.
    lastTold(sourceRef: string): number | null {
      return sql.exec<{ at: number | null }>('SELECT MAX(at) AS at FROM triage_told WHERE source_ref = ?', sourceRef).one().at ?? null;
    },
    // Whether this exact version was already told: saying it again would be the same thing twice.
    toldExactly(change: ToldChange): boolean {
      return sql.exec('SELECT 1 FROM triage_told WHERE source_ref = ? AND version = ?', change.source_ref, change.version).toArray().length > 0;
    },
    // What triage told or carded most recently, one entry per batch, newest first: when, the mail messages it was about (by
    // id), and the cards it raised. For the owner's signals.
    recent(limit: number): readonly Readonly<{ update_id: number; at: number; messages: readonly string[]; cards: readonly string[] }>[] {
      return sql.exec<{ update_id: number; at: number; versions: string; cards: string }>(
        'SELECT update_id, MAX(at) AS at, json_group_array(version) AS versions, MAX(cards) AS cards FROM triage_told GROUP BY update_id ORDER BY MAX(at) DESC LIMIT ?', limit).toArray()
        .map(row => ({ update_id: row.update_id, at: row.at, cards: JSON.parse(row.cards) as string[],
          messages: (JSON.parse(row.versions) as string[]).flatMap(version => version.startsWith('message:') ? [version.slice('message:'.length)] : []) }));
    },
  };
};
export type ToldBook = ReturnType<typeof toldBook>;
