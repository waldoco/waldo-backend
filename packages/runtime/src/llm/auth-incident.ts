import type { Provider } from '@waldo/contracts';
import type { TurnLogEntry } from '../channels/owner-turn-types';
import type { LLMAttempt } from './provider';

type Sql = Pick<SqlStorage, 'exec'>;

export type ModelAuthIncident = Readonly<{ provider: Provider; since: number }>;

const ensured = new WeakSet<Sql>();
const table = (sql: Sql): Sql => {
  if (!ensured.has(sql)) {
    sql.exec('CREATE TABLE IF NOT EXISTS model_auth_incidents (provider TEXT PRIMARY KEY, since INTEGER NOT NULL)');
    ensured.add(sql);
  }
  return sql;
};

// A provider that refuses the key stays refused until someone replaces it, so its refusals are one incident: the first opens
// it and is logged once for ops, the rest stay quiet, and the next call that provider answers closes it. A refusal the
// fallback provider covered still counts. Returns the incidents this call opened.
export function observeModelAuth(sql: Sql, attempts: readonly LLMAttempt[], now: number, log: (entry: TurnLogEntry) => void): readonly ModelAuthIncident[] {
  const opened: ModelAuthIncident[] = [];
  for (const attempt of attempts) {
    if (attempt.outcome === 'success') table(sql).exec('DELETE FROM model_auth_incidents WHERE provider = ?', attempt.provider);
    else if (attempt.outcome === 'failure' && attempt.code === 'auth_failed'
      && table(sql).exec('INSERT INTO model_auth_incidents (provider, since) VALUES (?, ?) ON CONFLICT (provider) DO NOTHING', attempt.provider, now).rowsWritten > 0) {
      opened.push({ provider: attempt.provider, since: now });
      log({ trace: `model-auth:${attempt.provider}:${now}`, hop: 'model_auth_failed', ms: 0, ok: false, code: 'auth_failed', provider: attempt.provider });
    }
  }
  return opened;
}

export function openModelAuthIncidents(sql: Sql): readonly ModelAuthIncident[] {
  return table(sql).exec<{ provider: Provider; since: number }>('SELECT provider, since FROM model_auth_incidents ORDER BY provider').toArray();
}
