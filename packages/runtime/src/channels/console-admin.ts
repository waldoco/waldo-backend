import type { AdminOverview } from '../identity/console-auth';
import { CONSOLE_ACTION_PATH, CONSOLE_PATH } from './console';

export const CONSOLE_ADMIN_PATH = `${CONSOLE_PATH}/admin`;

const esc = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const when = (iso: string | null) => (iso ? esc(iso.slice(0, 16).replace('T', ' ')) : '');
const button = (csrf: string, action: string, label: string, fields: Readonly<Record<string, string>>, extra = '') =>
  `<form method="post" action="${CONSOLE_ACTION_PATH}"><input type="hidden" name="csrf" value="${csrf}"><input type="hidden" name="action" value="${action}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join('')}${extra}<button>${esc(label)}</button></form>`;

// Beta admin page: who has access, who is invited, and invite or revoke by email.
export const renderAdmin = (overview: AdminOverview, csrf: string): string => {
  const owners = overview.owners.map((owner) => `<tr><td>${esc(owner.email ?? '(no email)')}</td><td>${esc(owner.state)}</td><td>${esc(owner.presences.join(', ') || 'none')}</td><td>${when(owner.created_at)}</td></tr>`).join('');
  const invites = overview.invites.map((invite) => {
    const state = invite.used_at ? `used ${when(invite.used_at)}` : invite.revoked_at ? `revoked ${when(invite.revoked_at)}` : 'open';
    const revoke = !invite.used_at && !invite.revoked_at ? button(csrf, 'invite.revoke', 'Revoke', { id: invite.id }) : '';
    return `<tr><td>${esc(invite.email ?? '')}</td><td>${state}</td><td>${when(invite.created_at)}</td><td>${revoke}</td></tr>`;
  }).join('');
  const create = button(csrf, 'invite.create', 'Invite', {}, '<input name="value" type="email" required placeholder="email@example.com">');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Waldo admin</title><style>body{font-family:system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;margin:24px}table{border-collapse:collapse;width:100%;margin-bottom:24px}td,th{border-bottom:1px solid #ddd;padding:8px;text-align:left;font-size:14px}form{display:inline-flex;gap:8px}input,button{font:inherit;padding:6px 10px}</style></head><body><p><a href="${CONSOLE_PATH}">Back to console</a></p><h2>Owners</h2><table><tr><th>Email</th><th>State</th><th>Linked</th><th>Since</th></tr>${owners}</table><h2>Invites</h2>${create}<table><tr><th>Email</th><th>State</th><th>Created</th><th></th></tr>${invites}</table></body></html>`;
};
