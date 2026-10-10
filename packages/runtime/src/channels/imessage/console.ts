import type { IMessageBridgeDO } from './bridge-do';
import { iMessageBridgeName, iMessageComposition, type IMessageEnv } from './bridge-do';
import { mintSetupSecret, sha256Hex } from './crypto';
import { iMessageDirectory, type BridgeListing } from './directory';

// Private owner lifecycle UI. The authenticated owner console session + CSRF is the sole authority
// for pair/verify/activate/revoke; host S2 credentials can never reach these actions.
export const CONSOLE_IMESSAGE_PATH = '/console/imessage';
export const IMESSAGE_CONSOLE_ACTIONS = ['imessage.pair', 'imessage.verify', 'imessage.activate', 'imessage.revoke'] as const;
export const isIMessageConsoleAction = (action: unknown): action is typeof IMESSAGE_CONSOLE_ACTIONS[number] => IMESSAGE_CONSOLE_ACTIONS.includes(action as never);

const HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
const TEXT = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' };
const escape = (v: string) => v.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const BRIDGE = /^imb_[0-9a-f]{32}$/;
const field = (form: FormData, name: string, max = 512): string | null => {
  const v = form.get(name);
  return typeof v === 'string' && v.length > 0 && v.length <= max && v.trim() === v && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
};

export function renderIMessage(rows: readonly (BridgeListing & { online?: boolean; textReady?: boolean; quarantine?: string | null })[], csrf: string): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const form = (action: string, body: string, label: string) => `<form method="post" action="/console/action">${hidden}<input type="hidden" name="action" value="${action}">${body}<button>${label}</button></form>`;
  const row = (r: (typeof rows)[number]) => {
    const id = `<input type="hidden" name="id" value="${escape(r.bridge_id)}">`;
    const scope = `<input name="subject" placeholder="Your Apple ID sender" value="${escape(r.subject ?? '')}" required><input name="chat" placeholder="iMessage;-;sender" value="${escape(r.chat_guid ?? '')}" required>`;
    const actions = r.state === 'pending'
      ? form('imessage.verify', id + scope, 'Set exact sender and get a challenge') + (r.observed ? form('imessage.activate', id + `<input type="hidden" name="subject" value="${escape(r.subject ?? '')}"><input type="hidden" name="chat" value="${escape(r.chat_guid ?? '')}">`, `Confirm ${escape(r.subject ?? '')} in ${escape(r.chat_guid ?? '')}`) : '')
      : '';
    const revoke = r.state === 'revoked' ? '' : form('imessage.revoke', id, 'Revoke');
    const health = r.state === 'active' ? ` · ${r.online ? 'online' : 'offline'} · ${r.textReady ? 'text verified' : 'text not verified'}${r.quarantine ? ' · sending paused (uncertain send)' : ''}` : '';
    return `<tr><td>${escape(r.state)}${health}</td><td>${escape(r.subject ?? '')}</td><td>${escape(r.host_version)}</td><td>${actions}${revoke}</td></tr>`;
  };
  return `<!doctype html><html><head><meta charset="utf-8"><title>Waldo on iMessage</title></head><body><a href="/console">Back to console</a><h1>iMessage</h1>`
    + `<p>Direct iMessage text only. Groups, SMS, files and reactions are not supported.</p>${form('imessage.pair', '', 'Pair a Mac host')}`
    + `<table><tr><th>Status</th><th>Sender</th><th>Host</th><th>Actions</th></tr>${rows.map(row).join('')}</table></body></html>`;
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
    return new Response(renderIMessage(withStatus, csrf), { headers: HEADERS });
  } catch { return new Response('iMessage status unavailable.', { status: 503, headers: HEADERS }); }
}

export async function iMessageConsoleAction(form: FormData, csrf: string, owner: string, env: IMessageEnv, onRevoked: (bridgeDoName: string) => void): Promise<Response> {
  if (!owner || form.get('csrf') !== csrf) return new Response('invalid', { status: 403 });
  const c = iMessageComposition(env);
  if (!c) return new Response('iMessage is not enabled.', { status: 404, headers: TEXT });
  const directory = iMessageDirectory(env), lifetime = Math.floor(c.policy.setupLifetimeMs / 1000);
  try {
    const action = form.get('action');
    if (action === 'imessage.pair') {
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
