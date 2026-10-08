import { browserBoundedJson, BrowserBodyError } from './browser-bounded-body';
import type { BrowserStateBinding } from './browser-state-custody';

export const PRIVATE_BROWSER_CONSENT_KEY = 'browser_saved_signin_consent_v1';
export type PrivateBrowserConsent = Readonly<{ binding: BrowserStateBinding; custodyDigest: string; expiresAt: number; state: 'approved' | 'retiring' | 'revoked'; revision: string }>;
type Pending = Readonly<{ nonce: string; approval: PrivateBrowserConsent; previousRevision: string | null; expiresAt: number }>;
const pendingKey = `${PRIVATE_BROWSER_CONSENT_KEY}:pending`;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });

// The caller supplies an authenticated console session and trusted site/account
// policy. Public trial consent never grants persistent private-state permission.
export async function privateBrowserConsent(request: Request, options: Readonly<{
  storage: DurableObjectStorage; csrf: string; binding: Omit<BrowserStateBinding, 'generation'>; expiresAt: number;
  now(): number; newId(): string; assertOwner(): Promise<string>;
  retire(approval: PrivateBrowserConsent): Promise<void>;
}>): Promise<Response> {
  options = Object.freeze({ ...options, binding: Object.freeze({ ...options.binding }) });
  const { storage, now } = options;
  const read = () => storage.kv.get<PrivateBrowserConsent>(PRIVATE_BROWSER_CONSENT_KEY);
  const sameScope = (row: PrivateBrowserConsent) => Object.entries(options.binding).every(([key, value]) => row.binding[key as keyof BrowserStateBinding] === value);
  try {
    if (request.method !== 'GET' && request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
    const custodyDigest = await options.assertOwner();
    if (!custodyDigest) throw Error('owner unavailable');
    const previous = read();
    if (previous && !sameScope(previous)) throw Error('consent unavailable');
    if (request.method === 'GET') {
      if (previous && (previous.custodyDigest !== custodyDigest || previous.state === 'retiring')) throw Error('consent unavailable');
      if (!Number.isSafeInteger(options.expiresAt) || options.expiresAt <= now()) throw Error('policy expired');
      const nonce = options.newId(), generation = (previous?.binding.generation ?? 0) + 1;
      if (!Number.isSafeInteger(generation)) throw Error('generation exhausted');
      const approval: PrivateBrowserConsent = { binding: { ...options.binding, generation }, custodyDigest, expiresAt: options.expiresAt, state: 'approved', revision: options.newId() };
      if (await options.assertOwner() !== custodyDigest) throw Error('owner changed');
      storage.transactionSync(() => {
        if (read()?.revision !== previous?.revision) throw Error('decision changed');
        storage.kv.put(pendingKey, { nonce, approval, previousRevision: previous?.revision ?? null, expiresAt: Math.min(now() + 60000, options.expiresAt) } satisfies Pending);
      });
      return reply({ nonce, csrf: options.csrf, site: approval.binding.siteOrigin, account: approval.binding.accountId, generation, expires_at: approval.expiresAt,
        message: 'Save this account sign-in in encrypted owner-scoped storage until expiry. Renewal retires prior saved state and requires signing in again. Browser spend allowance stays unchanged.' });
    }
    if (request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return reply({ error: 'invalid_confirmation' }, 415);
    const input = await browserBoundedJson(request) as Record<string, unknown>;
    if (!input || Array.isArray(input) || input.csrf !== options.csrf) return reply({ error: 'invalid_confirmation' }, 403);
    if (input.action === 'revoke' && Object.keys(input).sort().join(',') === 'action,csrf') {
      if (!previous) return reply({ revoked: true });
      const retiring = storage.transactionSync(() => {
        if (read()?.revision !== previous.revision) throw Error('decision changed');
        const row: PrivateBrowserConsent = { ...previous, state: 'retiring', revision: options.newId() };
        storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, row); storage.kv.delete(pendingKey); return row;
      });
      await options.retire(previous);
      if (await options.assertOwner() !== custodyDigest) throw Error('owner changed');
      storage.transactionSync(() => {
        if (read()?.revision !== retiring.revision) throw Error('decision changed');
        storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, { ...retiring, state: 'revoked' });
      });
      return reply({ revoked: true, remote_logout: 'not_attempted' });
    }
    if (input.action !== 'confirm' || Object.keys(input).sort().join(',') !== 'action,csrf,nonce' || typeof input.nonce !== 'string') return reply({ error: 'invalid_confirmation' }, 403);
    if (previous && (previous.custodyDigest !== custodyDigest || previous.state === 'retiring')) throw Error('consent unavailable');
    if (await options.assertOwner() !== custodyDigest) throw Error('owner changed');
    const pending = storage.transactionSync(() => {
      const proposal = storage.kv.get<Pending>(pendingKey);
      if (!proposal || proposal.nonce !== input.nonce || proposal.expiresAt <= now() || proposal.approval.expiresAt <= now()
        || proposal.previousRevision !== (read()?.revision ?? null) || !sameScope(proposal.approval) || proposal.approval.custodyDigest !== custodyDigest
        || proposal.approval.expiresAt !== options.expiresAt || proposal.approval.binding.generation !== (previous?.binding.generation ?? 0) + 1) throw Error('confirmation stale');
      storage.kv.delete(pendingKey);
      if (previous) storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, { ...previous, state: 'retiring', revision: proposal.approval.revision });
      return proposal;
    });
    if (previous) await options.retire(previous);
    if (await options.assertOwner() !== custodyDigest) throw Error('owner changed');
    storage.transactionSync(() => {
      if (previous ? read()?.revision !== pending.approval.revision || read()?.state !== 'retiring' : read() !== undefined) throw Error('decision changed');
      if (pending.approval.expiresAt <= now()) throw Error('policy expired');
      storage.kv.put(PRIVATE_BROWSER_CONSENT_KEY, pending.approval);
    });
    return reply({ confirmed: true, generation: pending.approval.binding.generation });
  } catch (error) { return reply({ error: 'consent_unavailable' }, error instanceof BrowserBodyError ? error.status : 409); }
}
