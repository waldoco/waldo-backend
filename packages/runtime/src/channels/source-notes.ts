import { numericHealthIn } from '../scribe/sanitiser';
import type { EpisodeIndex } from './episodes';
import type { Change } from './update-cards';

// What triage keeps of something an outside source says happened (a form confirmation, a receipt, a plan that changed), so the
// owner can later ask about it from any surface. A note is source-bound: it names the mail or event it came from, and is never
// the owner's word, an owner fact, or authority for an action. Its one line is indexed with the episodes as speaker 'source',
// so recall and search_episodes find it on every surface and the owner's forget redacts it there; this table keeps only ids,
// the owner's own account and times, never text. The triage settle is its one writer.
export type NoteChoice = Readonly<{ ref: string; line: string; loop?: string | undefined }>;
export type BoundNote = Readonly<{ key: string; source_ref: string; source: Change['source']; account: string | null; loop_id: string | null; at: number; line: string }>;
// Why a chosen note was not kept: it named no change in the batch, or its line carries a health reading.
export type NoteDrop = 'unbound' | 'health';

const detailOf = (change: Change): Record<string, unknown> => {
  try { const parsed: unknown = JSON.parse(change.detail); return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}; } catch { return {}; }
};
const refOf = (change: Change): string | undefined => change.source_ref ?? change.ref;

// Binds each chosen note to the change in this batch it names, by that change's ref: a note can only be about what the batch
// holds, so text inside a mail cannot point a note at anything else. When it happened and from which account come from the
// change, never from the model. A loop is kept only while it is open; a note about a closed or unknown loop still stands alone.
export const bindNotes = (chosen: readonly NoteChoice[], changes: readonly Change[], deps: Readonly<{ recordId: number; now: number; loopOpen(id: string): boolean }>):
  Readonly<{ notes: readonly BoundNote[]; dropped: readonly NoteDrop[] }> => {
  const notes: BoundNote[] = [], dropped: NoteDrop[] = [];
  for (const note of chosen) {
    const change = changes.find(candidate => refOf(candidate) === note.ref);
    if (!change) { dropped.push('unbound'); continue; }
    if (numericHealthIn(note.line)) { dropped.push('health'); continue; }
    const detail = detailOf(change);
    const sent = change.source === 'mail' && typeof detail.at === 'string' ? Date.parse(detail.at) : NaN;
    // One mail message is one source: its id keys the note across batches, whether the change named it by its thread's source
    // ref (with its message id) or by the message. A calendar change is keyed to the batch that held it.
    const key = change.source === 'mail' ? `mail:${change.source_message_id ?? change.ref?.replace(/^message:/, '') ?? note.ref}` : `${note.ref}@${deps.recordId}`;
    notes.push({ key, source_ref: note.ref, source: change.source, account: typeof detail.account === 'string' ? detail.account : null,
      loop_id: note.loop && deps.loopOpen(note.loop) ? note.loop : null, at: Number.isFinite(sent) ? sent : deps.now, line: note.line });
  }
  return { notes, dropped };
};

// Where it came from leads, so a recall snippet cut to a few words still names the source.
export const sourceNoteText = (note: BoundNote): string =>
  `From ${note.source}${note.account ? ` on ${note.account}` : ''} (${note.source_ref}): ${note.line}${note.loop_id ? ` Bears on loop ${note.loop_id}.` : ''}`;

export const sourceNoteBook = (sql: Pick<SqlStorage, 'exec'>, episodes: Pick<EpisodeIndex, 'add'>) => {
  sql.exec(`CREATE TABLE IF NOT EXISTS source_notes (
    key TEXT PRIMARY KEY, source_ref TEXT NOT NULL, account TEXT, loop_id TEXT, at INTEGER NOT NULL, noted_at INTEGER NOT NULL, update_id INTEGER NOT NULL)`);
  sql.exec('CREATE INDEX IF NOT EXISTS source_notes_loop_idx ON source_notes (loop_id) WHERE loop_id IS NOT NULL');
  return {
    // Run inside the triage settle's transaction. A source already noted is not noted again; returns how many were new.
    record(notes: readonly BoundNote[], updateId: number, now: number): number {
      let added = 0;
      for (const note of notes) {
        const inserted = sql.exec('INSERT INTO source_notes (key, source_ref, account, loop_id, at, noted_at, update_id) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (key) DO NOTHING RETURNING key',
          note.key, note.source_ref, note.account, note.loop_id, note.at, now, updateId).toArray().length > 0;
        if (!inserted) continue;
        episodes.add(`note:${note.key}`, 'source', sourceNoteText(note), note.at);
        added += 1;
      }
      return added;
    },
    // The evidence noted for each loop: when, and the note's episode entry. Closure stays with the owner.
    evidence(): ReadonlyMap<string, readonly Readonly<{ at: number; entry_id: string }>[]> {
      const by = new Map<string, Readonly<{ at: number; entry_id: string }>[]>();
      for (const row of sql.exec<{ loop_id: string; at: number; key: string }>('SELECT loop_id, at, key FROM source_notes WHERE loop_id IS NOT NULL ORDER BY at')) {
        by.set(row.loop_id, [...(by.get(row.loop_id) ?? []), { at: row.at, entry_id: `note:${row.key}` }]);
      }
      return by;
    },
  };
};
export type SourceNoteBook = ReturnType<typeof sourceNoteBook>;
