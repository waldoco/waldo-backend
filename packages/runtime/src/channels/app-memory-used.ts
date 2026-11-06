import { APP_CHAT_MEMORY_USED_MAX_V1 } from '../../../contracts/src/app/core';
import { REPLY_MEMORY_USED_TABLE_SCHEMA } from '../do-schema';
import { holdsIn } from '../memory/forget-guard';
import { outsideSafe } from '../memory/outside-view';
import type { Claim } from '../memory/claims';

type Sql = Pick<SqlStorage, 'exec'>;

// The notes Waldo had in front of it for one owner message: ids only, never text. What the app shows is read back from the
// claims as they are now, so a claim the owner forgot or Waldo retired since is no longer named.
const KEPT = 2000;

export const memoryUsedBook = (sql: Sql) => {
  for (const statement of REPLY_MEMORY_USED_TABLE_SCHEMA) sql.exec(statement);
  return {
    record(turnId: string, claimIds: readonly number[], at: number): void {
      const ids = [...new Set(claimIds)].filter(Number.isSafeInteger);
      if (!ids.length) return;
      sql.exec('INSERT INTO reply_memory_used (turn_id, claim_ids, at) VALUES (?, ?, ?) ON CONFLICT (turn_id) DO UPDATE SET claim_ids = excluded.claim_ids, at = excluded.at', turnId, JSON.stringify(ids), at);
      sql.exec('DELETE FROM reply_memory_used WHERE rowid NOT IN (SELECT rowid FROM reply_memory_used ORDER BY at DESC, rowid DESC LIMIT ?)', KEPT);
    },
    ids(turnId: string): readonly number[] {
      const raw = sql.exec<{ claim_ids: string }>('SELECT claim_ids FROM reply_memory_used WHERE turn_id = ?', turnId).toArray()[0]?.claim_ids;
      try { const ids = JSON.parse(raw ?? '[]') as unknown; return Array.isArray(ids) ? ids.filter(Number.isSafeInteger) : []; } catch { return []; }
    },
  };
};

// What the app shows for a turn: each recorded claim that is still live and not held by a forget in progress, as its text now.
export const memoryUsedFor = (book: ReturnType<typeof memoryUsedBook>, live: () => readonly Claim[], held: () => readonly string[]) =>
  (turnId: string): readonly Readonly<{ id: string; text: string }>[] | undefined => {
    const wanted = book.ids(turnId);
    if (!wanted.length) return undefined;
    const holds = holdsIn(held());
    const claims = new Map(live().map(claim => [claim.id, claim]));
    const shown = wanted.flatMap(id => { const claim = claims.get(id); return claim && !holds(claim.text, claim.evidence, claim.source_ref) && claim.origin !== 'untrusted' && outsideSafe(claim) && !claim.bring_up_less_at ? [{ id: `memory:claim:${id}`, text: [...claim.text.replace(/\s+/g, ' ').trim()].slice(0, 300).join('') }] : []; })
      .filter(item => item.text.length > 0).slice(-APP_CHAT_MEMORY_USED_MAX_V1);
    return shown.length ? shown : undefined;
  };
