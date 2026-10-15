import { OWNER_COOKIE, type ConsoleAuth } from '../identity/console-auth';
import { CONSOLE_ACTION_PATH, CONSOLE_COOKIE, CONSOLE_PATH } from './console';
import { CONTROL_ACTION_PATH } from './dashboard-control-actions';
import { fenceSession, ownerSessionHash, type FenceEnv } from './session-fence';

// Console chat turns run under the console's owner session, so signing out of the console must end that session's
// work as app sign-out does: otherwise a message sent just before signing out would still run, and a single sign-out
// would leave the owner cookie's session live for chat until it expired.
export const consoleSignoutKind = async (request: Request, url: URL): Promise<'one' | 'all' | null> => {
  if (request.method !== 'POST' || (url.pathname !== CONSOLE_ACTION_PATH && url.pathname !== CONTROL_ACTION_PATH)) return null;
  let action: unknown;
  try { action = (await request.clone().formData()).get('action'); } catch { return null; }
  return action === 'session.signout' ? 'one' : action === 'session.signout.all' ? 'all' : null;
};

// Before the owner object signs out. One browser: its session row is revoked and fenced first, so a failure leaves
// nothing half done. Everywhere: the rows the owner object is about to revoke, to fence once it has. Throws when the
// directory cannot confirm.
export const prepareConsoleSignout = async (kind: 'one' | 'all', request: Request, auth: ConsoleAuth, env: FenceEnv, owners: DurableObjectNamespace, doName: string): Promise<readonly string[]> => {
  if (kind === 'all') return (await auth.listSessions(doName)).map(row => row.session);
  const own = await ownerSessionHash(request);
  if (!own) return [];
  await auth.revokeSession(doName, own);
  await fenceSession(env, owners, doName, own);
  return [];
};

// The owner object signed this browser out when it cleared the console cookie.
export const signedOut = (response: Response): boolean => new RegExp(`(?:^|,\\s*)${CONSOLE_COOKIE}=;`).test(response.headers.get('set-cookie') ?? '');

// A signed-out response clears the owner cookie too, which the classic console's sign-out leaves in place.
export const clearOwnerCookie = (response: Response): Response => {
  if (new RegExp(`(?:^|,\\s*)${OWNER_COOKIE}=;`).test(response.headers.get('set-cookie') ?? '')) return response;
  const headers = new Headers(response.headers);
  headers.append('set-cookie', `${OWNER_COOKIE}=; Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`);
  return new Response(response.body, { status: response.status, headers });
};

