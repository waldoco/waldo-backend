import { consoleAuth, OWNER_COOKIE, type ConsoleAuth } from '../identity/console-auth';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { CONSOLE_COOKIE, CONSOLE_PATH } from './console';

export const CONSOLE_SIGNIN_PATH = `${CONSOLE_PATH}/signin`;
export const CONSOLE_VERIFY_PATH = `${CONSOLE_PATH}/verify`;

type ConsoleEnv = OwnerDirectoryEnv & Readonly<{ TELEGRAM_OWNER_DO?: DurableObjectNamespace }>;

const esc = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const page = (body: string, status = 200) => new Response(
  `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo console</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;display:grid;place-items:center;min-height:100vh;margin:0}form{display:grid;gap:12px;width:min(320px,90vw)}input,button{font:inherit;font-size:17px;padding:12px;border-radius:10px;border:1px solid #ccc}button{border:0;background:#1A1A1A;color:#FAFAF8;cursor:pointer}</style></head><body>${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } },
);
const emailForm = (note = '') => page(`<form method="post" action="${CONSOLE_SIGNIN_PATH}"><p>Sign in to Waldo</p>${note ? `<p>${esc(note)}</p>` : ''}<input name="email" type="email" autocomplete="email" required placeholder="you@example.com"><button>Email me a code</button></form>`);
const codeForm = (email: string, note = '') => page(`<form method="post" action="${CONSOLE_VERIFY_PATH}"><p>${note ? esc(note) : `If ${esc(email)} has access, a code is on its way.`}</p><input type="hidden" name="email" value="${esc(email)}"><input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="Code"><button>Sign in</button></form>`);

// With Supabase configured, the console signs in by invite-gated email code and a signed owner cookie picks the owner DO.
// Returns null when Supabase is not configured; the caller keeps the Telegram one-time link sign-in.
export const handleConsole = async (request: Request, env: ConsoleEnv, auth: ConsoleAuth | null = consoleAuth(env)): Promise<Response | null> => {
  const owners = env.TELEGRAM_OWNER_DO;
  if (!auth || !owners) return null;
  const url = new URL(request.url);
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'GET') return emailForm();
  if (url.pathname === CONSOLE_SIGNIN_PATH && request.method === 'POST') {
    const email = String((await request.formData()).get('email') ?? '').trim().toLowerCase();
    if (!email.includes('@')) return emailForm('Enter your email address.');
    await auth.sendCode(email);
    return codeForm(email);
  }
  if (url.pathname === CONSOLE_VERIFY_PATH && request.method === 'POST') {
    const form = await request.formData();
    const email = String(form.get('email') ?? '');
    const doName = await auth.verify(email, String(form.get('code') ?? ''));
    if (!doName) return codeForm(email, 'That code did not work, or this address has no access. Try again.');
    const grant = await owners.get(owners.idFromName(doName))
      .fetch('https://telegram-owner/grant-console', { method: 'POST', headers: { 'x-waldo-do-name': doName } });
    const cookie = `Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`;
    const headers = new Headers({ location: CONSOLE_PATH });
    headers.append('set-cookie', `${CONSOLE_COOKIE}=${await grant.text()}; ${cookie}`);
    headers.append('set-cookie', `${OWNER_COOKIE}=${await auth.ownerCookie(doName)}; ${cookie}`);
    return new Response(null, { status: 303, headers });
  }
  const doName = await auth.readOwnerCookie(request);
  if (!doName) return new Response(null, { status: 303, headers: { location: CONSOLE_SIGNIN_PATH } });
  const forwarded = new Request(request);
  forwarded.headers.set('x-waldo-do-name', doName);
  return owners.get(owners.idFromName(doName)).fetch(forwarded);
};
