// Who set the owner's time zone: the owner themselves (timezone.set from the app or console, or asking Waldo), or the phone
// reporting its own zone. The phone's zone confirms one that is not confirmed yet and follows the phone while the phone set it;
// the owner's own choice is never replaced by the phone. A zone confirmed before the source was recorded counts as the owner's.

type Kv = Readonly<{ get<T>(key: string): T | undefined }>;
export type ZoneSource = 'device' | 'owner';
export const ZONE_SOURCE_KEY = 'timezone_source';
// The provenance a phone's report carries on its timezone.set. Only the Worker's own route sets it; a client action cannot.
export const DEVICE_ZONE_MADE = 'device:timezone';

export type ZoneState = Readonly<{ timezone: string | undefined; confirmed: boolean; source: ZoneSource | undefined }>;
export const zoneState = (kv: Kv): ZoneState => {
  const confirmed = kv.get<boolean>('timezone_confirmed') === true;
  return { timezone: kv.get<string>('timezone'), confirmed, source: !confirmed ? undefined : kv.get<string>(ZONE_SOURCE_KEY) === 'device' ? 'device' : 'owner' };
};
// Whether the phone may set `zone` now: the zone in force is unconfirmed or the phone's, and it is not already this one.
export const deviceZoneApplies = (state: ZoneState, zone: string): boolean => state.source !== 'owner' && !(state.confirmed && state.timezone === zone);
export const deviceZoneAnswer = (before: ZoneState, after: ZoneState, zone: string) => ({
  timezone: after.timezone ?? zone, source: after.source ?? 'device', changed: before.timezone !== after.timezone || before.confirmed !== after.confirmed,
} as const);
