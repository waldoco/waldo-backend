import { commonOwnerAuthority } from '../identity/common-owner-authority';
import type { TelegramWebhookEnv } from './telegram-webhook';
import { assertCommonPublicBrowserUsage, commonPublicBrowserConfiguration } from './common-public-browser-configuration';
import { commonSpendReservation } from './common-spend-reservation';
import { COMMON_BROWSER_MONTH_CEILING_MICROUSD, commonStagingRegistration } from './common-staging-registration';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';

const KEY = 'common_owner_browser_registration_v1';
type Pinned = Readonly<{ operator: string; custodyDigest: string; registration: Record<string, any> }>;

// Expiry renewal preserves prior effects and old grants. A first acceptance
// capsule only tightens admission; live/uncertain sessions forbid either change.
function renewExpiry(storage: DurableObjectStorage, prior: Pinned, next: Pinned) {
  const priorOperator = JSON.parse(prior.operator), nextOperator = JSON.parse(next.operator);
  const firstAcceptance = priorOperator.acceptance === undefined && prior.registration.acceptance === undefined && nextOperator.acceptance !== undefined;
  const withoutExpiry = (value: any) => {
    const copy = structuredClone(value);
    delete copy.policy.expiresAt; delete copy.spend.validUntil;
    if (firstAcceptance) delete copy.acceptance;
    return JSON.stringify(copy);
  };
  const old = prior.registration, fresh = next.registration;
  if (prior.custodyDigest !== next.custodyDigest
    || withoutExpiry(priorOperator) !== withoutExpiry(nextOperator)
    || withoutExpiry(old) !== withoutExpiry(fresh)
    || fresh.policy.expiresAt < old.policy.expiresAt || fresh.spend.validUntil < old.spend.validUntil
    || !firstAcceptance && fresh.policy.expiresAt === old.policy.expiresAt && fresh.spend.validUntil === old.spend.validUntil)
    throw Error('automatic browser policy requires reconciliation');
  for (const [, row] of storage.kv.list<any>({ prefix: 'common-browser:' })) {
    if (row.cleanup !== 'closed' || row.cleanupFailed || row.allocation !== 'observed' || row.session?.state !== 'ended')
      throw Error('automatic browser renewal requires confirmed cleanup');
  }
  for (const [, total] of storage.kv.list<number>({ prefix: 'common-public-browser-month:' })) {
    if (!Number.isSafeInteger(total) || total < 0 || total > COMMON_BROWSER_MONTH_CEILING_MICROUSD)
      throw Error('automatic browser renewal monthly usage conflict');
  }
  const registered = commonStagingRegistration({ WALDO_ENVIRONMENT: 'staging', COMMON_BROWSER_REGISTRATION: JSON.stringify(old) });
  if (!registered) throw Error('automatic browser renewal policy unavailable');
  const usageKey = `common-public-browser-usage:${old.policy.ref}`, spendKey = `common-spend:${old.policy.ref}`;
  const usage = storage.kv.get<any>(usageKey), spend = storage.kv.get<any>(spendKey);
  if (usage && (JSON.stringify(usage.policy) !== JSON.stringify(old.policy) || usage.custodyDigest !== prior.custodyDigest))
    throw Error('automatic browser renewal usage conflict');
  if (usage) assertCommonPublicBrowserUsage(usage, registered.policy, registered.spend.allocationMicrousd);
  if (spend) {
    commonSpendReservation(storage, registered.spend.policy, Date.now, () => {}).reserved();
  }
  if (usage) storage.kv.put(usageKey, { ...usage, policy: { ...usage.policy, expiresAt: fresh.policy.expiresAt } });
  if (spend) storage.kv.put(spendKey, { ...spend, policy: { ...spend.policy, validUntil: fresh.spend.validUntil } });
}

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
  const capsuleMatchesPhysical = (capsule: any) => !!capsule
    && typeof capsule.doName === 'string' && capsule.doName.length > 0
    && typeof capsule.subject === 'string' && capsule.subject.length > 0
    && capsule.doName === storage.kv.get<string>('do_name')
    && capsule.subject === storage.kv.get<string>('telegram_subject')
    && env.TELEGRAM_OWNER_DO?.idFromName(capsule.doName).toString() === actualDoId;
  return {
    selected,
    get acceptanceSelected() {
      const retained = storage.kv.get<Pinned>(KEY);
      return capsuleMatchesPhysical(raw?.acceptance) || capsuleMatchesPhysical(retained?.registration.acceptance);
    },
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
      const acceptanceSelected = capsuleMatchesPhysical(raw.acceptance);
      if (acceptanceSelected && raw.acceptance.directoryOwnerId !== owner.directoryOwnerId)
        throw Error('automatic browser acceptance owner unavailable');
      const registration = { ...(acceptanceSelected ? { acceptance: structuredClone(raw.acceptance) } : {}), policy: { ...raw.policy, doName: after.doName, subject: after.subject,
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
        if (prior && JSON.stringify(prior) !== JSON.stringify(pinned)) renewExpiry(storage, prior, pinned);
        // A different registration cannot manufacture a fresh allowance beside
        // existing manual spend or orphan its exact-session cleanup obligations.
        if (!prior && ['common-spend:', 'common-public-browser-usage:', 'common-browser:']
          .some(prefix => [...storage.kv.list({ prefix })].length > 0)) throw Error('automatic browser prior policy requires reconciliation');
        if (!prior || JSON.stringify(prior) !== JSON.stringify(pinned)) storage.kv.put(KEY, pinned);
      });
      return config;
    },
  };
}
