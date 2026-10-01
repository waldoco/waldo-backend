import { consoleLog, consoleTrace } from '../observability/console-correlation';
import type { ConsoleAuth } from '../identity/console-auth';
import { signupAuth, SIGNUP_COOKIE, SIGNUP_TTL_SECONDS, type SignupAuth, type SignupProgress } from '../identity/console-signup';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';

export const CONSOLE_SIGNUP_PATH = '/console/signup';
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const unavailableInvite = 'We could not continue. Check the email code and recipient email. New members also need a valid invite; it may be expired, revoked or already used. Existing member access does not depend on invite validity. Retry the email code or ask the sender for a new link if needed.';
const unavailable = 'Verification is temporarily unavailable. Try again shortly.';
const css = `*{box-sizing:border-box}body{margin:0;background:#FAFAF8;color:#1A1A1A;font-family:system-ui,sans-serif;line-height:1.5;overflow-wrap:anywhere}main{max-width:440px;margin:8vh auto;padding:28px}h1{font-size:30px;line-height:1.2}form{display:grid;gap:12px}label{font:bold 1rem system-ui,sans-serif}input,button{font:inherit;font-size:17px;min-height:48px;width:100%;padding:12px;border:1px solid #767676;border-radius:10px}button{background:#1A1A1A;color:#FAFAF8;cursor:pointer}a{color:#1A1A1A}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #5267AF;outline-offset:3px}.eyebrow{font-size:14px;letter-spacing:.08em}.note{border-left:3px solid #5267AF;padding:12px}ol{padding-left:24px}.help{font-size:14px}@media(max-width:480px){main{margin:2vh auto;padding:24px}h1{font-size:28px}}`;
const restartScript = `const restart=()=>{if(new URLSearchParams(location.hash.slice(1)).has('invite'))location.replace('/console/signup?restart=1'+location.hash);};addEventListener('hashchange',restart);restart();`;
const entryScript = `const fillInvite=()=>{const fragment=new URLSearchParams(location.hash.slice(1));history.replaceState(null,'',location.pathname);const email=fragment.get('email');const invite=fragment.get('invite');if(email)document.getElementById('email').value=email;if(invite)document.getElementById('invite').value=invite;};addEventListener('hashchange',fillInvite);fillInvite();`;
const page = (body: string, status = 200, script = '') => {
  const nonce = crypto.randomUUID();
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Join Waldo</title><style nonce="${nonce}">${css}</style></head><body><main><p class="eyebrow">WALDO · INVITE SIGNUP</p>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`, { status, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
    'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'none'; img-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  } });
};
const note = (text: string) => text ? `<p class="note" role="alert">${esc(text)}</p>` : '';
const entry = (text = '') => page(`<h1>Your Waldo starts here.</h1><p>Verify your email, then enter your phone. Both need verification before signup can finish.</p><p class="help">Requesting an email code can create a Supabase Auth identity. It does not create your Waldo owner account.</p>${note(text)}<form method="post" action="${CONSOLE_SIGNUP_PATH}/send"><label for="email">Recipient email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required><label for="invite">Invite code</label><input id="invite" name="invite" autocomplete="off" spellcheck="false" maxlength="20" required aria-describedby="invite-help"><p id="invite-help" class="help">Your link fills this in. Opening it does not use the invite. Codes expire after 14 days.</p><button>Send email code</button></form><p class="help">SMS verification is not configured yet. You can verify email and enter a phone, but cannot finish signup.</p><p><a href="/console/signin">Already a member? Sign in</a></p><noscript><p>Enter the email and code from your invite link manually. Nothing is sent until you submit.</p></noscript>`, 200, entryScript);
const csrf = (p: SignupProgress) => `<input type="hidden" name="csrf" value="${esc(p.csrf)}">`;
const otp = (p: SignupProgress, text = '') => page(`<h1>Check your email.</h1><ol aria-label="Verification progress"><li>Email: waiting for a code</li><li>Phone: not verified</li></ol><p>Enter the most recent email code for ${esc(p.email)}. Codes are requested only when this email has existing member access or a valid matching invite. This does not prove that an invite is valid. Delivery can take a few minutes.</p>${note(text)}<form method="post" action="${CONSOLE_SIGNUP_PATH}/verify">${csrf(p)}<label for="code">Email verification code</label><input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="16" required><button>Verify email</button></form><form method="post" action="${CONSOLE_SIGNUP_PATH}/resend">${csrf(p)}<button>Send another code</button></form><p><a href="${CONSOLE_SIGNUP_PATH}?restart=1">Use another invite or email</a></p>`, 200, restartScript);
const phone = (p: SignupProgress, text = '') => page(`<h1>${p.phone ? 'Phone verification is pending.' : 'Email verified. Next, your phone.'}</h1><ol aria-label="Verification progress"><li>Email: verified (${esc(p.email)})</li><li>Phone: ${p.phone ? 'entered, not verified' : 'not verified'}</li></ol>${note(text)}<p>SMS verification is not configured. No text has been sent. Signup is incomplete. This signup flow has not consumed an invite or created a Waldo owner.</p><form method="post" action="${CONSOLE_SIGNUP_PATH}/phone">${csrf(p)}<label for="phone">Phone with country code</label><input id="phone" name="phone" type="tel" autocomplete="tel" maxlength="32" required value="${esc(p.phone ?? '')}" aria-describedby="phone-help"><p id="phone-help" class="help">For example, +91 98765 43210. Entering a number does not verify it. It is stored in a readable, signed cookie for temporary signup progress, not a Waldo owner account. Anyone holding this cookie can reuse it until expiry.</p><button>${p.phone ? 'Update phone' : 'Save phone for this signup'}</button></form><p class="help">This progress expires 15 minutes after starting this signup attempt. Reopen your invite and verify email again after expiry. Finishing signup requires an approved SMS verification flow.</p><p><a href="${CONSOLE_SIGNUP_PATH}?restart=1">Start again</a></p><p class="help">Starting again clears this browser’s progress cookie only; it does not revoke copies elsewhere.</p>`, 200, restartScript);
const resume = (p: SignupProgress, text = '') => p.emailVerified ? phone(p, text) : otp(p, text);
const withCookie = (response: Response, value: string) => {
  response.headers.append('set-cookie', `${SIGNUP_COOKIE}=${value}; Path=${CONSOLE_SIGNUP_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SIGNUP_TTL_SECONDS}`);
  return response;
};
const redirect = (value: string, notice: 'unconfirmed' | 'throttled' | null = null) => withCookie(new Response(null, { status: 303, headers: { location: notice ? `${CONSOLE_SIGNUP_PATH}?send=${notice}` : CONSOLE_SIGNUP_PATH, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' } }), value);
type SignupEnv = OwnerDirectoryEnv & Readonly<{ RESPONSIBILITY_RATE_LIMITER?: RateLimit }>;
// No route in this module calls owner_for_auth, grants a console session, or sends an SMS.
export const handleSignup = async (request: Request, env: SignupEnv, auth: ConsoleAuth | null, signup: SignupAuth | null = signupAuth(env), trace = consoleTrace()): Promise<Response> => {
  const url = new URL(request.url);
  const progress = signup ? await signup.read(request) : null;
  if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === CONSOLE_SIGNUP_PATH) {
    const restarting = url.searchParams.has('restart');
    const response = progress && !restarting ? resume(progress, url.searchParams.get('send') === 'throttled' ? 'Too many attempts. No new code was requested. Wait a few minutes and retry below.' : url.searchParams.get('send') === 'unconfirmed' ? 'We could not confirm that an email code was sent. Request another code below, or retry a code you already received.' : '') : entry();
    if (restarting) response.headers.append('set-cookie', `${SIGNUP_COOKIE}=; Path=${CONSOLE_SIGNUP_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
    return request.method === 'HEAD' ? new Response(null, { headers: response.headers }) : response;
  }
  if (request.method !== 'POST') return page('<h1>Open your signup link to continue.</h1>', 405);
  if (request.headers.get('origin') !== url.origin) return page('<h1>Open your signup link to continue.</h1>', 403);
  if (!signup || !auth) return page(`<h1>Signup unavailable.</h1>${note(unavailable)}`, 503);
  let form: FormData;
  try { form = await request.formData(); } catch { return entry('This form could not be read. Reopen your invite link.'); }
  const action = url.pathname.slice(CONSOLE_SIGNUP_PATH.length);
  if (!['/send', '/verify', '/resend', '/phone'].includes(action)) return page('<h1>Page not found.</h1>', 404);
  if (action !== '/send' && (!progress || form.get('csrf') !== progress.csrf)) return entry('This signup has expired or could not be verified. Reopen your invite link to start again.');
  const email = action === '/send' ? String(form.get('email') ?? '').trim().toLowerCase() : progress!.email;
  const invite = String(form.get('invite') ?? '').trim().toUpperCase();
  if (action === '/send' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !/^[A-HJ-NP-Z2-9]{20}$/.test(invite))) return entry('Enter the recipient email and the 20-character code from your invite link.');
  if (action === '/phone' && !progress!.emailVerified) return resume(progress!, 'Verify your email before entering a phone.');
  if ((action === '/verify' || action === '/resend') && progress!.emailVerified) return resume(progress!);
  // Seal the draft before attempts, so throttle and transport failures can resume with a
  // hash after the browser has cleared its fragment. This is not proof of eligibility.
  const draftValue = action === '/send' ? await signup.begin(email, invite) : null;
  // Coarse per-location and durable per-email/IP limits cover every attempt, including phone
  // collection rechecks. Errors fail closed and expose only a retryable, content-free message.
  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const verify = action === '/verify';
    if (!env.RESPONSIBILITY_RATE_LIMITER
      || !(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signup:${email}` })).success
      || !(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signup-ip:${ip}` })).success
      || !await auth.throttle(`${verify ? 'verify' : 'send'}:${email}`, verify ? 10 : 5, 900)
      || !await auth.throttle(`ip:${ip}`, 30, 900)) return draftValue ? redirect(draftValue, 'throttled') : resume(progress!, 'Too many attempts. Wait a few minutes and retry.');
    if (action === '/send') {
      const value = draftValue!;
      const draft = await signup.read(new Request(request.url, { headers: { cookie: `${SIGNUP_COOKIE}=${value}` } }));
      if (!draft) return entry(unavailable);
      try { await signup.sendCode(draft); }
      catch {
        consoleLog(trace, 'console_signup', false, 'email_send_unconfirmed');
        return redirect(value, 'unconfirmed');
      }
      return redirect(value);
    }
    if (action === '/resend') {
      await signup.sendCode(progress!);
      return resume(progress!, 'If this email still has member access or a valid matching invite, another email code was requested. Use the most recent code.');
    }
    if (action === '/verify') {
      const code = String(form.get('code') ?? '').trim();
      if (!code || code.length > 16) return otp(progress!, 'Enter the email code.');
      const value = await signup.verifyEmail(progress!, code);
      return value ? redirect(value) : otp(progress!, unavailableInvite);
    }
    const compact = String(form.get('phone') ?? '').replace(/[\s().-]/g, '');
    if (!/^\+[1-9]\d{6,14}$/.test(compact)) return phone(progress!, 'Enter your phone with country code, for example +91 98765 43210.');
    const value = await signup.collectPhone(progress!, compact);
    return value ? redirect(value) : phone(progress!, unavailableInvite);
  } catch {
    consoleLog(trace, 'console_signup', false, 'verification_unavailable');
    return draftValue ? redirect(draftValue, 'unconfirmed') : resume(progress!, unavailable);
  }
};
