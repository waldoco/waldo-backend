import type { DeviceBridgeDO } from './device-bridge-do';
import type { deviceDirectory, ListedDevice } from './device-directory';
import { deviceDiagnostic } from './generic-reject';
import { devicePairingCodeHash, mintPairingCode } from './pairing-code';
import { notificationScope } from './notify-policy';
import type { NotifyPayload } from './wire';
import type { CommandSummary, CommandInput } from './command-store';
import { identifier, commandPayload } from './wire';
import { PAIRING_MINT_ATTEMPTS, NOTIFICATION_BODY_CHOICES, NOTIFICATION_TITLE } from './contract';
import { escapeHtml, isoMinute, pageHeading, resultCard, standalonePage } from '../channels/standalone-page';
const escape = escapeHtml;
type ConsoleDirectory = Pick<ReturnType<typeof deviceDirectory>, 'issuePairingCode' | 'revokeDevice'> & Partial<Pick<ReturnType<typeof deviceDirectory>, 'listDevices' | 'deviceForAuth'>>;
export const DEVICE_PAGE_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' };
const CAPABILITY_LABELS: Readonly<Record<string, string>> = { machine_state_query: 'Mac state query', notify_local: 'Local notifications' };
const QUERY_KINDS = [['session_status', 'Session status'], ['attempt_status', 'Attempt status'], ['worktree_watch', 'Worktree watch']] as const;
const SEVERITIES = [['info', 'Info'], ['warning', 'Warning'], ['error', 'Error']] as const;
const capabilityList = (raw: string): string[] => raw.split(',').map((value) => value.trim()).filter(Boolean);
const options = (choices: readonly (readonly [string, string])[]) => choices.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
export function renderDevices(devices: (ListedDevice & { online: boolean; commands?: CommandSummary[] })[], csrf: string): string {
  const hidden = `<input type="hidden" name="csrf" value="${escape(csrf)}">`;
  const card = (device: ListedDevice & { online: boolean; commands?: CommandSummary[] }, index: number): string => {
    const capabilities = capabilityList(device.capabilities);
    const common = () => `${hidden}<input type="hidden" name="id" value="${escape(device.device_id)}"><input type="hidden" name="request_id" value="${crypto.randomUUID()}">`;
    // Each select carries its own label so the query kind and severity are named for assistive tech.
    const query = capabilities.includes('machine_state_query') ? `<form method="post" action="/console/action" class="stack inset">${common()}<input type="hidden" name="action" value="device.query"><h3>Ask this Mac</h3><label for="query-${index}">Question</label><select id="query-${index}" name="query_kind">${options(QUERY_KINDS)}</select><div class="actions"><button class="primary">Ask Mac state</button></div></form>` : '';
    const notify = capabilities.includes('notify_local') ? `<form method="post" action="/console/action" class="stack inset">${common()}<input type="hidden" name="action" value="device.notify"><input type="hidden" name="notification_id" value="${crypto.randomUUID()}"><input type="hidden" name="title" value="${NOTIFICATION_TITLE}"><h3>Send a notification</h3><div class="fields"><label>Notification text <select name="body">${NOTIFICATION_BODY_CHOICES.map((body) => `<option>${escape(body)}</option>`).join('')}</select></label><label>Severity <select name="severity">${options(SEVERITIES)}</select></label></div><div class="actions"><button>Send this notification to my Mac</button></div></form>` : '';
    const history = (device.commands ?? []).map((command) => `<li><div class="row-head"><span>${escape(CAPABILITY_LABELS[command.class] ?? command.class)}</span><span class="chip">${escape(command.state)}</span></div>${command.result_state ? `<p class="meta">Reported result: ${escape(command.result_state)}</p>` : ''}</li>`).join('');
    const chips = capabilities.length ? `<ul class="chips">${capabilities.map((value) => `<li class="chip">${escape(CAPABILITY_LABELS[value] ?? value)}</li>`).join('')}</ul>` : 'None reported';
    return `<article class="tile" aria-labelledby="device-${index}"><div class="row-head"><h2 id="device-${index}">${escape(device.label)}</h2><span class="chip${device.online ? ' positive' : ''}">${device.online ? 'Online' : 'Offline'}</span></div><dl class="facts"><dt>Capabilities</dt><dd>${chips}</dd><dt>Paired</dt><dd class="time">${escape(isoMinute(device.created_at))}</dd><dt>Last seen</dt><dd class="time">${escape(isoMinute(device.last_seen_at))}</dd></dl>${query}${notify}<section class="inset" aria-label="Command history"><h3>Command history</h3>${history ? `<ul class="records">${history}</ul><p class="help">States are recorded as the bridge reports them. unknown and delivery_unknown mean the outcome was not confirmed.</p>` : '<p class="empty">No commands sent yet.</p>'}</section><form method="post" action="/console/action" class="actions">${hidden}<input type="hidden" name="action" value="device.revoke"><input type="hidden" name="id" value="${escape(device.device_id)}"><button class="danger">Revoke</button></form></article>`;
  };
  const pair = `<section class="tile"><h2>Pair a device</h2><p>Pairing gives you a single-use code that expires in 10 minutes. Lost a redeem response? Mint a new single-use code.</p><form method="post" action="/console/action" class="actions">${hidden}<input type="hidden" name="action" value="device.pair"><button class="primary">Pair a device</button></form></section>`;
  const list = devices.length ? devices.map(card).join('') : '<section class="tile"><p class="empty">No devices are paired yet.</p></section>';
  return standalonePage({ title: 'Devices · Waldo', body: `${pageHeading('Your devices', 'Macs you have paired with Waldo. A device acts only on the commands you choose here. Revoke unpairs it.', 'Settings')}${pair}<h2 class="section-title">Paired devices <span class="count">${devices.length}</span></h2>${list}` });
}
export const devicesUnavailablePage = (): string => standalonePage({ title: 'Devices · Waldo', layout: 'card', home: true, body: resultCard({ tone: 'negative', title: 'Devices unavailable.', body: '<p>The device list could not be read right now. Nothing was changed. Try again shortly.</p>', actions: '<a class="button-link" href="/console/devices">Try again</a>' }) });
const pairingReceipt = (code: string): string => standalonePage({ title: 'Pairing code · Waldo', layout: 'card', home: true, back: { href: '/console/devices', label: 'Back to devices' }, body: resultCard({ tone: 'neutral', title: 'Your pairing code', body: `<p>Enter this code on the device you are pairing. It works once and expires in 10 minutes. It is not shown again.</p><code class="secret">${escape(code)}</code>`, actions: '<a class="button-link" href="/console/devices">Back to devices</a>' }) });
const actionFailure = (status: number): Response => new Response(standalonePage({ title: 'Devices · Waldo', layout: 'card', home: true, back: { href: '/console/devices', label: 'Back to devices' }, body: resultCard({ tone: 'negative', title: 'That device request did not go through.', body: '<p>Nothing new was sent to a device. Go back to your devices and try again.</p>', actions: '<a class="button-link" href="/console/devices">Back to devices</a>' }) }), { status, headers: DEVICE_PAGE_HEADERS });
// `html` is set only for browser navigations. API and text callers keep the plain responses.
export async function deviceConsoleAction(form: FormData, csrf: string, owner: string, directory: ConsoleDirectory, namespace?: DurableObjectNamespace<DeviceBridgeDO>, html = false): Promise<Response> {
  // A per-request owner session and CSRF are the sole authority for pairing/revocation.
  if (!owner || form.get('csrf') !== csrf) return html ? actionFailure(403) : new Response('invalid', { status: 403 });
  try {
    if (form.get('action') === 'device.pair') {
      for (let attempt = 0; attempt < PAIRING_MINT_ATTEMPTS; attempt++) {
        const code = mintPairingCode();
        if (await directory.issuePairingCode(owner, await devicePairingCodeHash(code))) return html
          ? new Response(pairingReceipt(code), { headers: DEVICE_PAGE_HEADERS })
          : new Response(`${code}\nExpires in 10 minutes. Single use.`, { headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
      }
    } else if (form.get('action') === 'device.query' || form.get('action') === 'device.notify') {
      const device = form.get('id'), request = form.get('request_id'), kind = form.get('action') === 'device.query' ? 'machine_state_query' : 'notify_local';
      const payload = kind === 'machine_state_query' ? { query_id: request, query_kind: form.get('query_kind') } : { notification_id: form.get('notification_id'), title: form.get('title'), body: form.get('body'), severity: form.get('severity') };
      // Only explicitly owner-selected neutral presets issue; chat/model output supplies no permission.
      if (!identifier(device) || !identifier(request) || !commandPayload(kind, payload) || !directory.listDevices || !directory.deviceForAuth || !namespace) return html ? actionFailure(400) : new Response('invalid', { status: 400 });
      if (kind === 'notify_local' && !notificationScope(payload as NotifyPayload)) return html ? actionFailure(400) : new Response('invalid', { status: 400 });
      if (!(await directory.listDevices(owner)).some((entry) => entry.device_id === device)) return html ? actionFailure(400) : new Response('invalid', { status: 400 });
      const auth = await directory.deviceForAuth(device);
      if (!auth || !auth.capabilities.includes(kind)) return html ? actionFailure(400) : new Response('invalid', { status: 400 });
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
  return html ? actionFailure(400) : new Response('Unable to complete device request.', { status: 400 });
}
