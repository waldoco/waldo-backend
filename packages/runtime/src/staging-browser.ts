import { registerCommonBrowserSdk } from './channels/common-staging-registration';
import { configureStagingPublicBrowser } from './channels/browser-public-read-configuration';

// This entrypoint is selected only by reviewed staging Wrangler configuration.
// Production keeps the ordinary index entrypoint and its current compatibility.
// The SDK loads on the first browser call, not at Worker startup (guard-startup-lazy-sdks).
const loadSdk = async () => {
  const { acquire, connect, endpointURLString, sessions } = await import('@cloudflare/playwright');
  return { acquire, connect, endpointURLString, sessions };
};
configureStagingPublicBrowser(loadSdk);
registerCommonBrowserSdk(loadSdk);
export { default } from './index';
export * from './index';
