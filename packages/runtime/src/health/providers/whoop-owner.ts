import { whoopClient, whoopStartUrl, whoopPins, WhoopError, WHOOP_SCOPES, type WhoopClient, type WhoopConfig } from './whoop-client';
import { whoopDeletions, whoopNightSamples, whoopWorkoutSamples, type WhoopRecovery, type WhoopSleep, type WhoopWorkout } from './whoop-map';
import { PROVIDER_SYNC_EVERY_MS, providerOwner, type HintResult, type ProviderLog, type ProviderOwnerDeps, type ProviderSpec } from './provider-owner';

export type { ConnectResult, ExchangeResult, GrantPurpose, HintResult, ProviderState, SyncResult } from './provider-owner';

// WHOOP on the shared provider owner: what it reads for a window, and its webhook hints, which name one record by id.
export const WHOOP_SYNC_ID = 'whoop-sync';
export const WHOOP_SYNC_EVERY_MS = PROVIDER_SYNC_EVERY_MS;
const LOOKUPS_PER_WINDOW = 10;
const SEEN_TTL_MS = 86_400_000;

export type WhoopLog = ProviderLog<'whoop'>;
export type WhoopOwnerDeps = ProviderOwnerDeps<WhoopConfig, 'whoop'>;

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// WHOOP asks for an eight-character state; this is one, drawn without modulo bias.
const newState = (): string => {
  let out = '';
  while (out.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 248 && out.length < 8) out += BASE62[byte % 62];
  return out;
};

const WHOOP: ProviderSpec<WhoopConfig, WhoopClient, 'whoop'> = {
  source: 'whoop', scopes: WHOOP_SCOPES, pins: whoopPins, startUrl: whoopStartUrl, newState, client: whoopClient,
  rateLimitMs: error => (error instanceof WhoopError && error.kind === 'rate_limited' ? error.resetSeconds * 1000 + 1_000 : null),
  window: async (api, { from, to }, { collect, guard }) => {
    const range = { start: new Date(from).toISOString(), end: new Date(to).toISOString() };
    const sleeps = await collect(next => api.sleeps({ ...range, next }));
    const recoveries = await collect(next => api.recoveries({ ...range, next }));
    const workouts = await collect(next => api.workouts({ ...range, next }));
    const byId = new Map(sleeps.map(sleep => [sleep.id, sleep]));
    // A recovery whose night fell just outside the window still needs its sleep to be placed on a day.
    let lookups = 0;
    for (const recovery of recoveries) {
      if (byId.has(recovery.sleep_id) || lookups >= LOOKUPS_PER_WINDOW) continue;
      lookups += 1;
      const sleep = await guard(() => api.sleep(recovery.sleep_id));
      if (sleep) byId.set(sleep.id, sleep);
    }
    const recoveryOf = new Map(recoveries.map(recovery => [recovery.sleep_id, recovery]));
    return [...byId.values()].flatMap(sleep => whoopNightSamples({ sleep, recovery: recoveryOf.get(sleep.id) ?? null })).concat(workouts.flatMap(whoopWorkoutSamples));
  },
  revokeAtProvider: api => api.revoke(),
};

export const whoopOwner = (deps: WhoopOwnerDeps) => {
  const { owner, kit } = providerOwner(deps, WHOOP);
  const { api, kv } = kit;

  // ---- Webhook hints: WHOOP says that something changed; this object fetches it with the owner's own token ----
  const KINDS = /^(sleep|recovery|workout)\.(updated|deleted)$/;
  const hint = async (input: Readonly<{ type: string; id: string; trace: string }>): Promise<HintResult> => {
    const match = KINDS.exec(input.type);
    const conn = kit.connection();
    if (!match || !conn || !kit.hasProxy() || !/^[A-Za-z0-9-]{1,64}$/.test(input.id) || !/^[A-Za-z0-9-]{1,64}$/.test(input.trace)) return 'ignored';
    const seen = kit.key(`seen:${input.trace}`);
    if (kv.get<number>(seen) !== undefined) return 'duplicate';
    const [, kind, action] = match as unknown as [string, 'sleep' | 'recovery' | 'workout', 'updated' | 'deleted'];
    let changed = 0;
    const pass = { woke: false };
    try {
      const consent = await kit.consents();
      if (!consent) return 'failed';
      if (kit.missingGrants(consent).length > 0) return 'consent_required';
      if (action === 'deleted') changed = await kit.ingest({ samples: [], deletions: whoopDeletions(kind, input.id, Math.floor(kit.now() / 1000)) }, consent.epoch, pass);
      else if (kind === 'workout') {
        const workout: WhoopWorkout | null = await kit.guard(() => api.workout(input.id));
        changed = workout ? await kit.ingest({ samples: whoopWorkoutSamples(workout), deletions: [] }, consent.epoch, pass) : 0;
      } else {
        // A recovery's id is its sleep's id, so both kinds start from the sleep.
        const sleep: WhoopSleep | null = await kit.guard(() => api.sleep(input.id));
        const recovery: WhoopRecovery | null = sleep ? await kit.guard(() => api.cycleRecovery(sleep.cycle_id)) : null;
        changed = sleep ? await kit.ingest({ samples: whoopNightSamples({ sleep, recovery }), deletions: [] }, consent.epoch, pass) : 0;
      }
      if (changed > 0) await kit.produce(pass.woke).catch(() => kit.log(false, 'produce_failed'));
      for (const [key, at] of [...kv.list<number>({ prefix: kit.key('seen:') })]) if (kit.now() - at > SEEN_TTL_MS) kv.delete(key);
      kv.put(seen, kit.now());
      kit.log(true, 'hint_handled');
      return 'handled';
    } catch (error) {
      if (changed > 0) await kit.produce(pass.woke).catch(() => undefined);
      const result = kit.classify(error);
      kit.log(false, `hint_${result}`);
      // A rate limit or a failure is caught up by the next reconcile; nothing is guessed in the meantime.
      return result === 'idle' || result === 'synced' ? 'failed' : result;
    }
  };

  return { ...owner, hint };
};
export type WhoopOwner = ReturnType<typeof whoopOwner>;
