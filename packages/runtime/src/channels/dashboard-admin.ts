import type { ConsoleAuth } from '../identity/console-auth';
import { newInviteCode, inviteLink } from '../identity/invite-code';
import { parseConsoleAction } from './console';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { adminSpendFor } from './admin-spend';
import { announcementDraftSchema, ANNOUNCEMENT_ENVIRONMENTS } from './announcements';

const reply = (value: object, status = 200) => Response.json(value, { status, headers: DASHBOARD_OVERVIEW_HEADERS });
export const INVITE_HONESTY = 'Copy it now and send it yourself. Waldo did not email anyone.';

// Called only after the existing owner DO session check. The signed RPC remains the admin authority.
export async function adminRead(auth: ConsoleAuth | null, doName: string | undefined, csrf: string): Promise<Response> {
  try {
    const overview = auth && doName ? await auth.adminOverview(doName) : null;
    if (!auth || !doName || !overview) return reply({ error: 'not_found' }, 404);
    return reply({ ...overview, spend: await adminSpendFor(auth, doName, overview), csrf, as_of: new Date().toISOString() });
  } catch { return reply({ error: 'unavailable' }, 503); }
}

export async function adminAction(request: Request, csrf: string, auth: ConsoleAuth | null, doName: string | undefined): Promise<Response> {
  let action;
  try { action = parseConsoleAction(await request.formData(), csrf); }
  catch { return reply({ error: 'invalid_action' }, 400); }
  if (!action || !['invite.create', 'invite.revoke', 'announcement.create', 'announcement.live', 'announcement.report'].includes(action.action)) return reply({ error: 'invalid_action' }, 403);
  if (action.action.startsWith('announcement.')) return announcementAction(action, auth, doName);
  try {
    const code = action.action === 'invite.create' ? newInviteCode() : '';
    const done = auth && doName && await (action.action === 'invite.create' ? auth.invite(doName, action.value, code) : auth.revokeInvite(doName, action.id));
    if (!done) return reply({ error: 'not_completed' }, 409);
    return reply(code ? { code, link: inviteLink(request.url, action.value, code), message: `Invite for ${action.value} (expires in 14 days). ${INVITE_HONESTY}` } : { message: 'Invite revoked. Waldo did not email anyone.' });
  } catch { return reply({ error: 'outcome_unavailable' }, 503); }
}

// What's new, written once by an admin: create takes the draft as JSON in value, live names the announcement (id) and one
// environment (value), report names the announcement. The database decides who is an admin and refuses any other shape.
const announcementAction = async (action: ReturnType<typeof parseConsoleAction> & object, auth: ConsoleAuth | null, doName: string | undefined): Promise<Response> => {
  if (!auth?.announce || !auth.announcementLive || !auth.announcementReport || !doName) return reply({ error: 'not_completed' }, 409);
  try {
    if (action.action === 'announcement.report') {
      const report = await auth.announcementReport(doName, action.id);
      return report ? reply({ report }) : reply({ error: 'not_found' }, 404);
    }
    if (action.action === 'announcement.live') {
      if (!(ANNOUNCEMENT_ENVIRONMENTS as readonly string[]).includes(action.value)) return reply({ error: 'invalid_action' }, 400);
      return await auth.announcementLive(doName, action.id, action.value) ? reply({ message: `Live on ${action.value}. Each owner's Waldo there decides on its next release wake.` }) : reply({ error: 'not_completed' }, 409);
    }
    let draft;
    try { draft = announcementDraftSchema.parse(JSON.parse(action.value)); } catch { return reply({ error: 'invalid_action' }, 400); }
    return await auth.announce(doName, draft) ? reply({ message: 'Announcement saved in dry run everywhere. Owners\' Waldos only count who is eligible until you send it live per environment.' }) : reply({ error: 'not_completed' }, 409);
  } catch { return reply({ error: 'outcome_unavailable' }, 503); }
};
