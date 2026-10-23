// The stop on a bearer connect link (a chat's /c/<ticket>, the app's WHOOP start link) before it hands the browser to the
// provider. Anyone holding the link can open it, so a forwarded link would put the opener's account in the sender's
// Waldo: the page names whose Waldo the account joins, by a masked hint only, and the browser goes on only when the
// person presses Continue. Continue is a same-origin POST, so a link unfurler or prefetcher that GETs the link never
// redirects, binds or spends the ticket.
import { bindBrowser, checkBrowser, releaseBrowser } from '../connectors/oauth-browser-binding';
import type { signedRpc } from '../identity/owner-directory';

const escape = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// The directory masks the owner's email; anything that is not that exact shape is dropped rather than shown, so a full
// address never reaches the page even if the mask were lost upstream.
const MASKED = /^[^\s@]•••@[^\s@]{1,253}$/u;
export const ownerHint = (value: unknown): string | null => (typeof value === 'string' && MASKED.test(value) ? value : null);

// A cross-site form or script cannot trigger Continue: browsers name the submitting page's origin on a form POST. The
// page's referrer policy is same-origin, not no-referrer, because no-referrer makes browsers send Origin: null.
export const confirmedHere = (request: Request): boolean => request.method === 'POST' && request.headers.get('origin') === new URL(request.url).origin;

// form-action also names the provider's origin: browsers apply it to the redirect a submitted form follows.
export const confirmPage = (input: Readonly<{ provider: string; providerOrigin: string; hint: string | null; cancel: string }>): Response => {
  const whose = input.hint ? `the Waldo of <strong>${escape(input.hint)}</strong>` : 'the Waldo that sent this link';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect ${escape(input.provider)} - Waldo</title>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--btn:#2a6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--btn:#5b93f0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{box-sizing:border-box;width:min(420px,calc(100vw - 32px));background:var(--card);border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}strong{color:var(--ink)}form{margin:0}
.button{display:inline-block;margin-top:8px;padding:12px 20px;border:0;border-radius:10px;background:var(--btn);color:#fff;text-decoration:none;font:inherit;font-weight:bold;cursor:pointer}.cancel{display:inline-block;margin-top:16px;color:var(--muted)}</style></head>
<body><main><h1>Connect ${escape(input.provider)}?</h1><p>This connects your ${escape(input.provider)} account to ${whose}.</p><p>Continue only if that is your Waldo. If someone sent you this link, cancel: continuing would give their Waldo your ${escape(input.provider)} data.</p>
<form method="post"><button class="button" type="submit">Continue to ${escape(input.provider)}</button></form><a class="cancel" href="${escape(input.cancel)}">Cancel</a></main></body></html>`;
  return new Response(html, { status: 200, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin',
    'content-security-policy': `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'self' ${input.providerOrigin}`,
  } });
};

// A connect link handed to a surface that holds the owner's session (the app) carries a one-time code in ?handoff=. The
// first GET that presents it redeems it and binds that browser to this hop; every later step of the hop needs that
// binding. So once the code is spent or past its lifetime, the link or the bare start address opened in any other
// browser binds nothing and redirects nowhere. The code does not say who opens it: whichever browser loads a coded link
// first, including one the owner forwarded unopened, is the one bound, and the confirm page's masked owner hint plus
// the Continue press is what stands between that browser and the owner's Waldo. Chat links carry no code, because no
// owner session exists there.
export const HANDOFF_PARAM = 'handoff';
const HANDOFF = /^[A-Za-z0-9_-]{22}$/;
const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
export const handoffHash = async (code: string): Promise<string> => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
// Only the hash is stored; the code goes to the session holder alone, inside the link it opens.
export const newHandoff = async (): Promise<Readonly<{ code: string; hash: string }>> => {
  const code = b64url(crypto.getRandomValues(new Uint8Array(16)));
  return { code, hash: await handoffHash(code) };
};

type Rpc = NonNullable<ReturnType<typeof signedRpc>>;
// setCookie: redeemed by this request, so its answer must carry the binding. ok alone: this browser was bound earlier.
export type HandOff = Readonly<{ ok: true; setCookie?: string }> | Readonly<{ ok: false }>;
export const handOff = async (request: Request, call: Rpc, secret: string, ticketHash: string, ttlMs: number): Promise<HandOff> => {
  const url = new URL(request.url), code = url.searchParams.get(HANDOFF_PARAM), now = Date.now();
  if ((await checkBrowser(request, secret, 'handoff', ticketHash, now)) === 'bound') return { ok: true };
  if (request.method !== 'GET' || code === null || !HANDOFF.test(code)) return { ok: false };
  const hash = await handoffHash(code);
  if ((await call('connect_session_hand_off', `connsess.handoff.${ticketHash}.${hash}`, { p_ticket_hash: ticketHash, p_handoff_hash: hash })) !== true) return { ok: false };
  return { ok: true, setCookie: await bindBrowser(secret, 'handoff', ticketHash, url.pathname, ttlMs, now) };
};
// Continue spent the ticket, so the hop's own binding goes with it.
export const releaseHandOff = (request: Request, ticketHash: string): Promise<string> => releaseBrowser('handoff', ticketHash, new URL(request.url).pathname);
export const UNHANDED = { status: 403, title: 'Start the connection again', body: 'This link works once, in the browser Waldo first opened it in, so nothing was connected. Start the connection again from the Waldo app.' } as const;
