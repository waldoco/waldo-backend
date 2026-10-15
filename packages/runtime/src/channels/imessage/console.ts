import type { IMessageBridgeDO } from './bridge-do';
import { iMessageBridgeName, iMessageComposition, type IMessageEnv } from './bridge-do';
import { mintSetupSecret, sha256Hex } from './crypto';
import { iMessageDirectory, type BridgeListing } from './directory';
import { consoleAuth } from '../../identity/console-auth';
import { iMessageSendUrl } from './send-url';

// Private owner lifecycle UI. The authenticated owner console session + CSRF is the sole authority
// for pair/verify/activate/revoke; host S2 credentials can never reach these actions.
export const CONSOLE_IMESSAGE_PATH = '/console/imessage';
export const IMESSAGE_CONSOLE_ACTIONS = ['imessage.pair', 'imessage.verify', 'imessage.activate', 'imessage.revoke', 'imessage.link', 'imessage.unlink', 'imessage.pair_shared', 'imessage.activate_shared'] as const;
export const isIMessageConsoleAction = (action: unknown): action is typeof IMESSAGE_CONSOLE_ACTIONS[number] => IMESSAGE_CONSOLE_ACTIONS.includes(action as never);

const HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BRIDGE = /^imb_[0-9a-f]{32}$/;
const field = (form: FormData, name: string, max = 512): string | null => {
  const v = form.get(name);
  return typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
};

export function renderIMessage(rows: readonly (BridgeListing & { online?: boolean; textReady?: boolean; quarantine?: string | null })[], csrf: string, o: { admin?: boolean; address?: string; linkedHint?: string | null } = {}): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const form = (action: string, body: string, label: string) => `<form method="post" action="/console/action">${hidden}<input type="hidden" name="action" value="${action}">${body}<button>${label}</button></form>`;
  const row = (r: (typeof rows)[number]) => {
    const id = `<input type="hidden" name="id" value="${escape(r.bridge_id)}">`;
    const scope = `<input name="subject" placeholder="Your Apple ID sender" value="${escape(r.subject ?? '')}" required><input name="chat" placeholder="iMessage;-;sender" value="${escape(r.chat_guid ?? '')}" required>`;
    const shared = r.kind === 'shared';
    const actions = r.state === 'pending'
      ? form('imessage.verify', id + scope, shared ? 'Set your challenge sender and get a challenge' : 'Set exact sender and get a challenge') + (r.observed ? form(shared ? 'imessage.activate_shared' : 'imessage.activate', id + `<input type="hidden" name="subject" value="${escape(r.subject ?? '')}"><input type="hidden" name="chat" value="${escape(r.chat_guid ?? '')}">`, shared ? 'Activate the shared Waldo number' : `Confirm ${escape(r.subject ?? '')} in ${escape(r.chat_guid ?? '')}`) : '')
      : '';
    const revoke = r.state === 'revoked' ? '' : form('imessage.revoke', id, 'Revoke');
    const health = r.state === 'active' ? ` · ${r.online ? 'online' : 'offline'} · ${r.textReady ? 'text verified' : 'text not verified'}${r.quarantine ? ' · sending paused (uncertain send)' : ''}` : '';
    return `<tr><td>${shared ? 'shared Waldo number · ' : ''}${escape(r.state)}${health}</td><td>${shared ? '' : escape(r.subject ?? '')}</td><td>${escape(r.host_version)}</td><td>${actions}${revoke}</td></tr>`;
  };
  const address = o.address ? escape(o.address) : 'the Waldo iMessage number';
  const linked = o.linkedHint
    ? `<p>Linked: •••${escape(o.linkedHint)}. Texts from this number reach your Waldo.</p>${form('imessage.unlink', '', 'Unlink this number')}`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Waldo on iMessage</title></head><body><a href="/console">Back to console</a><h1>iMessage</h1>`
    + `<p>Direct iMessage text only. Groups, SMS, files and reactions are not supported.</p>`
    + `<h2>Text your Waldo from your iPhone</h2><p>Get a one-time code, then text <b>waldo CODE</b> to ${address} from your iPhone. Only your own number reaches your Waldo.</p>${linked}${form('imessage.link', '', 'Get an iMessage link code')}`
    + `<h2>Your own Mac host</h2>${form('imessage.pair', '', 'Pair a Mac host')}`
    + (o.admin ? `<h2>Shared Waldo number (operator)</h2><p>Pairs the Mac that runs ${address} for everyone. Each sender still reaches only their own Waldo.</p>${form('imessage.pair_shared', '', 'Pair the shared Waldo number host')}` : '')
    + `<table><tr><th>Status</th><th>Sender</th><th>Host</th><th>Actions</th></tr>${rows.map(row).join('')}</table></body></html>`;
}


/** Result of "Get an iMessage link code": the code, and on a phone a button that opens Messages ready to send. */
export function iMessageLinkPage(code: string, address: string | undefined): string {
  const to = address ? escape(address) : 'the Waldo iMessage number';
  const open = address ? `<p><a href="${escape(iMessageSendUrl(address, code))}" style="display:inline-block;padding:14px 22px;border-radius:12px;background:#0a84ff;color:#fff;text-decoration:none;font-weight:bold">Open Messages</a></p><p>On your iPhone, tap <b>Open Messages</b>, then tap <b>Send</b>.</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Connect iMessage</title></head>`
    + `<body style="font:17px system-ui;margin:32px;max-width:560px"><h1>Connect iMessage</h1>${open}`
    + `<p>Or text exactly this to ${to} from your iPhone:</p><p style="font:600 24px ui-monospace,monospace">waldo ${escape(code)}</p>`
    + `<p>The code works once, within 10 minutes. Waldo replies "Linked." and from then on only your number reaches your Waldo.</p>`
    + `<p><a href="${CONSOLE_IMESSAGE_PATH}">Back</a></p></body></html>`;
}

export async function iMessageConsolePage(env: IMessageEnv, owner: string, csrf: string): Promise<Response> {
  if (!iMessageComposition(env)) return new Response('iMessage is not enabled.', { status: 404, headers: HEADERS });
  try {
    const rows = await iMessageDirectory(env).list(owner);
    const ns = env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO>, environment = iMessageComposition(env)!.environment;
    const withStatus = await Promise.all(rows.map(async (r) => {
      if (r.state !== 'active') return r;
      const s = await ns.get(ns.idFromName(iMessageBridgeName(environment, r.bridge_id, r.account_id))).status();
      return { ...r, online: s.online, textReady: s.textReady, quarantine: s.quarantine };
    }));
    const auth = consoleAuth(env);
    const admin = await auth?.adminOverview(owner).then((v) => v !== null).catch(() => false) ?? false;
    const linkedHint = await auth?.iMessageHandleHint?.(owner) ?? null;
    return new Response(renderIMessage(withStatus, csrf, { admin, linkedHint, ...(env.IMESSAGE_WALDO_ADDRESS ? { address: env.IMESSAGE_WALDO_ADDRESS } : {}) }), { headers: HEADERS });
  } catch { return new Response('iMessage status unavailable.', { status: 503, headers: HEADERS }); }
}

export async function iMessageConsoleAction(form: FormData, csrf: string, owner: string, env: IMessageEnv, onRevoked: (bridgeDoName: string) => void): Promise<Response> {
  if (!owner || form.get('csrf') !== csrf) return new Response('invalid', { status: 403 });
  const c = iMessageComposition(env);
  if (!c) return new Response('iMessage is not enabled.', { status: 404, headers: TEXT });
  const directory = iMessageDirectory(env), lifetime = Math.floor(c.policy.setupLifetimeMs / 1000);
  try {
    const action = form.get('action');
    if (action === 'imessage.link') {
      const code = await consoleAuth(env)?.issueProviderLinkCode?.(owner, 'imessage');
      if (code) return new Response(iMessageLinkPage(code, env.IMESSAGE_WALDO_ADDRESS), { headers: HEADERS });
    } else if (action === 'imessage.unlink') {
      // Canonical unlink: the sender's authority and revision change at once, so the bridge refuses any queued reply
      // (authority_changed) and a later text from the handle is an unknown sender.
      if (await consoleAuth(env)?.unlinkIMessage?.(owner)) return new Response(null, { status: 303, headers: { location: CONSOLE_IMESSAGE_PATH } });
    } else if (action === 'imessage.pair_shared') {
      const code = mintSetupSecret('wim');
      if (await directory.issueSharedInvitation(owner, c.environment, await sha256Hex(code), lifetime))
        return new Response(`${code}\nEnter this on the shared Waldo number's Mac host. Single use, expires in ${Math.round(lifetime / 60)} minutes.`, { headers: TEXT });
    } else if (action === 'imessage.activate_shared') {
      const id = field(form, 'id', 64), subject = field(form, 'subject'), chat = field(form, 'chat');
      if (!id || !BRIDGE.test(id) || !subject || !chat) return new Response('invalid', { status: 400 });
      if (await directory.activateShared(owner, id, subject, chat)) return new Response(null, { status: 303, headers: { location: CONSOLE_IMESSAGE_PATH } });
    } else if (action === 'imessage.pair') {
      const code = mintSetupSecret('wim');
      if (await directory.issueInvitation(owner, c.environment, await sha256Hex(code), lifetime))
        return new Response(`${code}\nEnter this on your Mac host. Single use, expires in ${Math.round(lifetime / 60)} minutes.`, { headers: TEXT });
    } else if (action === 'imessage.verify') {
      const id = field(form, 'id', 64), subject = field(form, 'subject'), chat = field(form, 'chat');
      if (!id || !BRIDGE.test(id) || !subject || !chat || !chat.startsWith('iMessage;-;')) return new Response('invalid', { status: 400 });
      const challenge = mintSetupSecret('wic');
      if (await directory.setExpectedScope(owner, id, subject, chat, await sha256Hex(challenge), lifetime))
        return new Response(`${challenge}\nSend exactly this text from ${subject} to your Mac's Messages account, in that direct chat. Then confirm it here.`, { headers: TEXT });
    } else if (action === 'imessage.activate') {
      const id = field(form, 'id', 64), subject = field(form, 'subject'), chat = field(form, 'chat');
      if (!id || !BRIDGE.test(id) || !subject || !chat) return new Response('invalid', { status: 400 });
      if (await directory.activate(owner, id, subject, chat)) return new Response(null, { status: 303, headers: { location: CONSOLE_IMESSAGE_PATH } });
    } else if (action === 'imessage.revoke') {
      const id = field(form, 'id', 64);
      const row = id && BRIDGE.test(id) ? (await directory.list(owner)).find((r) => r.bridge_id === id) : undefined;
      // Canonical revocation (state + revision) commits first; local fences follow.
      if (row && await directory.revoke(owner, row.bridge_id)) {
        const name = iMessageBridgeName(c.environment, row.bridge_id, row.account_id);
        onRevoked(name);
        try { const ns = env.IMESSAGE_BRIDGE_DO as unknown as DurableObjectNamespace<IMessageBridgeDO>; await ns.get(ns.idFromName(name)).revoke(); }
        catch { /* the bridge rechecks canonical authority on every request and alarm */ }
        return new Response(null, { status: 303, headers: { location: CONSOLE_IMESSAGE_PATH } });
      }
    }
  } catch { /* fixed diagnostics only */ }
  return new Response('Unable to complete iMessage request.', { status: 400, headers: TEXT });
}
