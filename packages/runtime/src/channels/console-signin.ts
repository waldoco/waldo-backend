import {OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH} from './dashboard-owner-controls';
import {MEMORY_CONTROL_PATH} from './dashboard-memory-actions';
import {CONTROLS_PATH} from './dashboard-controls';
import {CONTROL_ACTION_PATH} from './dashboard-control-actions';
import { handleSignup, CONSOLE_SIGNUP_PATH, legalLinks } from './console-signup';
import { MEMORY_GRAPH_PATH } from './memory-graph';
import { consoleLog, consoleTrace, withConsoleTrace } from '../observability/console-correlation';
import { CONSOLE_SESSION_IDLE_MS, CONSOLE_SESSION_LIFETIME_MS, CONSOLE_STEP_UP_MS, consoleAuth, fromAnotherSite, OWNER_COOKIE, type ConsoleAuth } from '../identity/console-auth';
import { googlePkceCookie, readGoogleSignIn, startGoogleSignIn } from '../identity/google-pkce';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { CONSOLE_ACTION_PATH, CONSOLE_COOKIE, CONSOLE_PATH, clearConsoleCookie, consoleCookie, grantHeaders } from './console';
import { CONSOLE_DEVICES_PATH } from '../devices/contract';
import { WHATSAPP_LINK_TARGET, whatsappLinkToken } from '../identity/whatsapp-link';
import { DASHBOARD_OVERVIEW_PATH, DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { DASHBOARD_ACCESS_LOG_PATH } from './dashboard-access-log';
import { clearOwnerCookie, consoleSignoutKind, prepareConsoleSignout, signedOut } from './console-signout';
import { fenceSession, ownerSessionHash } from './session-fence';
import { DASHBOARD_ADMIN_HEALTH_PATH, DASHBOARD_HEALTH_PATH } from './dashboard-health';

export const CONSOLE_SIGNIN_PATH = `${CONSOLE_PATH}/signin`;
export const CONSOLE_VERIFY_PATH = `${CONSOLE_PATH}/verify`;
export const CONSOLE_GOOGLE_PATH = `${CONSOLE_SIGNIN_PATH}/google`;
export const CONSOLE_GOOGLE_CALLBACK_PATH = `${CONSOLE_GOOGLE_PATH}/callback`;

// Auth-specific fixed-window limits (per email, and per IP across both endpoints), enforced in
// the owner directory so they hold globally: OTP send 5 per 15 min, verify 10 per 15 min,
// IP 30 per 15 min. The per-location binding stays as a coarse first pass on top.
export const CONSOLE_OTP_SEND_LIMIT = 5;
export const CONSOLE_OTP_VERIFY_LIMIT = 10;
export const CONSOLE_AUTH_IP_LIMIT = 30;
export const CONSOLE_AUTH_WINDOW_SECONDS = 15 * 60;

// CONSOLE_GOOGLE_SIGNIN "1" offers Google on the sign-in page; it needs the callback on Supabase's redirect allow list first.
type ConsoleEnv = OwnerDirectoryEnv & Readonly<{ OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit; CONSOLE_GOOGLE_SIGNIN?: string }>;
// The dashboard's JSON reads and writes: a signed-out call gets a JSON 401 and every answer keeps the dashboard's headers.
const dashboardJson = (url: URL, request: Request) =>
  [DASHBOARD_OVERVIEW_PATH,MEMORY_GRAPH_PATH,CONTROLS_PATH,CONTROL_ACTION_PATH,MEMORY_CONTROL_PATH,OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH,DASHBOARD_HEALTH_PATH,DASHBOARD_ADMIN_HEALTH_PATH,DASHBOARD_ACCESS_LOG_PATH].includes(url.pathname)
  ||(url.pathname.startsWith('/console/workspace')&&request.headers.get('accept')==='application/json');

const DOWNLOAD_RETURN_PATTERN = /^\/console\/workspace\/file\?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})&revision=([1-9]\d*)$/;
// A continuation is a read-only file locator, never an arbitrary redirect or grant.
export const downloadReturnTarget = (values: readonly unknown[]): string | null => {
  if (values.length !== 1 || typeof values[0] !== 'string') return null;
  const raw = values[0];
  const match = DOWNLOAD_RETURN_PATTERN.exec(raw);
  return match && Number.isSafeInteger(Number(match[2])) ? raw : null;
};
// Seamless Mac pairing: Kennel opens /console/devices; a signed-out owner returns there after
// sign-in. Exactly that path, never an arbitrary redirect. A WhatsApp link confirm page returns the
// same way: it is read-only, and binding still takes the confirm on that page.
const redirectReturnTarget = (values: readonly unknown[]): string | null =>
  values.length !== 1 || typeof values[0] !== 'string' ? null : values[0] === CONSOLE_DEVICES_PATH || whatsappLinkToken(values[0]) ? values[0] : null;
export const consoleReturnTarget = (values: readonly unknown[]): string | null =>
  redirectReturnTarget(values) ?? downloadReturnTarget(values);
const returnField = (target: string | null) => target ? `<input type="hidden" name="return_to" value="${esc(target)}">` : '';
const esc = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const page = (body: string, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo console</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;display:grid;place-items:center;min-height:100vh;margin:0}main{display:grid;gap:16px;width:min(320px,90vw)}form{display:grid;gap:12px;width:100%}input,button{font:inherit;font-size:17px;padding:12px;border-radius:10px;border:1px solid #ccc}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #5267AF;outline-offset:3px}label{font:bold 1rem system-ui,sans-serif}button:disabled{opacity:.65;cursor:wait}button{border:0;background:#1A1A1A;color:#FAFAF8;cursor:pointer}button.secondary{background:transparent;color:#1A1A1A;border:1px solid #ccc}a.alt{font-size:17px;padding:12px;border-radius:10px;border:1px solid #ccc;color:#1A1A1A;text-align:center;text-decoration:none}h1{margin:0}p{margin:0}.help{color:#555;font-size:15px}</style></head><body><main>${body}<p id="signin-progress" role="status" aria-live="polite"></p><button id="signin-cancel" type="button" hidden>Stop waiting</button></main><script>
(() => {
  let main = document.querySelector('main');
  let pending = null;
  let generation = 0;
  let uncertain = false;
  const uncertainNote = 'Could not confirm the result. The request may have completed. Check your email before requesting another code.';
  const screens = new Map();
  // Matches the email provider's own wait between codes to one address. Shown here only, so the server's answer is
  // the same for every address.
  const RESEND_WAIT_MS = 60000;
  let resendAt = 0;
  let resendTimer = false;
  const holdResend = () => {
    const resend = main.querySelector('#signin-resend');
    if (!resend) return;
    const left = Math.ceil((resendAt - Date.now()) / 1000);
    if (left > 0) {
      resend.disabled = true;
      resend.textContent = 'Send a new code in ' + left + ' s';
      if (!resendTimer) { resendTimer = true; setTimeout(() => { resendTimer = false; holdResend(); }, 1000); }
    } else {
      resend.textContent = 'Send a new code';
      if (!pending) resend.disabled = false;
    }
  };
  const phase = () => main.querySelector('#signin-download') ? 'download' : main.querySelector('#signin-code') ? 'code' : 'details';
  const clearCode = () => { const code = main.querySelector('#signin-code'); if (code) code.value = ''; };
  const reset = () => {
    main.querySelectorAll('button').forEach(button => { button.disabled = false; });
    main.querySelectorAll('form').forEach(form => { form.removeAttribute('aria-busy'); });
    main.querySelector('#signin-cancel').hidden = true;
    main.querySelector('#signin-progress').textContent = uncertain ? uncertainNote : '';
    clearCode();
    holdResend();
  };
  const stop = () => {
    generation++;
    if (pending) { uncertain = true; pending.abort(); }
    pending = null;
    reset();
  };
  const remember = () => {
    const screen = main.cloneNode(true);
    const code = screen.querySelector('#signin-code');
    if (code) code.value = '';
    // Each phase keeps its own recipient; unsent edits cannot retarget an outstanding code.
    screens.set(phase(), screen);
  };
  const show = screen => {
    const next = screen.cloneNode(true);
    main.replaceWith(next);
    main = next;
    reset();
    main.querySelector('input:not([type="hidden"])')?.focus();
  };
  const allowedAction = form => {
    const url = new URL(form.action, location.href);
    return url.origin === location.origin && !url.search && !url.hash &&
      ['/console/signin', '/console/verify'].includes(url.pathname) && form.method.toLowerCase() === 'post';
  };
  history.replaceState({ waldoSignin: phase() }, '', location.href);
  remember();
  if (phase() === 'code') { resendAt = Date.now() + RESEND_WAIT_MS; holdResend(); }
  document.addEventListener('submit', async event => {
    const form = event.target;
    if (!allowedAction(form)) return;
    event.preventDefault();
    if (pending) return;
    const action = new URL(form.action, location.href).href;
    const body = new URLSearchParams(new FormData(form));
    clearCode();
    remember();
    uncertain = false;
    const attempt = ++generation;
    const controller = new AbortController();
    pending = controller;
    form.setAttribute('aria-busy', 'true');
    main.querySelector('#signin-progress').textContent = form.dataset.pending;
    main.querySelectorAll('button').forEach(button => { button.disabled = true; });
    const cancel = main.querySelector('#signin-cancel');
    cancel.disabled = false;
    cancel.hidden = false;
    try {
      const response = await fetch(action, { method: 'POST', body, mode: 'same-origin',
        credentials: 'same-origin', cache: 'no-store', redirect: 'follow', signal: controller.signal });
      if (attempt !== generation) return;
      const destination = new URL(response.url);
      if (response.redirected) {
        if (action === location.origin + '/console/verify' && response.ok &&
          destination.origin === location.origin && !destination.search && !destination.hash &&
          (destination.pathname === '/console' || (destination.pathname === '${CONSOLE_DEVICES_PATH}' && body.get('return_to') === '${CONSOLE_DEVICES_PATH}') ||
            (destination.pathname === body.get('return_to') && new RegExp(${JSON.stringify(WHATSAPP_LINK_TARGET.source)}).test(destination.pathname)))) {
          // The devices page answers a navigation with the console route it moved to. fetch drops that
          // fragment, so a Kennel sign-in navigates to the page itself and lets the browser keep it.
          // A dashboard page lives in the fragment, which the redirect to sign-in kept. The path stays the console's.
          const back = location.hash && location.hash.startsWith('#/') && location.hash.length <= 512 ? location.hash : '';
          location.assign(body.get('return_to') === '${CONSOLE_DEVICES_PATH}' ? '${CONSOLE_DEVICES_PATH}' : destination.pathname === '/console' ? '/console' + back : destination.pathname);
          return;
        }
        throw new Error('Unexpected redirect');
      }
      if (!response.ok || destination.href !== action || !response.headers.get('content-type')?.includes('text/html')) throw new Error('Unexpected response');
      const html = await response.text();
      if (attempt !== generation) return;
      const next = new DOMParser().parseFromString(html, 'text/html').querySelector('main');
      const download = next?.querySelector('#signin-download');
      // Terminal HTML leaves the binary for a real browser navigation, never fetch.
      if (action === location.origin + '/console/verify' && download &&
        next.querySelector('#signin-progress') && next.querySelector('#signin-cancel') && !next.querySelectorAll('form').length &&
        download.getAttribute('href') === body.get('return_to') &&
        new RegExp(${JSON.stringify(DOWNLOAD_RETURN_PATTERN.source)}).test(download.getAttribute('href')) &&
        Number.isSafeInteger(Number(new URL(download.getAttribute('href'), location.origin).searchParams.get('revision')))) {
        uncertain = false;
        show(next);
        remember();
        history.pushState({ waldoSignin: phase() }, '', location.href);
        return;
      }
      if (!next || !next.querySelector('#signin-progress') || !next.querySelector('#signin-cancel') ||
        !next.querySelectorAll('form').length || Array.from(next.querySelectorAll('form')).some(form => !allowedAction(form))) throw new Error('Unexpected form');
      uncertain = false;
      const previousPhase = phase();
      show(next);
      if (action === location.origin + '/console/signin' && phase() === 'code') { resendAt = Date.now() + RESEND_WAIT_MS; holdResend(); }
      remember();
      if (phase() !== previousPhase) history.pushState({ waldoSignin: phase() }, '', location.href);
    } catch {
      if (attempt !== generation) return;
      uncertain = true;
      reset();
    } finally {
      if (attempt === generation) pending = null;
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('#signin-cancel')) return;
    stop();
    main.querySelector('#signin-progress').textContent = 'Stopped waiting. The request may have completed. Check your email before requesting another code.';
  });
  window.addEventListener('popstate', event => {
    remember();
    stop();
    const screen = screens.get(event.state?.waldoSignin);
    if (screen) show(screen);
  });
  window.addEventListener('pageshow', stop);
  window.addEventListener('pagehide', stop);
})();
</script></body></html>`,
  // same-origin, as on signup: a browser without Sec-Fetch-Site still names the console as the Origin of these forms.
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'same-origin' } },
);
const DAY_MS = 24 * 60 * 60_000;
const staysSignedIn = `<p class="help">You stay signed in on this browser for up to ${CONSOLE_SESSION_LIFETIME_MS / DAY_MS} days while you keep using it, and sign in again after ${CONSOLE_SESSION_IDLE_MS / DAY_MS} days away. On a shared computer, sign out when you finish.</p>`;
// Sign-in is for members. A new member joins through the invite signup, which spends the invite.
const joinLink = `<p class="help">New to Waldo? <a href="${CONSOLE_SIGNUP_PATH}">Join with your invite</a>.</p>`;
// Confirm mode is the step-up before an action that creates lasting access: the same email code, in a browser that stays
// signed in, back to the page the owner came from.
const confirmIntro = `<h1>Confirm it's you</h1><p>Pairing a Mac, linking a chat, connecting an account or tool, letting a tool run without asking, inviting someone and deleting your account need an email code from the last ${CONSOLE_STEP_UP_MS / 3_600_000} hours. Enter your email and Waldo sends you one; this browser stays signed in.</p>`;
const googleLink = (target: string | null) => `<a class="alt" id="signin-google" href="${CONSOLE_GOOGLE_PATH}${target ? `?return_to=${encodeURIComponent(target)}` : ''}">Continue with Google</a>`;
const signinEmailForm = (note = '', email = '', target: string | null = null, confirming = false, google = false) => page(`${target === CONSOLE_DEVICES_PATH ? `<p>Sign in to pair your Mac with Waldo. Already signed in on this browser? <a href="${CONSOLE_DEVICES_PATH}">Continue to your devices</a>.</p>` : target && whatsappLinkToken(target) ? `<p>Sign in to link your WhatsApp number to Waldo. You will confirm the number on the next page.</p>` : target ? `<p>Already signed in on this browser? <a href="${esc(target)}">Continue to download</a>. Otherwise, sign in below to open your file.</p>` : ''}<form method="post" action="${CONSOLE_SIGNIN_PATH}" data-pending="Requesting an email code…">${returnField(target)}${confirming ? confirmIntro : '<h1>Sign in to Waldo</h1><p>Enter your email and Waldo sends you a sign-in code.</p>'}${note ? `<p role="alert">${esc(note)}</p>` : ''}<label for="signin-email">Email address</label><input id="signin-email" name="email" value="${esc(email)}" type="email" autocomplete="email" required placeholder="you@example.com"><button>Email me a code</button></form>${confirming ? '' : `${google ? googleLink(target) : ''}${staysSignedIn}${joinLink}${legalLinks}`}`);
// The default status is the same for every address, so this page never says who is a member.
// link: the Google identity this code also confirms; it rides along with every form on the page.
const linkField = (link: string | null) => link ? `<input type="hidden" name="link" value="${esc(link)}">` : '';
const signinCodeForm = (email: string, note = '', target: string | null = null, link: string | null = null) => page(`<form method="post" action="${CONSOLE_VERIFY_PATH}" data-pending="Checking your code…">${returnField(target)}${linkField(link)}<h1>Check your email</h1><p role="status">${note ? esc(note) : `If ${esc(email)} belongs to a Waldo member, a sign-in code was requested for it. It can take a minute to arrive; check spam too.`}</p><input type="hidden" name="email" value="${esc(email)}"><label for="signin-code">Email sign-in code</label><input id="signin-code" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="Code from the email"><button>Sign in</button></form><form method="post" action="${CONSOLE_SIGNIN_PATH}" data-pending="Requesting an email code…">${returnField(target)}${linkField(link)}<input type="hidden" name="email" value="${esc(email)}"><button id="signin-resend" class="secondary">Send a new code</button></form><form method="post" action="${CONSOLE_SIGNIN_PATH}" data-pending="Opening your details…">${returnField(target)}<input type="hidden" name="intent" value="edit"><input type="hidden" name="email" value="${esc(email)}"><button class="secondary">Use a different email</button></form>${joinLink}`);

// With Supabase configured, the console signs in by email code (invite-required for new members) and a signed owner cookie picks the owner DO.
// Returns null when Supabase is not configured; the caller keeps the Telegram one-time link sign-in.
export const handleConsole = async (request: Request, env: ConsoleEnv, auth: ConsoleAuth | null = consoleAuth(env), requestTrace: string = consoleTrace()): Promise<Response | null> => {
  if (new URL(request.url).pathname === CONSOLE_SIGNUP_PATH || new URL(request.url).pathname.startsWith(`${CONSOLE_SIGNUP_PATH}/`)) return withConsoleTrace(await handleSignup(request, env, auth, undefined, requestTrace), requestTrace);
  const owners = env.OWNER_DO;
  if (!auth || !owners) return null;
  const url = new URL(request.url);
  const trace = requestTrace;
  const event = (hop: string, ok: boolean, code: string) => consoleLog(trace, hop, ok, code);
  const finish = (response: Response) => withConsoleTrace(response, trace);
  const resume = request.method === 'GET' ? consoleReturnTarget([url.pathname + url.search]) : null;
  const signin = () => new Response(null, { status: 303, headers: { location: resume ? `${CONSOLE_SIGNIN_PATH}?return_to=${encodeURIComponent(resume)}` : CONSOLE_SIGNIN_PATH } });
  let target = consoleReturnTarget(url.searchParams.getAll('return_to'));
  const google = env.CONSOLE_GOOGLE_SIGNIN === '1' && Boolean(env.SUPABASE_PROJECT_URL && env.WALDO_ROUTER_HMAC_SECRET && auth.signInWithAuthCode);
  const emailForm = (note = '', email = '') => signinEmailForm(note, email, target, url.searchParams.get('confirm') === '1', google);
  let link: string | null = null;
  const codeForm = (email: string, note = '') => signinCodeForm(email, note, target, link);
  const formLink = (form: FormData) => { const value = form.get('link'); return typeof value === 'string' && value.length > 0 && value.length <= 2048 ? value : null; };
  // The owner's console session, the same whichever way they proved their email. retry is the page to show on a failure.
  const signInOwner = async (doName: string, hop: string, retry: (note: string) => Response, cookies: readonly string[] = []): Promise<Response> => {
    const withCookies = (response: Response) => { cookies.forEach(cookie => response.headers.append('set-cookie', cookie)); return finish(response); };
    const grant = await owners.get(owners.idFromName(doName))
      .fetch('https://telegram-owner/grant-console', { method: 'POST', headers: grantHeaders(doName, request) });
    if (!grant.ok) {
      event(hop, false, 'grant_failed');
      return withCookies(retry('Sign-in is having trouble. Try again in a moment.'));
    }
    let ownerCookieValue: string | null;
    try { ownerCookieValue = await auth.ownerCookie(doName, request); }
    catch { ownerCookieValue = null; }
    if (ownerCookieValue === null) {
      event(hop, false, 'session_unavailable');
      return withCookies(retry('Sign-in is having trouble. Try again in a moment.'));
    }
    const terminal = target && !redirectReturnTarget([target]) ? page(`<h1>Signed in</h1><p>Your file still requires access from the account you signed in with.</p><a id="signin-download" href="${esc(target)}">Download your file</a><p><a href="${CONSOLE_PATH}">Open your console</a></p>`) : null;
    const headers = new Headers(terminal?.headers ?? { location: target ?? CONSOLE_PATH });
    headers.append('set-cookie', consoleCookie(CONSOLE_COOKIE, await grant.text()));
    headers.append('set-cookie', consoleCookie(OWNER_COOKIE, ownerCookieValue));
    event(hop, true, 'signed_in');
    return withCookies(new Response(terminal?.body ?? null, { status: terminal ? 200 : 303, headers }));
  };
  if (url.pathname === CONSOLE_GOOGLE_PATH && request.method === 'GET') {
    // Another site may link here, but only this console starts the flow, so a visit it did not start sets no verifier.
    if (!google || fromAnotherSite(request)) return finish(new Response(null, { status: 303, headers: { location: CONSOLE_SIGNIN_PATH } }));
    const started = await startGoogleSignIn(env.WALDO_ROUTER_HMAC_SECRET!, env.SUPABASE_PROJECT_URL!, `${url.origin}${CONSOLE_GOOGLE_CALLBACK_PATH}`, CONSOLE_GOOGLE_PATH, target, Date.now());
    event('console_google', true, 'started');
    return finish(new Response(null, { status: 303, headers: { location: started.location, 'set-cookie': started.cookie } }));
  }
  // Supabase sends the browser back here from its own site, so this is the one sign-in step that a cross-site visit may
  // finish: without this browser's verifier the code cannot be exchanged.
  if (url.pathname === CONSOLE_GOOGLE_CALLBACK_PATH && request.method === 'GET') {
    const spent = googlePkceCookie(CONSOLE_GOOGLE_PATH, '', 0);
    const back = (code: string, note: string) => { event('console_google', false, code); const response = emailForm(note); response.headers.append('set-cookie', spent); return finish(response); };
    const started = google ? await readGoogleSignIn(env.WALDO_ROUTER_HMAC_SECRET!, request, Date.now()) : null;
    if (!started) return back('no_verifier', 'Google sign-in timed out or began in another browser. Try again.');
    target = consoleReturnTarget([started.target]);
    const code = url.searchParams.get('code');
    if (!code || code.length > 512) return back('not_finished', 'Google sign-in did not finish. Try again, or use an email code.');
    if (!env.RESPONSIBILITY_RATE_LIMITER) return back('limiter_absent', 'Sign-in is temporarily unavailable. Try again shortly.');
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    let admitted = false;
    try {
      admitted = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-google-ip:${ip}` })).success
        && await auth.throttle(`ip:${ip}`, CONSOLE_AUTH_IP_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS);
    } catch { admitted = false; }
    if (!admitted) return back('throttled', 'Too many attempts. Try again in a few minutes.');
    let signedIn: Awaited<ReturnType<NonNullable<ConsoleAuth['signInWithAuthCode']>>>;
    try { signedIn = await auth.signInWithAuthCode!(code, started.verifier); }
    catch { return back('verification_unavailable', 'Sign-in is temporarily unavailable. Try again shortly.'); }
    if (signedIn.state === 'refused') return back(signedIn.reason === 'token' ? 'code_refused' : 'no_email', 'Google did not confirm that sign-in. Try again, or use an email code.');
    // The person proved they hold this Google address, so saying it has no account tells them only about themselves.
    if (signedIn.state === 'needs_invite') return back('not_member', 'No Waldo account uses that Google address. Sign in with the email you were invited with, or join with your invite.');
    if (signedIn.state === 'confirm') {
      // A Google account this owner has never signed in with: the mailbox confirms it before anything is signed in.
      let sent = false;
      try { sent = await auth.throttle(`send:${signedIn.email}`, CONSOLE_OTP_SEND_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS) && await auth.sendCode(signedIn.email); }
      catch { sent = false; }
      if (!sent) return back('confirm_unsent', 'Sign-in is having trouble. Try again in a few minutes, or use an email code.');
      event('console_google', true, 'confirm_sent');
      link = signedIn.link;
      const response = codeForm(signedIn.email, `This is the first time this Google account signs in to your Waldo account. To confirm it, enter the code we emailed to ${signedIn.email}.`);
      response.headers.append('set-cookie', spent);
      return finish(response);
    }
    return signInOwner(signedIn.doName, 'console_google', emailForm, [spent]);
  }
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'GET') return finish(emailForm());
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'POST') {
    const form = await request.formData();
    target = consoleReturnTarget(form.getAll('return_to'));
    link = formLink(form);
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    if (form.get('intent') === 'edit') return finish(emailForm('Check your email address, then request a code.', email));
    if (!email.includes('@')) return finish(emailForm('Enter your email address.', email));
    // OTP bombing guard: per-email and per-IP throttle, fail-closed: a public signup endpoint
    // without its limiter refuses codes rather than spraying OTPs.
    if (!env.RESPONSIBILITY_RATE_LIMITER) {
      event('console_signin', false, 'limiter_absent');
      return finish(emailForm('Sign-in is temporarily unavailable. Try again shortly.', email));
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const emailOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin:${email}` })).success;
    const ipOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin-ip:${ip}` })).success;
    if (!emailOk || !ipOk) {
      event('console_signin', false, 'rate_limited');
      return finish(emailForm('Too many attempts. Wait a minute and try again.', email));
    }
    const address = email.trim().toLowerCase();
    let admitted = false;
    try {
      admitted = (await auth.throttle(`send:${address}`, CONSOLE_OTP_SEND_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS))
        && (await auth.throttle(`ip:${ip}`, CONSOLE_AUTH_IP_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS));
    } catch {
      admitted = false;
    }
    if (!admitted) {
      event('console_signin', false, 'throttled');
      return finish(emailForm('Too many attempts. Try again in a few minutes.', email));
    }
    // A refused send (the provider's wait between codes, or an outage) answers like any other: a different page
    // would tell anyone which addresses are members. The log keeps the difference.
    let sent: boolean;
    try { sent = await auth.sendCode(email); }
    catch {
      event('console_signin', false, 'email_send_unconfirmed');
      return finish(codeForm(email));
    }
    event('console_signin', sent, sent ? 'sent' : 'not_allowed');
    return finish(codeForm(email));
  }
  if (url.pathname === CONSOLE_VERIFY_PATH && request.method === 'POST') {
    const form = await request.formData();
    target = consoleReturnTarget(form.getAll('return_to'));
    link = formLink(form);
    const email = String(form.get('email') ?? '');
    // A verification code is guessable, so verify attempts are throttled like code sends,
    // fail-closed: without the limiter this public endpoint refuses rather than allowing
    // unlimited guesses.
    if (!env.RESPONSIBILITY_RATE_LIMITER) {
      event('console_verify', false, 'limiter_absent');
      return finish(codeForm(email, 'Sign-in is temporarily unavailable. Try again shortly.'));
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const address = email.trim().toLowerCase();
    const emailOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-verify:${address}` })).success;
    const ipOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-verify-ip:${ip}` })).success;
    if (!emailOk || !ipOk) {
      event('console_verify', false, 'rate_limited');
      return finish(codeForm(email, 'Too many attempts. Wait a minute and try again.'));
    }
    let admitted = false;
    try {
      admitted = (await auth.throttle(`verify:${address}`, CONSOLE_OTP_VERIFY_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS))
        && (await auth.throttle(`ip:${ip}`, CONSOLE_AUTH_IP_LIMIT, CONSOLE_AUTH_WINDOW_SECONDS));
    } catch {
      admitted = false;
    }
    if (!admitted) {
      event('console_verify', false, 'throttled');
      return finish(codeForm(email, 'Too many attempts. Try again in a few minutes.'));
    }
    let doName: string | null;
    try { doName = link ? await auth.verify(email, String(form.get('code') ?? ''), undefined, undefined, link) : await auth.verify(email, String(form.get('code') ?? '')); }
    catch {
      event('console_verify', false, 'verification_unavailable');
      return finish(codeForm(email, 'Verification is temporarily unavailable. Try again shortly.'));
    }
    if (!doName) {
      event('console_verify', false, 'invalid');
      return finish(codeForm(email, 'That code did not work. A code works once and expires after a while: enter the newest one, or send a new code.'));
    }
    return signInOwner(doName, 'console_verify', note => codeForm(email, note));
  }
  // D1: sign-out-everywhere. Drops every server-side session, so all live cookies - including
  // this one - die at their next validation, then clears the cookies on this browser too.
  if (url.pathname === `${CONSOLE_PATH}/signout-all` && request.method === 'POST') {
    const doName = await auth.readOwnerCookie(request);
    if (doName) {
      // The sessions about to be revoked, so their console and app turns can be stopped after; at least this browser's.
      let hashes: readonly string[];
      try { hashes = (await auth.listSessions(doName)).map(row => row.session); }
      catch { const own = await ownerSessionHash(request); hashes = own ? [own] : []; }
      try { await auth.signOutAll(doName); }
      catch {
        event('console_route', false, 'signout_all_unconfirmed');
        return finish(new Response('Signing out everywhere did not finish. This browser is still signed in; go back and try again.', { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } }));
      }
      await Promise.all(hashes.map(hash => fenceSession(env, owners, doName, hash)));
    }
    const headers = new Headers({ location: CONSOLE_SIGNIN_PATH });
    headers.append('set-cookie', clearConsoleCookie(CONSOLE_COOKIE));
    headers.append('set-cookie', clearConsoleCookie(OWNER_COOKIE));
    event('console_route', true, 'signed_out_all');
    return finish(new Response(null, { status: 303, headers }));
  }
  // Ticket-link sign-in belongs to the owner DO. An existing signed owner cookie,
  // however, must never be silently switched to the deploy owner's DO by a ticket
  // URL: a link minted by another owner cannot select this browser's account.
  const hasOwnerCookie = (request.headers.get('cookie') ?? '').split(';').some((part) => part.trim().startsWith(`${OWNER_COOKIE}=`));
  if (!hasOwnerCookie && url.pathname === CONSOLE_PATH && (url.searchParams.get('t') !== null || request.method === 'POST')) {
    event('console_route', true, 'ticket_passthrough');
    return null;
  }
  // Email-code sessions carry BOTH cookies. Resolve the signed owner cookie first,
  // before the ticket-session fallback: otherwise every new member's console is routed
  // to the deploy Telegram owner's DO by index.ts. An invalid owner cookie must fail
  // closed rather than falling back to someone else's ticket route.
  if (!hasOwnerCookie && (request.headers.get('cookie') ?? '').includes(`${CONSOLE_COOKIE}=`)) {
    event('console_route', true, 'ticket_session_passthrough');
    return null;
  }
  let doName: string | null;
  try { doName = await auth.readOwnerCookie(request); }
  catch {
    if (dashboardJson(url,request)) return finish(new Response('unauthorized', { status: 401, headers: DASHBOARD_OVERVIEW_HEADERS }));
    throw new Error('owner session validation failed');
  }
  if (!doName) {
    event('console_route', false, 'no_valid_owner_cookie');
    if (dashboardJson(url,request)) return finish(new Response('unauthorized', { status: 401, headers: DASHBOARD_OVERVIEW_HEADERS }));
    return finish(signin());
  }
  const signout = await consoleSignoutKind(request, url);
  let fenceAfter: readonly string[] = [];
  if (signout) {
    try { fenceAfter = await prepareConsoleSignout(signout, request, auth, env, owners, doName); }
    catch {
      event('console_route', false, 'signout_unconfirmed');
      const message = 'Signing out did not finish. This browser is still signed in; go back and try again.';
      return finish(url.pathname === CONSOLE_ACTION_PATH
        ? new Response(message, { status: 503, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
        : Response.json({ error: 'unavailable' }, { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }));
    }
  }
  const forwarded = new Request(request);
  forwarded.headers.set('x-waldo-do-name', doName);
  let response: Response;
  try { response = await owners.get(owners.idFromName(doName)).fetch(forwarded); }
  catch (error) {
    if (dashboardJson(url,request)) return finish(new Response('overview unavailable', { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }));
    throw error;
  }
  const routed = response.ok || (response.status >= 300 && response.status < 400);
  event('console_route', routed, routed ? 'forwarded' : 'forward_failed');
  if (signout && signedOut(response)) {
    await Promise.all(fenceAfter.map(hash => fenceSession(env, owners, doName, hash)));
    response = clearOwnerCookie(response);
  }
  if (resume && response.status === 401) return finish(signin());
  if (dashboardJson(url,request)) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) headers.set(key, value);
    return finish(new Response(response.body, { status: response.status, headers }));
  }
  return finish(response);
};
