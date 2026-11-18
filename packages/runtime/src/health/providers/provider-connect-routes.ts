import { APP_RETURN_DEEP_LINK } from '../../channels/google-oauth';
import { confirmedHere, confirmPage, handOff, ownerHint, releaseHandOff, UNHANDED, type HandOff } from '../../channels/connect-confirm';
import { checkBrowser, releaseBrowser, startRedirect, type BoundProvider } from '../../connectors/oauth-browser-binding';
import { oauthStateSecret, type OAuthStateEnv } from '../../connectors/oauth-state-secret';
import { hex, signedRpc, type OwnerDirectoryEnv } from '../../identity/owner-directory';
import { callOwnerProvider } from './provider-route';

// The public edges of a wearable provider's connection: the start link the app opens and the page the provider sends the
// owner back to. Neither carries an owner session, so each is proved another way: the start link by the one-time handoff
// code only the owner's app received and the binding it leaves in the browser the app opened, the callback by a
// single-use state and the binding the start link's Continue left in that browser.
type OwnerNamespace = Parameters<typeof callOwnerProvider>[0];
export type ConnectRoutesEnv = OwnerDirectoryEnv & OAuthStateEnv & Readonly<{
  OWNER_DO?: OwnerNamespace; RESPONSIBILITY_RATE_LIMITER?: Readonly<{ limit(options: { key: string }): Promise<{ success: boolean }> }>;
}>;
type Page = Readonly<{ status: number; title: string; body: string }>;
export type ConnectSpec<Env, Config> = Readonly<{
  // The browser binding's provider and the log hop.
  provider: BoundProvider;
  // The provider's name as the owner reads it, and its slug in rate-limit keys.
  label: string;
  slug: string;
  startPath: string;
  callbackPath: string;
  state: RegExp;
  attemptTtlMs: number;
  config(env: Env): Config | null;
  authorizeUrl(config: Config, state: string): string;
  linked: string;
  failed: string;
  // What the owner object is told besides the code, so it knows which provider's attempt this is.
  exchangeBody?: Readonly<Record<string, string>>;
}>;

const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const notFound = () => new Response('not found', { status: 404, headers: { 'cache-control': 'no-store' } });
const escape = (text: string) => text.replace(/[&<>"']/g, char => `&#${char.charCodeAt(0)};`);
const slowDown = () => new Response('slow down', { status: 429, headers: { 'cache-control': 'no-store' } });
type Session = { status?: string; do_name?: string; begun?: boolean; handoff?: boolean; owner_hint?: unknown } | null;
const resolveSession = (call: NonNullable<ReturnType<typeof signedRpc>>, hash: string) => call('connect_session_resolve', `connsess.resolve.${hash}`, { p_ticket_hash: hash }) as Promise<Session>;

export const connectRoutes = <Env extends ConnectRoutesEnv, Config>(spec: ConnectSpec<Env, Config>) => {
  const { label } = spec;
  const pages = {
    linked: { status: 200, title: `${label} is connected`, body: spec.linked },
    denied: { status: 400, title: `${label} was not connected`, body: `Access was not granted. You can connect ${label} from Waldo whenever you want to try again.` },
    expired: { status: 410, title: 'This link has expired', body: 'This connect link has run out. Start the connection again from Waldo.' },
    used: { status: 410, title: 'This link was already used', body: 'Each connect link starts one sign-in. Start the connection again from the Waldo app.' },
    cancelled: { status: 200, title: `${label} was not connected`, body: 'Nothing was connected. You can go back to the app.' },
    unhanded: UNHANDED,
    unbound: { status: 403, title: 'Start the connection again', body: `This sign-in came back to a different browser from the one that started it, or it took too long, so nothing was connected. Connect ${label} again from the Waldo app.` },
    consent_required: { status: 403, title: `${label} was not connected`, body: `Waldo needs your consent to store your ${label} data and use it with AI to plan your day. Give both in Waldo, then connect again.` },
    invalid: { status: 400, title: 'This link is not valid', body: 'It may have been copied incompletely. Start the connection again from Waldo.' },
    already_linked: { status: 409, title: `That ${label} account is already connected`, body: `It is connected to another Waldo. Disconnect it there first, or use a different ${label} account.` },
    failed: { status: 502, title: `${label} could not be connected`, body: spec.failed },
  } as const satisfies Record<string, Page>;

  // The callback URL carries the authorization code, so the page is never cached, framed or sent as a referrer, and the
  // code and state leave the address bar as soon as it loads.
  const page = (outcome: keyof typeof pages): Response => {
    const shown = pages[outcome];
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(shown.title)} - Waldo</title><script>history.replaceState(null, '', location.pathname);</script>
<style>:root{color-scheme:light dark;--bg:#f7f7f5;--card:#fff;--ink:#1c1c1a;--muted:#6b6b66;--ok:#1f7a4d;--bad:#b3261e;--btn:#2a6fdb}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1f1f1d;--ink:#ecece8;--muted:#a3a39c;--ok:#5cc28f;--bad:#f2837a;--btn:#5b93f0}}
body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.5 system-ui,-apple-system,sans-serif}
main{box-sizing:border-box;width:min(420px,calc(100vw - 32px));background:var(--card);border-radius:16px;padding:32px 24px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.mark{width:56px;height:56px;margin:0 auto 16px;border-radius:50%;display:grid;place-items:center;font-size:28px;color:#fff;background:var(${outcome === 'linked' ? '--ok' : '--bad'})}
h1{font-size:22px;margin:0 0 8px}p{margin:0 0 16px;color:var(--muted)}.button{display:inline-block;margin-top:8px;padding:12px 20px;border-radius:10px;background:var(--btn);color:#fff;text-decoration:none;font-weight:bold}</style></head>
<body><main><div class="mark" aria-hidden="true">${outcome === 'linked' ? '&#10003;' : '!'}</div><h1>${escape(shown.title)}</h1><p>${escape(shown.body)}</p><a class="button" href="${APP_RETURN_DEEP_LINK}">Back to the app</a></main></body></html>`;
    return new Response(html, { status: shown.status, headers: {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
      'content-security-policy': "default-src 'none'; script-src 'sha256-BSHIA8uyEksveTZNsWDdE7q9p6Oqa/LdAOuySBi6RJg='; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
    } });
  };

  const log = (code: string, ok = false) => console.log(JSON.stringify({ trace: spec.provider, hop: `${spec.provider}_edge`, ok, code }));
  const throttled = async (env: Env, request: Request, route: string): Promise<boolean> =>
    Boolean(env.RESPONSIBILITY_RATE_LIMITER) && !(await env.RESPONSIBILITY_RATE_LIMITER!.limit({ key: `${spec.slug}-${route}:${request.headers.get('cf-connecting-ip') ?? 'unknown'}` })).success;

  // The app opens this link, never the provider's page directly. GET shows whose Waldo the account joins and changes nothing
  // a later visit would notice; only the Continue POST spends the attempt, binds this browser and hands it to the provider,
  // so the callback accepts only the browser that pressed Continue.
  const start = async (request: Request, env: Env): Promise<Response> => {
    const config = spec.config(env), call = signedRpc(env), bindingSecret = oauthStateSecret(env);
    if (!['GET', 'POST'].includes(request.method) || !config || !call || !bindingSecret) return notFound();
    const url = new URL(request.url);
    const state = url.pathname.slice(spec.startPath.length);
    if (!spec.state.test(state)) { log('bad_state'); return page('invalid'); }
    if (request.method === 'GET' && url.searchParams.has('cancelled')) return page('cancelled');
    try { if (await throttled(env, request, 'start')) return slowDown(); } catch { return page('failed'); }
    const hash = await sha256(state);
    let session: Session;
    try { session = await resolveSession(call, hash); } catch { log('resolve_failed'); return page('failed'); }
    if (session?.status === 'expired') return page('expired');
    if (session?.status !== 'ok') { log('unknown_state'); return page('invalid'); }
    if (session.begun) { log('used'); return page('used'); }
    let handed: HandOff = { ok: true };
    if (session.handoff) {
      try { handed = await handOff(request, call, bindingSecret, hash, spec.attemptTtlMs); } catch { log('handoff_failed'); return page('failed'); }
      if (!handed.ok) { log('unhanded'); return page('unhanded'); }
    }
    if (request.method === 'GET') {
      const confirm = confirmPage({ provider: label, providerOrigin: new URL(spec.authorizeUrl(config, state)).origin, hint: ownerHint(session.owner_hint), cancel: `${url.pathname}?cancelled` });
      if (handed.setCookie) confirm.headers.append('set-cookie', handed.setCookie);
      return confirm;
    }
    if (!confirmedHere(request)) { log('cross_site'); return page('invalid'); }
    let begun: Session;
    try { begun = await call('connect_session_begin', `connsess.begin.${hash}`, { p_ticket_hash: hash }) as Session; } catch { log('begin_failed'); return page('failed'); }
    if (begun?.status !== 'ok') { log('used'); return page('used'); }
    log('started', true);
    const redirect = await startRedirect(bindingSecret, spec.provider, state, spec.authorizeUrl(config, state), spec.callbackPath, spec.attemptTtlMs);
    if (session.handoff) redirect.headers.append('set-cookie', await releaseHandOff(request, hash));
    return redirect;
  };

  // The provider sends the owner back here. The state names one attempt, started by that owner's own app; the owner's object
  // does the exchange, so the token never passes through this Worker.
  const callback = async (request: Request, env: Env): Promise<Response> => {
    const secret = env.WALDO_ROUTER_HMAC_SECRET, owners = env.OWNER_DO, call = signedRpc(env), bindingSecret = oauthStateSecret(env);
    if (request.method !== 'GET' || !spec.config(env) || !secret || !owners || !call || !bindingSecret) return notFound();
    const params = new URL(request.url).searchParams;
    const state = params.get('state') ?? '', error = params.get('error'), code = params.get('code');
    if (!spec.state.test(state)) { log('bad_state'); return page(error ? 'denied' : 'invalid'); }
    // Checked before anything else is asked, so a callback landing in a browser that did not start the attempt neither links
    // nor settles it. Without PKCE, a code injected into the starting browser is not stopped here.
    const browser = await checkBrowser(request, bindingSecret, spec.provider, state, Date.now());
    if (browser !== 'bound') { log(`browser_${browser}`); return page('unbound'); }
    try { if (await throttled(env, request, 'callback')) return slowDown(); } catch { return page('failed'); }
    const settled = await settle(state, error, code, call, owners, secret);
    settled.headers.append('set-cookie', await releaseBrowser(spec.provider, state, spec.callbackPath));
    return settled;
  };

  const settle = async (state: string, error: string | null, code: string | null, call: NonNullable<ReturnType<typeof signedRpc>>, owners: OwnerNamespace, secret: string): Promise<Response> => {
    const hash = await sha256(state);
    let session: Session;
    try { session = await resolveSession(call, hash); } catch { log('resolve_failed'); return page('failed'); }
    if (!session) { log('unknown_state'); return page('invalid'); }
    if (session.status === 'expired') return page('expired');
    if (session.status !== 'ok' || !session.do_name) return page('invalid');
    const answer = await callOwnerProvider(owners, secret, session.do_name, 'exchange', { ...spec.exchangeBody, code: code ?? null, denied: Boolean(error) || !code });
    const outcome = answer?.json.outcome;
    if (outcome === 'linked') { await call('connect_session_complete', `connsess.complete.${hash}`, { p_ticket_hash: hash }).catch(() => undefined); log('linked', true); return page('linked'); }
    log(typeof outcome === 'string' ? outcome : 'owner_unreachable');
    return page(outcome === 'denied' || outcome === 'already_linked' || outcome === 'consent_required' ? outcome : 'failed');
  };

  return { start, callback, page };
};
