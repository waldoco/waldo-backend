import { withRequestTimeout } from './request-timeout';
import { linkCodeHash, routerSignature, signedRpc, type OwnerDirectoryEnv } from './owner-directory';

export const SIGNUP_COOKIE = 'waldo_signup';
export const SIGNUP_TTL_SECONDS = 15 * 60;
export type SignupProgress = Readonly<{
  authUser: string | null;
  emailVerified: boolean;
  csrf: string;
  email: string;
  inviteHash: string;
  expires: number;
  phone: string | null;
  phoneVerification: 'not_configured';
  complete: false;
}>;
export type SignupAuth = Readonly<{
  begin(email: string, invite: string): Promise<string>;
  sendCode(progress: SignupProgress): Promise<boolean>;
  verifyEmail(progress: SignupProgress, otp: string): Promise<string | null>;
  read(request: Request): Promise<SignupProgress | null>;
  collectPhone(progress: SignupProgress, phone: string): Promise<string | null>;
}>;

// Readable signed bearer progress, not encrypted, device-bound or server-revocable.
// No raw invite, OTP or Supabase tokens; no Waldo owner/session/consumption authority.
export const signupAuth = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): SignupAuth | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  const rpc = signedRpc(env, fetcher, now);
  if (!base || !key || !secret || !rpc) return null;
  // Access eligibility also admits active members, regardless of the invite hash.
  // It is not proof of invite validity.
  const eligible = async (email: string, hash: string) => (await rpc('signin_allowed', `signin.${email}.${hash}`, { p_email: email, p_code_hash: hash })) === true;
  const seal = async (progress: SignupProgress) => {
    const payload = btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(progress)))).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    return `${payload}.${await routerSignature(secret, 0, `signup.${payload}`)}`;
  };
  return {
    async begin(email, invite) {
      return seal({ authUser: null, emailVerified: false, csrf: crypto.randomUUID(), email: email.trim().toLowerCase(), inviteHash: await linkCodeHash(invite),
        expires: Math.floor(now() / 1000) + SIGNUP_TTL_SECONDS, phone: null, phoneVerification: 'not_configured', complete: false });
    },
    async sendCode(progress) {
      if (progress.expires <= Math.floor(now() / 1000) || !await eligible(progress.email, progress.inviteHash)) return false;
      return withRequestTimeout(async signal => {
        const response = await fetcher(`${base}/auth/v1/otp`, {
          method: 'POST', headers: { apikey: key, 'content-type': 'application/json' },
          body: JSON.stringify({ email: progress.email, create_user: true }), signal,
        });
        if (!response.ok) throw new Error('email code unavailable');
        return true;
      });
    },
    async verifyEmail(progress, otp) {
      const address = progress.email;
      if (progress.expires <= Math.floor(now() / 1000) || !await eligible(address, progress.inviteHash)) return null;
      const user = await withRequestTimeout(async signal => {
        const response = await fetcher(`${base}/auth/v1/verify`, {
          method: 'POST', headers: { apikey: key, 'content-type': 'application/json' },
          body: JSON.stringify({ type: 'email', email: address, token: otp.trim() }), signal,
        });
        if (!response.ok) return null;
        const { user } = await response.json() as { user?: { id?: string; email?: string; email_confirmed_at?: string } };
        return user;
      });
      if (!user?.id || user.email?.toLowerCase() !== address || !user.email_confirmed_at) return null;
      return seal({ ...progress, authUser: user.id, emailVerified: true });
    },
    async read(request) {
      const cookie = (request.headers.get('cookie') ?? '').split(';').map(p => p.trim()).find(p => p.startsWith(`${SIGNUP_COOKIE}=`))?.slice(SIGNUP_COOKIE.length + 1);
      if (!cookie || cookie.length > 2048) return null;
      const [payload, signature, extra] = cookie.split('.');
      if (!payload || !signature || extra || !/^[0-9a-f]{64}$/.test(signature)) return null;
      const hmacKey = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
      const bytes = Uint8Array.from(signature.match(/../g)!, b => Number.parseInt(b, 16));
      if (!await crypto.subtle.verify('HMAC', hmacKey, bytes, new TextEncoder().encode(`0.signup.${payload}`))) return null;
      try {
        const decoded = atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
        const p = JSON.parse(new TextDecoder().decode(Uint8Array.from(decoded, c => c.charCodeAt(0)))) as SignupProgress;
        if ((p.authUser !== null && typeof p.authUser !== 'string') || typeof p.csrf !== 'string' || p.csrf.length !== 36 || typeof p.emailVerified !== 'boolean' || p.emailVerified !== (p.authUser !== null) || typeof p.email !== 'string' || !/^[0-9a-f]{64}$/.test(p.inviteHash)
          || !Number.isSafeInteger(p.expires) || p.expires <= Math.floor(now() / 1000)
          || p.expires > Math.floor(now() / 1000) + SIGNUP_TTL_SECONDS
          || (p.phone !== null && (typeof p.phone !== 'string' || !/^\+[1-9]\d{6,14}$/.test(p.phone)))
          || p.phoneVerification !== 'not_configured' || p.complete !== false) return null;
        return p;
      } catch { return null; } // Malformed client cookie is an invalid continuation, not a server fault.
    },
    async collectPhone(progress, phone) {
      if (!progress.emailVerified || !progress.authUser || !/^\+[1-9]\d{6,14}$/.test(phone) || progress.expires <= Math.floor(now() / 1000) || !await eligible(progress.email, progress.inviteHash)) return null;
      return seal({ ...progress, phone, phoneVerification: 'not_configured', complete: false });
    },
  };
};
