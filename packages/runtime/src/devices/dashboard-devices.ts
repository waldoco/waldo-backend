import type { ConsoleAction } from '../channels/console';
import type { ControlReceipt, RevealingReceipt } from '../channels/dashboard-control-actions';
import type { DeviceBridgeDO } from './device-bridge-do';
import type { ListedDevice } from './device-directory';
import { deviceAction, type ConsoleDirectory } from './console-devices';
import { NOTIFICATION_BODY_CHOICES, NOTIFICATION_TITLE } from './contract';
import { QUERY_KINDS } from './wire';

type DeviceRowAction = 'device.revoke' | 'device.query' | 'device.notify';
export type DevicesControls = Readonly<{ version: 1; view: 'devices'; state: 'available'; csrf: string; data: Readonly<{
  actions: readonly 'device.pair'[];
  devices: readonly Readonly<{ id: string; label: string; capabilities: readonly string[]; created_at: string; actions: readonly DeviceRowAction[] }>[];
  query_kinds: readonly string[]; notification_bodies: readonly string[];
}> }>;
export type DashboardDeviceDirectory = Required<ConsoleDirectory>;

// The decision-relevant read. last_seen_at, liveness and command history change with every
// heartbeat, so they are read beside this and never hashed into it.
async function readDevices(directory: DashboardDeviceDirectory, owner: string, csrf: string): Promise<{ controls: DevicesControls; rows: readonly ListedDevice[] }> {
  if (!owner) throw new Error('owner_unbound');
  const rows = await directory.listDevices(owner);
  const devices = rows.map((row) => {
    const capabilities = row.capabilities.split(',').filter(Boolean);
    const actions: DeviceRowAction[] = ['device.revoke', ...(capabilities.includes('machine_state_query') ? ['device.query' as const] : []), ...(capabilities.includes('notify_local') ? ['device.notify' as const] : [])];
    return { id: row.device_id, label: row.label, capabilities, created_at: row.created_at, actions };
  });
  return { controls: { version: 1, view: 'devices', state: 'available', csrf, data: { actions: ['device.pair'], devices, query_kinds: [...QUERY_KINDS], notification_bodies: [...NOTIFICATION_BODY_CHOICES] } }, rows };
}

export const devicesControls = async (directory: DashboardDeviceDirectory, owner: string, csrf: string): Promise<DevicesControls> => (await readDevices(directory, owner, csrf)).controls;

export async function devicesControlsStatus(directory: DashboardDeviceDirectory, namespace: DurableObjectNamespace<DeviceBridgeDO> | undefined, owner: string, csrf: string) {
  const { controls, rows } = await readDevices(directory, owner, csrf);
  const devices = await Promise.all(rows.map(async (row) => {
    const stub = namespace?.get(namespace.idFromName(row.device_id));
    const [status, commands] = stub ? await Promise.all([stub.status(), stub.listCommands()]) : [{ online: false }, []];
    return { id: row.device_id, online: status.online, last_seen_at: row.last_seen_at, commands: commands.map((command) => ({ class: command.class, state: command.state, result_state: command.result_state })) };
  }));
  return { controls, status: { devices } };
}

const DONE: Readonly<Record<string, string>> = {
  'device.query': 'Queued for your Mac. Its answer shows in this device’s history once your Mac replies.',
  'device.notify': 'Notification queued for your Mac. Delivery shows in this device’s history.',
  'device.revoke': 'Device revoked. It can no longer connect to your Waldo.',
};
// The notification title is fixed and its id is the request's, so a retried request is the same command.
export async function deviceControlAct(directory: DashboardDeviceDirectory, namespace: DurableObjectNamespace<DeviceBridgeDO> | undefined, owner: string, action: ConsoleAction, fields: Readonly<Record<string, string>>): Promise<ControlReceipt | RevealingReceipt> {
  const outcome = await deviceAction(owner, directory, namespace, action.action, { id: action.id, request_id: fields.request_id, query_kind: fields.query_kind, notification_id: fields.request_id, title: NOTIFICATION_TITLE, body: fields.body, severity: fields.severity }, true);
  switch (outcome.kind) {
    case 'pairing_code': return { receipt: { state: 'recorded', message: 'Paste this into Kennel: Settings, then Connect to Waldo. It works once and expires in 10 minutes.' }, reveal: { kind: 'pairing_code', value: outcome.value } };
    case 'done': return { state: 'recorded', message: DONE[action.action] ?? 'The change was recorded.' };
    case 'invalid': return { state: 'rejected', message: 'That isn’t available for this device. Nothing was sent.' };
    case 'unknown': return { state: 'unconfirmed', message: 'The outcome is not confirmed. Refresh the records before trying again.' };
    default: return { state: 'rejected', message: 'That device change was not applied. Refresh and try again.' };
  }
}
