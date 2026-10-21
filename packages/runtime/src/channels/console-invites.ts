import type { ConsoleAuth } from '../identity/console-auth';
import { CONSOLE_ACTION_PATH, CONSOLE_PATH } from './console';

export const CONSOLE_INVITES_PATH = `${CONSOLE_PATH}/invites`;
const esc = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
export const renderMemberInvites = (invites: Awaited<ReturnType<ConsoleAuth['memberInvites']>>, csrf: string): string => {
  const rows = invites.map((invite) => {
    const status = invite.used_at ? 'Used' : invite.revoked_at ? 'Revoked' : invite.expires_at && Date.parse(invite.expires_at) <= Date.now() ? 'Expired' : 'Pending';
    return `<tr><td>${esc(invite.email ?? '')}</td><td>${status}</td><td>${esc(invite.created_at.slice(0, 10))}</td><td>${esc(invite.expires_at?.slice(0, 10) ?? '')}</td></tr>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo invites</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;margin:24px;max-width:720px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left}input,button{font:inherit;padding:8px}</style></head><body><p><a href="${CONSOLE_PATH}">Back to console</a></p><h2>Your invites (${invites.length}/5 issued)</h2><p>Each member can issue five codes total. Links expire in 14 days and only work for the recipient email. Waldo does not send them for you. Verified email and a valid invite are enough to finish signup. A phone number is optional, unverified contact information.</p>${invites.length < 5 ? `<form method="post" action="${CONSOLE_ACTION_PATH}"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="invite.member"><label>Recipient email <input name="value" type="email" autocomplete="email" required placeholder="email@example.com"></label><button>Create invite</button></form>` : '<p>You have used all five invites.</p>'}<table><tr><th>Email</th><th>Status</th><th>Created</th><th>Expires</th></tr>${rows}</table></body></html>`;
};
