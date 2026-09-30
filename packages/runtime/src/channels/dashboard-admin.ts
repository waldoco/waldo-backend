import type { ConsoleAuth } from '../identity/console-auth';
import { newInviteCode } from '../identity/invite-code';
import { parseConsoleAction } from './console';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';

const reply = (value: object, status = 200) => Response.json(value, { status, headers: DASHBOARD_OVERVIEW_HEADERS });
export const INVITE_HONESTY = 'Copy it now and send it yourself. Waldo did not email anyone.';

// Called only after the existing owner DO session check. The signed RPC remains the admin authority.
export async function adminRead(auth: ConsoleAuth | null, doName: string | undefined, csrf: string): Promise<Response> {
  try {
    const overview = auth && doName ? await auth.adminOverview(doName) : null;
    return overview ? reply({ ...overview, csrf, as_of: new Date().toISOString() }) : reply({ error: 'not_found' }, 404);
  } catch { return reply({ error: 'unavailable' }, 503); }
}

export async function adminAction(request: Request, csrf: string, auth: ConsoleAuth | null, doName: string | undefined): Promise<Response> {
  let action;
  try { action = parseConsoleAction(await request.formData(), csrf); }
  catch { return reply({ error: 'invalid_action' }, 400); }
  if (!action || !['invite.create', 'invite.revoke'].includes(action.action)) return reply({ error: 'invalid_action' }, 403);
  try {
    const code = action.action === 'invite.create' ? newInviteCode() : '';
    const done = auth && doName && await (action.action === 'invite.create' ? auth.invite(doName, action.value, code) : auth.revokeInvite(doName, action.id));
    if (!done) return reply({ error: 'not_completed' }, 409);
    return reply(code ? { code, message: `Invite for ${action.value} (expires in 14 days). ${INVITE_HONESTY}` } : { message: `Invite revoked. ${INVITE_HONESTY}` });
  } catch { return reply({ error: 'outcome_unavailable' }, 503); }
}
