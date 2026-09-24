import { hex, linkCodeHash, routerSignature, signedRpc, type OwnerDirectoryEnv } from './owner-directory';

export const OWNER_COOKIE = 'waldo_owner';

export type AdminOverview = Readonly<{
  owners: readonly Readonly<{ email: string | null; state: string; created_at: string; presences: readonly string[] }>[];
  invites: readonly Readonly<{ id: string; email: string | null; created_at: string; used_at: string | null; revoked_at: string | null }>[];
}>;

export type OwnerSettings = Readonly<{ timezone: string; quiet_start: string | null; quiet_end: string | null; volume: string }>;

export type ConsoleSession = Readonly<{ session: string; created_at: string; last_seen_at: string }>;

export type ConsoleAuth = Readonly<{
  sendCode(email: string): Promise<boolean>;
  verify(email: string, code: string): Promise<string | null>;
  issueLinkCode(doName: string): Promise<string | null>;
  saveSettings(doName: string, settings: OwnerSettings): Promise<boolean>;
  adminOverview(doName: string): Promise<AdminOverview | null>;
  invite(doName: string, email: string): Promise<boolean>;
  revokeInvite(doName: string, invite: string): Promise<boolean>;
  unlinkTelegram(doName: string): Promise<boolean>;
  deleteOwner(doName: string): Promise<boolean>;
  // D1: cookies carry a session id; minting opens a server-side session, reading validates it,
  // and sign-out-everywhere drops them all. ownerCookie returns null when the session cannot be
  // opened (storage down) so sign-in fails loudly instead of issuing an unverifiable cookie.
  ownerCookie(doName: string): Promise<string | null>;
  readOwnerCookie(request: Request): Promise<string | null>;
  listSessions(doName: string): Promise<readonly ConsoleSession[]>;
  revokeSession(doName: string, sessionHash: string): Promise<boolean>;
  signOutAll(doName: string): Promise<number>;
}>;

const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newLinkCode = () => [...crypto.getRandomValues(new Uint8Array(10))].map((byte) => LINK_ALPHABET[byte % LINK_ALPHABET.length]).join('');
const newSessionId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// Invite-gated Supabase email OTP. Returns null when Supabase is not configured, so the Telegram link sign-in stays.
export const consoleAuth = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): ConsoleAuth | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  const rpc = signedRpc(env, fetcher, now);
  if (!base || !key || !secret || !rpc) return null;
  const auth = (path: string, body: object) => fetcher(`${base}/auth/v1/${path}`, {
    method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const cookieSig = (doName: string, sessionId: string) => routerSignature(secret, 0, `cookie.${doName}.${sessionId}`);
  return {
    // Unknown addresses get no email and the same answer, so the page never reveals who is invited.
    async sendCode(email) {
      const address = email.trim().toLowerCase();
      if (!(await rpc('signin_allowed', `signin.${address}`, { p_email: address }))) return false;
      const response = await auth('otp', { email: address, create_user: true });
      if (!response.ok) throw new Error(`otp send ${response.status}`);
      return true;
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
    unlinkTelegram: async (doName) => (await rpc('unlink_presence', `unlink.${doName}.telegram`, { p_do_name: doName, p_provider: 'telegram' })) === true,
    deleteOwner: async (doName) => (await rpc('delete_owner', `delown.${doName}`, { p_do_name: doName })) === true,
    async ownerCookie(doName) {
      const sessionId = newSessionId();
      const sessionHash = await linkCodeHash(sessionId);
      const opened = await rpc('console_session_open', `consolesess.open.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash });
      if (opened !== true) return null;
      return `${encodeURIComponent(doName)}.${sessionId}.${await cookieSig(doName, sessionId)}`;
    },
    async readOwnerCookie(request) {
      const raw = (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
      const sigDot = raw?.lastIndexOf('.') ?? -1;
      if (!raw || sigDot < 1) return null;
      const sessionDot = raw.lastIndexOf('.', sigDot - 1);
      if (sessionDot < 1) return null;
      const doName = decodeURIComponent(raw.slice(0, sessionDot));
      const sessionId = raw.slice(sessionDot + 1, sigDot);
      const expected = new TextEncoder().encode(await cookieSig(doName, sessionId));
      const given = new TextEncoder().encode(raw.slice(sigDot + 1));
      let diff = expected.length ^ given.length;
      for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (given[i] ?? 0);
      if (diff !== 0) return null;
      const sessionHash = await linkCodeHash(sessionId);
      const live = await rpc('console_session_touch', `consolesess.touch.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash });
      return live === true ? doName : null;
    },
    async listSessions(doName) {
      const rows = await rpc('console_session_list', `consolesess.list.${doName}`, { p_do_name: doName });
      return Array.isArray(rows) ? (rows as ConsoleSession[]) : [];
    },
    async revokeSession(doName, sessionHash) {
      return (await rpc('console_session_revoke', `consolesess.revoke.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash })) === true;
    },
    async signOutAll(doName) {
      const count = await rpc('console_signout_all', `consolesess.signout.${doName}`, { p_do_name: doName });
      return typeof count === 'number' ? count : 0;
    },
  };
};

