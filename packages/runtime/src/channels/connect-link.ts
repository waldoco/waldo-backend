// S3 (CONNECT_FLOW_DESIGN): short first-party connect links. Chat carries /c/?t=<ticket>; the
// provider consent URL is minted at click time inside the owner's Durable Object and travels
// only in the 302 redirect. The ticket itself is never stored - only its sha256 hash.
//
// The ticket rides in the `t` query parameter, never the URL path: edge observability
// (Workers Logs, traces) captures request URLs and only query-string redaction is supported,
// so a path-borne bearer ticket would land in persisted logs. The legacy /c/<ticket> path
// form is still accepted so links minted before the cutover keep working until their 12h TTL
// lapses; nothing mints it anymore.
import { signedRpc, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { consentPage } from './google-oauth';

export const CONNECT_LINK_PREFIX = '/c/';
export const BEGIN_SESSION_PATH = '/google/begin-session';

const TICKET = /^[A-Za-z0-9_-]{22}$/;

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

export const newTicket = (): string => b64url(crypto.getRandomValues(new Uint8Array(16)));
export const ticketHash = async (ticket: string): Promise<string> =>
  hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticket)));

type Resolved = Readonly<{ status: string; do_name?: string; provider?: string; session?: string }>;

const hop = (status: string, hashPrefix: string) =>
  console.log(JSON.stringify({ trace: `connect:${hashPrefix}`, hop: 'connect_link', ok: status === 'ok', detail: status }));

type ConnectEnv = OwnerDirectoryEnv & Readonly<{ TELEGRAM_OWNER_DO?: { idFromName(name: string): unknown; get(id: unknown): { fetch(input: string, init?: RequestInit): Promise<Response> } } }>;

export const handleConnectTicket = async (request: Request, env: ConnectEnv): Promise<Response> => {
  const url = new URL(request.url);
  const ticket =
    url.searchParams.get('t') ??
    (url.pathname.startsWith(CONNECT_LINK_PREFIX) ? url.pathname.slice(CONNECT_LINK_PREFIX.length) : '');
  if (!TICKET.test(ticket)) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const call = signedRpc(env);
  const owners = env.TELEGRAM_OWNER_DO;
  if (!call || !owners) return new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  const hash = await ticketHash(ticket);
  const hashPrefix = hash.slice(0, 8);
  let session: Resolved | null;
  try {
    session = (await call('connect_session_resolve', `connsess.resolve.${hash}`, { p_ticket_hash: hash })) as Resolved | null;
  } catch (error) {
    console.log(JSON.stringify({ trace: `connect:${hashPrefix}`, hop: 'connect_link', ok: false, error: error instanceof Error ? error.message : String(error) }));
    return consentPage({ kind: 'failed', reason: 'resolve failed' }, null);
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
  try {
    const reply = await owners.get(owners.idFromName(session.do_name)).fetch(`https://telegram-owner${BEGIN_SESSION_PATH}`, {
      method: 'POST', body: JSON.stringify({ ticket_hash: hash }),
    });
    const { url } = await reply.json() as { url?: string };
    if (!url) throw new Error('no consent url minted');
    hop('ok', hashPrefix);
    return new Response(null, {
      status: 302,
      headers: { location: url, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
  } catch (error) {
    console.log(JSON.stringify({ trace: `connect:${hashPrefix}`, hop: 'connect_link', ok: false, error: error instanceof Error ? error.message : String(error) }));
    return consentPage({ kind: 'failed', reason: 'mint failed' }, null);
  }
};
