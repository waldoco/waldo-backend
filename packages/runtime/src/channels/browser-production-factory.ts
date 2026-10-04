import type { BrowserWorker } from '@cloudflare/playwright';
import type { BrowserOwnerConfiguration } from './browser-owner-host';
import { hex, signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { ownerPresenceBinding, type PresenceBinding } from '../identity/owner-message-admission';
import { browserOwnerAuthority } from './browser-owner-authority';
import { fixtureDigest, publicFixtureBrowser } from './public-fixture-browser';

export type BrowserProductionEnv = OwnerDirectoryEnv & Readonly<{
  WALDO_ENVIRONMENT?: string; WALDO_OWNER_DO_NAMESPACE?: string;
  TELEGRAM_OWNER_DO?: DurableObjectNamespace; BROWSER?: BrowserWorker;
}>;
// A deployment-code decision, never an environment variable or model argument.
export type BrowserTrialPolicy = Readonly<{ enabled: boolean; doName: string; fixtureOrigin: string }>;

type Options = Readonly<{
  env: BrowserProductionEnv; storage: DurableObjectStorage; actualDoId: string;
  policy?: BrowserTrialPolicy; fetcher?: typeof fetch; now?: () => number;
}>;

// Proposed read RPC; fails closed until installed by the release writer.
// The existing route_presence projection cannot supply canonical authority.
const bindingReader = (options: Options, doName: string, subject: string) => {
  const { env, storage, actualDoId } = options;
  const environment = env.WALDO_ENVIRONMENT, namespace = env.WALDO_OWNER_DO_NAMESPACE;
  const physical = () => environment === 'staging' && Boolean(namespace && /^[a-zA-Z0-9_-]{1,240}$/.test(namespace))
    && storage.kv.get('do_name') === doName && storage.kv.get('telegram_subject') === subject
    && storage.kv.get('telegram_unlinked') !== true && env.TELEGRAM_OWNER_DO?.idFromName(doName).toString() === actualDoId;
  const call = signedRpc(env, options.fetcher, options.now);
  return async (): Promise<PresenceBinding> => {
    if (!call || !physical() || !/^\d{1,32}$/.test(subject)) throw Error('browser configuration unavailable');
    const locator = JSON.stringify([environment, namespace, doName, actualDoId, 'telegram', subject]);
    const hash = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(locator)));
    const value = await call('browser_owner_binding', `browser.bind.${hash}`, { p_environment: environment!, p_namespace: namespace!, p_do_name: doName,
      p_do_id: actualDoId, p_provider: 'telegram', p_subject: subject, p_locator: locator });
    const binding = ownerPresenceBinding(value);
    if (!physical() || binding.do_name !== doName || binding.subject !== subject) throw Error('browser configuration unavailable');
    return binding;
  };
};

export async function browserProductionConfiguration(options: Options): Promise<BrowserOwnerConfiguration | undefined> {
  if (!options.policy) return undefined;
  try {
    const { env, storage, policy } = options, now = options.now ?? Date.now;
    if (!env.BROWSER || !policy.doName || policy.doName.length > 200) throw Error('browser configuration unavailable');
    const authority = browserOwnerAuthority(storage, now), authorization = authority.read();
    if (!authorization || authorization.binding.do_name !== policy.doName || authorization.manifest.origin !== policy.fixtureOrigin
      || authorization.manifestDigest !== await fixtureDigest(authorization.manifest)) throw Error('browser configuration unavailable');
    const lookup = bindingReader(options, policy.doName, authorization.binding.subject);
    const binding = await lookup();
    if (JSON.stringify(binding) !== JSON.stringify(ownerPresenceBinding(authorization.binding))) throw Error('browser configuration unavailable');
    const driver = publicFixtureBrowser({ binding: env.BROWSER, manifest: authorization.manifest, fetcher: options.fetcher });
    return Object.freeze({
      enabled: policy.enabled === true, binding, manifestDigest: authorization.manifestDigest, lookup,
      grant: async request => {
        if (policy.enabled !== true) return null;
        try { return authority.grant(request, await lookup()); } catch { return null; }
      },
      driver: Object.freeze({ ...driver, start: async (lifetimeMs: number) => {
        if (policy.enabled !== true || !authority.reserveAllocation(authorization, await lookup(), lifetimeMs)) throw Error('browser task allocation denied');
        return driver.start(lifetimeMs);
      } }),
    });
  } catch { throw Error('browser configuration unavailable'); }
}
