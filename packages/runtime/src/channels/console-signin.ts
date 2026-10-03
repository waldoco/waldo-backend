import {OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH} from './dashboard-owner-controls';
import {MEMORY_CONTROL_PATH} from './dashboard-memory-actions';
import {CONTROLS_PATH} from './dashboard-controls';
import {CONTROL_ACTION_PATH} from './dashboard-control-actions';
import { handleSignup, CONSOLE_SIGNUP_PATH } from './console-signup';
import { MEMORY_GRAPH_PATH } from './memory-graph';
import { consoleLog, consoleTrace, withConsoleTrace } from '../observability/console-correlation';
import { consoleAuth, OWNER_COOKIE, type ConsoleAuth } from '../identity/console-auth';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { CONSOLE_COOKIE, CONSOLE_PATH } from './console';
import { DASHBOARD_OVERVIEW_PATH, DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';

export const CONSOLE_SIGNIN_PATH = `${CONSOLE_PATH}/signin`;
export const CONSOLE_VERIFY_PATH = `${CONSOLE_PATH}/verify`;

// Auth-specific fixed-window limits (per email, and per IP across both endpoints), enforced in
// the owner directory so they hold globally: OTP send 5 per 15 min, verify 10 per 15 min,
// IP 30 per 15 min. The per-location binding stays as a coarse first pass on top.
export const CONSOLE_OTP_SEND_LIMIT = 5;
export const CONSOLE_OTP_VERIFY_LIMIT = 10;
export const CONSOLE_AUTH_IP_LIMIT = 30;
export const CONSOLE_AUTH_WINDOW_SECONDS = 15 * 60;

type ConsoleEnv = OwnerDirectoryEnv & Readonly<{ TELEGRAM_OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit }>;

const DOWNLOAD_RETURN_PATTERN = /^\/console\/workspace\/file\?id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})&revision=([1-9]\d*)$/;
// A continuation is a read-only file locator, never an arbitrary redirect or grant.
export const downloadReturnTarget = (values: readonly unknown[]): string | null => {
  if (values.length !== 1 || typeof values[0] !== 'string') return null;
  const raw = values[0];
  const match = DOWNLOAD_RETURN_PATTERN.exec(raw);
  return match && Number.isSafeInteger(Number(match[2])) ? raw : null;
};
const returnField = (target: string | null) => target ? `<input type="hidden" name="return_to" value="${esc(target)}">` : '';
const esc = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const page = (body: string, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo console</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;display:grid;place-items:center;min-height:100vh;margin:0}main{display:grid;gap:16px;width:min(320px,90vw)}form{display:grid;gap:12px;width:100%}input,button{font:inherit;font-size:17px;padding:12px;border-radius:10px;border:1px solid #ccc}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #5267AF;outline-offset:3px}label{font:bold 1rem system-ui,sans-serif}button:disabled{opacity:.65;cursor:wait}button{border:0;background:#1A1A1A;color:#FAFAF8;cursor:pointer}</style></head><body><main>${body}<p id="signin-progress" role="status" aria-live="polite"></p><button id="signin-cancel" type="button" hidden>Stop waiting</button></main><script>
(() => {
  let main = document.querySelector('main');
  let pending = null;
  let generation = 0;
  let uncertain = false;
  const uncertainNote = 'Could not confirm the result. The request may have completed. Check your email before requesting another code.';
  const screens = new Map();
  const phase = () => main.querySelector('#signin-download') ? 'download' : main.querySelector('#signin-code') ? 'code' : 'details';
  const clearCode = () => { const code = main.querySelector('#signin-code'); if (code) code.value = ''; };
  const reset = () => {
    main.querySelectorAll('button').forEach(button => { button.disabled = false; });
    main.querySelectorAll('form').forEach(form => { form.removeAttribute('aria-busy'); });
    main.querySelector('#signin-cancel').hidden = true;
    main.querySelector('#signin-progress').textContent = uncertain ? uncertainNote : '';
    clearCode();
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
          destination.origin === location.origin && destination.pathname === '/console' && !destination.search && !destination.hash) {
          location.assign('/console');
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
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } },
);
// Legacy sign-in accepts a phone for compatibility, but cannot provision a new owner.
// Collected phone data never proves SMS verification.
export const normalizePhone = (raw: string): string | null => {
  const compact = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
};

type SigninDetails = Readonly<{ email: string; phone: string; invite: string }>;
const signinEmailForm = (note = '', details: SigninDetails = { email: '', phone: '', invite: '' }, target: string | null = null) => page(`${target ? `<p>Already signed in on this browser? <a href="${esc(target)}">Continue to download</a>. Otherwise, sign in below to open your file.</p>` : ''}<form method="post" action="${CONSOLE_SIGNIN_PATH}" data-pending="Requesting an email code…">${returnField(target)}<h1>Sign in to Waldo</h1><p><a href="/console/signup">New member? Open your invite signup</a></p>${note ? `<p role="alert">${esc(note)}</p>` : ''}<label for="signin-email">Email address</label><input id="signin-email" name="email" value="${esc(details.email)}" type="email" autocomplete="email" required placeholder="you@example.com"><label for="signin-invite">Invite code (optional for existing members)</label><input id="signin-invite" name="invite" value="${esc(details.invite)}" autocomplete="off" placeholder="Invite code (new members)"><label for="signin-phone">Phone with country code (optional, contact only, unverified)</label><input id="signin-phone" name="phone" value="${esc(details.phone)}" type="tel" autocomplete="tel" placeholder="Phone, e.g. +91 98765 43210"><button>Email me a code</button></form>`);
// Retry forms retain entered fields; sign-in resolves existing owners only.
const signinCodeForm = (email: string, phone: string, invite: string, note = '', target: string | null = null) => page(`<form method="post" action="${CONSOLE_VERIFY_PATH}" data-pending="Checking your code…">${returnField(target)}<p role="status">${note ? esc(note) : `If ${esc(email)} has access, an email code was requested. Delivery is not confirmed here.`}</p><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="invite" value="${esc(invite)}"><label for="signin-code">Email sign-in code</label><input id="signin-code" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="Code"><button>Sign in</button></form><form method="post" action="${CONSOLE_SIGNIN_PATH}" data-pending="Opening your details…">${returnField(target)}<input type="hidden" name="intent" value="edit"><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="invite" value="${esc(invite)}"><button>Request another email code / edit details</button></form>`);

// With Supabase configured, the console signs in by email code (invite-required for new members) and a signed owner cookie picks the owner DO.
// Returns null when Supabase is not configured; the caller keeps the Telegram one-time link sign-in.
export const handleConsole = async (request: Request, env: ConsoleEnv, auth: ConsoleAuth | null = consoleAuth(env), requestTrace: string = consoleTrace()): Promise<Response | null> => {
  if (new URL(request.url).pathname === CONSOLE_SIGNUP_PATH || new URL(request.url).pathname.startsWith(`${CONSOLE_SIGNUP_PATH}/`)) return withConsoleTrace(await handleSignup(request, env, auth, undefined, requestTrace), requestTrace);
  const owners = env.TELEGRAM_OWNER_DO;
  if (!auth || !owners) return null;
  const url = new URL(request.url);
  const trace = requestTrace;
  const event = (hop: string, ok: boolean, code: string) => consoleLog(trace, hop, ok, code);
  const finish = (response: Response) => withConsoleTrace(response, trace);
  const resume = request.method === 'GET' ? downloadReturnTarget([url.pathname + url.search]) : null;
  const signin = () => new Response(null, { status: 303, headers: { location: resume ? `${CONSOLE_SIGNIN_PATH}?return_to=${encodeURIComponent(resume)}` : CONSOLE_SIGNIN_PATH } });
  let target = downloadReturnTarget(url.searchParams.getAll('return_to'));
  const emailForm = (note = '', details?: SigninDetails) => signinEmailForm(note, details, target);
  const codeForm = (email: string, phone: string, invite: string, note = '') => signinCodeForm(email, phone, invite, note, target);
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'GET') return finish(emailForm());
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'POST') {
    const form = await request.formData();
    target = downloadReturnTarget(form.getAll('return_to'));
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const rawPhone = String(form.get('phone') ?? '');
    const phone = rawPhone.trim() === '' ? '' : normalizePhone(rawPhone);
    const invite = String(form.get('invite') ?? '').trim().toUpperCase();
    const details = { email, phone: rawPhone, invite };
    if (form.get('intent') === 'edit') return finish(emailForm('Check your details, then request another email code.', details));
    if (!email.includes('@')) return finish(emailForm('Enter your email address.', details));
    if (phone === null) return finish(emailForm('Enter your phone number with country code, e.g. +91 98765 43210.', details));
    // OTP bombing guard: per-email and per-IP throttle, fail-closed: a public signup endpoint
    // without its limiter refuses codes rather than spraying OTPs.
    if (!env.RESPONSIBILITY_RATE_LIMITER) {
      event('console_signin', false, 'limiter_absent');
      return finish(emailForm('Sign-in is temporarily unavailable. Try again shortly.', details));
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const emailOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin:${email}` })).success;
    const ipOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin-ip:${ip}` })).success;
    if (!emailOk || !ipOk) {
      event('console_signin', false, 'rate_limited');
      return finish(emailForm('Too many attempts. Wait a minute and try again.', details));
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
      return finish(emailForm('Too many attempts. Try again in a few minutes.', details));
    }
    let sent: boolean;
    try { sent = await auth.sendCode(email, invite); }
    catch {
      event('console_signin', false, 'email_send_unconfirmed');
      return finish(codeForm(email, phone, invite, 'We could not confirm an email code was sent. Retry a code you already received, or return to sign-in to request another.'));
    }
    event('console_signin', sent, sent ? 'sent' : 'not_allowed');
    return finish(codeForm(email, phone, invite));
  }
  if (url.pathname === CONSOLE_VERIFY_PATH && request.method === 'POST') {
    const form = await request.formData();
    target = downloadReturnTarget(form.getAll('return_to'));
    const email = String(form.get('email') ?? '');
    const rawPhone = String(form.get('phone') ?? '');
    const phone = rawPhone.trim() === '' ? '' : normalizePhone(rawPhone);
    const invite = String(form.get('invite') ?? '').trim().toUpperCase();
    const details = { email, phone: rawPhone, invite };
    if (phone === null) return finish(emailForm('Enter your phone number with country code, e.g. +91 98765 43210.', details));
    // A verification code is guessable, so verify attempts are throttled like code sends,
    // fail-closed: without the limiter this public endpoint refuses rather than allowing
    // unlimited guesses.
    if (!env.RESPONSIBILITY_RATE_LIMITER) {
      event('console_verify', false, 'limiter_absent');
      return finish(codeForm(email, phone, invite, 'Sign-in is temporarily unavailable. Try again shortly.'));
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const address = email.trim().toLowerCase();
    const emailOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-verify:${address}` })).success;
    const ipOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-verify-ip:${ip}` })).success;
    if (!emailOk || !ipOk) {
      event('console_verify', false, 'rate_limited');
      return finish(codeForm(email, phone, invite, 'Too many attempts. Wait a minute and try again.'));
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
      return finish(codeForm(email, phone, invite, 'Too many attempts. Try again in a few minutes.'));
    }
    let doName: string | null;
    try { doName = await auth.verify(email, String(form.get('code') ?? ''), phone, invite); }
    catch {
      event('console_verify', false, 'verification_unavailable');
      return finish(codeForm(email, phone, invite, 'Verification is temporarily unavailable. Try again shortly.'));
    }
    if (!doName) {
      event('console_verify', false, 'invalid');
      return finish(codeForm(email, phone, invite, 'That code did not work. Retry the code or open your invite signup link if you are a new member.'));
    }
    const grant = await owners.get(owners.idFromName(doName))
      .fetch('https://telegram-owner/grant-console', { method: 'POST', headers: { 'x-waldo-do-name': doName } });
    if (!grant.ok) {
      event('console_verify', false, 'grant_failed');
      return finish(codeForm(email, phone, invite, 'Sign-in is having trouble. Try again in a moment.'));
    }
    const ownerCookieValue = await auth.ownerCookie(doName);
    if (ownerCookieValue === null) {
      event('console_verify', false, 'session_unavailable');
      return finish(codeForm(email, phone, invite, 'Sign-in is having trouble. Try again in a moment.'));
    }
    const cookie = `Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`;
    const terminal = target ? page(`<h1>Signed in</h1><p>Your file still requires access from the account you signed in with.</p><a id="signin-download" href="${esc(target)}">Download your file</a><p><a href="${CONSOLE_PATH}">Open your console</a></p>`) : null;
    const headers = new Headers(terminal?.headers ?? { location: CONSOLE_PATH });
    headers.append('set-cookie', `${CONSOLE_COOKIE}=${await grant.text()}; ${cookie}`);
    headers.append('set-cookie', `${OWNER_COOKIE}=${ownerCookieValue}; ${cookie}`);
    event('console_verify', true, 'signed_in');
    return finish(new Response(terminal?.body ?? null, { status: terminal ? 200 : 303, headers }));
  }
  // D1: sign-out-everywhere. Drops every server-side session, so all live cookies - including
  // this one - die at their next validation, then clears the cookies on this browser too.
  if (url.pathname === `${CONSOLE_PATH}/signout-all` && request.method === 'POST') {
    const doName = await auth.readOwnerCookie(request);
    const headers = new Headers({ location: CONSOLE_SIGNIN_PATH });
    const clear = `Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
    headers.append('set-cookie', `${CONSOLE_COOKIE}=; ${clear}`);
    headers.append('set-cookie', `${OWNER_COOKIE}=; ${clear}`);
    if (doName) await auth.signOutAll(doName);
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
    if ([DASHBOARD_OVERVIEW_PATH,MEMORY_GRAPH_PATH,CONTROLS_PATH,CONTROL_ACTION_PATH,MEMORY_CONTROL_PATH,OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH].includes(url.pathname)||(url.pathname.startsWith('/console/workspace')&&request.headers.get('accept')==='application/json')) return finish(new Response('unauthorized', { status: 401, headers: DASHBOARD_OVERVIEW_HEADERS }));
    throw new Error('owner session validation failed');
  }
  if (!doName) {
    event('console_route', false, 'no_valid_owner_cookie');
    if ([DASHBOARD_OVERVIEW_PATH,MEMORY_GRAPH_PATH,CONTROLS_PATH,CONTROL_ACTION_PATH,MEMORY_CONTROL_PATH,OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH].includes(url.pathname)||(url.pathname.startsWith('/console/workspace')&&request.headers.get('accept')==='application/json')) return finish(new Response('unauthorized', { status: 401, headers: DASHBOARD_OVERVIEW_HEADERS }));
    return finish(signin());
  }
  const forwarded = new Request(request);
  forwarded.headers.set('x-waldo-do-name', doName);
  let response: Response;
  try { response = await owners.get(owners.idFromName(doName)).fetch(forwarded); }
  catch (error) {
    if ([DASHBOARD_OVERVIEW_PATH,MEMORY_GRAPH_PATH,CONTROLS_PATH,CONTROL_ACTION_PATH,MEMORY_CONTROL_PATH,OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH].includes(url.pathname)||(url.pathname.startsWith('/console/workspace')&&request.headers.get('accept')==='application/json')) return finish(new Response('overview unavailable', { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }));
    throw error;
  }
  event('console_route', response.ok, response.ok ? 'forwarded' : 'forward_failed');
  if (resume && response.status === 401) return finish(signin());
  if ([DASHBOARD_OVERVIEW_PATH,MEMORY_GRAPH_PATH,CONTROLS_PATH,CONTROL_ACTION_PATH,MEMORY_CONTROL_PATH,OWNER_CONTROLS_PATH,OWNER_CONTROLS_ACTION_PATH].includes(url.pathname)||(url.pathname.startsWith('/console/workspace')&&request.headers.get('accept')==='application/json')) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) headers.set(key, value);
    return finish(new Response(response.body, { status: response.status, headers }));
  }
  return finish(response);
};
