import type { DeviceBridgeDO } from './device-bridge-do';
import type { deviceDirectory, ListedDevice } from './device-directory';
import { deviceDiagnostic } from './generic-reject';
import { devicePairingCodeHash, mintPairingCode } from './pairing-code';
import { notificationScope } from './notify-policy';
import type { NotifyPayload } from './wire';
import type { CommandSummary, CommandInput } from './command-store';
import { identifier, commandPayload } from './wire';
import { CONSOLE_DEVICES_PATH, KENNEL_PAIRING_CODE_PREFIX, PAIRING_MINT_ATTEMPTS, NOTIFICATION_BODY_CHOICES, NOTIFICATION_TITLE } from './contract';
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
type ConsoleDirectory = Pick<ReturnType<typeof deviceDirectory>, 'issuePairingCode' | 'revokeDevice'> & Partial<Pick<ReturnType<typeof deviceDirectory>, 'listDevices' | 'deviceForAuth' | 'issueOwnedPairingCode'>>;
// Self-contained console styling (dashboard tokens): nonce-gated, no external fonts or scripts.
const STYLE = `:root{--canvas:#f4f3f0;--card:#fff;--ink:#1a1a1a;--muted:#6b6862;--line:#e4e1db;--action:#2388ff;--good:#1f8a4c;--focus:#5267af;color-scheme:light}
*{box-sizing:border-box}body{margin:0;background:var(--canvas);color:var(--ink);font:15px/1.5 -apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",system-ui,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px;display:flex;flex-direction:column;gap:20px}
a{color:var(--action);text-decoration:none}a:hover{text-decoration:underline}
h1{margin:0;font-size:28px;letter-spacing:-.01em}h2{margin:0 0 4px;font-size:18px}p{margin:0}.muted{color:var(--muted)}
section{background:var(--card);border-radius:20px;padding:24px;display:flex;flex-direction:column;gap:14px}
ol{margin:0;padding-left:20px;display:flex;flex-direction:column;gap:6px}
button{font:inherit;border:0;border-radius:999px;padding:9px 16px;background:var(--canvas);color:var(--ink);cursor:pointer}
button:focus-visible,select:focus-visible,a:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.primary{background:var(--action);color:#fff;font-weight:bold;padding:11px 20px}
select{font:inherit;border:1px solid var(--line);border-radius:10px;padding:6px 8px;background:var(--card)}
form{margin:0;display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.table{overflow-x:auto}table{border-collapse:collapse;width:100%;min-width:640px}
th,td{text-align:left;padding:10px 8px;border-top:1px solid var(--line);vertical-align:top;font-size:14px}th{color:var(--muted);font-weight:normal;border-top:0}
td ul{margin:6px 0 0;padding-left:18px;color:var(--muted)}
.code{font:600 17px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;background:var(--canvas);border-radius:12px;padding:16px}
.row{display:flex;flex-wrap:wrap;gap:12px;align-items:center}`;
const shell = (title: string, nonce: string, body: string, script = ''): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style nonce="${nonce}">${STYLE}</style></head><body><main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`;
export const devicePageHeaders = (nonce: string): Record<string, string> => ({
  ...DEVICE_PAGE_HEADERS,
  'content-security-policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src 'none'; connect-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`,
  'x-content-type-options': 'nosniff',
});
export function renderDevices(devices: (ListedDevice & { online: boolean; commands?: CommandSummary[] })[], csrf: string, nonce: string = crypto.randomUUID()): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const commands = (device: ListedDevice & { commands?: CommandSummary[] }): string => {
    const common = () => `${hidden}<input type="hidden" name="id" value="${escape(device.device_id)}"><input type="hidden" name="request_id" value="${crypto.randomUUID()}">`;
    const query = device.capabilities.split(',').includes('machine_state_query') ? `<form method="post" action="/console/action">${common()}<input type="hidden" name="action" value="device.query"><select name="query_kind"><option>session_status</option><option>attempt_status</option><option>worktree_watch</option></select><button>Ask Mac state</button></form>` : '';
    const notify = device.capabilities.split(',').includes('notify_local') ? `<form method="post" action="/console/action">${common()}<input type="hidden" name="action" value="device.notify"><input type="hidden" name="notification_id" value="${crypto.randomUUID()}"><input type="hidden" name="title" value="${NOTIFICATION_TITLE}"><label>Notification text <select name="body">${NOTIFICATION_BODY_CHOICES.map((body) => `<option>${escape(body)}</option>`).join('')}</select></label><select name="severity"><option>info</option><option>warning</option><option>error</option></select><button>Send this notification to my Mac</button></form>` : '';
    const history = (device.commands ?? []).map((command) => `<li>${escape(command.class)}: ${escape(command.state)}${command.result_state ? ` (${escape(command.result_state)})` : ''}</li>`).join('');
    return `${query}${notify}<ul>${history}</ul>`;
  };
  const rows = devices.map((device) => `<tr><td>${escape(device.label)}</td><td>${escape(device.capabilities)}</td><td>${escape(device.created_at)}</td><td>${escape(device.last_seen_at ?? 'Never')}</td><td>${device.online ? 'Online' : 'Offline'}</td><td><form method="post" action="/console/action">${hidden}<input type="hidden" name="action" value="device.revoke"><input type="hidden" name="id" value="${escape(device.device_id)}"><button>Revoke</button></form>${commands(device)}</td></tr>`).join('');
  const list = devices.length ? `<div class="table"><table><tr><th>Device</th><th>Capabilities</th><th>Created</th><th>Last seen</th><th>Status</th><th>Action</th></tr>${rows}</table></div>` : '<p class="muted">No devices yet.</p>';
  return shell('Waldo devices', nonce, `<a href="/console">Back to console</a><h1>Your devices</h1><section><h2>Pair a Mac</h2><p class="muted">Connect Kennel on your Mac to your Waldo.</p><ol><li>Get a pairing code here.</li><li>In Kennel, open Settings, then Connect to Waldo.</li><li>Paste the code and select Connect.</li></ol><form method="post" action="/console/action">${hidden}<input type="hidden" name="action" value="device.pair"><button class="primary">Get pairing code</button></form><p class="muted">Each code works once and expires in 10 minutes. If one expires, get a new one.</p></section><section><h2>Paired devices</h2>${list}</section>`);
}
// The browser view of a fresh code: one copyable value that also names the owner (see
// KENNEL_PAIRING_CODE_PREFIX). Never cached, never framed, no referrer.
export function renderPairingCode(value: string, nonce: string): string {
  const script = `document.getElementById('copy').addEventListener('click',async function(){var b=this;try{await navigator.clipboard.writeText(document.getElementById('code').textContent);b.textContent='Copied';}catch(e){b.textContent='Select the code and copy it';}});`;
  return shell('Your pairing code', nonce, `<a href="${CONSOLE_DEVICES_PATH}">Back to devices</a><h1>Your pairing code</h1><section><p class="muted">Paste this into Kennel: Settings, then Connect to Waldo.</p><p class="code" id="code">${escape(value)}</p><div class="row"><button class="primary" id="copy" type="button">Copy code</button><span class="muted">Expires in 10 minutes. Single use.</span></div></section>`, script);
}
export const DEVICE_PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
export async function deviceConsoleAction(form: FormData, csrf: string, owner: string, directory: ConsoleDirectory, namespace?: DurableObjectNamespace<DeviceBridgeDO>, accept = ''): Promise<Response> {
  // A per-request owner session and CSRF are the sole authority for pairing/revocation.
  if (!owner || form.get('csrf') !== csrf) return new Response('invalid', { status: 403 });
  try {
    if (form.get('action') === 'device.pair') {
      // A browser gets the copyable Kennel code; scripted clients keep the plain 43-char code.
      if (accept.includes('text/html') && directory.issueOwnedPairingCode) {
        for (let attempt = 0; attempt < PAIRING_MINT_ATTEMPTS; attempt++) {
          const code = mintPairingCode();
          const ownerId = await directory.issueOwnedPairingCode(owner, await devicePairingCodeHash(code));
          if (ownerId) { const nonce = crypto.randomUUID(); return new Response(renderPairingCode(`${KENNEL_PAIRING_CODE_PREFIX}.${ownerId}.${code}`, nonce), { headers: devicePageHeaders(nonce) }); }
        }
        return new Response('Unable to complete device request.', { status: 400 });
      }
      for (let attempt = 0; attempt < PAIRING_MINT_ATTEMPTS; attempt++) {
        const code = mintPairingCode();
        if (await directory.issuePairingCode(owner, await devicePairingCodeHash(code))) return new Response(`${code}\nExpires in 10 minutes. Single use.`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      }
    } else if (form.get('action') === 'device.query' || form.get('action') === 'device.notify') {
      const device = form.get('id'), request = form.get('request_id'), kind = form.get('action') === 'device.query' ? 'machine_state_query' : 'notify_local';
      const payload = kind === 'machine_state_query' ? { query_id: request, query_kind: form.get('query_kind') } : { notification_id: form.get('notification_id'), title: form.get('title'), body: form.get('body'), severity: form.get('severity') };
      // Only explicitly owner-selected neutral presets issue; chat/model output supplies no permission.
      if (!identifier(device) || !identifier(request) || !commandPayload(kind, payload) || !directory.listDevices || !directory.deviceForAuth || !namespace) return new Response('invalid', { status: 400 });
      if (kind === 'notify_local' && !notificationScope(payload as NotifyPayload)) return new Response('invalid', { status: 400 });
      if (!(await directory.listDevices(owner)).some((entry) => entry.device_id === device)) return new Response('invalid', { status: 400 });
      const auth = await directory.deviceForAuth(device);
      if (!auth || !auth.capabilities.includes(kind)) return new Response('invalid', { status: 400 });
      const result = await namespace.get(namespace.idFromName(device)).enqueueCommand({ owner_id: auth.owner_id, device_id: device, request_id: request, class: kind, payload } as CommandInput);
      if (result.accepted) return new Response(null, { status: 303, headers: { location: '/console/devices' } });
    } else if (form.get('action') === 'device.revoke') {
      const device = form.get('id');
      if (identifier(device) && await directory.revokeDevice(owner, device)) {
        try { if (!namespace) throw new Error('infrastructure_unavailable'); await namespace.get(namespace.idFromName(device)).revoke(); }
        catch { deviceDiagnostic('infrastructure_unavailable'); }
        return new Response(null, { status: 303, headers: { location: '/console/devices' } });
      }
    }
  } catch { deviceDiagnostic('infrastructure_unavailable'); }
  return new Response('Unable to complete device request.', { status: 400 });
}
