import { withRequestTimeout } from '../identity/request-timeout';
import { consoleLog, consoleTrace } from '../observability/console-correlation';
import { OWNER_COOKIE, type ConsoleAuth } from '../identity/console-auth';
import { signupAuth, signupName, SIGNUP_COOKIE, SIGNUP_NAME_MAX, SIGNUP_TTL_SECONDS, type SignupAuth, type SignupProgress } from '../identity/console-signup';
import { CONSOLE_COOKIE, CONSOLE_PATH, consoleCookie, grantHeaders } from './console';
import type { OwnerDirectoryEnv } from '../identity/owner-directory';
import { resolveCaptureText } from '../observability/trace-privacy';
import { DIAGNOSTIC_RECORDING_WORDING, diagnosticRecordingDirectory, type DiagnosticRecordingDirectory } from '../identity/diagnostic-recording';

export const CONSOLE_SIGNUP_PATH = '/console/signup';
const SIGNUP_WELCOME_PATH = `${CONSOLE_SIGNUP_PATH}/welcome`;
const esc = (s: string) => s.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);
const unavailableInvite = 'We could not continue. Check the email code and recipient email. New members also need a valid invite; it may be expired, revoked or already used. Existing member access does not depend on invite validity. Retry the email code or ask the sender for a new link if needed.';
const unavailableCompletion = 'We could not finish signup. New members need a valid invite for this verified email; it may be expired, revoked or already used. If an earlier attempt was interrupted, retry Finish signup to open the same account. Otherwise ask the sender for a new invite.';
const unavailable = 'Verification is temporarily unavailable. Try again shortly.';
const contactRequired = 'Enter what Waldo should call you, and your phone with its country code, such as +91 98765 43210.';
const css = `*{box-sizing:border-box}body{margin:0;background:#FAFAF8;color:#1A1A1A;font-family:system-ui,sans-serif;line-height:1.5;overflow-wrap:anywhere}main{max-width:440px;margin:8vh auto;padding:28px}h1{font-size:30px;line-height:1.2}form{display:grid;gap:12px}label{font:bold 1rem system-ui,sans-serif}input,button{font:inherit;font-size:17px;min-height:48px;width:100%;padding:12px;border:1px solid #767676;border-radius:10px}button{background:#1A1A1A;color:#FAFAF8;cursor:pointer}a{color:#1A1A1A}input:focus-visible,button:focus-visible,a:focus-visible{outline:3px solid #5267AF;outline-offset:3px}.eyebrow{font-size:14px;letter-spacing:.08em}.note{border-left:3px solid #5267AF;padding:12px}ol{padding-left:24px}.help{font-size:14px}.consent{display:flex;gap:12px;align-items:flex-start;font-weight:normal}.consent input{flex:none;width:22px;height:22px;min-height:0;margin:3px 0 0;padding:0}@media(max-width:480px){main{margin:2vh auto;padding:24px}h1{font-size:28px}}`;
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
// The email is what the person typed, shown back so a refused field does not wipe it. The invite code is never reflected.
const entry = (text = '', email = '') => page(`<h1>Your Waldo starts here.</h1><p>Verify your email to join with your invite.</p><p class="help">Requesting an email code can create a Supabase Auth identity. It does not create your Waldo owner account.</p>${note(text)}<form method="post" action="${CONSOLE_SIGNUP_PATH}/send"><label for="email">Recipient email</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" value="${esc(email.slice(0, 254))}" required><label for="invite">Invite code</label><input id="invite" name="invite" autocomplete="off" spellcheck="false" maxlength="20" required aria-describedby="invite-help"><p id="invite-help" class="help">Your link fills this in. Opening it does not use the invite. Codes expire after 14 days.</p><button>Send email code</button></form><p class="help">After your email, Waldo asks what to call you and for your phone number.</p><p><a href="/console/signin">Already a member? Sign in</a></p><noscript><p>Enter the email and code from your invite link manually. Nothing is sent until you submit.</p></noscript>`, 200, entryScript);
const csrf = (p: SignupProgress) => `<input type="hidden" name="csrf" value="${esc(p.csrf)}">`;
const otp = (p: SignupProgress, text = '') => page(`<h1>Check your email.</h1><ol aria-label="Verification progress"><li>Email: waiting for a code</li></ol><p>Enter the most recent email code for ${esc(p.email)}. Codes are requested only when this email has existing member access or a valid matching invite. This does not prove that an invite is valid. Delivery can take a few minutes.</p>${note(text)}<form method="post" action="${CONSOLE_SIGNUP_PATH}/verify">${csrf(p)}<label for="code">Email verification code</label><input id="code" name="code" autocomplete="one-time-code" inputmode="numeric" maxlength="16" required><button>Verify email</button></form><form method="post" action="${CONSOLE_SIGNUP_PATH}/resend">${csrf(p)}<button>Send another code</button></form><p><a href="${CONSOLE_SIGNUP_PATH}?restart=1">Use another invite or email</a></p>`, 200, restartScript);
// Beta diagnostic recording is optional and starts unticked; a retry shows the owner's own earlier choice.
const diagnosticChoice = (ticked: boolean) => `<label class="consent" for="diagnostic-recording"><input id="diagnostic-recording" name="diagnostic_recording" type="checkbox" value="on" aria-describedby="diagnostic-recording-help"${ticked ? ' checked' : ''}><span>${esc(DIAGNOSTIC_RECORDING_WORDING.label)}</span></label><p id="diagnostic-recording-help" class="help">${esc(DIAGNOSTIC_RECORDING_WORDING.detail)}</p>`;
// offered: this environment records text, so the choice means something; elsewhere the box is not shown.
const finishPage = (p: SignupProgress, text = '', choice: Readonly<{ offered: boolean; ticked: boolean }>) => page(`<h1>Email verified. Finish signup.</h1><ol aria-label="Verification progress"><li>Email: verified (${esc(p.email)})</li></ol>${note(text)}<p>Tell Waldo what to call you and your phone number to finish.</p><form method="post" action="${CONSOLE_SIGNUP_PATH}/complete">${csrf(p)}<label for="name">What should Waldo call you?</label><input id="name" name="name" maxlength="${SIGNUP_NAME_MAX}" autocomplete="given-name" value="${esc(p.name ?? '')}" required><label for="phone">Phone, with country code</label><input id="phone" name="phone" type="tel" inputmode="tel" maxlength="24" autocomplete="tel" required aria-describedby="phone-help"><p id="phone-help" class="help">Waldo checks this number the first time you text your link code to Waldo from it. Nothing is sent to this number now.</p>${choice.offered ? diagnosticChoice(choice.ticked) : ''}<button>Finish signup</button></form><p class="help">Finishing checks your invite and opens your member account. If a previous attempt was interrupted, it may already have created the account; retrying opens that same account. Progress expires 15 minutes after starting. If finishing is interrupted, retry here without another email code.</p><p class="help">Temporary progress is a readable signed cookie. Anyone holding a copy can finish this signup until it expires.</p><p><a href="${CONSOLE_SIGNUP_PATH}?restart=1">Start again</a></p><p class="help">Starting again clears this browser’s progress only; it does not revoke copies elsewhere.</p>`, 200, restartScript);
// After sign-up: the two optional next steps, each through the console flow that already does it.
const welcome = () => page(`<h1>You're in.</h1><p>Two optional steps help Waldo help you. Either can wait; both live in Connections.</p><ol><li><a href="${CONSOLE_PATH}#/connections">Connect Google</a> so Waldo can read your calendar and mail.</li><li><a href="${CONSOLE_PATH}#/connections/phone">Verify your phone</a>. Until you do, Waldo sends nothing to the number you gave.</li></ol><p><a href="${CONSOLE_PATH}">Open Waldo</a></p>`);
const withCookie = (response: Response, value: string) => {
  response.headers.append('set-cookie', `${SIGNUP_COOKIE}=${value}; Path=${CONSOLE_SIGNUP_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=${SIGNUP_TTL_SECONDS}`);
  return response;
};
const redirect = (value: string, notice: 'unconfirmed' | 'throttled' | null = null) => withCookie(new Response(null, { status: 303, headers: { location: notice ? `${CONSOLE_SIGNUP_PATH}?send=${notice}` : CONSOLE_SIGNUP_PATH, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' } }), value);
type SignupEnv = OwnerDirectoryEnv & Readonly<{ RESPONSIBILITY_RATE_LIMITER?: RateLimit; OWNER_DO?: DurableObjectNamespace; LANGFUSE_CAPTURE_TEXT?: string; WALDO_ENVIRONMENT?: string }>;
// Completion admits only the verified invite identity. Phone collection never grants channel authority.
export const handleSignup = async (request: Request, env: SignupEnv, auth: ConsoleAuth | null, signup: SignupAuth | null = signupAuth(env), trace = consoleTrace(),
  diagnostics: DiagnosticRecordingDirectory | null = diagnosticRecordingDirectory(env)): Promise<Response> => {
  const url = new URL(request.url);
  if (request.method === 'GET' && url.pathname === SIGNUP_WELCOME_PATH) return welcome();
  const progress = signup ? await signup.read(request) : null;
  const offered = resolveCaptureText(env);
  let ticked = false;
  const finish = (p: SignupProgress, text = '') => finishPage(p, text, { offered, ticked });
  const resume = (p: SignupProgress, text = '') => p.emailVerified ? finish(p, text) : otp(p, text);
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
  if (!['/send', '/verify', '/resend', '/phone', '/complete'].includes(action)) return page('<h1>Page not found.</h1>', 404);
  if (action !== '/send' && (!progress || form.get('csrf') !== progress.csrf)) return entry('This signup has expired or could not be verified. Reopen your invite link to start again.');
  const email = action === '/send' ? String(form.get('email') ?? '').trim().toLowerCase() : progress!.email;
  const invite = String(form.get('invite') ?? '').trim().toUpperCase();
  if (action === '/send' && (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || !/^[A-HJ-NP-Z2-9]{20}$/.test(invite))) return entry('Enter the recipient email and the 20-character code from your invite link.', email);
  if ((action === '/phone' || action === '/complete') && !progress!.emailVerified) return resume(progress!, 'Verify your email before entering a phone.');
  if ((action === '/verify' || action === '/resend') && progress!.emailVerified) return resume(progress!);
  // Seal the draft before attempts, so throttle and transport failures can resume with a
  // hash after the browser has cleared its fragment. This is not proof of eligibility.
  const draftValue = action === '/send' ? await signup.begin(email, invite) : null;
  ticked = offered && action === '/complete' && form.get('diagnostic_recording') === 'on';
  const retry = (message: string) => action === '/phone' || action === '/complete'
    ? finish(progress!, message) : resume(progress!, message);
  // Coarse per-location and durable per-email/IP limits cover every attempt, including phone
  // collection rechecks. Errors fail closed and expose only a retryable, content-free message.
  try {
    const ip = request.headers.get('cf-connecting-ip') ?? 'unknown';
    const stage = action === '/verify' ? 'verify' : action === '/complete' ? 'complete' : action === '/phone' ? 'contact' : 'send';
    const attemptLimit = stage === 'verify' || stage === 'complete' ? 10 : 5;
    if (!env.RESPONSIBILITY_RATE_LIMITER
      || !(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signup:${email}` })).success
      || !(await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `console-signup-ip:${ip}` })).success
      || !await auth.throttle(`${stage}:${email}`, attemptLimit, 900)
      || !await auth.throttle(`ip:${ip}`, 30, 900)) return draftValue ? redirect(draftValue, 'throttled') : retry('Too many attempts. Wait a few minutes and retry.');
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
    const name = signupName(String(form.get('name') ?? ''));
    if (!name || !/^\+[1-9]\d{6,14}$/.test(compact)) return finish(progress!, contactRequired);
    if (action === '/complete' && !env.OWNER_DO) return finish(progress!, unavailable);
    let value: string | null;
    try { value = await signup.collectContact(progress!, name, compact); }
    catch { return finish(progress!, unavailable); }
    if (!value) return finish(progress!, unavailableCompletion);
    if (action === '/phone') return redirect(value);
    const saved = await signup.read(new Request(request.url, { headers: { cookie: `${SIGNUP_COOKIE}=${value}` } }));
    if (!saved) return withCookie(finish(progress!, unavailable), value);
    // Keep verified progress and entered contact on any uncertain completion/session result.
    // A retry resolves the already-bound owner and never replays the consumed OTP.
    try {
      const doName = await signup.complete(saved, compact);
      if (!doName) return withCookie(finish(saved, unavailableCompletion), value);
      // The name becomes the owner's own "call me" answer in their owner object, as the first run's name step records it.
      const named = await withRequestTimeout(async signal => (await env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName))
        .fetch('https://telegram-owner/signup-profile', { method: 'POST', headers: { 'x-waldo-do-name': doName, 'content-type': 'application/json' }, body: JSON.stringify({ name: saved.name }), signal })).ok);
      if (!named) return withCookie(finish(saved, unavailable), value);
      const grant = await withRequestTimeout(async signal => {
        const response = await env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName))
          .fetch('https://telegram-owner/grant-console', { method: 'POST', headers: grantHeaders(doName, request), signal });
        return response.ok ? await response.text() : null;
      });
      if (!grant) return withCookie(finish(saved, unavailable), value);
      const ownerCookie = await auth.ownerCookie(doName, request);
      if (!ownerCookie) return withCookie(finish(saved, unavailable), value);
      // Recorded only once the account is open. A failure leaves recording off and signup finished; the owner can agree
      // later in the console, which shows the state the directory actually holds.
      if (ticked) {
        let recorded = false;
        try { recorded = await diagnostics?.set(doName, true, 'signup') === true; } catch { /* recorded stays false */ }
        if (!recorded) consoleLog(trace, 'console_signup', false, 'diagnostic_recording_unconfirmed');
      }
      const headers = new Headers({ location: SIGNUP_WELCOME_PATH, 'cache-control': 'no-store', 'referrer-policy': 'same-origin' });
      headers.append('set-cookie', consoleCookie(CONSOLE_COOKIE, grant));
      headers.append('set-cookie', consoleCookie(OWNER_COOKIE, ownerCookie));
      headers.append('set-cookie', `${SIGNUP_COOKIE}=; Path=${CONSOLE_SIGNUP_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
      consoleLog(trace, 'console_signup', true, 'signed_in');
      return new Response(null, { status: 303, headers });
    } catch {
      consoleLog(trace, 'console_signup', false, 'completion_unconfirmed');
      return withCookie(finish(saved, 'We could not confirm completion. Retry Finish signup; your verified email is retained.'), value);
    }
  } catch {
    consoleLog(trace, 'console_signup', false, 'verification_unavailable');
    return draftValue ? redirect(draftValue, 'unconfirmed') : retry(unavailable);
  }
};
