import { ownerPresenceBinding, type PresenceBinding } from '../identity/owner-message-admission';
import type { BrowserOwnerGrantRequest } from './browser-owner-host';
import type { FixtureManifest } from './public-fixture-browser';

export const BROWSER_AUTHORIZATION_KEY = 'browser_owner_authorization_v1';
const USAGE_KEY = 'browser_owner_authority_usage_v1';
const REVOKED_KEY = 'browser_owner_task_revoked_v1';
export type BrowserOwnerAuthorization = Readonly<{
  version: 1; ref: string; state: 'active' | 'revoked'; binding: PresenceBinding;
  manifest: FixtureManifest; manifestDigest: string; createdAt: number; expiresAt: number;
  operations: readonly ('navigate' | 'extract' | 'act')[];
  budget: Readonly<{ maxAdmissions: number; maxAllocations: number; maxBrowserMs: number }>;
}>;
type Storage = Pick<DurableObjectStorage, 'kv' | 'transactionSync'>;
type Usage = { ref: string; admissions: number; allocations: number; reservedBrowserMs: number };
const integer = (value: unknown, min: number, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
const text = (value: unknown, max = 120): value is string => typeof value === 'string' && value.length > 0 && value.length <= max;
const digest = (value: unknown): value is string => typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
const object = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Reflect.ownKeys(value).some(key => typeof key !== 'string')
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !('value' in d))
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw Error('browser authority invalid');
  return value as Record<string, unknown>;
};
const parse = (value: unknown): BrowserOwnerAuthorization => {
  const r = object(value, ['version', 'ref', 'state', 'binding', 'manifest', 'manifestDigest', 'createdAt', 'expiresAt', 'operations', 'budget']);
  const binding = ownerPresenceBinding(r.binding);
  const manifest = object(r.manifest, ['origin', 'pagePath', 'submitPath', 'receiptPrefix', 'runId', 'fields', 'formSelector', 'submitSelector', 'resultSelector']);
  const budget = object(r.budget, ['maxAdmissions', 'maxAllocations', 'maxBrowserMs']);
  if (r.version !== 1 || !text(r.ref) || !['active', 'revoked'].includes(String(r.state)) || !digest(r.manifestDigest)
    || !integer(r.createdAt, 0, Number.MAX_SAFE_INTEGER) || !integer(r.expiresAt, r.createdAt + 1, Math.min(Number.MAX_SAFE_INTEGER, r.createdAt + 60000))
    || !Array.isArray(r.operations) || r.operations.length < 1 || r.operations.length > 3 || new Set(r.operations).size !== r.operations.length
    || r.operations.some(op => !['navigate', 'extract', 'act'].includes(op))
    || Object.entries(manifest).some(([key, value]) => key !== 'fields' && !text(value, 300))
    || !Array.isArray(manifest.fields) || manifest.fields.length < 1 || manifest.fields.length > 24 || manifest.fields.some(field => !text(field, 80))
    || !integer(budget.maxAdmissions, 1, 32) || !integer(budget.maxAllocations, 1, 1) || !integer(budget.maxBrowserMs, 1, 120000)) throw Error('browser authority invalid');
  return { ...(r as unknown as BrowserOwnerAuthorization), binding };
};
const sameBinding = (a: PresenceBinding, b: PresenceBinding) => Object.keys(a).every(key => a[key as keyof PresenceBinding] === b[key as keyof PresenceBinding]);

// Reads an authorization installed only by a future authenticated owner-confirmation
// handler. This adapter deliberately cannot create, refresh or widen that decision.
// Counters are reserved synchronously before provider I/O and never refunded on error.
export function browserOwnerAuthority(storage: Storage, now: () => number = Date.now) {
  const read = () => { try { return parse(storage.kv.get(BROWSER_AUTHORIZATION_KEY)); } catch { return undefined; } };
  const current = (expected: BrowserOwnerAuthorization, binding: PresenceBinding) => {
    const row = read(), time = now();
    return row && Number.isSafeInteger(time) && row.createdAt <= time && row.expiresAt > time && row.state === 'active'
      && storage.kv.get(REVOKED_KEY) !== row.manifest.runId && JSON.stringify(row) === JSON.stringify(parse(expected))
      && sameBinding(row.binding, binding) ? row : undefined;
  };
  const usage = (row: BrowserOwnerAuthorization): Usage => {
    const raw = storage.kv.get(USAGE_KEY);
    if (raw === undefined) return { ref: row.ref, admissions: 0, allocations: 0, reservedBrowserMs: 0 };
    const u = object(raw, ['ref', 'admissions', 'allocations', 'reservedBrowserMs']);
    if (u.ref !== row.ref || !integer(u.admissions, 0, row.budget.maxAdmissions) || !integer(u.allocations, 0, row.budget.maxAllocations)
      || !integer(u.reservedBrowserMs, 0, row.budget.maxBrowserMs)) throw Error('browser authority usage invalid');
    return u as unknown as Usage;
  };
  return {
    read,
    grant(request: BrowserOwnerGrantRequest, binding: PresenceBinding) {
      try { return storage.transactionSync(() => {
        const expected = read(); if (!expected) return null;
        const row = current(expected, binding); if (!row) return null;
        const owner = row.binding.owner_id.replaceAll('-', '').toLowerCase();
        const fields = { principal: `prn_${owner}`, tenant: `ten_${owner}`, doName: row.binding.do_name, presence: row.binding.presence_id,
          revision: row.binding.admission_revision, task: row.manifest.runId, manifest: row.manifestDigest, page: row.manifest.origin + row.manifest.pagePath };
        if (Object.entries(fields).some(([key, value]) => request[key as keyof BrowserOwnerGrantRequest] !== value)
          || !row.operations.includes(request.operation as 'navigate' | 'extract' | 'act')) return null;
        const evidence = request.evidence;
        if (!evidence || Object.getPrototypeOf(evidence) !== Object.prototype || Object.entries(evidence).some(([key, value]) =>
          ['actionDigest', 'bindingDigest', 'stateDigest'].includes(key) ? !digest(value) : ['proposalId', 'approvalRef'].includes(key) ? !text(value, 200) : true)
          || request.operation === 'act' && Object.keys(evidence).length > 0 && (!digest(evidence.actionDigest) || !digest(evidence.stateDigest))
          || evidence.approvalRef && (!text(evidence.proposalId, 200) || !digest(evidence.bindingDigest))) return null;
        const used = usage(row); if (used.admissions >= row.budget.maxAdmissions) return null;
        used.admissions++; storage.kv.put(USAGE_KEY, used);
        return { ...request, ref: `${row.ref}:${used.admissions}`, expiresAt: row.expiresAt };
      }); } catch { return null; }
    },
    reserveAllocation(expected: BrowserOwnerAuthorization, binding: PresenceBinding, lifetimeMs: number) {
      try { return storage.transactionSync(() => {
        const row = current(expected, binding); if (!row || !integer(lifetimeMs, 10000, 60000)) return false;
        const used = usage(row);
        // keep_alive is inactivity, not total lifetime. Reserve the task window
        // plus one full idle timeout for an unknown allocation/failed close.
        const reserve = lifetimeMs * 2;
        if (used.allocations >= row.budget.maxAllocations || used.reservedBrowserMs + reserve > row.budget.maxBrowserMs) return false;
        used.allocations++; used.reservedBrowserMs += reserve; storage.kv.put(USAGE_KEY, used); return true;
      }); } catch { return false; }
    },
  };
}
