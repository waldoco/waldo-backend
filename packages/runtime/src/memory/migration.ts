import { CLAIM_KINDS, memoryPrompt, type ClaimStore } from './claims';

type Sql = Pick<SqlStorage, 'exec'>;
type LegacyFile = Readonly<{ file: string; revision: number; content: string }>;
type LegacySpot = Readonly<{ id: number; kind: string; text: string; source: string; evidence: string; status: string; created_at: string; last_seen_at: string; seen_count: number }>;

export const LEGACY_BACKUP = 'pre-claims';
export const CORE_FILES_MIGRATED = 'core-files-migrated';

const legacy = (sql: Sql) => {
  sql.exec('CREATE TABLE IF NOT EXISTS core_file_revisions (file TEXT NOT NULL, revision INTEGER NOT NULL, content TEXT NOT NULL, reason TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (file, revision))');
  sql.exec(`CREATE TABLE IF NOT EXISTS spots (id INTEGER PRIMARY KEY AUTOINCREMENT, kind TEXT NOT NULL, text TEXT NOT NULL, source TEXT NOT NULL, evidence TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, seen_count INTEGER NOT NULL DEFAULT 1)`);
  return {
    revisions: () => sql.exec<LegacyFile & { reason: string; created_at: string }>('SELECT * FROM core_file_revisions ORDER BY file, revision').toArray(),
    latest: () => sql.exec<LegacyFile>(`SELECT file, revision, content FROM core_file_revisions r
      WHERE revision = (SELECT MAX(revision) FROM core_file_revisions WHERE file = r.file) AND content != '' ORDER BY file`).toArray(),
    spots: () => sql.exec<LegacySpot>('SELECT * FROM spots ORDER BY id').toArray(),
  };
};

export const backupAndCopySpots = (sql: Sql, store: ClaimStore, at: string): string | null => {
  if (store.backedUp(LEGACY_BACKUP)) return null;
  const old = legacy(sql);
  const spots = old.spots();
  store.backup(LEGACY_BACKUP, { core_file_revisions: old.revisions(), spots, nodes: store.nodes(), edges: store.edges() }, at);
  for (const spot of spots) {
    sql.exec('INSERT OR IGNORE INTO claims (id, kind, text, source, evidence, status, created_at, last_seen_at, seen_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      spot.id, CLAIM_KINDS.includes(spot.kind as never) ? spot.kind : 'observation', spot.text, spot.source, `${spot.evidence} (spot #${spot.id})`, spot.status, spot.created_at, spot.last_seen_at, spot.seen_count);
  }
  return `backup taken; ${spots.length} spots copied`;
};

export const pendingCoreFiles = (sql: Sql, store: ClaimStore): string | null => {
  if (store.backedUp(CORE_FILES_MIGRATED)) return null;
  const files = legacy(sql).latest();
  if (files.length === 0) {
    store.backup(CORE_FILES_MIGRATED, { files: 0 }, new Date(0).toISOString());
    return null;
  }
  return [memoryPrompt(store), 'Notes files to split:', ...files.map((file) => `<file name="${file.file}" revision="${file.revision}">\n${file.content}\n</file>`)].join('\n\n');
};

export const markCoreFilesMigrated = (store: ClaimStore, detail: string, at: string): void => store.backup(CORE_FILES_MIGRATED, { detail }, at);
