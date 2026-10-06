import type { BrowserWorker } from '@cloudflare/playwright';
import type { BrowserPageProviders } from '../tools/live/browser';
import type { CloudflareBrowserSdkLoader } from './public-fixture-browser';
import { cloudflarePublicRead } from './cloudflare-public-read';

let stagingSdk: CloudflareBrowserSdkLoader | undefined;
// Only the staging Worker entrypoint registers executable provider code. Keeping
// that import out of the ordinary entrypoint preserves its non-Node bundle.
export function configureStagingPublicBrowser(loadSdk: CloudflareBrowserSdkLoader): void {
  if (stagingSdk) throw Error('public browser provider already configured');
  stagingSdk = loadSdk;
}

// Called by the ordinary registered two-argument owner DO. Model arguments cannot
// install provider code, enable bindings or widen the existing public-read policy.
export function browserPublicReadConfiguration(env: Readonly<{ WALDO_ENVIRONMENT?: string; BROWSER?: BrowserWorker }>): BrowserPageProviders {
  const selected = env.WALDO_ENVIRONMENT === 'staging' && stagingSdk !== undefined;
  return {
    defaultProvider: selected ? 'cloudflare_playwright' : 'browserbase_stagehand_http_v3',
    allowBrowserbase: true,
    cloudflare: selected && env.BROWSER ? cloudflarePublicRead({ binding: env.BROWSER, loadSdk: stagingSdk! }) : undefined,
  };
}
