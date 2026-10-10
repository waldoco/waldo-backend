import { APP_ACCESS_MAX_REQUEST_BYTES, APP_ONBOARDING_STEPS, appAccessAccountsV1Schema, appAccessReceiptV1Schema, appConnectV1Schema, appDisconnectV1Schema, appForgetDerivedV1Schema, appOnboardingUpdateV1Schema, appProfileSaveV1Schema, appProfileV1Schema, appServerSessionsV1Schema, appSessionRevokeV1Schema, type AppAccessReceiptV1, type AppAccessAccountsV1, type AppConnectV1, type AppOnboardingV1, type AppProfileV1, type AppServerSessionsV1 } from '../../../contracts/src/app/access';
import { GOOGLE_FEATURE_SCOPES, googleHas } from '../connectors/google';
import { RightsError } from '../rights/jobs';
import { rightsDigest } from '../rights/capability';

export type AppAccessStorage = { get<T>(key: string): T | undefined; put<T>(key: string, value: T): void };
type Setup = { revision: number; steps: Partial<Record<typeof APP_ONBOARDING_STEPS[number], 'visited' | 'skipped'>> };
type Operation = { digest: string; session: string; receipt: AppAccessReceiptV1 };
export type AppAccessHost = {
  accountRef: string; sessionHash: string; storage: AppAccessStorage; now(): number; assertCurrent(): Promise<void>; rateLimit(): Promise<boolean>;
  commit<T>(work: () => T): T;
  // Run within commit: apply the new profile to runtime planning/context and bump
  // the source epoch so an already composed turn cannot retain stale preferences.
  profileChanged(profile: AppProfileV1): void;
  googleConfigured(): boolean;
  sourceRevision(): number;
  googleAccounts(): Promise<readonly { id: string; email: string; scopes: readonly string[] | null; error: string | null }[]>;
  connect(args: AppConnectV1): Promise<{ url: string; expires_at: number; connection_ref: string | null } | null>;
  disconnect(connectionRef: string): Promise<boolean>;
  forgetDerived(connectionRef: string, expectedSourceRevision: number): Promise<'recorded' | 'unconfirmed' | 'rejected'>;
  sessions(): Promise<AppServerSessionsV1['sessions']>;
  // Revoke server push first, then the canonical session; return true only when
  // both are settled. Listing sessions never discloses the ambient credential.
  revokeSession(sessionRef: string): Promise<boolean>;
  onboardingEvidence(): Promise<{ firstValueRef: string | null; steps: Partial<Record<typeof APP_ONBOARDING_STEPS[number], string>> }>;
};
const PROFILE_KEY = 'app:profile.v1', SETUP_KEY = 'app:onboarding.v1';
const features = Object.keys(GOOGLE_FEATURE_SCOPES) as (keyof typeof GOOGLE_FEATURE_SCOPES)[];
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' } });
const read = async <T>(request: Request, schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } }): Promise<T> => {
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/json') || !request.body) throw new RightsError('invalid');
  const reader = request.body.getReader(), parts: Uint8Array[] = []; let size = 0, expired = false;
  const deadline = setTimeout(() => { expired = true; void reader.cancel(); }, 5000);
  try { while (true) { const part = await reader.read(); if (expired) throw new RightsError('unavailable'); if (part.done) break; size += part.value.byteLength; if (size > APP_ACCESS_MAX_REQUEST_BYTES) { await reader.cancel(); throw new RightsError('invalid'); } parts.push(part.value); } } finally { clearTimeout(deadline); reader.releaseLock(); }
  const bytes = new Uint8Array(size); let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
  let value: unknown; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)); } catch { throw new RightsError('invalid'); }
  const parsed = schema.safeParse(value); if (!parsed.success) throw new RightsError('invalid'); return parsed.data;
};
export const appStoredProfile = (host: Pick<AppAccessHost, 'storage' | 'accountRef'>): AppProfileV1 => {
  const saved = host.storage.get<unknown>(PROFILE_KEY);
  if (saved !== undefined) { const parsed = appProfileV1Schema.safeParse(saved); if (!parsed.success || parsed.data.account_ref !== host.accountRef) throw new RightsError('unavailable'); return parsed.data; }
  return { version: 'access.v1', account_ref: host.accountRef, revision: 0, updated_at: null, preferences: {}, source: 'explicit_owner', authority: 'preferences_only' };
};
// This owner-stated context has no derived physiology or effect authority. The
// composer still stamps the authenticated owner/source epoch before model use.
export const appProfileContext = (profile: AppProfileV1): string => JSON.stringify({ version: 'owner-profile.v1', revision: profile.revision, source: profile.source, preferences: profile.preferences, authority: profile.authority });
const setup = (host: AppAccessHost): Setup => host.storage.get<Setup>(SETUP_KEY) ?? { revision: 0, steps: {} };
const profileSteps: Partial<Record<typeof APP_ONBOARDING_STEPS[number], keyof AppProfileV1['preferences']>> = { name: 'name', day: 'day_type', goals: 'goals', wake: 'wake_time', bedtime: 'bedtime', peak: 'peak', stress: 'stress_signs', caffeine: 'caffeine', profession: 'profession', autonomy: 'autonomy_preference', 'connect-watch': 'wearable_preference', 'signal-depth': 'health_interest' };
const onboarding = async (host: AppAccessHost): Promise<AppOnboardingV1> => {
  const profile = appStoredProfile(host), stored = setup(host), evidence = await host.onboardingEvidence(); await host.assertCurrent();
  return { version: 'onboarding.v1', revision: stored.revision, setup_state: evidence.firstValueRef ? 'first_value_observed' : profile.revision || stored.revision ? 'in_progress' : 'new', required_steps: [],
    steps: APP_ONBOARDING_STEPS.map(step => { const field = profileSteps[step], saved = field !== undefined && profile.preferences[field] !== undefined; return { step, state: evidence.steps[step] ? 'observed' : saved ? 'saved' : stored.steps[step] ?? 'not_recorded', evidence_ref: evidence.steps[step] ?? null }; }),
    first_value: { state: evidence.firstValueRef ? 'observed' : 'pending', evidence_ref: evidence.firstValueRef } };
};
const queues = new WeakMap<object, Promise<unknown>>();
const serialized = async <T>(storage: object, work: () => Promise<T>) => { const next = (queues.get(storage) ?? Promise.resolve()).catch(() => undefined).then(work); queues.set(storage, next); try { return await next; } finally { if (queues.get(storage) === next) queues.delete(storage); } };
export const appAccessRequest = async (request: Request, host: AppAccessHost): Promise<Response | null> => {
  const url = new URL(request.url), path = url.pathname;
  if (path !== '/app/v1/profile' && path !== '/app/v1/onboarding' && !path.startsWith('/app/v1/access/')) return null;
  try {
    if (url.search || request.method !== 'GET' && request.method !== 'POST') throw new RightsError('invalid');
    const origin = request.headers.get('origin'); if (request.method === 'POST' && origin !== null && origin !== url.origin) throw new RightsError('rejected');
    if (!await host.rateLimit()) return json({ error: 'rate_limited' }, 429);
    await host.assertCurrent();
    if (request.method === 'GET') {
      let value: unknown;
      if (path === '/app/v1/profile') value = appStoredProfile(host);
      else if (path === '/app/v1/onboarding') value = await onboarding(host);
      else if (path === '/app/v1/access/catalog') value = { version: 'access.v1', connectors: [{ provider: 'google', configured: host.googleConfigured(), multiple_accounts: true, features: features.map(feature => ({ feature, read: 'source_capability', effect_authority: 'separate_approval' })) }] };
      else if (path === '/app/v1/access/accounts') { const accounts = await host.googleAccounts(); value = appAccessAccountsV1Schema.parse({ version: 'access.v1', source_revision: host.sourceRevision(), accounts: accounts.map(row => ({ connection_ref: row.id, provider: 'google', email: row.email, state: row.error ? 'reauth_required' : 'connected', grants: features.map(feature => ({ feature, read: googleHas(row.scopes, feature) ? row.error ? 'reauth_required' : 'granted' : 'missing', effect_authority: 'separate_approval' })) })) } satisfies AppAccessAccountsV1); }
      else if (path === '/app/v1/access/sessions') value = appServerSessionsV1Schema.parse({ version: 'access.v1', sessions: await host.sessions() });
      else { const id = /^\/app\/v1\/access\/operations\/([A-Za-z0-9_-]{8,64})$/.exec(path)?.[1]; if (!id) return json({ error: 'not_found' }, 404); const row = host.storage.get<Operation>(`app:access.operation:${id}`); if (!row) throw new RightsError('not_found'); value = row.receipt; }
      await host.assertCurrent(); return json(value);
    }
    const schema = path === '/app/v1/profile' ? appProfileSaveV1Schema : path === '/app/v1/onboarding' ? appOnboardingUpdateV1Schema : path === '/app/v1/access/connect' ? appConnectV1Schema : path === '/app/v1/access/disconnect' ? appDisconnectV1Schema : path === '/app/v1/access/forget-derived' ? appForgetDerivedV1Schema : path === '/app/v1/access/sessions/revoke' ? appSessionRevokeV1Schema : null;
    if (!schema) return json({ error: 'not_found' }, 404);
    const args = await read(request, schema as { safeParse(value: unknown): { success: true; data: { operation_id: string } } | { success: false } });
    return await serialized(host.storage, async () => {
      await host.assertCurrent(); const digest = await rightsDigest(JSON.stringify([path, args])), key = `app:access.operation:${args.operation_id}`;
      await host.assertCurrent();
      const prior = host.storage.get<Operation>(key); if (prior) { if (prior.digest !== digest || prior.session !== host.sessionHash) throw new RightsError('conflict'); return json(prior.receipt); }
      const kind: AppAccessReceiptV1['kind'] = path === '/app/v1/profile' ? 'profile' : path === '/app/v1/onboarding' ? 'onboarding' : path === '/app/v1/access/connect' ? 'connect' : path === '/app/v1/access/disconnect' ? 'disconnect' : path === '/app/v1/access/forget-derived' ? 'forget_derived' : 'session_revoke';
      const receipt: AppAccessReceiptV1 = { version: 'access.v1', operation_id: args.operation_id, kind, state: 'unconfirmed', revision: null, recorded_at: host.now(), authority: 'authenticated_owner', handoff: null };
      if (kind === 'profile') {
        const saved = appProfileSaveV1Schema.parse(args), previous = appStoredProfile(host); if (saved.expected_revision !== previous.revision) throw new RightsError('conflict');
        if (saved.preferences.timezone !== undefined) { try { new Intl.DateTimeFormat('en', { timeZone: saved.preferences.timezone }).format(); } catch { throw new RightsError('invalid'); } }
        const profile: AppProfileV1 = { ...previous, preferences: saved.preferences, revision: previous.revision + 1, updated_at: host.now() };
        receipt.state = 'recorded'; receipt.revision = profile.revision;
        await host.assertCurrent(); host.commit(() => { host.storage.put(PROFILE_KEY, profile); host.profileChanged(profile); host.storage.put(key, { digest, session: host.sessionHash, receipt }); });
      } else if (kind === 'onboarding') {
        const saved = appOnboardingUpdateV1Schema.parse(args), previous = setup(host); if (saved.expected_revision !== previous.revision) throw new RightsError('conflict');
        const next: Setup = { revision: previous.revision + 1, steps: { ...previous.steps, [saved.step]: saved.disposition === 'visit' ? 'visited' : 'skipped' } }; receipt.state = 'recorded'; receipt.revision = next.revision;
        await host.assertCurrent(); host.commit(() => { host.storage.put(SETUP_KEY, next); host.storage.put(key, { digest, session: host.sessionHash, receipt }); });
      } else {
        // Persist intent before network I/O. A lost response remains unconfirmed
        // and replay/readback never dispatches that operation again.
        await host.assertCurrent(); host.commit(() => host.storage.put(key, { digest, session: host.sessionHash, receipt }));
        try {
          if (kind === 'connect') { const saved = appConnectV1Schema.parse(args); if (saved.connection_ref && !(await host.googleAccounts()).some(row => row.id === saved.connection_ref)) throw new RightsError('rejected'); await host.assertCurrent(); const ticket = await host.connect(saved); if (ticket) { const target = new URL(ticket.url); if (target.origin !== url.origin || !/^\/c\/[A-Za-z0-9_-]{22}$/.test(target.pathname) || target.search || target.hash || ticket.expires_at <= host.now() || saved.mode === 'reauth' && ticket.connection_ref !== saved.connection_ref) throw new RightsError('unavailable'); receipt.state = 'recorded'; receipt.handoff = { ...ticket, origin: target.origin }; } }
          else if (kind === 'disconnect') { const saved = appDisconnectV1Schema.parse(args); if (!(await host.googleAccounts()).some(row => row.id === saved.connection_ref)) throw new RightsError('rejected'); await host.assertCurrent(); receipt.state = await host.disconnect(saved.connection_ref) ? 'recorded' : 'rejected'; }
          else if (kind === 'forget_derived') { const saved = appForgetDerivedV1Schema.parse(args); if (!(await host.googleAccounts()).some(row => row.id === saved.connection_ref) || host.sourceRevision() !== saved.expected_source_revision) throw new RightsError('rejected'); await host.assertCurrent(); receipt.state = await host.forgetDerived(saved.connection_ref, saved.expected_source_revision); }
          else { const saved = appSessionRevokeV1Schema.parse(args); if (!(await host.sessions()).some(row => row.session_ref === saved.session_ref)) throw new RightsError('rejected'); await host.assertCurrent(); receipt.state = await host.revokeSession(saved.session_ref) ? 'recorded' : 'unconfirmed'; }
        } catch (error) { receipt.state = error instanceof RightsError && error.code === 'rejected' ? 'rejected' : 'unconfirmed'; }
        // A revoked current session cannot perform normal writes; preserve the
        // already admitted receipt via the host's operation custody commit.
        if (kind !== 'session_revoke') await host.assertCurrent();
        host.commit(() => host.storage.put(key, { digest, session: host.sessionHash, receipt }));
      }
      return json(appAccessReceiptV1Schema.parse(receipt));
    });
  } catch (error) { const code = error instanceof RightsError ? error.code : 'unavailable'; return json({ error: `access_${code}` }, code === 'invalid' ? 400 : code === 'rejected' ? 403 : code === 'conflict' ? 409 : code === 'not_found' ? 404 : 503); }
};
