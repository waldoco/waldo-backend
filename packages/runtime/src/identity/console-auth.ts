import { withRequestTimeout } from './request-timeout';
import { adminCostSummarySchema, type AdminCostSummary } from '../channels/admin-spend';
import { announcementReportSchema, type AnnouncementDraft, type AnnouncementReport } from '../channels/announcements';
import { OPEN_SIGNUP_EMAIL_DAILY_LIMIT, OPEN_SIGNUP_IP_DAILY_LIMIT, type OpenSignup } from './open-signup';
import { APP_JOIN_TICKET_SECONDS } from '../../../contracts/src/app/core';
import { hex, linkCodeHash, routerSignature, signedRpc, type OwnerDirectoryEnv } from './owner-directory';
import { openValue, sealValue } from './sealed-value';

export const OWNER_COOKIE = 'waldo_owner';
// A console sign-in stays signed in while it is used: it ends 7 days after its last signed-in request, and 30 days
// after sign-in however much it is used. The directory row and the owner object's own session both enforce it, and
// the database refuses a row past 30 days. Email codes are a single factor, so 30 days is NIST SP 800-63B-4's AAL1
// reauthentication ceiling; the app bearer keeps its own 12 hours.
export const CONSOLE_SESSION_LIFETIME_MS = 30 * 24 * 60 * 60_000;
export const CONSOLE_SESSION_IDLE_MS = 7 * 24 * 60 * 60_000;
// An action that creates lasting access needs a sign-in (an email code, Apple or Google) from the last 2 hours. That is GitHub's sudo mode ("a
// two-hour session timeout period before prompting you for authentication again"), and OWASP's Authentication Cheat
// Sheet asks for current credentials before sensitive features. Unlike GitHub's, the window does not restart with each
// sensitive action: it runs from the sign-in.
export const CONSOLE_STEP_UP_MS = 2 * 60 * 60_000;
// The app proves a recent sign-in by its session's sign-in time: every app session starts from an email code, Apple or
// Google, so the row's created_at is the console's verified_at. A missing row or an unreadable time is never recent.
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

// Why a person who proved their mailbox or token got no account: this server takes no new ones, today's attempts from their
// network or for their email are spent, or another owner row holds the email.
export type JoinRefusal = 'signup_closed' | 'join_limited' | 'account_conflict';
// new_account: the person proved the mailbox or token, no owner has the email, and nothing was created; `ticket` makes the
// account on their yes (joinWithTicket). Asked only when the sign-in passes confirmNew.
type AskedOrRefused = Readonly<{ state: 'join_refused'; reason: JoinRefusal } | { state: 'new_account'; email: string; ticket: string }>;
// refused: Supabase declined the token or code, or it vouched for no confirmed email (no_email). confirm: the identity
// reached an existing owner it has never signed in; nothing is signed in until the owner enters an email code with link.
// needs_invite: no owner, and this sign-in does not join (the console's).
export type IdentitySignIn = Readonly<{ state: 'owner'; doName: string } | { state: 'needs_invite' } | { state: 'refused'; reason: 'token' | 'no_email' }
  | { state: 'confirm'; email: string; link: string }> | AskedOrRefused;
// code_invalid: the email code did not verify. Nothing else was checked.
export type EmailSignIn = Readonly<{ state: 'owner'; doName: string } | { state: 'code_invalid' }> | AskedOrRefused;
export type JoinSignIn = Readonly<{ state: 'owner'; doName: string } | { state: 'ticket_invalid' } | { state: 'join_refused'; reason: JoinRefusal }>;
// How long a confirm link stays good: about as long as the email code it travels with.
export const SIGNIN_LINK_SECONDS = 15 * 60;
const SIGNIN_LINK_PURPOSE = 'signinlink';
const JOIN_TICKET_PURPOSE = 'jointicket';

export type ConsoleAuth = Readonly<{
  // With open sign-up, an address that is not a member also gets a code. False when no code was sent.
  sendCode(email: string, code?: string, open?: OpenSignup): Promise<boolean>;
  // Strict fixed-window auth throttle kept in the owner directory: global and durable, unlike
  // the per-location binding layer, which only expresses 10s/60s periods.
  throttle(key: string, limit: number, windowSeconds: number): Promise<boolean>;
  // Console sign-in: resolves an existing member only; new console members use the signup flow.
  // A link from a confirm also records that Apple or Google identity as trusted, once the code proves the mailbox.
  verify(email: string, code: string, phone?: string, inviteCode?: string, link?: string): Promise<string | null>;
  // App sign-in: resolves an existing member, otherwise joins with the exact recipient-bound invite, otherwise, with open
  // sign-up, joins openly. The phone is kept, unverified, only on a join; an existing member's sign-in never changes the
  // number on file.
  verifyOrJoin(email: string, code: string, inviteCode: string, phone?: string, link?: string, open?: OpenSignup): Promise<string | null>;
  // verifyOrJoin, saying why when no owner signs in. With confirmNew and no invite, a newcomer is asked first (new_account)
  // instead of joined.
  signInWithEmailCode?(email: string, code: string, options: Readonly<{ invite?: string; phone?: string; link?: string; open?: OpenSignup; confirmNew?: boolean }>): Promise<EmailSignIn>;
  // The yes to new_account: makes the one account the ticket's proven identity names, or signs into it when it already exists.
  joinWithTicket?(ticket: string, phone?: string, open?: OpenSignup): Promise<JoinSignIn>;
  // App sign-in with Apple or Google: Supabase checks the identity token's signature, audience and nonce, and the owner
  // resolves from the email it confirms as verifyOrJoin resolves it. An identity signs an existing owner in only once it
  // is trusted: it created the owner (through an invite or an open join), or the owner confirmed it with an email code. Supabase links a new
  // identity to the Auth user holding the same verified email, and a provider's verified flag is the provider's view of the
  // address (Google's covers whoever held a custom domain's address before), so the mailbox decides.
  signInWithIdToken?(provider: 'apple' | 'google', idToken: string, nonce: string, inviteCode: string, phone?: string, open?: OpenSignup, confirmNew?: boolean): Promise<IdentitySignIn>;
  // Console Google sign-in: the PKCE code Supabase redirected back with and this browser's verifier. Members only, like verify.
  signInWithAuthCode?(code: string, verifier: string): Promise<IdentitySignIn>;
  issueLinkCode(doName: string): Promise<string | null>;
  // Whether the active owner joined without an invite: held until released after their agreements, released, or a member.
  openOwnerState?(doName: string): Promise<'member' | 'held' | 'released' | null>;
  /** A one-time code for one provider: the sender texts "waldo CODE" (WhatsApp, iMessage) or /link CODE (Telegram). */
  issueProviderLinkCode?(doName: string, provider: 'telegram' | 'whatsapp' | 'imessage'): Promise<string | null>;
  saveSettings(doName: string, settings: OwnerSettings): Promise<boolean>;
  adminOverview(doName: string): Promise<AdminOverview | null>;
  /** Spend across every owner for the last 30 days; null unless the database admits the caller as an admin. */
  adminCostSummary(doName: string): Promise<AdminCostSummary | null>;
  /** Writes an announcement once; false when the caller is not an admin or the id is taken. */
  announce?(doName: string, draft: AnnouncementDraft): Promise<boolean>;
  /** Sends an announcement live in one environment; production needs its own call. */
  announcementLive?(doName: string, id: string, environment: string): Promise<boolean>;
  /** Counts per outcome for one announcement; null unless the caller is an admin and the announcement exists. */
  announcementReport?(doName: string, id: string): Promise<AnnouncementReport | null>;
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

const ownerName = (signedIn: EmailSignIn): string | null => signedIn.state === 'owner' ? signedIn.doName : null;

// The sub claim of a compact JWT; null when the payload is not JSON or carries no usable subject.
const tokenSubject = (token: string): string | null => {
  try {
    const { sub } = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(token.split('.')[1]!.replaceAll('-', '+').replaceAll('_', '/')), c => c.charCodeAt(0)))) as { sub?: unknown };
    return typeof sub === 'string' && sub.length > 0 && sub.length <= 255 ? sub : null;
  } catch { return null; } // Not a JWT payload: the sign-in is refused as an unusable token.
};

const GOOGLE_USERINFO = 'https://www.googleapis.com/userinfo/v2/me';

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
  const resolveOwner = async (email: string, code: string, inviteCode: string, join: boolean, joinPhone = '', link = '', open?: OpenSignup, confirmNew = false): Promise<EmailSignIn> => {
    const address = email.trim().toLowerCase();
    const user = await auth('verify', { type: 'email', email: address, token: code.trim() }, async response => {
      if (!response.ok) return null;
      const { user } = (await response.json()) as { user?: { id?: string; email?: string } };
      return user;
    });
    if (!user?.id || user.email?.toLowerCase() !== address) return { state: 'code_invalid' };
    const proven = { id: user.id, email: address }, askFirst = join && confirmNew && !inviteCode;
    const owner = await ownerFor(proven, inviteCode, join && !askFirst, joinPhone, undefined, open);
    if (owner && 'refused' in owner) return { state: 'join_refused', reason: owner.refused };
    if (!owner) return askFirst ? askToJoin(proven, '', '', open) : { state: 'join_refused', reason: 'signup_closed' };
    const ticket = link ? await openValue(secret, SIGNIN_LINK_PURPOSE, link, now(), SIGNIN_LINK_SECONDS) : null;
    if (ticket && ticket.user === user.id && ticket.email === address && (ticket.provider === 'apple' || ticket.provider === 'google') && typeof ticket.subject === 'string')
      await trustIdentity(proven, ticket.provider, ticket.subject);
    return { state: 'owner', doName: owner.doName };
  };
  // A newcomer who proved the mailbox or token: a ticket for their yes, unless no join could be made at all.
  const askToJoin = async (user: Readonly<{ id: string; email: string }>, provider: '' | 'apple' | 'google', subject: string, open?: OpenSignup): Promise<AskedOrRefused> =>
    open ? { state: 'new_account', email: user.email, ticket: await sealValue(secret, JOIN_TICKET_PURPOSE, { user: user.id, email: user.email, provider, subject, expires: Math.floor(now() / 1000) + APP_JOIN_TICKET_SECONDS }) }
      : { state: 'join_refused', reason: 'signup_closed' };
  // An existing member resolves first, so an invite they also hold is never spent. Empty phone makes
  // owner_for_auth refuse new provisioning; only the join path admits a new member, through
  // signup_owner_for_auth, which rechecks the confirmed Auth email and spends the exact invite atomically.
  // joined: this call created the owner, spending its invite. With an identity, the same transaction trusts it, and
  // joined comes from that transaction: an owner another sign-in created first is only found.
  // With open sign-up an invite still goes first, so the one who sent it stays named; a join it cannot make joins openly.
  // null: no owner, and this call does not join. refused: it tried to join and could not.
  const ownerFor = async (user: Readonly<{ id: string; email: string }>, inviteCode: string, join: boolean, joinPhone = '',
    identity?: Readonly<{ provider: 'apple' | 'google'; subject: string }>, open?: OpenSignup): Promise<Joined | Readonly<{ refused: JoinRefusal }> | null> => {
    const address = user.email;
    const phoneE164 = '';
    const codeHash = inviteCode ? await linkCodeHash(inviteCode) : '';
    const owner = (await rpc('owner_for_auth', `owner.${user.id}.${address}.${phoneE164}.${codeHash}`, { p_auth_user: user.id, p_email: address, p_phone: phoneE164, p_code_hash: codeHash })) as string | null;
    if (owner) return { doName: owner, joined: false };
    if (!join) return null;
    const invited = codeHash ? await inviteJoin(user, codeHash, joinPhone, identity) : null;
    return invited ?? (open ? openJoin(user, joinPhone, identity, open) : { refused: 'signup_closed' });
  };
  const inviteJoin = async (user: Readonly<{ id: string; email: string }>, codeHash: string, joinPhone: string,
    identity?: Readonly<{ provider: 'apple' | 'google'; subject: string }>): Promise<Joined | null> => {
    const address = user.email;
    if (identity) {
      const { provider, subject } = identity;
      const result = (await rpc('signup_owner_with_signin_identity', `signinid.signup.${user.id}.${address}.${provider}.${subject}.${joinPhone}.${codeHash}`,
        { p_auth_user: user.id, p_email: address, p_provider: provider, p_subject: subject, p_phone: joinPhone, p_code_hash: codeHash })) as { do_name?: unknown; created?: unknown } | null;
      return typeof result?.do_name === 'string' && result.do_name.length > 0 ? { doName: result.do_name, joined: result.created === true } : null;
    }
    const joined = await rpc('signup_owner_for_auth', `signup.owner.${user.id}.${address}.${joinPhone}.${codeHash}`, { p_auth_user: user.id, p_email: address, p_phone: joinPhone, p_code_hash: codeHash });
    return typeof joined === 'string' && joined.length > 0 ? { doName: joined, joined: true } : null;
  };
  const refuseOpen = (code: 'open_signup_limited' | 'open_signup_taken' | 'open_signup_refused', refused: JoinRefusal) => {
    console.error(JSON.stringify({ hop: 'open_signup', ok: false, code }));
    return { refused };
  };
  // Each attempt spends one of the address's and one of the email's daily attempts, keyed by a router-keyed digest, so a
  // leaked key names neither an address nor an email that can be guessed and hashed. The database counts the day's joins,
  // caps none, and trusts the joining identity as an invite join does.
  const openJoin = async (user: Readonly<{ id: string; email: string }>, joinPhone: string,
    identity: Readonly<{ provider: 'apple' | 'google'; subject: string }> | undefined, open: OpenSignup): Promise<Joined | Readonly<{ refused: JoinRefusal }>> => {
    const address = user.email;
    const attempt = async (key: string, limit: number) =>
      (await rpc('open_signup_throttle', `signup.open.throttle.${key}.${limit}`, { p_key: key, p_limit: limit })) === true;
    const keyed = (text: string) => routerSignature(secret, 0, `openthrottle.${text}`);
    if (!(await attempt(`ip.${await keyed(open.ip)}`, OPEN_SIGNUP_IP_DAILY_LIMIT)) || !(await attempt(`email.${await keyed(address)}`, OPEN_SIGNUP_EMAIL_DAILY_LIMIT)))
      return refuseOpen('open_signup_limited', 'join_limited');
    const provider = identity?.provider ?? '', subject = identity?.subject ?? '';
    const result = (await rpc('signup_owner_open_uncapped', `signup.open.uncapped.${user.id}.${address}.${provider}.${subject}.${joinPhone}`,
      { p_auth_user: user.id, p_email: address, p_provider: provider, p_subject: subject, p_phone: joinPhone })) as
      { do_name?: unknown; created?: unknown; refused?: unknown } | null;
    if (typeof result?.do_name === 'string' && result.do_name.length > 0) return { doName: result.do_name, joined: result.created === true };
    if (result?.refused === 'taken') return refuseOpen('open_signup_taken', 'account_conflict');
    // The database refused the join's own fields (an Auth user that no longer holds this confirmed email, or a malformed phone):
    // retrying cannot change that, so it is not reported as unavailable.
    return refuseOpen('open_signup_refused', 'account_conflict');
  };
  type Identity = Readonly<{ id: string; email: string }>;
  type Joined = Readonly<{ doName: string; joined: boolean }>;
  const identityTrusted = async (user: Identity, provider: string, subject: string) =>
    (await rpc('signin_identity_trusted', `signinid.trusted.${user.id}.${user.email}.${provider}.${subject}`, { p_auth_user: user.id, p_email: user.email, p_provider: provider, p_subject: subject })) === true;
  // Recording trust is never what signs the owner in, so a failure here costs only an email code at the next sign-in.
  const trustIdentity = async (user: Identity, provider: string, subject: string) => {
    try { await rpc('trust_signin_identity', `signinid.trust.${user.id}.${user.email}.${provider}.${subject}`, { p_auth_user: user.id, p_email: user.email, p_provider: provider, p_subject: subject }); }
    catch { console.error(JSON.stringify({ hop: 'signin_identity_trust', ok: false, code: 'trust_unavailable' })); }
  };
  // Supabase's own refusal body can echo the token's claims, so only its status is read. A limit or an outage is not a
  // refusal of the token, and throws.
  const granted = (grant: 'id_token' | 'pkce', body: object) => auth(`token?grant_type=${grant}`, body, async response => {
    if (response.status === 429 || response.status >= 500) throw new Error(`token grant ${response.status}`);
    if (!response.ok) return { state: 'refused', reason: 'token' } as const;
    type GrantedIdentity = { id?: unknown; provider?: unknown };
    const { user, provider_token: providerToken } = (await response.json()) as { provider_token?: unknown; user?: { id?: string; email?: string | null; email_confirmed_at?: string | null; identities?: GrantedIdentity[] | null } };
    if (!user?.id) return { state: 'refused', reason: 'token' } as const;
    if (!user.email || !user.email_confirmed_at) return { state: 'refused', reason: 'no_email' } as const;
    return { state: 'user', id: user.id, email: user.email.toLowerCase(), identities: Array.isArray(user.identities) ? user.identities : [],
      providerToken: typeof providerToken === 'string' && providerToken.length > 0 ? providerToken : null } as const;
  });
  // The Google account behind a console sign-in: Google's answer for the access token Supabase kept from this very flow.
  // Supabase derives a Google identity's subject from the same endpoint and the same token (provider/google.go), so this
  // names the identity the flow signed in, where the user's identity list can only say which signed in last.
  const googleSubject = (token: string | null) => token ? withRequestTimeout(async signal => {
    const response = await fetcher(GOOGLE_USERINFO, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal });
    if (response.status === 429 || response.status >= 500) throw new Error(`google userinfo ${response.status}`);
    if (!response.ok) return null;
    const { id } = (await response.json()) as { id?: unknown };
    return typeof id === 'string' && id.length > 0 && id.length <= 255 ? id : null;
  }) : Promise.resolve(null);
  const signInIdentity = async (grant: Awaited<ReturnType<typeof granted>>, provider: 'apple' | 'google', subject: (granted: Extract<typeof grant, { state: 'user' }>) => Promise<string | null>,
    inviteCode: string, join: boolean, joinPhone = '', open?: OpenSignup, confirmNew = false): Promise<IdentitySignIn> => {
    if (grant.state === 'refused') return grant;
    const user = { id: grant.id, email: grant.email }, sub = await subject(grant);
    if (!sub) return { state: 'refused', reason: 'token' };
    const askFirst = join && confirmNew && !inviteCode;
    const owner = await ownerFor(user, inviteCode, join && !askFirst, joinPhone, { provider, subject: sub }, open);
    if (owner && 'refused' in owner) return { state: 'join_refused', reason: owner.refused };
    if (!owner) return askFirst ? askToJoin(user, provider, sub, open) : { state: 'needs_invite' };
    return identityOwner(user, provider, sub, owner);
  };
  // An identity signs an owner it did not create in only once it is trusted; otherwise the owner confirms it with an email code.
  const identityOwner = async (user: Identity, provider: 'apple' | 'google', sub: string, owner: Joined): Promise<IdentitySignIn> => {
    if (!owner.joined && !(await identityTrusted(user, provider, sub)))
      return { state: 'confirm', email: user.email, link: await sealValue(secret, SIGNIN_LINK_PURPOSE, { user: user.id, email: user.email, provider, subject: sub, expires: Math.floor(now() / 1000) + SIGNIN_LINK_SECONDS }) };
    return { state: 'owner', doName: owner.doName };
  };
  return {
    async throttle(key, limit, windowSeconds) {
      return (await rpc('console_auth_throttle', `throttle.${key}.${limit}.${windowSeconds}`, { p_key: key, p_limit: limit, p_window_seconds: windowSeconds })) === true;
    },
    // With open sign-up every address gets a code. Without it, an address that is neither a member nor holding a matching
    // invite gets none, and the answer says so.
    async sendCode(email, code = '', open) {
      const address = email.trim().toLowerCase();
      const codeHash = code ? await linkCodeHash(code) : '';
      if (!open && !(await rpc('signin_allowed', `signin.${address}.${codeHash}`, { p_email: address, p_code_hash: codeHash }))) return false;
      // Supabase may create an Auth identity here; this does not create a Waldo owner.
      return auth('otp', { email: address, create_user: true }, response => {
        if (!response.ok) throw new Error(`otp send ${response.status}`);
        return true;
      });
    },
    verify: async (email, code, _phone, inviteCode = '', link = '') => ownerName(await resolveOwner(email, code, inviteCode, false, '', link)),
    verifyOrJoin: async (email, code, inviteCode, phone = '', link = '', open) => ownerName(await resolveOwner(email, code, inviteCode, true, phone, link, open)),
    signInWithEmailCode: (email, code, { invite = '', phone = '', link = '', open, confirmNew = false }) => resolveOwner(email, code, invite, true, phone, link, open, confirmNew),
    // The ticket is the proven identity, sealed for APP_JOIN_TICKET_SECONDS: it joins that person, or finds them if they joined
    // since. An identity that reaches an owner it has not signed in before is not trusted here: the person signs in again
    // and confirms it with an email code.
    async joinWithTicket(raw, phone = '', open) {
      const ticket = await openValue(secret, JOIN_TICKET_PURPOSE, raw, now(), APP_JOIN_TICKET_SECONDS);
      const { user: id, email, provider, subject } = ticket ?? {};
      if (typeof id !== 'string' || typeof email !== 'string' || (provider !== '' && provider !== 'apple' && provider !== 'google') || typeof subject !== 'string') return { state: 'ticket_invalid' };
      const user = { id, email };
      const owner = await ownerFor(user, '', true, phone, provider ? { provider, subject } : undefined, open);
      if (!owner) return { state: 'ticket_invalid' };
      if ('refused' in owner) return { state: 'join_refused', reason: owner.refused };
      if (!provider) return { state: 'owner', doName: owner.doName };
      const signedIn = await identityOwner(user, provider, subject, owner);
      return signedIn.state === 'owner' ? signedIn : { state: 'ticket_invalid' };
    },
    // The identity is the token's own subject. Supabase accepted these exact bytes, so the claim is authentic; the grant's
    // identity list cannot name it, because Supabase leaves an identity it links in this call out of that list.
    signInWithIdToken: async (provider, idToken, nonce, inviteCode, phone = '', open, confirmNew = false) =>
      signInIdentity(await granted('id_token', { provider, id_token: idToken, nonce }), provider, async () => tokenSubject(idToken), inviteCode, true, phone, open, confirmNew),
    // Google names the account behind this flow's token; it must be one of this user's Google identities.
    signInWithAuthCode: async (code, verifier) => signInIdentity(await granted('pkce', { auth_code: code, code_verifier: verifier }), 'google', async grant => {
      const sub = await googleSubject(grant.providerToken);
      return sub && grant.identities.some(identity => identity.provider === 'google' && identity.id === sub) ? sub : null;
    }, '', false),
    async openOwnerState(doName) {
      const state = await rpc('open_owner_state', `openowner.state.${doName}`, { p_do_name: doName });
      if (state !== null && state !== 'member' && state !== 'held' && state !== 'released') throw new Error('open owner state unavailable');
      return state;
    },
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
    announce: async (doName, draft) => {
      const requires = draft.requires.join(','), environments = draft.environments.join(',');
      const fields = [draft.release, draft.title, draft.shipped, draft.why, draft.capability, requires, environments].join('\u001f');
      const digest = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fields)));
      return (await rpc('admin_announce', `announce.${doName}.${draft.id}.${digest}`, { p_do_name: doName, p_id: draft.id, p_release: draft.release, p_title: draft.title,
        p_shipped: draft.shipped, p_why: draft.why, p_capability: draft.capability, p_requires: requires, p_environments: environments })) === true;
    },
    announcementLive: async (doName, id, environment) =>
      (await rpc('admin_announcement_live', `announcelive.${doName}.${id}.${environment}`, { p_do_name: doName, p_id: id, p_environment: environment })) === true,
    announcementReport: async (doName, id) => {
      const report = await rpc('admin_announcement_report', `announcereport.${doName}.${id}`, { p_do_name: doName, p_id: id });
      return report === null ? null : announcementReportSchema.parse(report);
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
