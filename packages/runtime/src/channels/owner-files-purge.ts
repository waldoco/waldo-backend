// Account deletion removes an owner's stored files from the shared bucket before anything else is deleted, so a failure
// leaves the account intact and the deletion can simply be requested again. Every key an owner writes carries that owner's
// scope in a fixed prefix; a prefix must end in "/" so one owner's scope can never cover another's.
const DO_ID = /^[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SEGMENT = /^[a-zA-Z0-9_-]{1,240}$/;
const PAGE = 1000;
const MAX_LISTS_PER_PREFIX = 10;

// The artifact and export prefixes come from the Durable Object id. The workspace prefix comes from the binding the
// workspace manifest stores; no manifest, or a manifest that was never bound, means no workspace object was ever written.
// Returns null when a prefix cannot be named with certainty, which the caller must treat as "do not delete".
export const ownerFilePrefixes = (doId: string, sql: Pick<SqlStorage, 'exec'>): string[] | null => {
  if (!DO_ID.test(doId)) return null;
  const prefixes = [`artifacts/by-owner/${doId}/`, `artifacts/exports/by-owner/${doId}/`];
  if (sql.exec('SELECT name FROM sqlite_master WHERE type = ? AND name = ?', 'table', 'workspace_manifest').toArray().length === 0) return prefixes;
  const row = sql.exec<{ state_json: string }>('SELECT state_json FROM workspace_manifest WHERE singleton = 1').toArray()[0];
  if (!row) return prefixes;
  let binding: unknown;
  try { binding = (JSON.parse(row.state_json) as { binding?: unknown }).binding; } catch { return null; }
  if (binding === null || binding === undefined) return prefixes;
  const { ownerId, environment, namespace } = binding as Record<string, unknown>;
  if (typeof ownerId !== 'string' || !UUID.test(ownerId) || typeof environment !== 'string' || !SEGMENT.test(environment) || typeof namespace !== 'string' || !SEGMENT.test(namespace)) return null;
  return [...prefixes, `workspace/v1/${encodeURIComponent(environment)}/${encodeURIComponent(namespace)}/${ownerId}/`];
};

// True only when every prefix was listed empty after the deletes. Bounded: past MAX_LISTS_PER_PREFIX pages it reports
// false and a repeated request continues where this one stopped.
export const purgeOwnerFiles = async (bucket: R2Bucket | undefined, prefixes: readonly string[]): Promise<boolean> => {
  if (!bucket) return true;
  try {
    for (const prefix of prefixes) {
      if (prefix.length < 24 || !prefix.endsWith('/')) return false;
      let empty = false;
      for (let page = 0; page < MAX_LISTS_PER_PREFIX && !empty; page++) {
        const { objects } = await bucket.list({ prefix, limit: PAGE });
        if (objects.length === 0) empty = true;
        else await bucket.delete(objects.map(object => object.key));
      }
      if (!empty) return false;
    }
    return true;
  } catch { return false; }
};
