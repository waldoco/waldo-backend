import type { DeviceBridgeDO } from './device-bridge-do';
import type { deviceDirectory, ListedDevice } from './device-directory';
import { deviceDiagnostic } from './generic-reject';
import { devicePairingCodeHash, mintPairingCode } from './pairing-code';
import { notificationScope } from './notify-policy';
import type { NotifyPayload } from './wire';
import type { CommandSummary, CommandInput } from './command-store';
import { identifier, commandPayload } from './wire';
import { PAIRING_MINT_ATTEMPTS, NOTIFICATION_BODY_CHOICES, NOTIFICATION_TITLE } from './contract';
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
type ConsoleDirectory = Pick<ReturnType<typeof deviceDirectory>, 'issuePairingCode' | 'revokeDevice'> & Partial<Pick<ReturnType<typeof deviceDirectory>, 'listDevices' | 'deviceForAuth'>>;
export function renderDevices(devices: (ListedDevice & { online: boolean; commands?: CommandSummary[] })[], csrf: string): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const commands = (device: ListedDevice & { commands?: CommandSummary[] }): string => {
    const common = () => `${hidden}<input type="hidden" name="id" value="${escape(device.device_id)}"><input type="hidden" name="request_id" value="${crypto.randomUUID()}">`;
    const query = device.capabilities.split(',').includes('machine_state_query') ? `<form method="post" action="/console/action">${common()}<input type="hidden" name="action" value="device.query"><select name="query_kind"><option>session_status</option><option>attempt_status</option><option>worktree_watch</option></select><button>Ask Mac state</button></form>` : '';
    const notify = device.capabilities.split(',').includes('notify_local') ? `<form method="post" action="/console/action">${common()}<input type="hidden" name="action" value="device.notify"><input type="hidden" name="notification_id" value="${crypto.randomUUID()}"><input type="hidden" name="title" value="${NOTIFICATION_TITLE}"><label>Notification text <select name="body">${NOTIFICATION_BODY_CHOICES.map((body) => `<option>${escape(body)}</option>`).join('')}</select></label><select name="severity"><option>info</option><option>warning</option><option>error</option></select><button>Send this notification to my Mac</button></form>` : '';
    const history = (device.commands ?? []).map((command) => `<li>${escape(command.class)}: ${escape(command.state)}${command.result_state ? ` (${escape(command.result_state)})` : ''}</li>`).join('');
    return `${query}${notify}<ul>${history}</ul>`;
  };
  const rows = devices.map((device) => `<tr><td>${escape(device.label)}</td><td>${escape(device.capabilities)}</td><td>${escape(device.created_at)}</td><td>${escape(device.last_seen_at ?? 'Never')}</td><td>${device.online ? 'Online' : 'Offline'}</td><td><form method="post" action="/console/action">${hidden}<input type="hidden" name="action" value="device.revoke"><input type="hidden" name="id" value="${escape(device.device_id)}"><button>Revoke</button></form>${commands(device)}</td></tr>`).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>Waldo devices</title></head><body><a href="/console">Back to console</a><h1>Your devices</h1><form method="post" action="/console/action">${hidden}<input type="hidden" name="action" value="device.pair"><button>Pair a device</button></form><p>Lost a redeem response? Mint a new single-use code.</p><table><tr><th>Device</th><th>Capabilities</th><th>Created</th><th>Last seen</th><th>Status</th><th>Action</th></tr>${rows}</table></body></html>`;
}
export const DEVICE_PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
export async function deviceConsoleAction(form: FormData, csrf: string, owner: string, directory: ConsoleDirectory, namespace?: DurableObjectNamespace<DeviceBridgeDO>): Promise<Response> {
  // A per-request owner session and CSRF are the sole authority for pairing/revocation.
  if (!owner || form.get('csrf') !== csrf) return new Response('invalid', { status: 403 });
  try {
    if (form.get('action') === 'device.pair') {
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
