import type { AdminOverview } from '../identity/console-auth';
import { CONSOLE_ACTION_PATH, CONSOLE_PATH } from './console';
import { pageHeading, standalonePage } from './standalone-page';

export const CONSOLE_ADMIN_PATH = `${CONSOLE_PATH}/admin`;

const esc = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
const when = (iso: string | null) => (iso ? esc(iso.slice(0, 16).replace('T', ' ')) : '');
const button = (csrf: string, action: string, label: string, fields: Readonly<Record<string, string>>, extra = '', kind = '') =>
  `<form method="post" action="${CONSOLE_ACTION_PATH}"${extra ? ' class="stack"' : ''}><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="${action}">${Object.entries(fields).map(([name, value]) => `<input type="hidden" name="${name}" value="${esc(value)}">`).join('')}${extra}<div class="actions"><button${kind ? ` class="${kind}"` : ''}>${esc(label)}</button></div></form>`;

// Admin page: who has access, who is invited, and invite or revoke by email.
export const renderAdmin = (overview: AdminOverview, csrf: string): string => {
  const owners = overview.owners.map((owner) => `<li><div class="row-head"><h3>${esc(owner.email ?? '(no email)')}</h3><span class="chip">${esc(owner.state)}</span></div><dl class="facts"><dt>Linked</dt><dd>${esc(owner.presences.join(', ') || 'none')}</dd><dt>Since</dt><dd class="time">${when(owner.created_at)}</dd></dl></li>`).join('');
  const invites = overview.invites.map((invite) => {
    const state = invite.used_at ? `used ${when(invite.used_at)}` : invite.revoked_at ? `revoked ${when(invite.revoked_at)}` : invite.expires_at && new Date(invite.expires_at).getTime() <= Date.now() ? 'expired' : 'open';
    const revoke = state === 'open' ? button(csrf, 'invite.revoke', 'Revoke', { id: invite.id }, '', 'danger') : '';
    return `<li><div class="row-head"><h3>${esc(invite.email ?? '')}</h3><span class="chip">${state}</span></div><dl class="facts"><dt>Created</dt><dd class="time">${when(invite.created_at)}</dd><dt>Expires</dt><dd class="time">${when(invite.expires_at)}</dd></dl>${revoke}</li>`;
  }).join('');
  const create = button(csrf, 'invite.create', 'Invite', {}, '<label>Recipient email <input name="value" type="email" autocomplete="email" required placeholder="email@example.com"></label>', 'primary');
  const ownerTile = `<section class="tile" aria-labelledby="owners-heading"><h2 id="owners-heading">Owners <span class="count">${overview.owners.length}</span></h2>${owners ? `<ul class="records">${owners}</ul>` : '<p class="empty">No owners yet.</p>'}</section>`;
  const inviteTile = `<section class="tile" aria-labelledby="invites-heading"><h2 id="invites-heading">Invites <span class="count">${overview.invites.length}</span></h2><p>Root invites count toward your five codes. A signup link is shown once after creation; Waldo does not email anyone.</p>${create}${invites ? `<ul class="records inset">${invites}</ul>` : '<p class="empty inset">No invites yet.</p>'}</section>`;
  return standalonePage({ title: 'Admin · Waldo', body: `${pageHeading('Admin', 'Who has access to this Waldo, and who is invited.', 'Settings')}${ownerTile}${inviteTile}` });
};
