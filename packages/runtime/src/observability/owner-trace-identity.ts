import type { TurnLogEntry } from '../channels/owner-turn-types';

export type OwnerTraceIdentity = Readonly<{ owner_id: string; owner_email: string | null }>;
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

// Only the authenticated directory supplies this value. Chat text and connector accounts are not identity sources.
export const ownerTraceIdentity = (value: unknown): OwnerTraceIdentity | undefined => {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as Record<string, unknown>;
  if (typeof row.owner_id !== 'string' || !uuid.test(row.owner_id)) return undefined;
  const email = typeof row.owner_email === 'string' && row.owner_email.length <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.owner_email) ? row.owner_email.toLowerCase() : null;
  return Object.freeze({ owner_id: row.owner_id.toLowerCase(), owner_email: email });
};

export const OWNER_TRACE_HEADER = 'x-waldo-owner-trace';
export const readOwnerTraceHeader = (headers: Headers): OwnerTraceIdentity | undefined => {
  const value = headers.get(OWNER_TRACE_HEADER);
  if (!value || value.length > 2_000) return undefined;
  try { return ownerTraceIdentity(JSON.parse(decodeURIComponent(value))); } catch { return undefined; }
};

export const ownerTraceFields = (identity: OwnerTraceIdentity | undefined) => ({
  owner_id: identity?.owner_id ?? 'unknown',
  owner_email: identity?.owner_email ?? 'unknown',
  owner_identity: identity ? identity.owner_email ? 'verified' as const : 'email_unavailable' as const : 'unknown' as const,
});

type Occurrence = Readonly<{ updateId: number; doName: string; subject: string; traceIdentity?: OwnerTraceIdentity }>;
// Lookup is local and occurrence-bound: a newer inbound email must not relabel an older turn's delayed hops.
export const enrichOwnerTrace = (entry: TurnLogEntry, rows: readonly Occurrence[], doName: string, subject: string): TurnLogEntry => {
  const match = /^tg-(\d+)$/.exec(entry.trace);
  const row = match ? rows.find(row => row.updateId === Number(match[1]) && row.doName === doName && row.subject === subject) : undefined;
  return { ...entry, owner: doName || 'unresolved', ...ownerTraceFields(ownerTraceIdentity(row?.traceIdentity)) };
};

// What is persisted at rest follows the same capture switch as the sinks: owner_id stays, the email is dropped when capture is off.
export const identityForStorage = (identity: OwnerTraceIdentity | undefined, captureText: boolean): OwnerTraceIdentity | undefined =>
  identity && !captureText ? Object.freeze({ owner_id: identity.owner_id, owner_email: null }) : identity;
