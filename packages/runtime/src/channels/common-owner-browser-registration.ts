import { commonOwnerAuthority } from '../identity/common-owner-authority';
import type { TelegramWebhookEnv } from './telegram-webhook';
import { commonPublicBrowserConfiguration } from './common-public-browser-configuration';
import { commonStagingRegistration } from './common-staging-registration';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';

const KEY = 'common_owner_browser_registration_v1';
type Pinned = Readonly<{ operator: string; custodyDigest: string; registration: Record<string, any> }>;

// Operator-supplied per-owner ceilings, not an account-wide allocation service.
// No policy means no automatic browser admission; existing ledgers are never reset.
export function commonOwnerBrowserRegistration(options: Readonly<{
  env: TelegramWebhookEnv; storage: DurableObjectStorage; actualDoId: string;
  loadSdk?: CloudflareBrowserSdkLoader;
}>) {
  const { env, storage, actualDoId } = options;
  let raw: any, invalid = false;
  if (env.WALDO_ENVIRONMENT === 'staging' && env.COMMON_BROWSER_REGISTRATION) {
    try { raw = JSON.parse(env.COMMON_BROWSER_REGISTRATION); } catch { invalid = true; }
  }
  // Broken operator input must deny new I/O without breaking host construction
  // or removing access to a previously funded cleanup obligation.
  const selected = invalid || raw?.scope === 'verified_owners';
  const operator = selected ? JSON.stringify(raw) : undefined;
  const directory = commonOwnerAuthority(env);
  const physical = () => {
    const doName = storage.kv.get<string>('do_name'), subject = storage.kv.get<string>('telegram_subject');
    if (!doName || !subject || storage.kv.get('telegram_unlinked') === true
      || env.TELEGRAM_OWNER_DO?.idFromName(doName).toString() !== actualDoId) throw Error('automatic browser owner unavailable');
    return { doName, subject };
  };
  const configuration = (registration: Record<string, any>, cleanupOnly: boolean) => {
    const registered = commonStagingRegistration({ WALDO_ENVIRONMENT: env.WALDO_ENVIRONMENT, COMMON_BROWSER_REGISTRATION: JSON.stringify(registration) });
    if (!registered) return undefined;
    return commonPublicBrowserConfiguration({ ...options, ...registered, cleanupOnly });
  };
  return {
    selected,
    hasRetained: () => storage.kv.get<Pinned>(KEY) !== undefined,
    async configuration(cleanupOnly = false) {
      const retained = storage.kv.get<Pinned>(KEY);
      // Revocation/expiry must not strand an already funded exact-session obligation.
      // Cleanup uses the retained registration only; it cannot grant or allocate.
      if (cleanupOnly) return retained ? configuration(retained.registration, true) : undefined;
      if (invalid) throw Error('automatic browser operator policy invalid');
      if (!selected) return undefined;
      const before = physical();
      const owner = await directory.resolve('telegram', before.subject, before.doName);
      const after = physical();
      if (!owner || owner.doName !== after.doName || owner.subject !== after.subject
        || JSON.stringify(before) !== JSON.stringify(after)) throw Error('automatic browser authority unavailable');
      const registration = { policy: { ...raw.policy, doName: after.doName, subject: after.subject,
        directoryOwnerId: owner.directoryOwnerId, ref: `${raw.policy?.ref}:owner:${owner.directoryOwnerId}` },
        spend: raw.spend, billing: raw.billing };
      if (!raw.policy?.ref || raw.policy.doName !== undefined || raw.policy.subject !== undefined
        || raw.policy.directoryOwnerId !== undefined) throw Error('automatic browser operator policy invalid');
      const config = configuration(registration, false);
      if (!config) throw Error('automatic browser configuration unavailable');
      const now = Date.now();
      if (now < registration.policy.createdAt || now >= registration.policy.expiresAt
        || now >= registration.spend.validUntil) throw Error('automatic browser operator policy expired');
      const pinned: Pinned = { operator: operator!, custodyDigest: owner.custodyDigest, registration };
      storage.transactionSync(() => {
        physical();
        const prior = storage.kv.get<Pinned>(KEY);
        if (prior && JSON.stringify(prior) !== JSON.stringify(pinned)) throw Error('automatic browser policy requires reconciliation');
        // A different registration cannot manufacture a fresh allowance beside
        // existing manual spend or orphan its exact-session cleanup obligations.
        if (!prior && ['common-spend:', 'common-public-browser-usage:', 'common-browser:']
          .some(prefix => [...storage.kv.list({ prefix })].length > 0)) throw Error('automatic browser prior policy requires reconciliation');
        if (!prior) storage.kv.put(KEY, pinned);
      });
      return config;
    },
  };
}
