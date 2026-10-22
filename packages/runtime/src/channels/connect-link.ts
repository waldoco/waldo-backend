// S3 (CONNECT_FLOW_DESIGN): short first-party connect links. Chat carries /c/<ticket>; the
// provider consent URL is minted on Continue inside the owner's Durable Object and travels
// only in the redirect. The ticket itself is never stored - only its sha256 hash.
import { GOOGLE_AUTH_ORIGIN, GOOGLE_CALLBACK_PATH } from '../connectors/google';
import { CONSENT_TTL_MS } from '../connectors/google-consent';
import { startRedirect } from '../connectors/oauth-browser-binding';
import { signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { confirmedHere, confirmPage, handOff, ownerHint, releaseHandOff, UNHANDED, type HandOff } from './connect-confirm';
import { callbackPage, consentPage } from './google-oauth';

export const CONNECT_LINK_PREFIX = '/c/';
export const BEGIN_SESSION_PATH = '/google/begin-session';

const TICKET = /^[A-Za-z0-9_-]{22}$/;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export const newTicket = (): string => b64url(crypto.getRandomValues(new Uint8Array(16)));
export const ticketHash = async (ticket: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket)));

type Resolved = Readonly<{ status: string; do_name?: string; provider?: string; session?: string; begun?: boolean; handoff?: boolean; owner_hint?: unknown }>;
const USED = { status: 410, title: 'This link was already used', body: 'Each connect link starts one sign-in. Ask Waldo to connect Google for a fresh one.' };
const CANCELLED = { status: 200, title: 'Nothing was connected', body: 'Google was not connected. You can close this tab.' };

const hop = (status: string, hashPrefix: string) =>
  console.log(JSON.stringify({ trace: `connect:${hashPrefix}`, hop: 'connect_link', ok: status === 'ok', detail: status }));

type ConnectEnv = OwnerDirectoryEnv & Readonly<{ OWNER_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } }>;

// GET shows whose Waldo the account joins and changes nothing a later visit would notice; only the Continue POST spends
// the ticket, mints the consent attempt, binds this browser and redirects to Google.
export const handleConnectTicket = async (request: Request, env: ConnectEnv): Promise<Response> => {
  const url = new URL(request.url);
  const ticket = url.pathname.slice(CONNECT_LINK_PREFIX.length);
  if (!TICKET.test(ticket) || !['GET', 'POST'].includes(request.method)) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const call = signedRpc(env);
  const owners = env.OWNER_DO;
  if (!call || !owners) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  if (request.method === 'GET' && url.searchParams.has('cancelled')) return callbackPage(false, CANCELLED, '', '');
  const hash = await ticketHash(ticket);
  const hashPrefix = hash.slice(0, 8);
  const failed = (error: unknown, reason: string) => {
    console.log(JSON.stringify({ trace: `connect:${hashPrefix}`, hop: 'connect_link', ok: false, error: error instanceof Error ? error.message : String(error) }));
    return consentPage({ kind: 'failed', reason }, null);
  };
  let session: Resolved | null;
  try {
    session = (await call('connect_session_resolve', `connsess.resolve.${hash}`, { p_ticket_hash: hash })) as Resolved | null;
  } catch (error) {
    return failed(error, 'resolve failed');
  }
  if (session === null) {
    hop('unknown', hashPrefix);
    return consentPage({ kind: 'invalid' }, null);
  }
  if (session.status === 'expired') {
    hop('expired', hashPrefix);
    return consentPage({ kind: 'expired' }, null);
  }
  if (session.status !== 'ok' || !session.do_name) {
    hop(session.status, hashPrefix);
    return consentPage({ kind: 'invalid' }, null);
  }
  if (session.begun) {
    hop('used', hashPrefix);
    return callbackPage(false, USED, '', '');
  }
  let handed: HandOff = { ok: true };
  if (session.handoff) {
    try { handed = await handOff(request, call, hash, CONSENT_TTL_MS); } catch (error) { return failed(error, 'handoff failed'); }
    if (!handed.ok) {
      hop('unhanded', hashPrefix);
      return callbackPage(false, UNHANDED, '', '');
    }
  }
  if (request.method === 'GET') {
    hop('confirm', hashPrefix);
    const page = confirmPage({ provider: 'Google', providerOrigin: GOOGLE_AUTH_ORIGIN, hint: ownerHint(session.owner_hint), cancel: `${url.pathname}?cancelled` });
    if (handed.setCookie) page.headers.append('set-cookie', handed.setCookie);
    return page;
  }
  if (!confirmedHere(request)) {
    hop('cross_site', hashPrefix);
    return consentPage({ kind: 'invalid' }, null);
  }
  let begun: Resolved | null;
  try {
    begun = (await call('connect_session_begin', `connsess.begin.${hash}`, { p_ticket_hash: hash })) as Resolved | null;
  } catch (error) {
    return failed(error, 'begin failed');
  }
  if (!begun?.do_name) {
    hop('used', hashPrefix);
    return callbackPage(false, USED, '', '');
  }
  try {
    const reply = await owners.get(owners.idFromName(begun.do_name)).fetch(`https://telegram-owner${BEGIN_SESSION_PATH}`, {
      method: 'POST', body: JSON.stringify({ ticket_hash: hash }),
    });
    const { url: consent, nonce } = await reply.json() as { url?: string; nonce?: string };
    // The browser that follows this link is the only one the callback accepts, so a redirect without a binding would only dead-end.
    if (!consent || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('no consent url minted');
    hop('ok', hashPrefix);
    const redirect = await startRedirect('google', nonce, consent, GOOGLE_CALLBACK_PATH, CONSENT_TTL_MS);
    if (session.handoff) redirect.headers.append('set-cookie', await releaseHandOff(request, hash));
    return redirect;
  } catch (error) {
    return failed(error, 'mint failed');
  }
};
