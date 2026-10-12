import type { BrowserWorker } from '@cloudflare/playwright';
import type { BrowserOwnerConfiguration, BrowserOwnerGrantRequest } from './browser-owner-host';
import { browserBoundedJson } from './browser-bounded-body';
import type { BrowserSourceGuard, CloudflareBrowserSdkLoader } from './public-fixture-browser';
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
  policy?: BrowserTrialPolicy; loadSdk?: CloudflareBrowserSdkLoader; fetcher?: typeof fetch; now?: () => number;
}>;

// Signed read RPC; remains unavailable until its migration is installed.
// The existing route_presence projection cannot supply canonical authority.
export const browserOwnerBindingReader = (options: Options, doName: string, subject: string) => {
  const { env, storage, actualDoId } = options;
  const environment = env.WALDO_ENVIRONMENT, namespace = env.WALDO_OWNER_DO_NAMESPACE;
  const physical = () => environment === 'staging' && Boolean(namespace && /^[a-zA-Z0-9_-]{1,240}$/.test(namespace))
    && storage.kv.get('do_name') === doName && storage.kv.get('telegram_subject') === subject
    && storage.kv.get('telegram_unlinked') !== true && env.TELEGRAM_OWNER_DO?.idFromName(doName).toString() === actualDoId;
  const call = signedRpc(env, async (input, init) => {
    const response = await (options.fetcher ?? fetch)(input, init);
    if (!response.body) return response;
    const value = await browserBoundedJson(response, 4096, 15000);
    return Response.json(value, { status: response.status, headers: response.headers });
  }, options.now);
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

export type BrowserProductionConfiguration = BrowserOwnerConfiguration & Readonly<{ lastFailure: Error | undefined }>;
export async function browserProductionConfiguration(options: Options): Promise<BrowserProductionConfiguration | undefined> {
  if (!options.policy) return undefined;
  try {
    const { env, storage } = options, policy = Object.freeze({ ...options.policy }), now = options.now ?? Date.now;
    if (!options.loadSdk || !env.BROWSER || !policy.doName || policy.doName.length > 200) throw Error('browser configuration unavailable');
    const authority = browserOwnerAuthority(storage, now), authorization = authority.read();
    if (!authorization || authorization.binding.do_name !== policy.doName || authorization.manifest.origin !== policy.fixtureOrigin
      || authorization.manifestDigest !== await fixtureDigest(authorization.manifest)) throw new Error('browser configuration unavailable', { cause: authority.lastFailure });
    const lookup = browserOwnerBindingReader(options, policy.doName, authorization.binding.subject);
    const binding = await lookup();
    if (JSON.stringify(binding) !== JSON.stringify(ownerPresenceBinding(authorization.binding))) throw Error('browser configuration unavailable');
    const driver = publicFixtureBrowser({ binding: env.BROWSER, manifest: authorization.manifest, loadSdk: options.loadSdk, fetcher: options.fetcher });
    return Object.freeze({
      enabled: policy.enabled === true, binding, manifestDigest: authorization.manifestDigest, lookup,
      // Internal diagnostic only; never serialize causes into a tool/client result.
      get lastFailure() { return authority.lastFailure; },
      grant: async (request: BrowserOwnerGrantRequest) => {
        if (policy.enabled !== true) return null;
        try { return authority.grant(request, await lookup()); }
        catch (cause) { authority.recordFailure('directory', cause); return null; }
      },
      driver: Object.freeze({ ...driver, start: async (lifetimeMs: number, source?: BrowserSourceGuard) => {
        await source?.();
        if (policy.enabled !== true || !authority.reserveAllocation(authorization, await lookup(), lifetimeMs)) throw Error('browser task allocation denied');
        await source?.();
        return driver.start(lifetimeMs, source);
      } }),
    });
  } catch (cause) {
    console.warn(JSON.stringify({ event: 'browser_configuration_failure' }));
    throw new Error('browser configuration unavailable', { cause });
  }
}
