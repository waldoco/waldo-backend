import { withRequestTimeout } from './request-timeout';
import { adminCostSummarySchema, type AdminCostSummary } from '../channels/admin-spend';
import { hex, linkCodeHash, routerSignature, signedRpc, type OwnerDirectoryEnv } from './owner-directory';

export const OWNER_COOKIE = 'waldo_owner';
// A console sign-in stays signed in while it is used: it ends 7 days after its last signed-in request, and 30 days
// after sign-in however much it is used. The directory row and the owner object's own session both enforce it, and
// the database refuses a row past 30 days. Email codes are a single factor, so 30 days is NIST SP 800-63B-4's AAL1
// reauthentication ceiling; the app bearer keeps its own 12 hours.
export const CONSOLE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const CONSOLE_SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
// An action that creates lasting access needs an email code from the last 2 hours. That is GitHub's sudo mode ("a
// two-hour session timeout period before prompting you for authentication again"), and OWASP's Authentication Cheat
// Sheet asks for current credentials before sensitive features. Unlike GitHub's, the window does not restart with each
// sensitive action: it runs from the code.
export const CONSOLE_STEP_UP_MS = 2 * 60 * 60_000;
// The app proves a recent email code by its session's sign-in time: every app session starts from one, so the row's
// created_at is the console's verified_at. A missing row or an unreadable time is never recent.
export const signedInRecently = (createdAt: string | undefined, now: number): boolean => now - Date.parse(createdAt ?? '') < CONSOLE_STEP_UP_MS;
// A sign-in in a browser that holds a live session (a confirm, or a link or signup there) does not end that session: by
// owner ruling it keeps ordinary access, without its code, for 5 more minutes, so a turn running or queued under it
// finishes, and then it ends. The directory holds the same 5 minutes in console_session_cap.
export const CONSOLE_REPLACED_SESSION_MS = 5 * 60_000;
// A request another site started (Fetch Metadata): under Lax it can still be a top-level visit carrying the cookies, so
// it may read a session but never renews one, and the console refuses it any write or flow start.
export const fromAnotherSite = (request: Request): boolean => {
  const site = request.headers.get('sec-fetch-site');
  return site === 'cross-site' || site === 'same-site';
};

export type AdminOverview = Readonly<{
  owners: readonly Readonly<{ id?: string; email: string | null; state: string; created_at: string; presences: readonly string[]; issued_count?: number }>[];
  invites: readonly Readonly<{ id: string; email: string | null; created_at: string; expires_at: string | null; used_at: string | null; revoked_at: string | null; issued_by?: string | null; issuer_email?: string | null }>[];
  current_issuer?: Readonly<{ id: string; email: string | null; issued_count: number }>;
}>;

export type OwnerSettings = Readonly<{ timezone: string; quiet_start: string | null; quiet_end: string | null; volume: string }>;

// rotated_to: the session a renewal issued in this one's place for the same device; this one still works until it expires.
// signed_in_at: when the sign-in this session renews from happened. created_at is when this row opened, which a renewal
// resets, so the step-up reads signed_in_at.
export type ConsoleSession = Readonly<{ session: string; created_at: string; last_seen_at: string; expires_at: string; rotated_to: string | null; signed_in_at: string }>;
// A session and every listed session a renewal links to it, either way. They are one device: signing one out signs out all.
export const sessionFamily = (rows: readonly ConsoleSession[], session: string): readonly string[] => {
  const family = new Set([session]);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of rows) {
      const linked = family.has(row.session) ? row.rotated_to : row.rotated_to !== null && family.has(row.rotated_to) ? row.session : null;
      if (linked !== null && !family.has(linked)) { family.add(linked); grew = true; }
    }
  }
  return [...family];
};

export type ConsoleAuth = Readonly<{
  sendCode(email: string, code?: string): Promise<boolean>;
  // Strict fixed-window auth throttle kept in the owner directory: global and durable, unlike
  // the per-location binding layer, which only expresses 10s/60s periods.
  throttle(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  // Console sign-in: resolves an existing member only; new console members use the signup flow.
  verify(email: string, code: string, phone?: string, inviteCode?: string): Promise<string | null>;
  // App sign-in: resolves an existing member, otherwise joins with the exact recipient-bound invite. The phone is
  // kept, unverified, only on a join; an existing member's sign-in never changes the number on file.
  verifyOrJoin(email: string, code: string, inviteCode: string, phone?: string): Promise<string | null>;
  issueLinkCode(doName: string): Promise<string | null>;
  /** A one-time code for one provider: the sender texts "waldo CODE" (WhatsApp, iMessage) or /link CODE (Telegram). */
  issueProviderLinkCode?(doName: string, provider: 'telegram' | 'whatsapp' | 'imessage'): Promise<string | null>;
  saveSettings(doName: string, settings: OwnerSettings): Promise<boolean>;
  adminOverview(doName: string): Promise<AdminOverview | null>;
  /** Spend across every owner for the last 30 days; null unless the database admits the caller as an admin. */
  adminCostSummary(doName: string): Promise<AdminCostSummary | null>;
  invite(doName: string, email: string, code: string): Promise<boolean>;
  memberInvite(doName: string, email: string, code: string): Promise<boolean>;
  memberInvites(doName: string): Promise<readonly Readonly<{ email: string | null; created_at: string; expires_at: string | null; used_at: string | null; revoked_at: string | null }>[]>;
  revokeInvite(doName: string, invite: string): Promise<boolean>;
  unlinkTelegram(doName: string): Promise<boolean>;
  unlinkIMessage?(doName: string): Promise<boolean>;
  /** The last 2-4 characters of the owner's linked iMessage handle, or null; the full handle never leaves the database. */
  iMessageHandleHint?(doName: string): Promise<string | null>;
  unlinkWhatsApp?(doName: string): Promise<boolean>;
  /** The last 2-4 digits of the owner's linked WhatsApp number, or null; the full number never leaves the database. */
  whatsAppHandleHint?(doName: string): Promise<string | null>;
  // Send-time ownership re-check: true only while an active presence binds this channel subject to this owner.
  assertChannelPresence(doName: string, provider: string, subject: string): Promise<boolean>;
  deleteOwner(doName: string): Promise<boolean>;
  // D1: cookies carry a session id; minting opens a server-side session, reading validates it,
  // and sign-out-everywhere drops them all. ownerCookie returns null when the session cannot be
  // opened (storage down) so sign-in fails loudly instead of issuing an unverifiable cookie. Given the sign-in request,
  // it first caps the session of the owner cookie that browser presents, whichever owner holds it, to
  // CONSOLE_REPLACED_SESSION_MS, and throws when that cannot be confirmed, so a copy of the old cookie runs out.
  ownerCookie(doName: string, presented?: Request): Promise<string | null>;
  readOwnerCookie(request: Request): Promise<string | null>;
  // The mobile app's bearer: the same kind of server-side session, signed under its own context so it is never
  // accepted as a console cookie, and a console cookie is never accepted as an app bearer.
  ownerAppCredential(doName: string): Promise<string | null>;
  readAppCredential(credential: string): Promise<string | null>;
  // A credential for a fresh 30-day app session; the presented session keeps 5 more minutes. null when it is no longer live.
  renewAppCredential(doName: string, sessionId: string): Promise<string | null>;
  listSessions(doName: string): Promise<readonly ConsoleSession[]>;
  revokeSession(doName: string, sessionHash: string): Promise<boolean>;
  signOutAll(doName: string): Promise<number>;
}>;

const LINK_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const newLinkCode = () => [...crypto.getRandomValues(new Uint8Array(10))].map((byte) => LINK_ALPHABET[byte % LINK_ALPHABET.length]).join('');
const newSessionId = () => [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

// Invite-gated Supabase email OTP. Returns null when Supabase is not configured, so the Telegram link sign-in stays.
// Directory-backed sends fail closed when the DO's identity is incomplete: no recheck function
// exists only where no directory is wired at all (explicit local dev), never when the database
// is reachable but the do_name or channel subject is missing.
export const presenceRecheck = (
  auth: ConsoleAuth | null,
  doName: string | undefined,
  provider: 'telegram' | 'whatsapp',
  subject: string | undefined,
): (() => Promise<boolean>) | undefined =>
  auth === null
    ? undefined
    : async () => doName !== undefined && subject !== undefined && (await auth.assertChannelPresence(doName, provider, subject));

export const consoleAuth = (env: OwnerDirectoryEnv, fetcher: typeof fetch = fetch, now = () => Date.now()): ConsoleAuth | null => {
  const { SUPABASE_PROJECT_URL: base, SUPABASE_PUBLISHABLE_KEY: key, WALDO_ROUTER_HMAC_SECRET: secret } = env;
  const rpc = signedRpc(env, fetcher, now);
  if (!base || !key || !secret || !rpc) return null;
  const presenceHint = async (doName: string, provider: 'imessage' | 'whatsapp') => {
    const hint = await rpc('presence_hint', `presencehint.${doName}.${provider}`, { p_do_name: doName, p_provider: provider });
    return typeof hint === 'string' && hint.length >= 2 && hint.length <= 4 ? hint : null;
  };
  const auth = <T>(path: string, body: object, decode: (response: Response) => T | Promise<T>) => withRequestTimeout(async signal => {
    const response = await fetcher(`${base}/auth/v1/${path}`, {
      method: 'POST', headers: { apikey: key, 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    return decode(response);
  });
  const cookieSig = (doName: string, sessionId: string) => routerSignature(secret, 0, `cookie.${doName}.${sessionId}`);
  const appSig = (doName: string, sessionId: string) => routerSignature(secret, 0, `appbearer.${doName}.${sessionId}`);
  const lifetime = CONSOLE_SESSION_LIFETIME_MS / 1000, idle = CONSOLE_SESSION_IDLE_MS / 1000;
  type Open = (doName: string, sessionHash: string) => Promise<unknown>;
  const openLong: Open = (doName, sessionHash) => rpc('console_session_open_for', `consolesess.openfor.${doName}.${sessionHash}.${lifetime}.${idle}`, { p_do_name: doName, p_session_hash: sessionHash, p_lifetime_seconds: lifetime, p_idle_seconds: idle });
  const openTwelveHours: Open = (doName, sessionHash) => rpc('console_session_open', `consolesess.open.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash });
  const mint = async (doName: string, sign: (doName: string, sessionId: string) => Promise<string>, open: Open): Promise<string | null> => {
    const sessionId = newSessionId();
    const sessionHash = await linkCodeHash(sessionId);
    if (await open(doName, sessionHash) !== true) return null;
    return `${encodeURIComponent(doName)}.${sessionId}.${await sign(doName, sessionId)}`;
  };
  // A malformed artifact is simply not valid: it never throws, so a bad value cannot read as an outage.
  const readSession = async (raw: string | null | undefined, sign: (doName: string, sessionId: string) => Promise<string>): Promise<Readonly<{ doName: string; sessionHash: string }> | null> => {
    const sigDot = raw?.lastIndexOf('.') ?? -1;
    if (!raw || sigDot < 1) return null;
    const sessionDot = raw.lastIndexOf('.', sigDot - 1);
    if (sessionDot < 1) return null;
    let doName: string;
    try { doName = decodeURIComponent(raw.slice(0, sessionDot)); } catch { return null; }
    const sessionId = raw.slice(sessionDot + 1, sigDot);
    const expected = new TextEncoder().encode(await sign(doName, sessionId));
    const given = new TextEncoder().encode(raw.slice(sigDot + 1));
    let diff = expected.length ^ given.length;
    for (let i = 0; i < expected.length; i += 1) diff |= expected[i]! ^ (given[i] ?? 0);
    if (diff !== 0) return null;
    return { doName, sessionHash: await linkCodeHash(sessionId) };
  };
  const readSigned = async (raw: string | null | undefined, sign: (doName: string, sessionId: string) => Promise<string>): Promise<string | null> => {
    const session = await readSession(raw, sign);
    if (!session) return null;
    const { doName, sessionHash } = session;
    const live = await rpc('console_session_touch', `consolesess.touch.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash });
    return live === true ? doName : null;
  };
  const presentedOwnerCookie = (request: Request) =>
    (request.headers.get('cookie') ?? '').split(';').map((part) => part.trim()).find((part) => part.startsWith(`${OWNER_COOKIE}=`))?.slice(OWNER_COOKIE.length + 1);
  // console_session_inventory, not console_session_list: the list keeps its three keys for a Worker deployed before the
  // 30-day app session, and the inventory adds each row's end, its renewal successor and its sign-in time.
  const listSessions = async (doName: string): Promise<readonly ConsoleSession[]> => {
    const rows = await rpc('console_session_inventory', `consolesess.inventory.${doName}`, { p_do_name: doName });
    // An invalid authority response cannot prove that a session is absent.
    if (!Array.isArray(rows)) throw new Error('session inventory unavailable');
    const seen = new Set<string>();
    return rows.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('session inventory unavailable');
      const row = raw as Record<string, unknown>;
      if (Object.keys(row).sort().join(',') !== 'created_at,expires_at,last_seen_at,rotated_to,session,signed_in_at'
        || typeof row.session !== 'string' || !/^[a-f0-9]{64}$/.test(row.session) || seen.has(row.session)
        || typeof row.created_at !== 'string' || !Number.isFinite(Date.parse(row.created_at))
        || typeof row.last_seen_at !== 'string' || !Number.isFinite(Date.parse(row.last_seen_at))
        || typeof row.expires_at !== 'string' || !Number.isFinite(Date.parse(row.expires_at))
        || typeof row.signed_in_at !== 'string' || !Number.isFinite(Date.parse(row.signed_in_at))
        || (row.rotated_to !== null && (typeof row.rotated_to !== 'string' || !/^[a-f0-9]{64}$/.test(row.rotated_to)))) throw new Error('session inventory unavailable');
      seen.add(row.session);
      return { session: row.session, created_at: row.created_at, last_seen_at: row.last_seen_at, expires_at: row.expires_at, rotated_to: row.rotated_to, signed_in_at: row.signed_in_at };
    });
  };
  // The list holds only live rows, so membership answers liveness without moving last_seen_at.
  const readListed = async (raw: string | null | undefined): Promise<string | null> => {
    const session = await readSession(raw, cookieSig);
    if (!session) return null;
    return (await listSessions(session.doName)).some((row) => row.session === session.sessionHash) ? session.doName : null;
  };
  const capSession = async (doName: string, sessionHash: string): Promise<boolean> => {
    const capped = await rpc('console_session_cap', `consolesess.cap.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash });
    if (typeof capped !== 'boolean') throw new Error('session cap unavailable');
    return capped;
  };
  const revokeSession = async (doName: string, sessionHash: string): Promise<boolean> => {
    const revoked = await rpc('console_session_revoke', `consolesess.revoke.${doName}.${sessionHash}`, { p_do_name: doName, p_session_hash: sessionHash });
    if (typeof revoked !== 'boolean') throw new Error('session revocation unavailable');
    return revoked;
  };
  const resolveOwner = async (email: string, code: string, inviteCode: string, join: boolean, joinPhone = '') => {
    const address = email.trim().toLowerCase();
    const user = await auth('verify', { type: 'email', email: address, token: code.trim() }, async response => {
      if (!response.ok) return null;
      const { user } = (await response.json()) as { user?: { id?: string; email?: string } };
      return user;
    });
    if (!user?.id || user.email?.toLowerCase() !== address) return null;
    // An existing member resolves first, so an invite they also hold is never spent. Empty phone makes
    // owner_for_auth refuse new provisioning; only the join path admits a new member, through
    // signup_owner_for_auth, which rechecks the confirmed Auth email and spends the exact invite atomically.
    const phoneE164 = '';
    const codeHash = inviteCode ? await linkCodeHash(inviteCode) : '';
    const owner = (await rpc('owner_for_auth', `owner.${user.id}.${address}.${phoneE164}.${codeHash}`, { p_auth_user: user.id, p_email: address, p_phone: phoneE164, p_code_hash: codeHash })) as string | null;
    if (owner || !join || !codeHash) return owner;
    const joined = await rpc('signup_owner_for_auth', `signup.owner.${user.id}.${address}.${joinPhone}.${codeHash}`, { p_auth_user: user.id, p_email: address, p_phone: joinPhone, p_code_hash: codeHash });
    return typeof joined === 'string' && joined.length > 0 ? joined : null;
  };
  return {
    async throttle(key, limit, windowSeconds) {
      return (await rpc('console_auth_throttle', `throttle.${key}.${limit}.${windowSeconds}`, { p_key: key, p_limit: limit, p_window_seconds: windowSeconds })) === true;
    },
    // Unknown addresses get no email and the same answer, so the page never reveals who is invited.
    async sendCode(email, code = '') {
      const address = email.trim().toLowerCase();
      const codeHash = code ? await linkCodeHash(code) : '';
      if (!(await rpc('signin_allowed', `signin.${address}.${codeHash}`, { p_email: address, p_code_hash: codeHash }))) return false;
      // Supabase may create an Auth identity here; this does not create a Waldo owner.
      return auth('otp', { email: address, create_user: true }, response => {
        if (!response.ok) throw new Error(`otp send ${response.status}`);
        return true;
      });
    },
    verify: (email, code, _phone, inviteCode = '') => resolveOwner(email, code, inviteCode, false),
    verifyOrJoin: (email, code, inviteCode, phone = '') => resolveOwner(email, code, inviteCode, true, phone),
    async issueLinkCode(doName) {
      const code = newLinkCode();
      const hash = await linkCodeHash(code);
      return (await rpc('issue_link_code', `link.${doName}.${hash}`, { p_do_name: doName, p_code_hash: hash })) ? code : null;
    },
    async issueProviderLinkCode(doName, provider) {
      const code = newLinkCode();
      const hash = await linkCodeHash(code);
      return (await rpc('issue_provider_link_code', `link.${provider}.${doName}.${hash}`, { p_do_name: doName, p_provider: provider, p_code_hash: hash })) ? code : null;
    },
    async saveSettings(doName, { timezone, quiet_start: start, quiet_end: end, volume }) {
      const message = `settings.${doName}.${timezone}.${start ?? ''}.${end ?? ''}.${volume}`;
      return (await rpc('set_owner_settings', message, { p_do_name: doName, p_timezone: timezone, p_quiet_start: start ?? '', p_quiet_end: end ?? '', p_volume: volume })) === true;
    },
    adminOverview: async (doName) => (await rpc('admin_overview', `admin.${doName}`, { p_do_name: doName })) as AdminOverview | null,
    adminCostSummary: async (doName) => {
      const summary = await rpc('admin_cost_summary', `admincost.${doName}`, { p_do_name: doName });
      return summary === null ? null : adminCostSummarySchema.parse(summary);
    },
    invite: async (doName, email, code) => {
      const address = email.trim().toLowerCase();
      const hash = await linkCodeHash(code);
      return (await rpc('admin_invite', `invite.${doName}.${address}.${hash}`, { p_do_name: doName, p_email: address, p_code_hash: hash })) === true;
    },
    memberInvite: async (doName, email, code) => {
      const address = email.trim().toLowerCase();
      const hash = await linkCodeHash(code);
      return (await rpc('issue_member_invite', `memberinvite.${doName}.${address}.${hash}`, { p_do_name: doName, p_email: address, p_code_hash: hash })) === true;
    },
    memberInvites: async (doName) => (await rpc('member_invites', `memberinvites.${doName}`, { p_do_name: doName })) as AdminOverview['invites'],
    revokeInvite: async (doName, invite) => (await rpc('admin_revoke', `revoke.${doName}.${invite}`, { p_do_name: doName, p_invite: invite })) === true,
    unlinkTelegram: async (doName) => (await rpc('unlink_presence', `unlink.${doName}.telegram`, { p_do_name: doName, p_provider: 'telegram' })) === true,
    unlinkIMessage: async (doName) => (await rpc('unlink_presence', `unlink.${doName}.imessage`, { p_do_name: doName, p_provider: 'imessage' })) === true,
    iMessageHandleHint: (doName) => presenceHint(doName, 'imessage'),
    unlinkWhatsApp: async (doName) => (await rpc('unlink_presence', `unlink.${doName}.whatsapp`, { p_do_name: doName, p_provider: 'whatsapp' })) === true,
    whatsAppHandleHint: (doName) => presenceHint(doName, 'whatsapp'),
    assertChannelPresence: async (doName, provider, subject) => (await rpc('assert_channel_presence', `presence.${doName}.${provider}.${subject}`, { p_do_name: doName, p_provider: provider, p_subject: subject })) === true,
    deleteOwner: async (doName) => (await rpc('delete_owner', `delown.${doName}`, { p_do_name: doName })) === true,
    async ownerCookie(doName, presented) {
      const previous = presented ? await readSession(presentedOwnerCookie(presented), cookieSig) : null;
      if (previous) await capSession(previous.doName, previous.sessionHash);
      return mint(doName, cookieSig, openLong);
    },
    readOwnerCookie: (request) => fromAnotherSite(request) ? readListed(presentedOwnerCookie(request)) : readSigned(presentedOwnerCookie(request), cookieSig),
    ownerAppCredential: (doName) => mint(doName, appSig, openTwelveHours),
    readAppCredential: (credential) => readSigned(credential, appSig),
    async renewAppCredential(doName, sessionId) {
      const fresh = newSessionId();
      const [presented, renewed] = await Promise.all([linkCodeHash(sessionId), linkCodeHash(fresh)]);
      const rotated = await rpc('app_session_rotate', `appsess.rotate.${doName}.${presented}.${renewed}`, { p_do_name: doName, p_session_hash: presented, p_new_session_hash: renewed });
      if (typeof rotated !== 'boolean') throw new Error('session renewal unavailable');
      return rotated ? `${encodeURIComponent(doName)}.${fresh}.${await appSig(doName, fresh)}` : null;
    },
    listSessions,
    revokeSession,
    async signOutAll(doName) {
      const count = await rpc('console_signout_all', `consolesess.signout.${doName}`, { p_do_name: doName });
      if (typeof count !== 'number') throw new Error('session revocation unavailable');
      return count;
    },
  };
};
