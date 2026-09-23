import { exchangeGoogleCode, GOOGLE_CALLBACK_PATH, verifyOauthState } from '../connectors/google';
import { googleProxy } from '../connectors/connections';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import type { TelegramWebhookEnv } from './telegram-webhook';

const page = (status: number, text: string) =>
  new Response(`<!doctype html><meta name="viewport" content="width=device-width"><p style="font:18px system-ui;margin:40px">${text}</p>`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });

// Google redirects the owner here after consent. The signed state names the owner's Durable Object,
// and the grant goes only there.
export const handleGoogleCallback = async (request: Request, env: TelegramWebhookEnv & OwnerDirectoryEnv): Promise<Response> => {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_DO: owners } = env;
  if (!clientId || !clientSecret || !secret || !owners) return page(404, 'Not found.');
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  if (url.searchParams.get('error')) return page(400, 'Google access was not granted. You can close this tab.');
  const owner = code ? await verifyOauthState(secret, state, Date.now()) : null;
  if (!code || !owner) return page(400, 'This link has expired. Ask Waldo for a new one.');
  const redirectUri = `${url.origin}${GOOGLE_CALLBACK_PATH}`;
  const proxy = googleProxy(env);
  // With the proxy the code is exchanged and stored there; the Durable Object gets only the connection id.
  const tokens = proxy ? await proxy.exchange(owner, code, redirectUri) : await exchangeGoogleCode({ clientId, clientSecret, redirectUri }, code);
  if (!tokens) return page(400, 'Google access could not be saved. Try again from the console.');
  const stub = owners.get(owners.idFromName(owner));
  await stub.fetch('https://telegram-owner/google', { method: 'POST', body: JSON.stringify(tokens) });
  return page(200, 'Google is connected. You can go back to Telegram.');
};
