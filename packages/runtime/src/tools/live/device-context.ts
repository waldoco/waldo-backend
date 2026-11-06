import {
  getDeviceContextArgsSchema, TOOL_PERMISSIONS, triggerTypeSchema,
  type GetDeviceContextArgs, type GetDeviceContextResult, type ToolHandler,
} from '@waldo/contracts';
import { devicePlaceStoredV1Schema } from '../../../../contracts/src/app/device-context';
import { invokeDeviceContext } from '../../channels/app-device-context';
import type { ToolDispatcherContext } from '../dispatcher';
import type { OwnerClock } from './get-context';

// Where the owner's phones are, for the owner's own model context: each phone's latest time zone and city-level place, read
// from the health plane with the agent's purpose, which the database checks against storage and model consent on every call.
// The cell never leaves the database read: the model gets the OS's place names, the zone and how old each is. The result lives
// in the turn that asked (turn_only_output), so no place reaches the tool ledger, memory, logs or storage.
type SignedCall = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
export type DeviceContextReadBook = Readonly<{ places(): Promise<unknown> }>;

export const deviceContextReadBook = (call: SignedCall | null, doName: string | null): DeviceContextReadBook => ({
  async places() {
    if (!call || !doName) return { error: 'not_linked' };
    return invokeDeviceContext(call, doName, 'place_read', JSON.stringify({ purpose: 'model' }));
  },
});

type Unavailable = Extract<GetDeviceContextResult, { state: 'unavailable' }>['reason'];
type Device = Extract<GetDeviceContextResult, { state: 'available' }>['devices'][number];
const REFUSALS: ReadonlySet<string> = new Set<Unavailable>(['consent_required', 'consent_withdrawn', 'not_linked']);
const minutesSince = (now: number, at: string) => Math.max(0, Math.floor((now - Date.parse(at)) / 60_000));

// A stored row that does not read as the contract's is left out, never guessed around.
const deviceOf = (raw: unknown, now: number): Omit<Device, 'device'> | null => {
  const stored = devicePlaceStoredV1Schema.safeParse(raw);
  if (!stored.success) return null;
  const { platform, timezone, timezone_observed_at, place } = stored.data;
  return {
    platform, timezone, timezone_observed_at, timezone_age_minutes: minutesSince(now, timezone_observed_at),
    place: place && {
      ...(place.locality ? { locality: place.locality } : {}), ...(place.region ? { region: place.region } : {}), ...(place.country ? { country: place.country } : {}),
      observed_at: place.observed_at, age_minutes: minutesSince(now, place.observed_at),
    },
  };
};

const allowlist = triggerTypeSchema.options.filter((trigger) => TOOL_PERMISSIONS[trigger].includes('get_device_context'));

export const getDeviceContextHandler = (book: DeviceContextReadBook, clock: OwnerClock): ToolHandler<GetDeviceContextArgs, GetDeviceContextResult, ToolDispatcherContext> => ({
  name: 'get_device_context',
  description:
    "Where the owner's phones are, as each last told Waldo: its time zone and, when the app was open with location allowed, the city-level place its own OS named (locality, region, country), each with when it was observed and how many minutes ago. Device 1 is the phone heard from most recently. A phone that sent only its zone has place null; a place with no names is one the OS could not name. Old readings are only what the phone last knew, not where the owner is now, and a zone that differs from the owner's set zone may mean travel. Nothing here is a coordinate, and it stays in this turn: never stored or logged.",
  schema: getDeviceContextArgsSchema,
  trigger_allowlist: allowlist,
  autonomy_gated: false,
  turn_only_output: true,
  async handle() {
    const unavailable = (reason: Unavailable) => result({ state: 'unavailable', reason });
    let raw: unknown;
    try { raw = await book.places(); } catch { return unavailable('read_failed'); }
    const answer = (raw ?? {}) as { error?: unknown; places?: unknown };
    if (typeof answer.error === 'string') return unavailable(REFUSALS.has(answer.error) ? answer.error as Unavailable : 'read_failed');
    if (!Array.isArray(answer.places)) return unavailable('read_failed');
    const now = clock.now().getTime();
    const devices = answer.places.flatMap((row) => deviceOf(row, now) ?? []).slice(0, 8).map((device, index) => ({ device: index + 1, ...device }));
    if (devices.length === 0) return unavailable('no_data');
    return result({ state: 'available', devices });
  },
});

const result = (data: GetDeviceContextResult) => ({ ok: true as const, data, source_taint: null });
