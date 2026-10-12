import { readConsentState, type ConsentSurface } from '../connectors/google';
import { CONSOLE_PATH } from './console';
import { resultCard, standalonePage } from './standalone-page';
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
        ? `<a class="button-link" href="https://t.me/${encodeURIComponent(bot)}">Back to Telegram</a>`
        : '<p class="help">You can go back to Telegram.</p>';
    case 'whatsapp':
      return '<p class="help">You can go back to WhatsApp.</p>';
    case 'app':
      return `<a class="button-link" href="${APP_RETURN_DEEP_LINK}">Back to the app</a>`;
    case 'dashboard':
    default:
      return `<a class="button-link" href="${CONSOLE_PATH}">Back to your console</a>`;
  }
};

const COPY: Record<ConsentOutcome['kind'], Readonly<{ status: number; title: string; body: string }>> = {
  linked: { status: 200, title: 'Google is connected', body: 'Google access was saved. This does not confirm a live Calendar or Gmail read yet. Try a request in chat to check it. You can close this tab.' },
  denied: { status: 400, title: 'Google was not connected', body: 'Access was not granted. Ask Waldo to connect Google whenever you want to try again.' },
  expired: { status: 410, title: 'This link has expired', body: 'Connect links last 15 minutes. Ask Waldo to connect Google for a fresh one.' },
  invalid: { status: 400, title: 'This link is not valid', body: 'It may have been copied incompletely. Ask Waldo to connect Google for a fresh one.' },
  failed: { status: 502, title: 'Google could not be connected', body: 'Google approved access but saving it failed. Ask Waldo to connect Google to try again.' },
};

// The callback URL carries the authorization code, so the page is never cached, framed or sent as a referrer.
export const consentPage = (outcome: ConsentOutcome, bot: string | null, surface?: ConsentSurface): Response => {
  const copy = COPY[outcome.kind];
  const account = outcome.kind === 'linked' && outcome.email ? `<p><strong>${escape(outcome.email)}</strong></p>` : '';
  const back = returnAction(surface, bot);
  // The callback has already settled server-side. Remove its one-time code and state from
  // the address bar/history before the owner follows a return link or shares this tab.
  const html = standalonePage({
    title: `${copy.title} - Waldo`, layout: 'card',
    body: resultCard({ tone: outcome.kind === 'linked' ? 'positive' : 'negative', title: copy.title, body: `${account}<p>${copy.body}</p>`, actions: back }),
    tail: "<script>history.replaceState(null, '', location.pathname);</script>",
  });
  return new Response(html, {
    status: copy.status,
    headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'sha256-BSHIA8uyEksveTZNsWDdE7q9p6Oqa/LdAOuySBi6RJg='; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
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
