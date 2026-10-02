import type { ConsoleAuth } from '../identity/console-auth';
import { inviteLink, newInviteCode } from '../identity/invite-code';
import { parseConsoleAction } from './console';
import { controlRevision } from './dashboard-control-actions';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';

export const OWNER_CONTROLS_PATH = '/console/dashboard/api/v1/owner';
export const OWNER_CONTROLS_ACTION_PATH = `${OWNER_CONTROLS_PATH}/actions`;
export type OwnerControlsView = 'invites' | 'account';
type Auth = Pick<ConsoleAuth, 'memberInvites' | 'memberInvite' | 'deleteOwner'>;
type Store = { get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> };
export type OwnerControlsDeps = {
  owner: string; csrf: string; expires: number; auth: Auth | null; requestUrl: string; store: Store;
  sessions(): Promise<readonly { csrf: string; expires: number }[]>;
  eraseOwnerStorage(): Promise<void>;
};
type Receipt = { state: 'recorded' | 'incomplete' | 'rejected' | 'unconfirmed'; message: string; signed_out?: boolean };
type Stored = { fingerprint: string; expires: number; status: number; receipt: Receipt };
const reply = (value: object, status = 200) => Response.json(value, { status, headers: DASHBOARD_OVERVIEW_HEADERS });
const unavailable = () => reply({ error: 'owner_controls_unavailable' }, 503);
const unknown: Receipt = { state: 'unconfirmed', message: 'The outcome is unconfirmed. Inspect your invite history or account state before any new request. This request will not run again.' };
const inviteRecorded: Receipt = { state: 'recorded', message: 'Invite issuance was recorded. Its one-time code cannot be recovered or resent. Waldo did not email anyone.' };

async function projection(view: OwnerControlsView, deps: OwnerControlsDeps) {
  if (!deps.auth || !deps.owner) return null;
  const data = view === 'account' ? { deletion_available: true } : await (async () => {
    const rows = await deps.auth!.memberInvites(deps.owner);
    if (!Array.isArray(rows)) throw new Error('Invite read unavailable.');
    return {
      issued: rows.length, limit: 5, creation_available: rows.length < 5, expiry_days: 14,
      invites: rows.map(row => ({ email: row.email, created_at: row.created_at, expires_at: row.expires_at, used_at: row.used_at, revoked_at: row.revoked_at })),
    };
  })();
  return { version: 1 as const, view, state: 'available' as const, csrf: deps.csrf, data };
}
export function ownerControlsView(query: URLSearchParams): OwnerControlsView | null {
  if ([...query.keys()].some(key => key !== 'view') || query.getAll('view').length !== 1) return null;
  const view = query.get('view');
  return view === 'invites' || view === 'account' ? view : null;
}
export async function ownerControlsRead(view: OwnerControlsView, deps: OwnerControlsDeps): Promise<Response> {
  try {
    const value = await projection(view, deps);
    return value ? reply({ ...value, revision: await controlRevision(value) }) : unavailable();
  } catch { return unavailable(); }
}

// The authenticated owner DO serializes this operation. Only content-free receipts
// survive a request: raw invite codes and signup links never enter the durable journal.
export async function ownerControlsAction(form: FormData, deps: OwnerControlsDeps): Promise<Response> {
  const fields = ['csrf', 'action', 'value', 'view', 'revision', 'request_id', 'confirmation'];
  if ([...form.keys()].some(key => !fields.includes(key) || form.getAll(key).length !== 1) || [...form.values()].some(value => typeof value !== 'string' || value.length > 4096)) return reply({ error: 'invalid_action' }, 400);
  const action = parseConsoleAction(form, deps.csrf), view = form.get('view');
  if (!action || !((view === 'invites' && action.action === 'invite.member') || (view === 'account' && action.action === 'account.delete'))) return reply({ error: 'invalid_action' }, 403);
  if (action.action === 'account.delete' && form.get('confirmation') !== 'DELETE') return reply({ error: 'confirmation_required' }, 400);
  const requestId = String(form.get('request_id') ?? '');
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(requestId)) return reply({ error: 'request_id_required' }, 400);
  if (!deps.auth || !deps.owner) return unavailable();
  const fingerprint = await controlRevision({ action, view, revision: form.get('revision') });
  const session = await controlRevision(deps.csrf), key = `${session}:${requestId}`;
  const book = await deps.store.get<Record<string, Stored>>('console:owner-control-receipts') ?? {};
  const live = new Map(await Promise.all((await deps.sessions()).map(async row => [await controlRevision(row.csrf), row.expires] as const)));
  for (const [id, row] of Object.entries(book)) {
    const renewed = live.get(id.split(':')[0]!);
    if (renewed !== undefined && renewed > row.expires) row.expires = renewed;
    if (row.expires < Date.now()) delete book[id];
  }
  const previous = book[key];
  if (previous) return previous.fingerprint === fingerprint ? reply({ receipt: previous.receipt, duplicate: true }, previous.status) : reply({ error: 'request_reused' }, 409);
  if (Object.keys(book).filter(id => id.startsWith(`${session}:`)).length >= 100 || Object.keys(book).length >= 1000) return reply({ error: 'receipt_capacity' }, 429);
  let current;
  try { current = await projection(view as OwnerControlsView, deps); } catch { return unavailable(); }
  if (!current) return unavailable();
  if (await controlRevision(current) !== form.get('revision')) return reply({ error: 'stale_read' }, 409);
  if (view === 'invites' && 'creation_available' in current.data && !current.data.creation_available) return reply({ error: 'quota_exhausted' }, 409);
  book[key] = { fingerprint, expires: deps.expires, status: 503, receipt: unknown };
  await deps.store.put('console:owner-control-receipts', book);
  let receipt: Receipt = unknown, status = 503;
  if (action.action === 'invite.member') {
    const code = newInviteCode();
    let done;
    try { done = await deps.auth.memberInvite(deps.owner, action.value, code); } catch { return reply({ receipt: unknown, duplicate: false }, 503); }
    receipt = done ? inviteRecorded : { state: 'rejected', message: 'Invite creation was not applied. Review quota, recipient eligibility and existing invites; no email was sent.' };
    status = done ? 200 : 409;
    book[key] = { fingerprint, expires: deps.expires, status, receipt };
    try { await deps.store.put('console:owner-control-receipts', book); } catch { return reply({ receipt: unknown, duplicate: false }, 503); }
    return reply({ receipt, duplicate: false, ...(done ? { invite: { email: action.value, code, link: inviteLink(deps.requestUrl, action.value, code), expiry_days: 14 } } : {}) }, status);
  }
  try {
    const deleted = await deps.auth.deleteOwner(deps.owner);
    if (!deleted) {
      receipt = { state: 'rejected', message: 'Account removal was not applied. Refresh your account state before trying again.' }; status = 409;
      book[key] = { fingerprint, expires: deps.expires, status, receipt };
      await deps.store.put('console:owner-control-receipts', book);
      return reply({ receipt, duplicate: false }, status);
    }
  } catch { return reply({ receipt: unknown, duplicate: false }, 503); }
  // Never recreate owner storage just to retain a success receipt after deleteAll.
  try {
    await deps.eraseOwnerStorage();
    return reply({ receipt: { state: 'recorded', signed_out: true, message: 'Account removal was recorded and this console is signed out. The owner directory and local owner storage were removed; this receipt does not verify that every retained copy or file byte has been purged.' }, duplicate: false });
  } catch {
    return reply({ receipt: { state: 'incomplete', signed_out: true, message: 'Owner-directory removal was recorded, but local owner-storage removal could not be confirmed. This console is signed out. Retained copies or file bytes are not certified purged.' }, duplicate: false }, 503);
  }
}
