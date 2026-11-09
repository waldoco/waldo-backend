import { APP_SESSION_FENCE_PATH, appSessionFenceSignature } from '../identity/app-session-fence';
import { OWNER_COOKIE } from '../identity/console-auth';
import { linkCodeHash } from '../identity/owner-directory';

export type FenceEnv = Readonly<{ WALDO_ROUTER_HMAC_SECRET?: string }>;

// Closes the session's queued work and stops its running turn in the owner Durable Object; false when it cannot be confirmed.
// Revoking a session first makes this safe to repeat: nothing new is admitted under it after the revoke.
export const fenceSession = async (env: FenceEnv, owners: DurableObjectNamespace, doName: string, sessionHash: string): Promise<boolean> => {
  const secret = env.WALDO_ROUTER_HMAC_SECRET;
  if (!secret) return false;
  try {
    const response = await owners.get(owners.idFromName(doName)).fetch(new Request(`https://telegram-owner${APP_SESSION_FENCE_PATH}`, {
      method: 'POST',
      headers: { 'x-waldo-do-name': doName, 'x-waldo-app-session-hash': sessionHash, 'x-waldo-fence-sig': await appSessionFenceSignature(secret, doName, sessionHash) },
    }));
    if (response.ok) return true;
  } catch { /* reported below */ }
  console.error('app session fence unavailable');
  return false;
};

export const ownerCookies = (request: Request): readonly string[] =>
  (request.headers.get('cookie') ?? '').split(';').map(part => part.trim()).filter(part => part.startsWith(`${OWNER_COOKIE}=`));

// The hash of the session inside the owner cookie, read only after readOwnerCookie has checked its signature and that its row is live.
export const ownerSessionHash = async (request: Request): Promise<string | null> => {
  const raw = ownerCookies(request)[0]?.slice(OWNER_COOKIE.length + 1);
  const sigDot = raw?.lastIndexOf('.') ?? -1;
  const sessionDot = raw && sigDot > 0 ? raw.lastIndexOf('.', sigDot - 1) : -1;
  return raw && sessionDot > 0 ? linkCodeHash(raw.slice(sessionDot + 1, sigDot)) : null;
};
