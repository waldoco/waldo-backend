import { healthIngestReceiptV1Schema, healthSampleV1Schema, type HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';
import { invokeHealth } from '../../channels/app-health';
import { HANDOFF_CODE_TTL_MS, newHandoff } from '../../channels/connect-confirm';
import { md5Hex } from '../../channels/md5';
import { hex } from '../../identity/owner-directory';
import { OAuthProxyError, type OAuthProxy } from '../../connectors/oauth-proxy-client';
import { whoopClient, whoopStartUrl, whoopPins, WhoopError, WHOOP_SCOPES, type EdgeReply, type WhoopCall, type WhoopConfig } from './whoop-client';
import { whoopDeletions, whoopNightSamples, whoopWorkoutSamples, type WhoopDeletion, type WhoopRecovery, type WhoopSleep, type WhoopWorkout } from './whoop-map';

// The owner object's side of WHOOP: connect, sync, webhook hints, disconnect. Every token lives at the oauth-proxy Edge
// Function, which exchanges the code, makes each WHOOP request, and refreshes and rotates the single-use refresh token with a
// compare-and-set; this object never receives a token, a code's result or the client secret. It is the one retry owner per
// connection: it refreshes once, single-file, with the version a failing call reported, and then retries once. Every reading
// goes through the same signed waldo.health_ingest the app uses, so consent, epochs, revisions and idempotency are the
// database's, not this module's. Nothing here stores a reading or a zone, and the only things it keeps in the object are ids,
// dates, a token version and counters.
export const WHOOP_SYNC_ID = 'whoop-sync';
const SOURCE = 'whoop';
const BACKFILL_DAYS = 30;
const WINDOW_DAYS = 7;
const RECONCILE_DAYS = 3;
const DAY_MS = 86_400_000;
export const WHOOP_SYNC_EVERY_MS = DAY_MS;
const SYNC_EVERY_MS = WHOOP_SYNC_EVERY_MS;
const RETRY_MS = 15 * 60_000;
const PAGE_LIMIT = 20;
const BATCH_MAX = 128;
const LOOKUPS_PER_WINDOW = 10;
const SEEN_TTL_MS = DAY_MS;
// The edge reports a token expired this long before it lapses, so a call never leaves with one about to.
const EXPIRY_SKEW_MS = 120_000;
const CHANNEL = 'app';

type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
export type WhoopLog = Readonly<{ hop: 'whoop'; ok: boolean; code: string }>;
export type WhoopOwnerDeps = Readonly<{
  // Read when used: the owner object learns its own name after it is built.
  doName(): string;
  rpc: Rpc | null;
  // The client id and redirect address only. The client secret is the edge's.
  config: WhoopConfig | null;
  proxy: OAuthProxy | null;
  kv: Kv;
  now(): number;
  timezone(): string;
  // Recomputes the owner's derived rows after readings were committed, and tells the health trigger about a zone change.
  produce(): Promise<unknown>;
  arm(at: number): Promise<void>;
  disarm(): Promise<void>;
  log(line: WhoopLog): void;
}>;

export type GrantPurpose = 'storage_compute' | 'model_processing';
// consent_required names the grants that are not live, so the owner is sent to exactly those.
export type ConnectResult = Readonly<{ authorize_url: string; expires_at: number }> | Readonly<{ error: 'not_configured' | 'unavailable' }> | Readonly<{ error: 'consent_required'; missing: readonly GrantPurpose[] }>;
export type ExchangeResult = 'linked' | 'denied' | 'already_linked' | 'consent_required' | 'failed';
export type ProviderState = 'not_connected' | 'connected' | 'needs_reconnect' | 'consent_required';
export type SyncResult = 'idle' | 'synced' | 'needs_reconnect' | 'consent_required' | 'rate_limited' | 'failed';
export type HintResult = 'handled' | 'duplicate' | 'ignored' | 'needs_reconnect' | 'consent_required' | 'rate_limited' | 'failed';

// The owner must connect again: WHOOP no longer accepts the saved access.
class NeedsReconnect extends Error {}
class ConsentGone extends Error {}
class RateLimited extends Error { constructor(readonly afterMs: number) { super('rate limited'); } }
class Failed extends Error {}

// What the object keeps of a connection: the edge's id for it, WHOOP's account id, the version of the token last used (so a
// refresh can say which token failed) and when that token lapses. Never a token.
type Conn = Readonly<{ id: string; account: string; version: string; expires_at: number | null }>;
type Cursor = Readonly<{ backfilled: boolean; next_from: number | null; last_sync_at: number | null }>;
const FRESH: Cursor = { backfilled: false, next_from: null, last_sync_at: null };

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
// WHOOP asks for an eight-character state; this is one, drawn without modulo bias.
const newState = (): string => {
  let out = '';
  while (out.length < 8) for (const byte of crypto.getRandomValues(new Uint8Array(16))) if (byte < 248 && out.length < 8) out += BASE62[byte % 62];
  return out;
};
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

export const whoopOwner = (deps: WhoopOwnerDeps) => {
  const { kv } = deps;
  const doName = () => deps.doName();
  const connection = (): Conn | null => kv.get<Conn>('whoop:conn') ?? null;
  const cursor = (): Cursor => ({ ...FRESH, ...(kv.get<Cursor>('whoop:cursor') ?? {}) });
  const rpc = async (fn: string, message: string, args: Record<string, string | number>): Promise<unknown> => {
    if (!deps.rpc) throw new Failed('no database');
    return deps.rpc(fn, message, { p_do_name: doName(), ...args });
  };

  // ---- Tokens: the edge's. This object passes a connection id and a version ----
  const proxy = deps.proxy, config = deps.config;
  const reconnecting = () => kv.get<boolean>('whoop:reconnect') === true;
  const needReconnect = (): NeedsReconnect => { kv.put('whoop:reconnect', true); return new NeedsReconnect('reconnect'); };
  const remember = (conn: Conn): Conn => { kv.put('whoop:conn', conn); return conn; };
  const refused = (error: unknown): unknown => {
    if (!(error instanceof OAuthProxyError)) return error;
    const { code, retry_after } = error.failure;
    if (code === 'reauth_needed' || code === 'connection_unavailable') return needReconnect();
    return code === 'unavailable' && retry_after ? new RateLimited(retry_after * 1000) : new Failed(code);
  };
  // One refresh at a time. A caller that arrives with a stale version gets the winner's token from the edge, which never
  // spends a rotated refresh token twice.
  let refreshing: Promise<Conn> | null = null;
  const refresh = async (conn: Conn): Promise<Conn> => {
    if (refreshing) return refreshing;
    const work = (async (): Promise<Conn> => {
      try {
        const data = await proxy!.refresh(doName(), conn.id, conn.version);
        return remember({ ...conn, version: data.version, expires_at: data.expires_at ?? null });
      } catch (error) { throw refused(error); }
    })();
    refreshing = work;
    try { return await work; } finally { refreshing = null; }
  };
  const SIGNED_OUT = new Set(['token_expired', 'reauth_needed']);
  // A request to WHOOP through the edge. A token about to lapse is refreshed first; one the edge reports expired or refused
  // is refreshed once and the request tried once more. A second refusal means the owner revoked access at WHOOP.
  const call: WhoopCall = async (method, path, query) => {
    let conn = connection();
    if (!conn || !proxy || reconnecting()) throw new NeedsReconnect('not connected');
    if (conn.expires_at !== null && conn.expires_at - EXPIRY_SKEW_MS <= deps.now()) conn = await refresh(conn);
    const attempt = async (current: Conn): Promise<EdgeReply> => {
      const reply = await proxy.fetch(doName(), current.id, method, path, query);
      if (reply.version !== current.version) remember({ ...current, version: reply.version });
      return reply;
    };
    try { return await attempt(conn); }
    catch (error) { if (!(error instanceof OAuthProxyError) || !SIGNED_OUT.has(error.failure.code)) throw refused(error); }
    conn = await refresh(conn);
    try { return await attempt(conn); }
    catch (error) { throw error instanceof OAuthProxyError && SIGNED_OUT.has(error.failure.code) ? needReconnect() : refused(error); }
  };
  const api = whoopClient(call);
  // WHOOP's own answers: a rate limit waits for the window to reset.
  const guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) { if (error instanceof WhoopError && error.kind === 'rate_limited') throw new RateLimited(error.resetSeconds * 1000 + 1_000); throw error; }
  };

  // ---- Consent: the database's answer, read before each connect and sync ----
  // WHOOP's express authorization for storing its data and using it with AI is the owner's two grants for this source.
  // Both must be live to connect and to sync; the database separately refuses readings without storage.
  const consents = async (): Promise<Readonly<{ storage: boolean; model: boolean; epoch: number }> | null> => {
    const answer = record(await invokeHealth(deps.rpc, doName(), 'consent_list', '{}'));
    const rows = Array.isArray(answer?.consents) ? answer!.consents.map(record) : null;
    if (!rows) return null;
    const live = (purpose: string) => rows.find(row => row?.source === SOURCE && row.purpose === purpose && row.status === 'granted');
    const storage = live('storage_compute');
    return { storage: Boolean(storage), model: Boolean(live('model_processing')), epoch: typeof storage?.epoch === 'number' ? storage.epoch : 0 };
  };
  const missingGrants = (grants: Readonly<{ storage: boolean; model: boolean }>): GrantPurpose[] => [...(grants.storage ? [] : ['storage_compute' as const]), ...(grants.model ? [] : ['model_processing' as const])];

  // ---- Ingest: the app's own signed write, in batches the contract accepts ----
  type Staged = Readonly<{ samples: readonly HealthSampleV1[]; deletions: readonly WhoopDeletion[] }>;
  const ingest = async (staged: Staged, epoch: number): Promise<number> => {
    const samples = staged.samples.filter(sample => healthSampleV1Schema.safeParse(sample).success);
    if (samples.length !== staged.samples.length) deps.log({ hop: 'whoop', ok: false, code: 'sample_dropped' });
    let committed = 0;
    const changes = [...samples.map(sample => ({ sample })), ...staged.deletions.map(deletion => ({ deletion }))];
    for (let at = 0; at < changes.length; at += BATCH_MAX) {
      const slice = changes.slice(at, at + BATCH_MAX);
      const batchSamples = slice.flatMap(change => 'sample' in change ? [change.sample] : []);
      const batchDeletions = slice.flatMap(change => 'deletion' in change ? [change.deletion] : []);
      // The same changes always make the same request id, so a retry is a replay the database answers, never a second write.
      const id = `whoop-${md5Hex(slice.map(change => 'sample' in change ? `${change.sample.sample_id}@${change.sample.revision}` : `${change.deletion.sample_id}@${change.deletion.revision}x`).sort().join('|'))}`;
      const send = (consentEpoch: number) => invokeHealth(deps.rpc, doName(), 'ingest', JSON.stringify({
        request_id: id, source: SOURCE, consent_epoch: consentEpoch, timezone: deps.timezone(), anchor_before: null, anchor_after: `whoop:${id}`, samples: batchSamples, deletions: batchDeletions,
      }));
      let answer = record(await send(epoch));
      if (answer?.error === 'epoch_conflict') { const fresh = await consents(); if (!fresh?.storage) throw new ConsentGone(); answer = record(await send(fresh.epoch)); }
      if (answer?.error === 'consent_required' || answer?.error === 'consent_withdrawn') throw new ConsentGone();
      const receipt = healthIngestReceiptV1Schema.safeParse(answer);
      if (!receipt.success) throw new Failed('ingest refused');
      if (!receipt.data.replayed) committed += receipt.data.accepted + receipt.data.deleted;
    }
    return committed;
  };

  const classify = (error: unknown): SyncResult => {
    if (error instanceof NeedsReconnect) return 'needs_reconnect';
    if (error instanceof ConsentGone) return 'consent_required';
    if (error instanceof RateLimited) return 'rate_limited';
    return 'failed';
  };

  // ---- Sync: a month back on connect, the last days on every later pass ----
  const collect = async <T>(fetchPage: (next: string | null) => Promise<Readonly<{ records: readonly T[]; next: string | null; dropped: number }>>): Promise<T[]> => {
    const out: T[] = [];
    let next: string | null = null;
    for (let pages = 0; pages < PAGE_LIMIT; pages += 1) {
      const page = await guard(() => fetchPage(next));
      out.push(...page.records);
      if (page.dropped) deps.log({ hop: 'whoop', ok: false, code: 'record_dropped' });
      if (!page.next) return out;
      next = page.next;
    }
    return out;
  };
  const windowBatch = async (from: number, to: number, epoch: number): Promise<number> => {
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
    const samples = [...byId.values()].flatMap(sleep => whoopNightSamples({ sleep, recovery: recoveryOf.get(sleep.id) ?? null })).concat(workouts.flatMap(whoopWorkoutSamples));
    return ingest({ samples, deletions: [] }, epoch);
  };

  const finish = async (result: SyncResult, code: string, next: number | null): Promise<SyncResult> => {
    deps.log({ hop: 'whoop', ok: result === 'synced' || result === 'idle', code });
    // The entry is a daily interval, so the scheduler keeps it armed after this run; a sooner `next` is a retry, and no `next` ends it.
    if (next !== null) await deps.arm(next);
    else await deps.disarm();
    return result;
  };

  const sync = async (): Promise<SyncResult> => {
    const conn = connection();
    if (!conn || !proxy) return 'idle';
    const started = deps.now();
    let progress = cursor();
    let changed = 0;
    try {
      const consent = await consents();
      if (!consent) return await finish('failed', 'consent_unreadable', started + RETRY_MS);
      if (missingGrants(consent).length > 0) return await finish('consent_required', 'consent_required', started + SYNC_EVERY_MS);
      const windows: [number, number][] = [];
      if (progress.backfilled) windows.push([started - RECONCILE_DAYS * DAY_MS, started]);
      else for (let from = progress.next_from ?? started - BACKFILL_DAYS * DAY_MS; from < started; from += WINDOW_DAYS * DAY_MS) windows.push([from, Math.min(from + WINDOW_DAYS * DAY_MS, started)]);
      for (const [from, to] of windows) {
        changed += await windowBatch(from, to, consent.epoch);
        // A committed window is never fetched again, so a failure later in the month resumes where it stopped.
        if (!progress.backfilled) { progress = { ...progress, next_from: to }; kv.put('whoop:cursor', progress); }
      }
      kv.put('whoop:cursor', { backfilled: true, next_from: null, last_sync_at: started });
      if (changed > 0) await deps.produce().catch(() => deps.log({ hop: 'whoop', ok: false, code: 'produce_failed' }));
      return await finish('synced', 'synced', started + SYNC_EVERY_MS);
    } catch (error) {
      if (changed > 0) await deps.produce().catch(() => undefined);
      const result = classify(error);
      // Committed pages stay committed; nothing is zero-filled for the rest. A reconnect or a consent waits for the owner.
      return finish(result, result === 'failed' ? 'failed' : result, result === 'rate_limited' ? started + (error as RateLimited).afterMs : result === 'failed' ? started + RETRY_MS : result === 'consent_required' ? started + SYNC_EVERY_MS : null);
    }
  };

  // ---- Webhook hints: WHOOP says that something changed; this object fetches it with the owner's own token ----
  const KINDS = /^(sleep|recovery|workout)\.(updated|deleted)$/;
  const hint = async (input: Readonly<{ type: string; id: string; trace: string }>): Promise<HintResult> => {
    const match = KINDS.exec(input.type);
    const conn = connection();
    if (!match || !conn || !proxy || !/^[A-Za-z0-9-]{1,64}$/.test(input.id) || !/^[A-Za-z0-9-]{1,64}$/.test(input.trace)) return 'ignored';
    const seen = `whoop:seen:${input.trace}`;
    if (kv.get<number>(seen) !== undefined) return 'duplicate';
    const [, kind, action] = match as unknown as [string, 'sleep' | 'recovery' | 'workout', 'updated' | 'deleted'];
    let changed = 0;
    try {
      const consent = await consents();
      if (!consent) return 'failed';
      if (missingGrants(consent).length > 0) return 'consent_required';
      if (action === 'deleted') changed = await ingest({ samples: [], deletions: whoopDeletions(kind, input.id, Math.floor(deps.now() / 1000)) }, consent.epoch);
      else if (kind === 'workout') {
        const workout: WhoopWorkout | null = await guard(() => api.workout(input.id));
        changed = workout ? await ingest({ samples: whoopWorkoutSamples(workout), deletions: [] }, consent.epoch) : 0;
      } else {
        // A recovery's id is its sleep's id, so both kinds start from the sleep.
        const sleep: WhoopSleep | null = await guard(() => api.sleep(input.id));
        const recovery: WhoopRecovery | null = sleep ? await guard(() => api.cycleRecovery(sleep.cycle_id)) : null;
        changed = sleep ? await ingest({ samples: whoopNightSamples({ sleep, recovery }), deletions: [] }, consent.epoch) : 0;
      }
      if (changed > 0) await deps.produce().catch(() => deps.log({ hop: 'whoop', ok: false, code: 'produce_failed' }));
      for (const [key, at] of [...kv.list<number>({ prefix: 'whoop:seen:' })]) if (deps.now() - at > SEEN_TTL_MS) kv.delete(key);
      kv.put(seen, deps.now());
      deps.log({ hop: 'whoop', ok: true, code: 'hint_handled' });
      return 'handled';
    } catch (error) {
      if (changed > 0) await deps.produce().catch(() => undefined);
      const result = classify(error);
      deps.log({ hop: 'whoop', ok: false, code: `hint_${result}` });
      // A rate limit or a failure is caught up by the next reconcile; nothing is guessed in the meantime.
      return result === 'idle' || result === 'synced' ? 'failed' : result;
    }
  };

  // ---- Connect, callback, status, disconnect ----
  const connect = async (): Promise<ConnectResult> => {
    if (!config || !proxy) return { error: 'not_configured' };
    try {
      const consent = await consents();
      if (!consent) return { error: 'unavailable' };
      const missing = missingGrants(consent);
      if (missing.length > 0) return { error: 'consent_required', missing };
      const state = newState(), hash = await sha256(state), handoff = await newHandoff();
      const session = await rpc('connect_session_issue_handoff', `connsess.issue_handoff.${doName()}.${SOURCE}.${CHANNEL}.${hash}.${handoff.hash}`, { p_provider: SOURCE, p_channel: CHANNEL, p_ticket_hash: hash, p_handoff_hash: handoff.hash });
      if (typeof session !== 'string') return { error: 'unavailable' };
      return { authorize_url: whoopStartUrl(config, state, handoff.code), expires_at: deps.now() + HANDOFF_CODE_TTL_MS };
    } catch { return { error: 'unavailable' }; }
  };

  const exchange = async (input: Readonly<{ code: string | null; denied: boolean }>): Promise<ExchangeResult> => {
    if (!config || !proxy || input.denied || !input.code) return input.denied || !input.code ? 'denied' : 'failed';
    try {
      // The grants can be withdrawn between starting a connection and returning from WHOOP; the code is then left unused.
      const grants = await consents();
      if (!grants) return 'failed';
      if (missingGrants(grants).length > 0) return 'consent_required';
      const linked = await proxy.exchange(doName(), SOURCE, whoopPins(config), input.code, { scope: WHOOP_SCOPES });
      const previous = connection();
      // One WHOOP account per owner: a different account replaces the old connection, whose saved access is dropped.
      if (previous && previous.id !== linked.id) await proxy.revoke(doName(), previous.id).catch(() => undefined);
      remember({ id: linked.id, account: linked.account, version: linked.version, expires_at: linked.expires_at ?? null });
      kv.put('whoop:cursor', FRESH);
      kv.delete('whoop:reconnect');
      await deps.arm(deps.now());
      deps.log({ hop: 'whoop', ok: true, code: 'linked' });
      return 'linked';
    } catch (error) {
      const code = error instanceof OAuthProxyError ? error.failure.code : 'failed';
      deps.log({ hop: 'whoop', ok: false, code: `exchange_${code}` });
      return code === 'account_linked' ? 'already_linked' : 'failed';
    }
  };

  const status = async (): Promise<Readonly<{ provider: 'whoop'; state: ProviderState; last_sync_at: string | null }>> => {
    const last = cursor().last_sync_at;
    const last_sync_at = last === null ? null : new Date(last).toISOString();
    const conn = connection();
    if (!conn) return { provider: 'whoop', state: 'not_connected', last_sync_at };
    try {
      const listed = await rpc('connection_list', `connlist.${doName()}`, {});
      const row = Array.isArray(listed) ? listed.map(record).find(item => item?.id === conn.id) : null;
      if (!row) return { provider: 'whoop', state: 'not_connected', last_sync_at };
      if (row.status === 'failing' || reconnecting()) return { provider: 'whoop', state: 'needs_reconnect', last_sync_at };
      const consent = await consents();
      return { provider: 'whoop', state: consent && missingGrants(consent).length === 0 ? 'connected' : 'consent_required', last_sync_at };
    } catch { return { provider: 'whoop', state: 'connected', last_sync_at }; }
  };

  // The saved access is removed whether or not WHOOP confirms. What WHOOP has already shared stays stored until the owner
  // withdraws storage consent for this source, as for every source.
  const disconnect = async (): Promise<Readonly<{ revoked_at_provider: boolean }>> => {
    const conn = connection();
    let revoked = false;
    if (conn && proxy) {
      try { revoked = await guard(() => api.revoke()); } catch { revoked = false; }
      try { await proxy.revoke(doName(), conn.id); } catch { /* the owner disconnects again; the edge refuses a call on a connection it no longer holds */ }
    }
    for (const key of ['whoop:conn', 'whoop:cursor', 'whoop:reconnect']) kv.delete(key);
    for (const [key] of [...kv.list<number>({ prefix: 'whoop:seen:' })]) kv.delete(key);
    await deps.disarm();
    deps.log({ hop: 'whoop', ok: true, code: 'disconnected' });
    return { revoked_at_provider: revoked };
  };

  return { connect, exchange, status, disconnect, hint, sync };
};
export type WhoopOwner = ReturnType<typeof whoopOwner>;
