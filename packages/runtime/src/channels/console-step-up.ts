import { CONSOLE_STEP_UP_MS } from '../identity/console-auth';
import { CONSOLE_ACTION_PATH, type ConsoleSession } from './console';
import { CONTROL_ACTION_PATH } from './dashboard-control-actions';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import { OWNER_CONTROLS_ACTION_PATH } from './dashboard-owner-controls';

// Actions whose effect outlives this browser's session: a paired Mac, a connected account, an invite, or the account's
// removal. With a 30-day session, each asks for an email code from the last two hours, so a copied cookie cannot do them.
const LASTING_ACCESS = new Set(['device.pair', 'google.connect', 'mcp.connect', 'invite.create', 'invite.member', 'account.delete']);
const ACTION_PATHS = new Set([CONSOLE_ACTION_PATH, CONTROL_ACTION_PATH, OWNER_CONTROLS_ACTION_PATH]);
export const CONSOLE_CONFIRM_HREF = '/console/signin?confirm=1';

const confirmPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Confirm it's you</title></head><body><h1>Confirm it's you</h1><p>This needs an email code from the last ${CONSOLE_STEP_UP_MS / 3_600_000} hours. You stay signed in.</p><p><a href="${CONSOLE_CONFIRM_HREF}">Get an email code</a></p></body></html>`;

// Refuses a lasting-access action unless this browser proved an email code recently. It runs before any action handler
// and reads only the action name, so every console path that can take such an action passes through it.
export const consoleStepUpRefusal = async (request: Request, session: ConsoleSession, now: number): Promise<Response | null> => {
  const path = new URL(request.url).pathname;
  if (request.method !== 'POST' || !ACTION_PATHS.has(path)) return null;
  if (session.verified_at !== undefined && now - session.verified_at < CONSOLE_STEP_UP_MS) return null;
  const action = (await request.clone().formData().catch(() => null))?.get('action');
  if (typeof action !== 'string' || !LASTING_ACCESS.has(action)) return null;
  if (path !== CONSOLE_ACTION_PATH || (request.headers.get('accept') ?? '').includes('application/json')) {
    return Response.json({ error: 'step_up_required' }, { status: 403, headers: DASHBOARD_OVERVIEW_HEADERS });
  }
  return new Response(confirmPage, { status: 403, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin' } });
};
