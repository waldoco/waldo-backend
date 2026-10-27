import type { ConsoleAction } from './console';
import { controlAction, controlRevision, type ControlReceipt, type RevealingReceipt } from './dashboard-control-actions';
import { DASHBOARD_OVERVIEW_HEADERS } from './dashboard-overview';
import type { IMessageEnv } from './imessage/bridge-do';
import { iMessageControlAct, iMessageControls, iMessageControlsStatus, type IMessageControls } from './imessage/dashboard';
import type { DeviceBridgeDO } from '../devices/device-bridge-do';
import type { PhoneSmsEnv } from '../identity/phone-sms';
import { phoneControlAct, phoneControls, type IMessageProof, type PhoneControls } from './dashboard-phone';
import { deviceControlAct, devicesControls, devicesControlsStatus, type DashboardDeviceDirectory, type DevicesControls } from '../devices/dashboard-devices';

// iMessage, device and phone setup read the owner directory and bridge objects, not the console view,
// so their reads and actions never build it. Their actions use the one control-action path; the owner DO
// runs them on their own queue, apart from turns, so their receipts keep a book of their own.
export const CHANNEL_CONTROL_VIEWS = ['imessage', 'devices', 'phone'] as const;
export type ChannelControlView = (typeof CHANNEL_CONTROL_VIEWS)[number];
export const CHANNEL_RECEIPT_BOOK_KEY = 'console:channel-control-receipts';
export const channelControlView = (value: unknown): ChannelControlView | null => CHANNEL_CONTROL_VIEWS.find((view) => view === value) ?? null;
// A read names exactly one view and nothing else.
export const channelControlsQuery = (params: URLSearchParams): ChannelControlView | null =>
  [...params.keys()].length === 1 && params.getAll('view').length === 1 ? channelControlView(params.get('view')) : null;

type Store = Readonly<{ get<T>(key: string): Promise<T | undefined>; put(key: string, value: unknown): Promise<void> }>;
export type ChannelControlsDeps = Readonly<{
  imessage: IMessageEnv; phone: PhoneSmsEnv; devices: DashboardDeviceDirectory; deviceBridges?: DurableObjectNamespace<DeviceBridgeDO>;
  owner: string; csrf: string; expires: number; store: Store;
  sessions(): Promise<readonly { csrf: string; expires: number }[]>;
  onIMessageRevoked(bridgeDoName: string): void;
  // Clears the WhatsApp chat the owner DO holds, after the directory unlinked it.
  onWhatsAppUnlinked(): Promise<void>;
  // Whether the owner can prove a number by sending their iMessage link code from it; absent means they cannot.
  imessageProof?: IMessageProof;
}>;

// One entry per view. fresh() pairs the hashed read with an executor bound to that same read.
type ChannelControl = Readonly<{
  status(deps: ChannelControlsDeps): Promise<Readonly<{ controls: IMessageControls | DevicesControls | PhoneControls; status: unknown }>>;
  fresh(deps: ChannelControlsDeps): Promise<Readonly<{ controls: IMessageControls | DevicesControls | PhoneControls; act(action: ConsoleAction, fields: Readonly<Record<string, string>>): Promise<ControlReceipt | RevealingReceipt> }>>;
}>;
const CHANNEL_CONTROLS: Readonly<Record<ChannelControlView, ChannelControl>> = {
  imessage: {
    status: (deps) => iMessageControlsStatus(deps.imessage, deps.owner, deps.csrf),
    fresh: async (deps) => {
      const controls = await iMessageControls(deps.imessage, deps.owner, deps.csrf);
      return { controls, act: (action, fields) => iMessageControlAct(deps.imessage, deps.owner, controls, action, fields, deps.onIMessageRevoked) };
    },
  },
  devices: {
    status: (deps) => devicesControlsStatus(deps.devices, deps.deviceBridges, deps.owner, deps.csrf),
    fresh: async (deps) => ({ controls: await devicesControls(deps.devices, deps.owner, deps.csrf), act: (action, fields) => deviceControlAct(deps.devices, deps.deviceBridges, deps.owner, action, fields) }),
  },
  phone: {
    status: async (deps) => ({ controls: await phoneControls(deps.phone, deps.owner, deps.csrf, deps.imessageProof), status: {} }),
    fresh: async (deps) => ({ controls: await phoneControls(deps.phone, deps.owner, deps.csrf, deps.imessageProof), act: (action, fields) => phoneControlAct(deps.phone, deps.owner, action, fields, deps.onWhatsAppUnlinked, deps.imessageProof) }),
  },
};

// Liveness rides beside the hashed read: a heartbeat between read and action never makes it stale.
export async function channelControlsRead(view: ChannelControlView, deps: ChannelControlsDeps): Promise<Response> {
  try {
    const { controls, status } = await CHANNEL_CONTROLS[view].status(deps);
    return Response.json({ ...controls, revision: await controlRevision(controls), status }, { headers: DASHBOARD_OVERVIEW_HEADERS });
  } catch { return Response.json({ error: 'controls_unavailable' }, { status: 503, headers: DASHBOARD_OVERVIEW_HEADERS }); }
}

export function channelControlsAction(form: FormData, deps: ChannelControlsDeps): Promise<Response> {
  let fresh: Awaited<ReturnType<ChannelControl['fresh']>> | undefined;
  return controlAction(form, {
    csrf: deps.csrf, expires: deps.expires, sessions: deps.sessions, store: deps.store, book: CHANNEL_RECEIPT_BOOK_KEY,
    projection: async (name) => {
      const view = channelControlView(name);
      fresh = view ? await CHANNEL_CONTROLS[view].fresh(deps) : undefined;
      return fresh?.controls ?? null;
    },
    // controlAction acts only after this request's projection returned its fresh read.
    act: (action, fields) => fresh!.act(action, fields),
  });
}
