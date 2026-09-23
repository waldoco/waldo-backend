import { hex, linkCodeHash, routerSignature, signedRpc, type OwnerDirectoryEnv } from './owner-directory';

export const OWNER_COOKIE = 'waldo_owner';

export type AdminOverview = Readonly<{
  owners: readonly Readonly<{ email: string | null; state: string; created_at: string; presences: readonly string[] }>[];
  invites: readonly Readonly<{ id: string; email: string | null; created_at: string; used_at: string | null; revoked_at: string | null }>[];
}>;

export type OwnerSettings = Readonly<{ timezone: string; quiet_start: string | null; quiet_end: string | null; volume: string }>;

export type ConsoleAuth = Readonly<{
  sendCode(email: string): Promise<void>;
  verify(email: string, code: string): Promise<string | null>;
  issueLinkCode(doName: string): Promise<string | null>;
  saveSettings(doName: string, settings: OwnerSettings): Promise<boolean>;
  adminOverview(doName: string): Promise<AdminOverview | null>;
  invite(doName: string, email: string): Promise<boolean>;
  revokeInvite(doName: string, invite: string): Promise<boolean>;
  ownerCookie(doName: string): Promise<string>;
  readOwnerCookie(request: Request): Promise<string | null>;
}>;

const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newLinkCode = () => [...crypto.getRandomValues(new Uint8Array(10))].map((byte) => LINK_ALPHABET[byte % LINK_ALPHABET.length]).join('');

// Invite-gated Supabase email OTP. Returns null when Supabase is not configured, so the Telegram link sign-in stays.
export const consoleAuth = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): ConsoleAuth | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  const rpc = signedRpc(env, fetcher, now);
  if (!base || !key || !secret || !rpc) return null;
  const auth = (path: string, body: object) => fetcher(`${base}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const cookieSig = (doName: string) => routerSignature(secret, 0, `cookie.${doName}`);
  return {
    // Unknown addresses get no email and the same answer, so the page never reveals who is invited.
    async sendCode(email) {
      const address = email.trim().toLowerCase();
      if (!(await rpc('signin_allowed', `signin.${address}`, { p_email: address }))) return;
      const response = await auth('otp', { email: address, create_user: true });
      if (!response.ok) throw new Error(`otp send ${response.status}`);
    },
    async verify(email, code) {
      const address = email.trim().toLowerCase();
      const response = await auth('verify', { type: 'email', email: address, token: code.trim() });
      if (!response.ok) return null;
      const { user } = (await response.json()) as { user?: { id?: string; email?: string } };
      if (!user?.id || user.email?.toLowerCase() !== address) return null;
      return (await rpc('owner_for_auth', `owner.${user.id}.${address}`, { p_auth_user: user.id, p_email: address })) as string | null;
    },
    async issueLinkCode(doName) {
      const code = newLinkCode();
      const hash = await linkCodeHash(code);
      return (await rpc('issue_link_code', `link.${doName}.${hash}`, { p_do_name: doName, p_code_hash: hash })) ? code : null;
    },
    async saveSettings(doName, { timezone, quiet_start: start, quiet_end: end, volume }) {
      const message = `settings.${doName}.${timezone}.${start ?? ''}.${end ?? ''}.${volume}`;
      return (await rpc('set_owner_settings', message, { p_do_name: doName, p_timezone: timezone, p_quiet_start: start ?? '', p_quiet_end: end ?? '', p_volume: volume })) === true;
    },
    adminOverview: async (doName) => (await rpc('admin_overview', `admin.${doName}`, { p_do_name: doName })) as AdminOverview | null,
    invite: async (doName, email) => {
      const address = email.trim().toLowerCase();
      return (await rpc('admin_invite', `invite.${doName}.${address}`, { p_do_name: doName, p_email: address })) === true;
    },
    revokeInvite: async (doName, invite) => (await rpc('admin_revoke', `revoke.${doName}.${invite}`, { p_do_name: doName, p_invite: invite })) === true,
    async ownerCookie(doName) {
      return `${encodeURIComponent(doName)}.${await cookieSig(doName)}`;
    },
    async readOwnerCookie(request) {
      const raw = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
      const dot = raw?.lastIndexOf('.') ?? -1;
      if (!raw || dot < 1) return null;
      const doName = decodeURIComponent(raw.slice(0, dot));
      const expected = new TextEncoder().encode(await cookieSig(doName));
      const given = new TextEncoder().encode(raw.slice(dot + 1));
      let diff = expected.length ^ given.length;
      for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (given[i] ?? 0);
      return diff === 0 ? doName : null;
    },
  };
};

