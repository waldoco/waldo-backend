import { whatsappLinkToken, whatsappLinkTokenHash, type WhatsAppLinkDirectory } from '../identity/whatsapp-link';
import { CONSOLE_ACTION_PATH, CONSOLE_PATH } from './console';

// The confirm step of text-first WhatsApp linking. It runs only inside the owner DO after the console host
// validated the owner's sign-in and the DO found a live console session. The page is read-only; the bind is
// the CSRF-checked POST, and the database rechecks that the request names this owner and this exact number.
export const WHATSAPP_LINK_CONFIRM_ACTION = 'whatsapp.confirm';

const HEADERS = {
  'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
  'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const escape = (value: string) => value.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const page = (body: string, status = 200) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Link WhatsApp</title><style>body{font:17px/1.5 system-ui,sans-serif;background:#FAFAF8;color:#1A1A1A;margin:0;display:grid;place-items:center;min-height:100vh}main{width:min(420px,90vw);display:grid;gap:12px}.number{font-size:28px;font-weight:700;letter-spacing:.02em}button{font:inherit;padding:12px;border:0;border-radius:10px;background:#1A1A1A;color:#FAFAF8;cursor:pointer;width:100%}</style></head><body><main>${body}</main></body></html>`,
  { status, headers: HEADERS },
);
const notFound = () => page(`<h1>This link has expired</h1><p>It may have been used already, be older than 10 minutes, or be for a different Waldo account. Text Waldo on WhatsApp again for a new link.</p><p><a href="${CONSOLE_PATH}">Open your console</a></p>`, 404);

export const whatsappLinkConfirmPage = async (path: string, doName: string, csrf: string, directory: WhatsAppLinkDirectory | null): Promise<Response> => {
  const token = whatsappLinkToken(path);
  if (!token || !doName || !directory) return notFound();
  const subject = await directory.subject(doName, await whatsappLinkTokenHash(token));
  if (!subject) return notFound();
  const number = `+${subject}`;
  return page(`<h1>Link this WhatsApp number?</h1><p class="number">${escape(number)}</p><p>Messages from this number will reach your Waldo, and Waldo will answer there with what it knows about you. Only continue if this is your own number. If another WhatsApp number is linked, this one replaces it.</p><form method="post" action="${CONSOLE_ACTION_PATH}"><input type="hidden" name="csrf" value="${escape(csrf)}"><input type="hidden" name="action" value="${WHATSAPP_LINK_CONFIRM_ACTION}"><input type="hidden" name="token" value="${escape(token)}"><input type="hidden" name="subject" value="${escape(subject)}"><button>Yes, link ${escape(number)}</button></form><p><a href="${CONSOLE_PATH}">This is not my number</a></p>`);
};

export const whatsappLinkConfirmAction = async (form: FormData, csrf: string, doName: string, directory: WhatsAppLinkDirectory | null, onLinked: (subject: string) => void): Promise<Response> => {
  if (!doName || !csrf || form.get('csrf') !== csrf) return new Response('invalid', { status: 403, headers: { 'cache-control': 'no-store' } });
  const token = form.get('token'), subject = form.get('subject');
  if (typeof token !== 'string' || typeof subject !== 'string' || !whatsappLinkToken(`/console/whatsapp/link/${token}`) || !/^[1-9]\d{5,14}$/.test(subject) || !directory) return notFound();
  const outcome = await directory.consume(doName, await whatsappLinkTokenHash(token), subject);
  if (outcome === 'claimed') return page(`<h1>Already linked elsewhere</h1><p>${escape(`+${subject}`)} is linked to another Waldo account, so nothing changed.</p><p><a href="${CONSOLE_PATH}">Open your console</a></p>`, 409);
  if (outcome !== 'linked') return notFound();
  onLinked(subject);
  return page(`<h1>WhatsApp linked</h1><p>${escape(`+${subject}`)} now talks to your Waldo. Head back to WhatsApp and say hello.</p><p><a href="${CONSOLE_PATH}">Open your console</a></p>`);
};
