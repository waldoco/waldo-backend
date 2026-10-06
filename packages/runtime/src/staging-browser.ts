import { acquire, connect, endpointURLString, sessions } from '@cloudflare/playwright';
import { configureStagingPublicBrowser } from './channels/browser-public-read-configuration';

// This entrypoint is selected only by reviewed staging Wrangler configuration.
// Production keeps the ordinary index entrypoint and its current compatibility.
configureStagingPublicBrowser(async () => ({ acquire, connect, endpointURLString, sessions }));
export { default } from './index';
export * from './index';
