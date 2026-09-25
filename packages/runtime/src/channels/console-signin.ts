import { consoleAuth, OWNER_COOKIE, type ConsoleAuth } from '../identity/console-auth';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { CONSOLE_COOKIE, CONSOLE_PATH } from './console';

export const CONSOLE_SIGNIN_PATH = `${CONSOLE_PATH}/signin`;
export const CONSOLE_VERIFY_PATH = `${CONSOLE_PATH}/verify`;

type ConsoleEnv = OwnerDirectoryEnv & Readonly<{ TELEGRAM_OWNER_DO?: DurableObjectNamespace; RESPONSIBILITY_RATE_LIMITER?: RateLimit }>;

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const page = (body: string, status = 200) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo console</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;display:grid;place-items:center;min-height:100vh;margin:0}form{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;font-size:17px;padding:12px;border-radius:10px;border:1px solid #ccc}button{border:0;background:#1A1A1A;color:#FAFAF8;cursor:pointer}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } },
);
// Phone is REQUIRED at signup (owner decision 16:39): it is stored UNVERIFIED and verified
// later by an account-bound SMS OTP at WhatsApp connect. Normalized to E.164 here; anything
// else is refused, never stored.
export const normalizePhone = (raw: string): string | null => {
  const compact = raw.replace(/[\s().-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(compact) ? compact : null;
};

const emailForm = (note = '') => page(`<form method="post" action="${CONSOLE_SIGNIN_PATH}"><p>Sign in to Waldo</p>${note ? `<p>${esc(note)}</p>` : ''}<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"><input name="phone" type="tel" autocomplete="tel" required placeholder="Phone, e.g. +91 98765 43210"><button>Email me a code</button></form>`);
// The phone rides along as a hidden field so it lands on the owner row at first verify; it is
// unverified contact data until the WhatsApp pairing proves the number (#156).
const codeForm = (email: string, phone: string, note = '') => page(`<form method="post" action="${CONSOLE_VERIFY_PATH}"><p>${note ? esc(note) : `If ${esc(email)} has access, a code is on its way.`}</p><input type="hidden" name="email" value="${esc(email)}"><input type="hidden" name="phone" value="${esc(phone)}"><input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="Code"><button>Sign in</button></form>`);

// With Supabase configured, the console signs in by invite-gated email code and a signed owner cookie picks the owner DO.
// Returns null when Supabase is not configured; the caller keeps the Telegram one-time link sign-in.
export const handleConsole = async (request: Request, env: ConsoleEnv, auth: ConsoleAuth | null = consoleAuth(env)): Promise<Response | null> => {
  const owners = env.TELEGRAM_OWNER_DO;
  if (!auth || !owners) return null;
  const url = new URL(request.url);
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'GET') return emailForm();
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'POST') {
    const form = await request.formData();
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const phone = normalizePhone(String(form.get('phone') ?? ''));
    if (!email.includes('@')) return emailForm('Enter your email address.');
    if (!phone) return emailForm('Enter your phone number with country code, e.g. +91 98765 43210.');
    // OTP bombing guard: per-email and per-IP throttle. FAIL-CLOSED (owner decision 16:39):
    // a public signup endpoint without its limiter refuses codes rather than spraying OTPs.
    if (!env.RESPONSIBILITY_RATE_LIMITER) {
      console.log(JSON.stringify({ hop: 'console_signin', ok: false, detail: 'limiter_absent' }));
      return emailForm('Sign-in is temporarily unavailable. Try again shortly.');
    }
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const emailOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin:${email}` })).success;
    const ipOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signin-ip:${ip}` })).success;
    if (!emailOk || !ipOk) {
      console.log(JSON.stringify({ hop: 'console_signin', ok: false, detail: 'rate_limited' }));
      return emailForm('Too many attempts. Wait a minute and try again.');
    }
    const sent = await auth.sendCode(email);
    if (!sent) console.log(JSON.stringify({ hop: 'console_signin', ok: false, detail: 'not_allowed' }));
    return codeForm(email, phone);
  }
  if (url.pathname === CONSOLE_VERIFY_PATH && request.method === 'POST') {
    const form = await request.formData();
    const email = String(form.get('email') ?? '');
    const phone = normalizePhone(String(form.get('phone') ?? ''));
    if (!phone) return emailForm('Enter your phone number with country code, e.g. +91 98765 43210.');
    const doName = await auth.verify(email, String(form.get('code') ?? ''), phone);
    if (!doName) return codeForm(email, phone, 'That code did not work. Try again.');
    const grant = await owners.get(owners.idFromName(doName))
      .fetch('https://telegram-owner/grant-console', { method: 'POST', headers: { 'x-waldo-do-name': doName } });
    const ownerCookieValue = await auth.ownerCookie(doName);
    if (ownerCookieValue === null) return codeForm(email, 'Sign-in is having trouble. Try again in a moment.');
    const cookie = `Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`;
    const headers = new Headers({ location: CONSOLE_PATH });
    headers.append('set-cookie', `${CONSOLE_COOKIE}=${await grant.text()}; ${cookie}`);
    headers.append('set-cookie', `${OWNER_COOKIE}=${ownerCookieValue}; ${cookie}`);
    return new Response(null, { status: 303, headers });
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
    return new Response(null, { status: 303, headers });
  }
  const doName = await auth.readOwnerCookie(request);
  if (!doName) return new Response(null, { status: 303, headers: { location: CONSOLE_SIGNIN_PATH } });
  const forwarded = new Request(request);
  forwarded.headers.set('x-waldo-do-name', doName);
  return owners.get(owners.idFromName(doName)).fetch(forwarded);
};
