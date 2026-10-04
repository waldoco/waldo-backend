import { browserBoundedJson, BrowserBodyError } from './browser-bounded-body';
import type { PresenceBinding } from '../identity/owner-message-admission';
import { ownerPresenceBinding } from '../identity/owner-message-admission';
import { BROWSER_AUTHORIZATION_KEY, parseBrowserOwnerAuthorization, type BrowserOwnerAuthorization } from './browser-owner-authority';
import type { BrowserTrialPolicy } from './browser-production-factory';
import { fixtureDigest, type FixtureManifest } from './public-fixture-browser';

export const BROWSER_TRIAL_PATH = '/console/browser/trial';
export const BROWSER_TRIAL_PENDING_KEY = 'browser_owner_trial_confirmation_v1';
export const BROWSER_TRIAL_REVOCATION_KEY = 'browser_owner_trial_revocation_v1';
const PENDING_KEY = BROWSER_TRIAL_PENDING_KEY;
export type BrowserTrialPreparation = Readonly<{ policy: BrowserTrialPolicy; manifest: FixtureManifest }>;
type Storage = Pick<DurableObjectStorage, 'kv' | 'transactionSync'>;
type Pending = Readonly<{ nonce: string; authorization: BrowserOwnerAuthorization; expiresAt: number }>;
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(status === 429 ? { 'retry-after': '30' } : {}) } });

// The caller has authenticated the owner's console session. Only trusted source
// policy supplies fixture/budget; confirmation cannot widen them or reset usage.
export async function browserTrialConsent(request: Request, options: Readonly<{
  storage: Storage; csrf: string; limiter?: RateLimit; ownerScope: string; trial?: BrowserTrialPreparation; lookup(): Promise<PresenceBinding>;
  doName: string; subject: string; now(): number; newId(): string;
}>): Promise<Response> {
  if (!options.trial) return reply({ error: 'not_configured' }, 404);
  const { storage, trial, now } = options;
  if (request.method !== 'GET' && request.method !== 'POST') return reply({ error: 'method_not_allowed' }, 405);
  if (!options.limiter) return reply({ error: 'unavailable' }, 503);
  try { if (!(await options.limiter.limit({ key: `browser-trial:${options.ownerScope}` })).success) return reply({ error: 'rate_limited' }, 429); }
  catch { return reply({ error: 'unavailable' }, 503); }
  try {
    const revocation = storage.kv.get(BROWSER_TRIAL_REVOCATION_KEY);
    if (request.method === 'POST' && request.headers.get('content-type')?.split(';')[0]?.trim() !== 'application/json') return reply({ error: 'invalid_confirmation' }, 415);
    const input = request.method === 'POST' ? await browserBoundedJson(request) as Record<string, unknown> : null;
    if (request.method === 'POST' && (!input || Array.isArray(input) || Object.keys(input).sort().join(',') !== 'csrf,nonce' || input.csrf !== options.csrf || typeof input.nonce !== 'string' || input.nonce.length > 100)) return reply({ error: 'invalid_confirmation' }, 403);
    const binding = ownerPresenceBinding(await options.lookup());
    if (binding.do_name !== options.doName || binding.subject !== options.subject || binding.do_name !== trial.policy.doName
      || trial.manifest.origin !== trial.policy.fixtureOrigin || new URL(trial.manifest.origin).protocol !== 'https:') return reply({ error: 'unavailable' }, 409);
    if (request.method === 'GET') {
      if (storage.kv.get(BROWSER_AUTHORIZATION_KEY) !== undefined) return reply({ error: 'already_decided' }, 409);
      const createdAt = now(), nonce = options.newId();
      const authorization = parseBrowserOwnerAuthorization({ version: 1, ref: `browser-confirm:${nonce}`, state: 'active', binding,
        manifest: trial.manifest, manifestDigest: await fixtureDigest(trial.manifest), createdAt, expiresAt: createdAt + 60_000,
        operations: ['navigate', 'extract', 'act'], budget: { maxAdmissions: 32, maxAllocations: 1, maxBrowserMs: 120_000 },
        usage: { authorizationRef: `browser-confirm:${nonce}`, admissions: 0, allocations: 0, reservedBrowserMs: 0 } });
      const current = ownerPresenceBinding(await options.lookup());
      if (JSON.stringify(current) !== JSON.stringify(binding)) return reply({ error: 'unavailable' }, 409);
      storage.transactionSync(() => {
        if (storage.kv.get(BROWSER_AUTHORIZATION_KEY) !== undefined || storage.kv.get(BROWSER_TRIAL_REVOCATION_KEY) !== revocation || now() >= createdAt + 60_000) throw Error('decision unavailable');
        storage.kv.put(PENDING_KEY, { nonce, authorization, expiresAt: createdAt + 60_000 } satisfies Pending);
      });
      return reply({ nonce, csrf: options.csrf, fixture: authorization.manifest, operations: authorization.operations, budget: authorization.budget,
        expires_at: authorization.expiresAt, message: 'Confirm one public fixture session for at most 60 seconds. Final submission needs a separate approval. No login or private cookies.' });
    }
    if (!input) return reply({ error: 'invalid_confirmation' }, 403);
    const digest = await fixtureDigest(trial.manifest);
    const current = ownerPresenceBinding(await options.lookup());
    const confirmed = storage.transactionSync(() => {
      const pending = storage.kv.get<Pending>(PENDING_KEY);
      if (storage.kv.get(BROWSER_TRIAL_REVOCATION_KEY) !== revocation || !pending || pending.nonce !== input.nonce || pending.expiresAt <= now() || storage.kv.get(BROWSER_AUTHORIZATION_KEY) !== undefined) return false;
      const authorization = parseBrowserOwnerAuthorization(pending.authorization);
      if (JSON.stringify(current) !== JSON.stringify(binding) || JSON.stringify(authorization.binding) !== JSON.stringify(binding)
        || authorization.ref !== `browser-confirm:${input.nonce}` || authorization.state !== 'active'
        || authorization.manifestDigest !== digest || JSON.stringify(authorization.manifest) !== JSON.stringify(trial.manifest)
        || authorization.createdAt > now() || authorization.expiresAt <= now()
        || authorization.usage.admissions !== 0 || authorization.usage.allocations !== 0 || authorization.usage.reservedBrowserMs !== 0) return false;
      storage.kv.put(BROWSER_AUTHORIZATION_KEY, authorization); storage.kv.delete(PENDING_KEY);
      return true;
    });
    return confirmed ? reply({ confirmed: true }) : reply({ error: 'stale_confirmation' }, 409);
  } catch (error) { return reply({ error: 'unavailable' }, error instanceof BrowserBodyError ? error.status : 409); }
}
