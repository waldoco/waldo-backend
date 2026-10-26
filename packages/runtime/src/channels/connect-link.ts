// S3 (CONNECT_FLOW_DESIGN): short first-party connect links. Chat carries /c/<ticket>; the
// provider consent URL is minted on Continue inside the owner's Durable Object and travels
// only in the redirect. The ticket itself is never stored - only its sha256 hash.
import { GOOGLE_AUTH_ORIGIN, GOOGLE_CALLBACK_PATH } from '../connectors/google';
import { CONSENT_TTL_MS } from '../connectors/google-consent';
import { GRANOLA_AUTH_ORIGIN } from '../connectors/granola-mcp';
import { MCP_CALLBACK_PATH } from '../connectors/mcp-oauth';
import { MCP_ATTEMPT_TTL_MS } from '../connectors/mcp-connections';
import { startRedirect, type BoundProvider } from '../connectors/oauth-browser-binding';
import { oauthStateSecret, type OAuthStateEnv } from '../connectors/oauth-state-secret';
import { signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { confirmedHere, confirmPage, handOff, HANDOFF_PARAM, ownerHint, releaseHandOff, UNHANDED, type HandOff } from './connect-confirm';
import { appConnectEntry } from './connect-app';
import { callbackPage, consentPage, returnAction } from './google-oauth';

export const CONNECT_LINK_PREFIX = '/c/';
export const BEGIN_SESSION_PATH = '/google/begin-session';
// The owner object answers what a catalogue app's ticket shows before Continue (channels/connect-app.ts).
export const DESCRIBE_SESSION_PATH = '/connect/describe';

const TICKET = /^[A-Za-z0-9_-]{22}$/;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export const newTicket = (): string => b64url(crypto.getRandomValues(new Uint8Array(16)));
export const ticketHash = async (ticket: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket)));

// Each provider a ticket can name: what the confirm page calls it, the origin its consent lives on (the page's form-action
// allows only that one), and the browser binding and callback its sign-in finishes on. Granola rides the MCP sign-in. A
// catalogue app's ticket (mcp:<id>) is described by the owner object instead, whose attempt fixed its consent origin when
// the link was sent.
type Provider = Readonly<{ name: string; origin: string; binding: BoundProvider; callback: string; ttlMs: number; consent?: string; fromChat?: true }>;
const PROVIDERS: Readonly<Record<'google' | 'granola', Provider>> = {
  google: { name: 'Google', origin: GOOGLE_AUTH_ORIGIN, binding: 'google', callback: GOOGLE_CALLBACK_PATH, ttlMs: CONSENT_TTL_MS },
  granola: { name: 'Granola', origin: GRANOLA_AUTH_ORIGIN, binding: 'mcp', callback: MCP_CALLBACK_PATH, ttlMs: MCP_ATTEMPT_TTL_MS },
} as const;
const providerOf = (value: string | undefined): Provider | null => (value === 'granola' ? PROVIDERS.granola : value === 'google' ? PROVIDERS.google : null);

type Resolved = Readonly<{ status: string; do_name?: string; provider?: string; session?: string; begun?: boolean; handoff?: boolean; owner_hint?: unknown }>;
const used = (provider: Provider, fromApp: boolean) => ({ status: 410, title: 'This link was already used', body: !fromApp && (provider.name === 'Google' || provider.fromChat)
  ? `Each connect link starts one sign-in. Ask Waldo to connect ${provider.name} for a fresh one.`
  : `Each connect link starts one sign-in. Connect ${provider.name} again from Connections in the Waldo app.` });
const CANCELLED = { status: 200, title: 'Nothing was connected', body: 'Nothing was connected. You can close this tab.' };
// Only the app's own links carry its handoff code, so a page reached with one ends in the app: it names the Waldo app and
// its button is the app's one return address. Without the code, the pages keep their Google and console wording.
const FROM_APP = {
  invalid: { status: 400, title: 'This link is not valid', body: 'Start the connection again from Connections in the Waldo app.' },
  expired: { status: 410, title: 'This link has expired', body: 'Start the connection again from Connections in the Waldo app.' },
  failed: { status: 502, title: 'Nothing was connected', body: 'Waldo could not start the sign-in. Start the connection again from Connections in the Waldo app.' },
} as const;
const ALREADY = (provider: string) => ({ status: 200, title: `${provider} is already connected`, body: 'Nothing else is needed. You can close this tab.' });

const hop = (status: string, hashPrefix: string) =>
  console.log(JSON.stringify({ trace: `connect:${hashPrefix}`, hop: 'connect_link', ok: status === 'ok', detail: status }));

type ConnectEnv = OwnerDirectoryEnv & OAuthStateEnv & Readonly<{ OWNER_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } }>;

// GET shows whose Waldo the account joins and changes nothing a later visit would notice; only the Continue POST spends
// the ticket, mints the consent attempt, binds this browser and redirects to Google.
export const handleConnectTicket = async (request: Request, env: ConnectEnv): Promise<Response> => {
  const url = new URL(request.url);
  const ticket = url.pathname.slice(CONNECT_LINK_PREFIX.length);
  if (!TICKET.test(ticket) || !['GET', 'POST'].includes(request.method)) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const call = signedRpc(env);
  const owners = env.OWNER_DO, bindingSecret = oauthStateSecret(env);
  if (!call || !owners || !bindingSecret) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  let fromApp = url.searchParams.has(HANDOFF_PARAM) || url.searchParams.get('cancelled') === 'app';
  const back = () => (fromApp ? returnAction('app', null) : '');
  const refused = (kind: keyof typeof FROM_APP, reason = '') => (fromApp ? callbackPage(false, FROM_APP[kind], '', back()) : consentPage(kind === 'failed' ? { kind, reason } : { kind }, null));
  if (request.method === 'GET' && url.searchParams.has('cancelled')) return callbackPage(false, CANCELLED, '', back());
  const hash = await ticketHash(ticket);
  const hashPrefix = hash.slice(0, 8);
  const failed = (error: unknown, reason: string) => {
    console.log(JSON.stringify({ trace: `connect:${hashPrefix}`, hop: 'connect_link', ok: false, error: error instanceof Error ? error.message : String(error) }));
    return refused('failed', reason);
  };
  let session: Resolved | null;
  try {
    session = (await call('connect_session_resolve', `connsess.resolve.${hash}`, { p_ticket_hash: hash })) as Resolved | null;
  } catch (error) {
    return failed(error, 'resolve failed');
  }
  if (session === null) {
    hop('unknown', hashPrefix);
    return refused('invalid');
  }
  if (session.status === 'expired') {
    hop('expired', hashPrefix);
    return refused('expired');
  }
  if (session.handoff === true) fromApp = true;
  const app = appConnectEntry(session.provider);
  let provider = app ? { name: app.label, origin: '', binding: 'mcp' as const, callback: MCP_CALLBACK_PATH, ttlMs: MCP_ATTEMPT_TTL_MS, fromChat: true as const } : providerOf(session.provider);
  if (session.status !== 'ok' || !session.do_name || !provider) {
    hop(session.status, hashPrefix);
    return refused('invalid');
  }
  if (session.begun) {
    hop('used', hashPrefix);
    return callbackPage(false, used(provider, fromApp), '', back());
  }
  if (app) {
    let described: { origin?: unknown; consent?: unknown } | null;
    try {
      described = await (await owners.get(owners.idFromName(session.do_name)).fetch(`https://telegram-owner${DESCRIBE_SESSION_PATH}`, { method: 'POST', body: JSON.stringify({ ticket_hash: hash }) })).json() as typeof described;
    } catch (error) {
      return failed(error, 'describe failed');
    }
    // The sign-in this link started has run out or already moved on: nothing here can start it again.
    if (typeof described?.origin !== 'string' || typeof described.consent !== 'string') {
      hop('expired', hashPrefix);
      return callbackPage(false, { status: 410, title: 'This link has expired', body: fromApp ? `Connect ${app.label} again from Connections in the Waldo app.` : `Connect links last 15 minutes. Ask Waldo to connect ${app.label} for a fresh one.` }, '', back());
    }
    provider = { ...provider, origin: described.origin, consent: described.consent };
  }
  let handed: HandOff = { ok: true };
  if (session.handoff) {
    try { handed = await handOff(request, call, bindingSecret, hash, provider.ttlMs); } catch (error) { return failed(error, 'handoff failed'); }
    if (!handed.ok) {
      hop('unhanded', hashPrefix);
      return callbackPage(false, UNHANDED, '', back());
    }
  }
  if (request.method === 'GET') {
    hop('confirm', hashPrefix);
    const page = confirmPage({ provider: provider.name, providerOrigin: provider.origin, hint: ownerHint(session.owner_hint), cancel: `${url.pathname}?cancelled${fromApp ? '=app' : ''}`, ...(provider.consent ? { consent: provider.consent } : {}) });
    if (handed.setCookie) page.headers.append('set-cookie', handed.setCookie);
    return page;
  }
  if (!confirmedHere(request)) {
    hop('cross_site', hashPrefix);
    return refused('invalid');
  }
  let begun: Resolved | null;
  try {
    begun = (await call('connect_session_begin', `connsess.begin.${hash}`, { p_ticket_hash: hash })) as Resolved | null;
  } catch (error) {
    return failed(error, 'begin failed');
  }
  if (!begun?.do_name) {
    hop('used', hashPrefix);
    return callbackPage(false, used(provider, fromApp), '', back());
  }
  try {
    const reply = await owners.get(owners.idFromName(begun.do_name)).fetch(`https://telegram-owner${BEGIN_SESSION_PATH}`, {
      method: 'POST', body: JSON.stringify({ ticket_hash: hash, provider: session.provider }),
    });
    const { url: consent, nonce, already } = await reply.json() as { url?: string; nonce?: string; already?: boolean };
    if (already === true) {
      hop('already', hashPrefix);
      const page = callbackPage(true, ALREADY(provider.name), '', back());
      if (session.handoff) page.headers.append('set-cookie', await releaseHandOff(request, hash));
      return page;
    }
    // The browser that follows this link is the only one the callback accepts, so a redirect without a binding would only dead-end.
    if (!consent || typeof nonce !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(nonce)) throw new Error('no consent url minted');
    // The confirm page told the owner where Continue goes; a consent address anywhere else is refused, not followed.
    if (new URL(consent).origin !== provider.origin) throw new Error('consent url off the named provider');
    hop('ok', hashPrefix);
    const redirect = await startRedirect(bindingSecret, provider.binding, nonce, consent, provider.callback, provider.ttlMs);
    if (session.handoff) redirect.headers.append('set-cookie', await releaseHandOff(request, hash));
    return redirect;
  } catch (error) {
    return failed(error, 'mint failed');
  }
};
