import { ProxyIntentError, type ProxyIntent } from './proxy-intent';
// Owner-local durable routing custody. Health ordering may change after response loss,
// but one host intent must never move to another connection or credential rail.
export type IntentRoute = Readonly<{ id: string; rail: 'local' | 'proxy' }>;
export const pinProxyIntentRoute = <T extends IntentRoute>(sql: Pick<SqlStorage,'exec'>, intent: ProxyIntent | undefined, purpose: string, candidates: readonly T[], preferred: T | undefined): T | null => {
  if(!intent)return preferred??null;
  if(!/^[a-zA-Z0-9:_-]{1,240}$/.test(intent.id))throw new ProxyIntentError('intent_required');
  // Read-only intents are per-call and unique: pinning them would fill the 5000-row cap shared with effects.
  if(intent.readOnly)return preferred??null;
  // Calendar undo belongs to the connection used for apply, never today's healthy account.
  const key=intent.id.replace(/:undo$/,':apply');
  sql.exec('CREATE TABLE IF NOT EXISTS proxy_intent_routes (intent_id TEXT PRIMARY KEY, purpose TEXT NOT NULL, connection TEXT NOT NULL, rail TEXT NOT NULL)');
  const prior=sql.exec<{purpose:string;connection:string;rail:string}>('SELECT purpose, connection, rail FROM proxy_intent_routes WHERE intent_id = ?',key).toArray()[0];
  if(prior){
    if(prior.purpose!==purpose)throw new ProxyIntentError('intent_conflict');
    const pinned=candidates.find(c=>c.id===prior.connection&&c.rail===prior.rail);
    if(!pinned)throw new ProxyIntentError('intent_unavailable');
    return pinned;
  }
  if(intent.requireRoute)throw new ProxyIntentError('intent_unavailable');
  if(!preferred)return null;
  // No receipt eviction: it could make an old intent eligible on another account.
  if(sql.exec<{n:number}>('SELECT count(*) AS n FROM proxy_intent_routes').toArray()[0]!.n>=5000)throw new ProxyIntentError('intent_unavailable');
  sql.exec('INSERT INTO proxy_intent_routes (intent_id, purpose, connection, rail) VALUES (?, ?, ?, ?)',key,purpose,preferred.id,preferred.rail);
  return preferred;
};
