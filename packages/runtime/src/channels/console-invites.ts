import type { ConsoleAuth } from '../identity/console-auth';
import { CONSOLE_ACTION_PATH, CONSOLE_PATH } from './console';
import { HTML_PAGE_HEADERS, pageHeading, resultCard, standalonePage, wantsHtml } from './standalone-page';

export const CONSOLE_INVITES_PATH = `${CONSOLE_PATH}/invites`;
const esc = (text: string) => text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
export const renderMemberInvites = (invites: Awaited<ReturnType<ConsoleAuth['memberInvites']>>, csrf: string): string => {
  const rows = invites.map((invite) => {
    const status = invite.used_at ? 'Used' : invite.revoked_at ? 'Revoked' : invite.expires_at && Date.parse(invite.expires_at) <= Date.now() ? 'Expired' : 'Pending';
    return `<li><div class="row-head"><h3>${esc(invite.email ?? '')}</h3><span class="chip">${status}</span></div><dl class="facts"><dt>Created</dt><dd class="time">${esc(invite.created_at.slice(0, 10))}</dd><dt>Expires</dt><dd class="time">${esc(invite.expires_at?.slice(0, 10) ?? '')}</dd></dl></li>`;
  }).join('');
  const create = invites.length < 5
    ? `<form method="post" action="${CONSOLE_ACTION_PATH}" class="stack"><input type="hidden" name="csrf" value="${esc(csrf)}"><input type="hidden" name="action" value="invite.member"><label>Recipient email <input name="value" type="email" autocomplete="email" required placeholder="email@example.com"></label><div class="actions"><button class="primary">Create invite</button></div></form>`
    : '<p class="notice">You have used all five invites.</p>';
  const invite = `<section class="tile"><div class="row-head"><h2>Invite someone to Waldo.</h2><span class="chip">${invites.length}/5 issued</span></div><p>Each member can issue five codes total. Links expire in 14 days and only work for the recipient email. Waldo does not send them for you. Verified email and a valid invite are enough to finish signup. A phone number is optional, unverified contact information.</p>${create}</section>`;
  const list = `<section class="tile" aria-labelledby="issued-heading"><h2 id="issued-heading">Your invites <span class="count">${invites.length}</span></h2>${rows ? `<ul class="records">${rows}</ul>` : '<p class="empty">No invites issued yet.</p>'}</section>`;
  return standalonePage({ title: 'Invites · Waldo', body: `${pageHeading('Invites', 'Invites let someone join Waldo. They do not share your data.', 'Settings')}${invite}${list}` });
};

// A one-time receipt for a browser navigation. The link is shown here once and never stored or re-fetched.
export const inviteReceiptPage = (email: string, link: string, back: string): string => standalonePage({
  title: 'Invite link · Waldo', layout: 'card', home: true, back: { href: back, label: 'Back' },
  body: resultCard({ tone: 'positive', title: 'Invite created.', body: `<p>Invite for ${esc(email)} (expires in 14 days). Copy it now and send it yourself. Waldo did not email anyone.</p><code class="secret">${esc(link)}</code><p class="help">This link is not shown again. It works only for this recipient email.</p>`, actions: `<a class="button-link" href="${esc(back)}">I’ve copied it</a>` }),
});
// Browser navigations get the one-time page; every other caller keeps the stable text receipt.
export const inviteReceipt = (request: Request, email: string, link: string, back: string): Response => wantsHtml(request.headers.get('accept'))
  ? new Response(inviteReceiptPage(email, link, back), { headers: HTML_PAGE_HEADERS })
  : new Response(`Invite for ${email}: ${link} (expires in 14 days). Copy it now and send it yourself. Waldo did not email anyone.`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
