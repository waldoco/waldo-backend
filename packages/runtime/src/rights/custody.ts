import type { AppRightsInventoryV1 } from '../../../contracts/src/app/rights';
import { rightsDigest } from './capability';

export const RIGHTS_STORE_ROWS: AppRightsInventoryV1['stores'] = [
  { store: 'owner_runtime', export: 'included', deletion: 'managed', explanation: 'Owner conversation, memory and responsibility state; private security state is excluded from export.' },
  { store: 'directory', export: 'metadata_only', deletion: 'managed', explanation: 'Owner settings, connection/account metadata and session summaries. Credentials are excluded.' },
  { store: 'health_plane', export: 'separate_authority', deletion: 'managed', explanation: 'Raw health remains in the health plane. Deletion withdraws consent and purges mapped health rows; consent audit is retained.' },
  { store: 'workspace', export: 'included', deletion: 'managed', explanation: 'Owner workspace files include immutable revisions. Unconfirmed byte cleanup remains pending.' },
  { store: 'artifacts', export: 'included', deletion: 'managed', explanation: 'Owner artifact bodies and revision metadata are included; owner-scoped R2 bytes must be checked after deletion.' },
  { store: 'push_devices', export: 'metadata_only', deletion: 'managed', explanation: 'Installation, provider and epoch metadata only; push tokens stay in Vault and are revoked on deletion.' },
  { store: 'auth_identity', export: 'unavailable', deletion: 'managed', explanation: 'Final signed erasure removes the mapped Auth/public identity and verifies absence; minimal receipt and workspace custody audit remain.' },
  { store: 'audit', export: 'metadata_only', deletion: 'pending_verification', explanation: 'Minimal transaction and consent audit may be retained separately from personalization.' },
  { store: 'backups', export: 'unavailable', deletion: 'outside_control', explanation: 'Immutable backup retention and recovery erasure are not verified by this runtime.' },
  { store: 'external_providers', export: 'unavailable', deletion: 'outside_control', explanation: 'Already sent messages and provider-owned records are not erased by account deletion.' },
  { store: 'offline_devices', export: 'unavailable', deletion: 'outside_control', explanation: 'Offline app caches require local cleanup and acknowledgment; the server cannot certify those copies gone.' },
];
export const rightsInventory = async (): Promise<AppRightsInventoryV1> => ({ version: 'rights.v1', revision: await rightsDigest(JSON.stringify(RIGHTS_STORE_ROWS)), stores: structuredClone(RIGHTS_STORE_ROWS) });

// Export only product state. Never enumerate arbitrary DO fields, because auth,
// sealed handoffs and trace state share the same SQLite database.
const EXPORT_TABLES = [
  'claims', 'episodes', 'spots', 'constellation_nodes', 'constellation_edges', 'core_file_revisions', 'goals', 'loops', 'loop_mail_sources', 'responsibilities', 'responsibility_items', 'memory_blocks', 'memory_inbox', 'thread_topic_index', 'drafts', 'outcomes', 'missions', 'work_units', 'responsibility_projection', 'work_unit_planning_projection', 'standing_orders', 'reminder_notes', 'artifacts', 'artifact_exports', 'owner_files', 'day_plan', 'card_pins', 'update_cards', 'event_briefs', 'proactivity', 'schedule_preferences',
  'owner_personal_day', 'owner_proactivity_policy', 'owner_proactivity_access', 'owner_proactivity_sweep', 'owner_proactivity_coverage', 'owner_proactivity_observation', 'owner_proactivity_watch', 'owner_proactivity_wake', 'owner_proactivity_delivery', 'owner_proactivity_adapter',
] as const;
export const exportOwnerRuntime = (sql: SqlStorage): Readonly<Record<string, readonly Record<string, unknown>[]>> => {
  const tables = new Set(sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").toArray().map(row => row.name));
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of EXPORT_TABLES) {
    if (!tables.has(table)) continue;
    const rows = sql.exec<Record<string, SqlStorageValue>>(`SELECT * FROM "${table}"`).toArray();
    // SQL identifiers come only from the source-owned table allowlist.
    out[table] = rows.map(row => Object.fromEntries(Object.entries(row).filter(([column]) => !['r2_key', 'secret_id', 'session_hash', 'credential', 'token', 'sealed_payload', 'csrf'].includes(column))));
  }
  return out;
};

export type ScopedBucket = Pick<R2Bucket, 'list' | 'delete'>;
// Prefixes are derived from the immutable DO identity, never a client path. Delete
// all revisions plus failed-write orphans, then independently list for absence.
export const purgeOwnerR2 = async (bucket: ScopedBucket, ownerScope: string, prefixes: readonly ('artifacts/by-owner/' | 'artifacts/exports/by-owner/')[] = ['artifacts/by-owner/', 'artifacts/exports/by-owner/']): Promise<void> => {
  if (!ownerScope.trim()) throw new Error('rights_unavailable');
  for (const base of prefixes) {
    const prefix = `${base}${encodeURIComponent(ownerScope)}/`;
    let cursor: string | undefined; const seen = new Set<string>();
    do {
      const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
      if (page.objects.some(object => !object.key.startsWith(prefix))) throw new Error('rights_unavailable');
      if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
      if (page.truncated && !page.cursor) throw new Error('rights_unconfirmed');
      cursor = page.truncated ? page.cursor : undefined;
      if (cursor) { if (seen.has(cursor)) throw new Error('rights_unconfirmed'); seen.add(cursor); }
    } while (cursor);
    const remaining = await bucket.list({ prefix, limit: 1 });
    if (remaining.objects.length || remaining.truncated) throw new Error('rights_unconfirmed');
  }
};


export const purgeWorkspaceR2 = async (bucket: ScopedBucket, binding: { environment: string; namespace: string; ownerId: string; doName: string; doId: string }, expected: { doName: string; doId: string }): Promise<void> => {
  if (binding.doName !== expected.doName || binding.doId !== expected.doId || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(binding.ownerId) || !binding.environment || !binding.namespace) throw new Error('rights_unavailable');
  const prefix = `workspace/v1/${encodeURIComponent(binding.environment)}/${encodeURIComponent(binding.namespace)}/${binding.ownerId}/`;
  let cursor: string | undefined; const seen = new Set<string>();
  do {
    const page = await bucket.list({ prefix, limit: 1000, ...(cursor ? { cursor } : {}) });
    if (page.objects.some(object => !object.key.startsWith(prefix))) throw new Error('rights_unavailable');
    if (page.objects.length) await bucket.delete(page.objects.map(object => object.key));
    if (page.truncated && !page.cursor) throw new Error('rights_unconfirmed');
    cursor = page.truncated ? page.cursor : undefined;
    if (cursor) { if (seen.has(cursor)) throw new Error('rights_unconfirmed'); seen.add(cursor); }
  } while (cursor);
  const remaining = await bucket.list({ prefix, limit: 1 });
  if (remaining.objects.length || remaining.truncated) throw new Error('rights_unconfirmed');
};
