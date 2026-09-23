import { exchangeGoogleCode, GOOGLE_CALLBACK_PATH, verifyOauthState } from '../connectors/google';
import type { TelegramWebhookEnv } from './telegram-webhook';

const page = (status: number, text: string) =>
  new Response(`<!doctype html><meta name="viewport" content="width=device-width"><p style="font:18px system-ui;margin:40px">${text}</p>`, {
    status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });

// Google redirects the owner here after consent. The signed state binds the grant to the
// configured owner; the refresh token goes straight into the owner's Durable Object.
export const handleGoogleCallback = async (request: Request, env: TelegramWebhookEnv): Promise<Response> => {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_DO: owners, WALDO_OWNER_TELEGRAM_ID: owner } = env;
  if (!clientId || !clientSecret || !secret || !owners || !owner) return page(404, 'Not found.');
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') ?? '';
  if (url.searchParams.get('error')) return page(400, 'Google access was not granted. You can close this tab.');
  if (!code || (await verifyOauthState(secret, state, Date.now())) !== owner) return page(400, 'This link has expired. Ask Waldo for a new one.');
  const tokens = await exchangeGoogleCode({ clientId, clientSecret, redirectUri: `${url.origin}${GOOGLE_CALLBACK_PATH}` }, code);
  const stub = owners.get(owners.idFromName(owner));
  await stub.fetch('https://telegram-owner/google', { method: 'POST', body: JSON.stringify(tokens) });
  return page(200, 'Google is connected. You can go back to Telegram.');
};
