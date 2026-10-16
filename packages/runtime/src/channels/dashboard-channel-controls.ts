import type { ConsoleAction } from './console';
import { controlAction, controlRevision } from './dashboard-control-actions';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import type { IMessageEnv } from './imessage/bridge-do';
import { iMessageControlAct, iMessageControls, iMessageControlsStatus, type IMessageControls } from './imessage/dashboard';
import type { DeviceBridgeDO } from '../devices/device-bridge-do';
import { deviceControlAct, devicesControls, devicesControlsStatus, type DashboardDeviceDirectory, type DevicesControls } from '../devices/dashboard-devices';

// iMessage and device setup read the owner directory and bridge objects, not the console view,
// so their reads and actions never build it. Their actions use the one control-action path.
export const CHANNEL_CONTROL_VIEWS = ['imessage', 'devices'] as const;
export type ChannelControlView = (typeof CHANNEL_CONTROL_VIEWS)[number];
export const channelControlView = (value: unknown): ChannelControlView | null => CHANNEL_CONTROL_VIEWS.find((view) => view === value) ?? null;
// A read names exactly one view and nothing else.
export const channelControlsQuery = (params: URLSearchParams): ChannelControlView | null =>
  [...params.keys()].length === 1 && params.getAll('view').length === 1 ? channelControlView(params.get('view')) : null;

type Store = Readonly<{ get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }>;
export type ChannelControlsDeps = Readonly<{
  imessage: IMessageEnv; devices: DashboardDeviceDirectory; deviceBridges?: DurableObjectNamespace<DeviceBridgeDO>;
  owner: string; csrf: string; expires: number; store: Store;
  sessions(): Promise<readonly { csrf: string; expires: number }[]>;
  onIMessageRevoked(bridgeDoName: string): void;
}>;

// Liveness rides beside the hashed read: a heartbeat between read and action never makes it stale.
export async function channelControlsRead(view: ChannelControlView, deps: ChannelControlsDeps): Promise<Response> {
  try {
    const { controls, status } = view === 'imessage' ? await iMessageControlsStatus(deps.imessage, deps.owner, deps.csrf) : await devicesControlsStatus(deps.devices, deps.deviceBridges, deps.owner, deps.csrf);
    return Response.json({ ...controls, revision: await controlRevision(controls), status }, { headers: DASHBOARD_OVERVIEW_HEADERS });
  } catch { return Response.json({ error: 'controls_unavailable' }, { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }); }
}

export function channelControlsAction(form: FormData, deps: ChannelControlsDeps): Promise<Response> {
  let fresh: IMessageControls | DevicesControls | undefined;
  return controlAction(form, {
    csrf: deps.csrf, expires: deps.expires, sessions: deps.sessions, store: deps.store,
    projection: async (view) => {
      const selected = channelControlView(view);
      fresh = selected === 'imessage' ? await iMessageControls(deps.imessage, deps.owner, deps.csrf) : selected === 'devices' ? await devicesControls(deps.devices, deps.owner, deps.csrf) : undefined;
      return fresh ?? null;
    },
    act: async (action: ConsoleAction, fields) => fresh?.view === 'imessage' ? iMessageControlAct(deps.imessage, deps.owner, fresh, action, fields, deps.onIMessageRevoked)
      : deviceControlAct(deps.devices, deps.deviceBridges, deps.owner, action, fields),
  });
}
