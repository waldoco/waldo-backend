import { clientMetadataDocument } from '../connectors/mcp-oauth';
import { MCP_ATTEMPT_TTL_MS, MCP_FINISH_PATH, readMcpState, type ConnectOutcome } from '../connectors/mcp-connections';
import { checkBrowser, releaseBrowser, startRedirect } from '../connectors/oauth-browser-binding';
import { oauthStateSecret, type OAuthStateEnv } from '../connectors/oauth-state-secret';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { callbackPage } from './google-oauth';
import type { TelegramWebhookEnv } from './telegram-webhook';

// Waldo's OAuth client identity for MCP servers (a Client ID Metadata Document): the client_id is
// this document's own URL, so it is served from the deployment's origin and never varies per owner.
export const handleMcpClientMetadata = (request: Request): Response => Response.json(clientMetadataDocument(new URL(request.url).origin), {
  headers: { 'cache-control': 'public, max-age=3600', 'x-content-type-options': 'nosniff' },
});

const COPY: Record<ConnectOutcome['kind'], Readonly<{ status: number; title: string; body: string }>> = {
  linked: { status: 200, title: 'Server connected', body: 'Waldo can now see this server\'s tools. Each one asks you first until you choose otherwise in Connections. You can close this tab.' },
  denied: { status: 400, title: 'Server was not connected', body: 'Access was not granted. Connect it again from Connections whenever you want.' },
  expired: { status: 410, title: 'This link has expired', body: 'Connect links last 15 minutes. Start again from Connections.' },
  invalid: { status: 400, title: 'This link is not valid', body: 'It may have been used already or copied incompletely. Start again from Connections.' },
  failed: { status: 502, title: 'Server could not be connected', body: 'The server\'s sign-in did not complete. Start again from Connections; if it keeps failing, the server may not support Waldo yet.' },
};

const UNBOUND = { status: 403, title: 'Start the connection again', body: 'This sign-in came back to a different browser from the one that started it, or it took too long, so nothing was connected. Connect the server again from Connections in this browser.' };

const rejected = (reason: string) => console.log(JSON.stringify({ trace: 'oauth', hop: 'mcp_oauth_callback', ok: false, error: reason }));

// The console start link, followed by the signed-in owner: it sends the browser to the provider and binds the attempt
// to that browser, so the callback accepts no other.
export const mcpStartRedirect = (nonce: string, target: string): Promise<Response> => startRedirect('mcp', nonce, target, MCP_ATTEMPT_TTL_MS);

// The provider redirects the owner here after consent. The signed state names the owner object and a
// single-use attempt; that object settles the attempt, so a reloaded callback never redeems the code twice.
export const handleMcpCallback = async (request: Request, env: TelegramWebhookEnv & OwnerDirectoryEnv & OAuthStateEnv): Promise<Response> => {
  const secret = oauthStateSecret(env), owners = env.OWNER_DO;
  if (!secret || !owners) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const url = new URL(request.url);
  const state = await readMcpState(secret, url.searchParams.get('state') ?? '');
  if (!state) {
    rejected(url.searchParams.get('state') ? 'bad_state' : 'missing_state');
    return callbackPage(false, COPY.invalid);
  }
  // Checked before the owner object wakes, so a forwarded sign-in or an injected code neither links nor settles the attempt.
  const browser = await checkBrowser(request, 'mcp', state.nonce, Date.now());
  if (browser !== 'bound') {
    rejected(`browser_${browser}`);
    return callbackPage(false, UNBOUND);
  }
  const page = await (async () => {
    try {
      const response = await owners.get(owners.idFromName(state.owner)).fetch(`https://telegram-owner${MCP_FINISH_PATH}`, {
        method: 'POST', body: JSON.stringify({ nonce: state.nonce, query: url.searchParams.toString() }),
      });
      const outcome = await response.json() as ConnectOutcome;
      return callbackPage(outcome.kind === 'linked', COPY[outcome.kind] ?? COPY.failed);
    } catch (failure) {
      rejected(`owner unreachable: ${failure instanceof Error ? failure.name : 'unknown'}`);
      return callbackPage(false, COPY.failed);
    }
  })();
  page.headers.append('set-cookie', await releaseBrowser('mcp', state.nonce));
  return page;
};
