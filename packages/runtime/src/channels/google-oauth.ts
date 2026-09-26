import { readConsentState, type ConsentSurface } from '../connectors/google';
import { CONSOLE_PATH } from './console';
import type { ConsentOutcome } from '../connectors/google-consent';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import type { TelegramWebhookEnv } from './telegram-webhook';

export const GOOGLE_FINISH_PATH = '/google/consent';
export type ConsentReply = Readonly<{ outcome: ConsentOutcome; bot: string | null }>;

// The only deep link the completion page may ever render for app-origin flows. Fixed string,
// never assembled from input, so no arbitrary return URL can ride the state.
export const APP_RETURN_DEEP_LINK = 'waldo://oauth/complete';

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// Where the completion page sends the owner back. The surface comes from the signed OAuth
// state; anything missing or unrecognized lands on the console, never on an arbitrary URL.
const returnAction = (surface: ConsentSurface | undefined, bot: string | null): string => {
  switch (surface) {
    case 'telegram':
      return bot
        ? `<a class="button" href="https://t.me/${encodeURIComponent(bot)}">Back to Telegram</a>`
        : '<p class="note">You can go back to Telegram.</p>';
    case 'whatsapp':
      return '<p class="note">You can go back to WhatsApp.</p>';
    case 'app':
      return `<a class="button" href="${APP_RETURN_DEEP_LINK}">Back to the app</a>`;
    case 'dashboard':
    default:
      return `<a class="button" href="${CONSOLE_PATH}">Back to your console</a>`;
  }
};

const COPY: Record<ConsentOutcome['kind'], Readonly<{ status: number; title: string; body: string }>> = {
  linked: { status: 200, title: 'Google is connected', body: 'Waldo can now read your calendar and help with mail you approve. You can close this tab.' },
  denied: { status: 400, title: 'Google was not connected', body: 'Access was not granted. Ask Waldo to connect Google whenever you want to try again.' },
  expired: { status: 410, title: 'This link has expired', body: 'Connect links last 15 minutes. Ask Waldo to connect Google for a fresh one.' },
  invalid: { status: 400, title: 'This link is not valid', body: 'It may have been copied incompletely. Ask Waldo to connect Google for a fresh one.' },
  failed: { status: 502, title: 'Google could not be connected', body: 'Google approved access but saving it failed. Ask Waldo to connect Google to try again.' },
};

// The callback URL carries the authorization code, so the page is never cached, framed or sent as a referrer.
export const consentPage = (outcome: ConsentOutcome, bot: string | null, surface?: ConsentSurface): Response => {
  const copy = COPY[outcome.kind];
  const account = outcome.kind === 'linked' && outcome.email ? `<p class="account">${escape(outcome.email)}</p>` : '';
  const back = returnAction(surface, bot);
  const mark = outcome.kind === 'linked' ? '&#10003;' : '!';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${copy.title} - Waldo</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--ok:#1f7a4d;--bad:#b3261e;--btn:#2a6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--ok:#5cc28f;--bad:#f2837a;--btn:#5b93f0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{box-sizing:border-box;width:min(420px,calc(100vw - 32px));background:var(--card);border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.mark{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;font-size:28px;color:#fff;background:var(${outcome.kind === 'linked' ? '--ok' : '--bad'})}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}.account{color:var(--ink);font-weight:bold}
.button{display:inline-block;margin-top:8px;padding:12px 20px;border-radius:10px;background:var(--btn);color:#fff;text-decoration:none;font-weight:bold}.note{margin:8px 0 0}</style></head>
<body><main><div class="mark" aria-hidden="true">${mark}</div><h1>${copy.title}</h1>${account}<p>${copy.body}</p>${back}</main></body></html>`;
  return new Response(html, {
    status: copy.status,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    },
  });
};

const rejected = (reason: string) => console.log(JSON.stringify({ trace: 'oauth', hop: 'oauth_callback', ok: false, error: reason }));

// Google redirects the owner here after consent. The signed state names the owner's Durable Object and
// a one-time attempt; that Durable Object settles the attempt, so a reloaded callback never exchanges twice.
export const handleGoogleCallback = async (request: Request, env: TelegramWebhookEnv & OwnerDirectoryEnv): Promise<Response> => {
  const { GOOGLE_CLIENT_ID: clientId, GOOGLE_CLIENT_SECRET: clientSecret, TELEGRAM_WEBHOOK_SECRET: secret, TELEGRAM_OWNER_DO: owners } = env;
  if (!clientId || !clientSecret || !secret || !owners) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const params = new URL(request.url).searchParams;
  const error = params.get('error');
  const state = await readConsentState(secret, params.get('state') ?? '');
  if (!state) {
    rejected(params.get('state') ? 'bad_state' : 'missing_state');
    return consentPage(error ? { kind: 'denied' } : { kind: 'invalid' }, null);
  }
  try {
    const response = await owners.get(owners.idFromName(state.owner)).fetch(`https://telegram-owner${GOOGLE_FINISH_PATH}`, {
      method: 'POST', body: JSON.stringify({ nonce: state.nonce, code: params.get('code'), error }),
    });
    const reply = await response.json() as ConsentReply;
    return consentPage(reply.outcome, reply.bot, state.surface);
  } catch (failure) {
    rejected(`owner unreachable: ${failure instanceof Error ? failure.message : String(failure)}`);
    // The signed state already proved where this flow started; the failure page must send the
    // owner back to THAT surface, not drop it and default every failure to the console.
    return consentPage({ kind: 'failed', reason: 'owner unreachable' }, null, state.surface);
  }
};
