import type { AppWearableV1 } from '../../../contracts/src/app/controls';
import type { ProviderState } from './providers/whoop-owner';

// Every source of body readings Waldo lists on Connections. A phone permission is available on its platform, because Waldo
// ingests what the phone sends; a cloud account is available where this Worker can connect it. Garmin and Oura are listed
// before Waldo can connect them, so the app shows them as not yet available.
type Entry = Omit<AppWearableV1, 'available' | 'connection'>;
const CATALOGUE: readonly Entry[] = [
  { id: 'apple', kind: 'device', label: 'Apple Watch', access: 'healthkit', platform: 'ios' },
  { id: 'samsung', kind: 'device', label: 'Samsung Galaxy Watch', access: 'samsung-health', platform: 'android' },
  { id: 'whoop', kind: 'device', label: 'WHOOP', access: 'oauth', platform: null },
  { id: 'garmin', kind: 'device', label: 'Garmin', access: 'oauth', platform: null },
  { id: 'oura', kind: 'device', label: 'Oura Ring', access: 'oauth', platform: null },
];

const STATUS: Readonly<Record<Exclude<ProviderState, 'not_connected'>, NonNullable<AppWearableV1['connection']>['status']>> = {
  connected: 'active', needs_reconnect: 'reauth_needed', consent_required: 'consent_required',
};

export type WearablesSource = Readonly<{
  whoopConfigured: boolean;
  whoop(): Promise<Readonly<{ state: ProviderState; connected_at: number | null }>>;
}>;

export async function wearablesCatalogue(source: WearablesSource): Promise<readonly AppWearableV1[]> {
  const whoop = await source.whoop();
  return CATALOGUE.map((entry): AppWearableV1 => {
    if (entry.access !== 'oauth') return { ...entry, available: true, connection: null };
    if (entry.id !== 'whoop') return { ...entry, available: false, connection: null };
    return { ...entry, available: source.whoopConfigured, connection: whoop.state === 'not_connected' ? null : { status: STATUS[whoop.state], connected_at: whoop.connected_at } };
  });
}
