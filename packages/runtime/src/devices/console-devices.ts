import type { DeviceBridgeDO } from './device-bridge-do';
import type { deviceDirectory, ListedDevice } from './device-directory';
import { deviceDiagnostic } from './generic-reject';
import { devicePairingCodeHash, mintPairingCode } from './pairing-code';
import { identifier } from './wire';
import { PAIRING_MINT_ATTEMPTS } from './contract';
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
type ConsoleDirectory = Pick<ReturnType<typeof deviceDirectory>, 'issuePairingCode' | 'revokeDevice'>;
export function renderDevices(devices: (ListedDevice & { online: boolean })[], csrf: string): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const rows = devices.map((device) => `<tr><td>${escape(device.label)}</td><td>${escape(device.capabilities)}</td><td>${escape(device.created_at)}</td><td>${escape(device.last_seen_at ?? 'Never')}</td><td>${device.online ? 'Online' : 'Offline'}</td><td><form method="post" action="/console/action">${hidden}<input type="hidden" name="action" value="device.revoke"><input type="hidden" name="id" value="${escape(device.device_id)}"><button>Revoke</button></form></td></tr>`).join('');
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
