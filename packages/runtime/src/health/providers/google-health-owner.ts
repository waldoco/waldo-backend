import { localIso } from '../../channels/reminders';
import { googleHealthClient, googleHealthPins, googleHealthStartUrl, GoogleHealthError, GOOGLE_HEALTH_SCOPES, type GoogleHealthClient, type GoogleHealthConfig } from './google-health-client';
import type { HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';
import { googleHealthBodySamples, googleHealthNightSamples, googleHealthWindowSamples, googleHealthWorkoutSamples, type GoogleHealthDaily, type GoogleHealthDailyKind } from './google-health-map';
import { DAY_MS, providerOwner, type HintResult, type ProviderLog, type ProviderOwnerDeps } from './provider-owner';

// Google Health (Fitbit, Pixel Watch) on the shared provider owner. Google's webhook names a data type and the time span
// that changed, never a record, so a hint does not fetch: it marks how far back the next reconcile must reach and brings
// that reconcile forward, once per burst.
export const GOOGLE_HEALTH_SYNC_ID = 'google-health-sync';
const HINT_DELAY_MS = 5 * 60_000;
const HOUR_MS = 3_600_000;
const SEEN_TTL_MS = DAY_MS;
const DAILY: readonly GoogleHealthDailyKind[] = ['overnight_hrv', 'resting_heart_rate', 'spo2', 'respiratory_rate', 'wrist_temperature'];
// The data types the subscriber names and Waldo maps.
const MAPPED = new Set(['sleep', 'daily-heart-rate-variability', 'daily-resting-heart-rate', 'daily-oxygen-saturation', 'daily-respiratory-rate',
  'daily-sleep-temperature-derivations', 'exercise', 'weight', 'body-fat', 'steps', 'active-energy-burned']);

export type GoogleHealthLog = ProviderLog<'google_health'>;

// Google's Limited Use rules forbid people reading this data, so an owner who has linked Google Health has no conversation
// text captured in traces from then on. The mark outlives a disconnect: what Google shared stays stored, and readable in a
// turn, until the owner withdraws storage consent for the source.
const HELD_KEY = 'google_health:held';
export const holdsGoogleHealthData = (kv: Readonly<{ get<T>(key: string): T | undefined }>): boolean =>
  kv.get<boolean>(HELD_KEY) === true || kv.get('google_health:conn') !== undefined;
export type GoogleHealthOwnerDeps = ProviderOwnerDeps<GoogleHealthConfig, 'google_health'>;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const newState = (): string => {
  let out = '';
  while (out.length < 32) for (const byte of crypto.getRandomValues(new Uint8Array(48))) if (byte < 248 && out.length < 32) out += BASE62[byte % 62];
  return out;
};
const instant = (at: number) => new Date(at).toISOString().replace('.000Z', 'Z');
const dateOf = (at: number) => new Date(at).toISOString().slice(0, 10);
// The owner's offset from UTC at an instant, in whole minutes.
const offsetAt = (at: number, timezone: string): number => {
  const minute = at - (at % 60_000);
  return Math.round((Date.parse(`${localIso(minute, timezone)}:00Z`) - minute) / 60_000);
};
const localHourFloor = (at: number, offset: number): number => {
  const local = at + offset * 60_000;
  return local - (((local % HOUR_MS) + HOUR_MS) % HOUR_MS) - offset * 60_000;
};

export const googleHealthOwner = (deps: GoogleHealthOwnerDeps) => {
  const { owner, kit } = providerOwner<GoogleHealthConfig, GoogleHealthClient, 'google_health'>(deps, {
    source: 'google_health', scopes: GOOGLE_HEALTH_SCOPES, pins: googleHealthPins, startUrl: googleHealthStartUrl, newState, client: googleHealthClient,
    rateLimitMs: error => (error instanceof GoogleHealthError && error.kind === 'rate_limited' ? error.resetSeconds * 1000 + 1_000 : null),
    window: async (api, { from, to }, { collect }) => {
      const fetched = Math.floor(deps.now() / 1000);
      const times = { from: instant(from), to: instant(to) };
      // A night ends inside the window; its waking day, in any offset, lies within a day either side of the window's dates.
      // Exercise is filtered by local start date, so it takes the same margin.
      const dates = { from: dateOf(from - DAY_MS), to: dateOf(to + 2 * DAY_MS) };
      const sleeps = await collect(next => api.sleeps({ ...times, next }));
      const daily: GoogleHealthDaily[] = [];
      for (const kind of DAILY) daily.push(...await collect(next => api.daily(kind, { ...dates, next })));
      const workouts = await collect(next => api.workouts({ ...dates, next }));
      const bodies = [...await collect(next => api.body('body_mass', { ...times, next })), ...await collect(next => api.body('body_fat_percentage', { ...times, next }))];
      // Steps and energy are summed into the owner's local hours. The window is widened back to a whole hour, and an hour
      // that ends after the window is left to the window or pass that holds all of it, so no hour is stored half-summed.
      const offset = offsetAt(to, deps.timezone());
      const span = { from: instant(localHourFloor(from, offset)), to: times.to };
      const hours: HealthSampleV1[] = [];
      for (const kind of ['steps', 'active_energy'] as const) {
        const points = await collect(next => api.intervals(kind, { ...span, next }));
        hours.push(...googleHealthWindowSamples(kind, points, offset, fetched).filter(sample => Date.parse(sample.end_at) <= to));
      }
      return [
        ...sleeps.flatMap(sleep => googleHealthNightSamples({ sleep, daily, fetchedAtSeconds: fetched })),
        ...workouts.flatMap(googleHealthWorkoutSamples),
        ...bodies.flatMap(body => googleHealthBodySamples(body, fetched)),
        ...hours,
      ];
    },
  });
  const { kv } = kit;

  const hint = async (input: Readonly<{ type: string; from: string; trace: string }>): Promise<HintResult> => {
    const from = /^\d{4}-\d{2}-\d{2}T/.test(input.from) ? Date.parse(input.from) : NaN;
    if (!MAPPED.has(input.type) || !Number.isFinite(from) || !/^[A-Za-z0-9-]{1,64}$/.test(input.trace) || !kit.connection() || !kit.hasProxy()) return 'ignored';
    const seen = kit.key(`seen:${input.trace}`);
    if (kv.get<number>(seen) !== undefined) return 'duplicate';
    try {
      const consent = await kit.consents();
      if (!consent) return 'failed';
      if (kit.missingGrants(consent).length > 0) return 'consent_required';
      kit.markDirty(from);
      const now = kit.now(), due = kv.get<number>(kit.key('hint_due'));
      if (due === undefined || due <= now) { await kit.arm(now + HINT_DELAY_MS); kv.put(kit.key('hint_due'), now + HINT_DELAY_MS); }
      for (const [key, at] of [...kv.list<number>({ prefix: kit.key('seen:') })]) if (now - at > SEEN_TTL_MS) kv.delete(key);
      kv.put(seen, now);
      kit.log(true, 'hint_handled');
      return 'handled';
    } catch {
      kit.log(false, 'hint_failed');
      return 'failed';
    }
  };

  // Marked as the link is kept, before any sync can bring Google data into a turn.
  const exchange: typeof owner.exchange = async (input) => {
    const outcome = await owner.exchange(input);
    if (outcome === 'linked') kv.put(HELD_KEY, true);
    return outcome;
  };

  const disconnect = async () => {
    const result = await owner.disconnect();
    kv.delete(kit.key('hint_due'));
    return result;
  };

  return { ...owner, exchange, disconnect, hint };
};
export type GoogleHealthOwner = ReturnType<typeof googleHealthOwner>;
