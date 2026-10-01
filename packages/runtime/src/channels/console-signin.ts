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

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const page = (body: string, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo console</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;display:grid;place-items:center;min-height:100vh;margin:0}form{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;font-size:17px;padding:12px;border-radius:10px;border:1px solid #ccc}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #5267AF;outline-offset:3px}label{font:bold 1rem system-ui,sans-serif}button{border:0;background:#1A1A1A;color:#FAFAF8;cursor:pointer}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } },
);
// Legacy sign-in accepts a phone for compatibility, but cannot provision a new owner.
// Collected phone data never proves SMS verification.
export const normalizePhone = (raw: string): string | null => {
  const compact = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
};

const emailForm = (note = '') => page(`<form method="post" action="${CONSOLE_SIGNIN_PATH}"><h1>Sign in to Waldo</h1><p><a href="/console/signup">New member? Open your invite signup</a></p>${note ? `<p role="alert">${esc(note)}</p>` : ''}<label for="signin-email">Email address</label><input id="signin-email" name="email" type="email" autocomplete="email" required placeholder="you@example.com"><label for="signin-invite">Invite code (optional for existing members)</label><input id="signin-invite" name="invite" autocomplete="off" placeholder="Invite code (new members)"><label for="signin-phone">Phone with country code (contact only, unverified)</label><input id="signin-phone" name="phone" type="tel" autocomplete="tel" required placeholder="Phone, e.g. +91 98765 43210"><button>Email me a code</button></form>`);
// Retry forms retain entered fields; sign-in resolves existing owners only.
const codeForm = (email: string, phone: string, invite: string, note = '') => page(`<form method="post" action="${CONSOLE_VERIFY_PATH}"><p role="status">${note ? esc(note) : `If ${esc(email)} has access, an email code was requested. Delivery is not confirmed here.`}</p><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="phone" value="${esc(phone)}"><input type="hidden" name="invite" value="${esc(invite)}"><label for="signin-code">Email sign-in code</label><input id="signin-code" name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="Code"><button>Sign in</button><a href="/console/signin">Request another email code</a></form>`);

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
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'GET') return finish(emailForm());
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'POST') {
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const phone = normalizePhone(String(form.get('phone') ?? ''));
    const invite = String(form.get('invite') ?? '').trim().toUpperCase();
    if (!email.includes('@')) return finish(emailForm('Enter your email address.'));
    if (!phone) return finish(emailForm('Enter your phone number with country code, e.g. +91 98765 43210.'));
    // OTP bombing guard: per-email and per-IP throttle, fail-closed: a public signup endpoint
    // without its limiter refuses codes rather than spraying OTPs.
    if (!env.RESPONSIBILITY_RATE_LIMITER) {
      event('console_signin', false, 'limiter_absent');
      return finish(emailForm('Sign-in is temporarily unavailable. Try again shortly.'));
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const emailOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin:${email}` })).success;
    const ipOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin-ip:${ip}` })).success;
    if (!emailOk || !ipOk) {
      event('console_signin', false, 'rate_limited');
      return finish(emailForm('Too many attempts. Wait a minute and try again.'));
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
      return finish(emailForm('Too many attempts. Try again in a few minutes.'));
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
    const email = String(form.get('email') ?? '');
    const phone = normalizePhone(String(form.get('phone') ?? ''));
    const invite = String(form.get('invite') ?? '').trim().toUpperCase();
    if (!phone) return finish(emailForm('Enter your phone number with country code, e.g. +91 98765 43210.'));
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
    const headers = new Headers({ location: CONSOLE_PATH });
    headers.append('set-cookie', `${CONSOLE_COOKIE}=${await grant.text()}; ${cookie}`);
    headers.append('set-cookie', `${OWNER_COOKIE}=${ownerCookieValue}; ${cookie}`);
    event('console_verify', true, 'signed_in');
    return finish(new Response(null, { status: 303, headers }));
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
    if ((url.pathname === DASHBOARD_OVERVIEW_PATH || url.pathname === MEMORY_GRAPH_PATH)) return finish(new Response('unauthorized', { status: 401, headers: DASHBOARD_OVERVIEW_HEADERS }));
    throw new Error('owner session validation failed');
  }
  if (!doName) {
    event('console_route', false, 'no_valid_owner_cookie');
    if ((url.pathname === DASHBOARD_OVERVIEW_PATH || url.pathname === MEMORY_GRAPH_PATH)) return finish(new Response('unauthorized', { status: 401, headers: DASHBOARD_OVERVIEW_HEADERS }));
    return finish(new Response(null, { status: 303, headers: { location: CONSOLE_SIGNIN_PATH } }));
  }
  const forwarded = new Request(request);
  forwarded.headers.set('x-waldo-do-name', doName);
  let response: Response;
  try { response = await owners.get(owners.idFromName(doName)).fetch(forwarded); }
  catch (error) {
    if ((url.pathname === DASHBOARD_OVERVIEW_PATH || url.pathname === MEMORY_GRAPH_PATH)) return finish(new Response('overview unavailable', { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }));
    throw error;
  }
  event('console_route', response.ok, response.ok ? 'forwarded' : 'forward_failed');
  if ((url.pathname === DASHBOARD_OVERVIEW_PATH || url.pathname === MEMORY_GRAPH_PATH)) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(DASHBOARD_OVERVIEW_HEADERS)) headers.set(key, value);
    return finish(new Response(response.body, { status: response.status, headers }));
  }
  return finish(response);
};
