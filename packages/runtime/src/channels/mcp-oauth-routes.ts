import { clientMetadataDocument } from '../connectors/mcp-oauth';
import { MCP_FINISH_PATH, readMcpState, type ConnectOutcome } from '../connectors/mcp-connections';
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

const rejected = (reason: string) => console.log(JSON.stringify({ trace: 'oauth', hop: 'mcp_oauth_callback', ok: false, error: reason }));

// The provider redirects the owner here after consent. The signed state names the owner object and a
// single-use attempt; that object settles the attempt, so a reloaded callback never redeems the code twice.
export const handleMcpCallback = async (request: Request, env: TelegramWebhookEnv & OwnerDirectoryEnv): Promise<Response> => {
  const { TELEGRAM_WEBHOOK_SECRET: secret, OWNER_DO: owners } = env;
  if (!secret || !owners) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const url = new URL(request.url);
  const state = await readMcpState(secret, url.searchParams.get('state') ?? '');
  if (!state) {
    rejected(url.searchParams.get('state') ? 'bad_state' : 'missing_state');
    return callbackPage(false, COPY.invalid);
  }
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
};
