import { healthIngestReceiptV1Schema, healthSampleV1Schema, type HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';
import { invokeHealth } from '../../channels/app-health';
import { md5Hex } from '../../channels/md5';
import { hex, OwnerDirectoryError } from '../../identity/owner-directory';
import { WhoopError, WHOOP_SCOPES, type WhoopClient, type WhoopTokens } from './whoop-client';
import { whoopDeletions, whoopNightSamples, whoopWorkoutSamples, type WhoopDeletion, type WhoopRecovery, type WhoopSleep, type WhoopWorkout } from './whoop-map';

// The owner object's side of WHOOP: connect, token custody, sync and webhook hints, disconnect. The owner's tokens live in
// Vault behind the signed connection calls; this object reads them, refreshes them single-file, and writes the rotated
// token back before using it. Every reading goes through the same signed waldo.health_ingest the app uses, so consent,
// epochs, revisions and idempotency are the database's, not this module's. Nothing here stores a reading or a zone, and the
// only things it keeps in the object are ids, dates and counters.
export const WHOOP_SYNC_ID = 'whoop-sync';
const SOURCE = 'whoop';
const BACKFILL_DAYS = 30;
const WINDOW_DAYS = 7;
const RECONCILE_DAYS = 3;
const DAY_MS = 86_400_000;
const SYNC_EVERY_MS = DAY_MS;
const RETRY_MS = 15 * 60_000;
const PAGE_LIMIT = 20;
const BATCH_MAX = 128;
const LOOKUPS_PER_WINDOW = 10;
const SEEN_TTL_MS = DAY_MS;
const ATTEMPT_TTL_MS = 30 * 60_000;
const CHANNEL = 'app';

type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
export type WhoopLog = Readonly<{ hop: 'whoop'; ok: boolean; code: string }>;
export type WhoopOwnerDeps = Readonly<{
  doName: string;
  rpc: Rpc | null;
  client: WhoopClient | null;
  kv: Kv;
  now(): number;
  timezone(): string;
  // Recomputes the owner's derived rows after readings were committed, and tells the health trigger about a zone change.
  produce(): Promise<unknown>;
  arm(at: number): Promise<void>;
  disarm(): Promise<void>;
  log(line: WhoopLog): void;
}>;

export type ConnectResult = Readonly<{ authorize_url: string; expires_at: number }> | Readonly<{ error: 'not_configured' | 'consent_required' | 'unavailable' }>;
export type ExchangeResult = 'linked' | 'denied' | 'already_linked' | 'failed';
export type ProviderState = 'not_connected' | 'connected' | 'needs_reconnect' | 'consent_required';
export type SyncResult = 'idle' | 'synced' | 'needs_reconnect' | 'consent_required' | 'rate_limited' | 'failed';
export type HintResult = 'handled' | 'duplicate' | 'ignored' | 'needs_reconnect' | 'consent_required' | 'rate_limited' | 'failed';

// The owner must connect again: WHOOP no longer accepts the saved access, or the rotated token could not be saved.
class NeedsReconnect extends Error {}
class ConsentGone extends Error {}
class RateLimited extends Error { constructor(readonly afterMs: number) { super('rate limited'); } }
class Failed extends Error {}

type Conn = Readonly<{ id: string; account: string }>;
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
  const { doName, kv, client } = deps;
  const connection = (): Conn | null => kv.get<Conn>('whoop:conn') ?? null;
  const cursor = (): Cursor => ({ ...FRESH, ...(kv.get<Cursor>('whoop:cursor') ?? {}) });
  const rpc = async (fn: string, message: string, args: Record<string, string | number>): Promise<unknown> => {
    if (!deps.rpc) throw new Failed('no database');
    return deps.rpc(fn, message, { p_do_name: doName, ...args });
  };

  // ---- Tokens: one refresh at a time, saved before use ----
  let cache: Readonly<{ id: string; tokens: WhoopTokens }> | null = null;
  let refreshing: Promise<WhoopTokens> | null = null;
  const secretJson = (tokens: WhoopTokens) => JSON.stringify({ v: 1, access: tokens.access, refresh: tokens.refresh, expires_at: tokens.expiresAt });
  const parseSecret = (raw: unknown): WhoopTokens | null => {
    if (typeof raw !== 'string') return null;
    try {
      const value = record(JSON.parse(raw));
      return value && value.v === 1 && typeof value.access === 'string' && typeof value.refresh === 'string' && typeof value.expires_at === 'number' ? { access: value.access, refresh: value.refresh, expiresAt: value.expires_at } : null;
    } catch { return null; }
  };
  const store = async (account: string, tokens: WhoopTokens): Promise<string> => {
    const secret = secretJson(tokens);
    const id = await rpc('connection_store', `connstore.${doName}.${SOURCE}.${account}.${WHOOP_SCOPES}.${await sha256(secret)}`, { p_provider: SOURCE, p_account: account, p_scopes: WHOOP_SCOPES, p_secret: secret });
    if (typeof id !== 'string') throw new Failed('token not saved');
    return id;
  };
  const markFailing = async (conn: Conn, reason: string): Promise<void> => {
    cache = null;
    try { await rpc('connection_health', `connhealth.${doName}.${conn.id}.${reason}`, { p_connection: conn.id, p_error: reason }); } catch { /* the sync stops either way */ }
  };
  const tokensFor = async (conn: Conn, force = false): Promise<WhoopTokens> => {
    if (!force && cache?.id === conn.id && cache.tokens.expiresAt - 60_000 > deps.now()) return cache.tokens;
    if (refreshing) return refreshing;
    const work = (async (): Promise<WhoopTokens> => {
      const current = parseSecret(await rpc('connection_secret', `connsecret.${doName}.${conn.id}`, { p_connection: conn.id }));
      if (!current) { cache = null; throw new NeedsReconnect('no saved access'); }
      if (!force && current.expiresAt - 60_000 > deps.now()) { cache = { id: conn.id, tokens: current }; return current; }
      let fresh: WhoopTokens;
      try { fresh = await client!.refresh(current.refresh); }
      catch (error) {
        if (error instanceof WhoopError && error.kind === 'rejected') { await markFailing(conn, 'refresh_rejected'); throw new NeedsReconnect('refresh rejected'); }
        throw error;
      }
      // WHOOP has already retired the old refresh token. Save the new one before anything uses it; if it cannot be saved the
      // old one is useless, so the owner connects again instead of this object retrying with a dead token.
      try { if (await store(conn.account, fresh) !== conn.id) throw new Failed('connection changed'); }
      catch { await markFailing(conn, 'token_save_failed'); throw new NeedsReconnect('token not saved'); }
      cache = { id: conn.id, tokens: fresh };
      return fresh;
    })();
    refreshing = work;
    try { return await work; } finally { refreshing = null; }
  };
  // Runs a call with the owner's access token. A 401 refreshes once and tries again; a second 401 means the access is gone.
  const withAccess = async <T>(work: (access: string) => Promise<T>): Promise<T> => {
    const conn = connection();
    if (!conn || !client) throw new NeedsReconnect('not connected');
    try { return await work((await tokensFor(conn)).access); }
    catch (error) {
      if (error instanceof WhoopError && error.kind === 'rate_limited') throw new RateLimited(error.resetSeconds * 1000 + 1_000);
      if (!(error instanceof WhoopError) || error.kind !== 'unauthorized') throw error;
    }
    try { return await work((await tokensFor(conn, true)).access); }
    catch (error) {
      if (error instanceof WhoopError && error.kind === 'unauthorized') { await markFailing(conn, 'unauthorized'); throw new NeedsReconnect('unauthorized'); }
      if (error instanceof WhoopError && error.kind === 'rate_limited') throw new RateLimited(error.resetSeconds * 1000 + 1_000);
      throw error;
    }
  };

  // ---- Consent: the database's answer, read before each sync ----
  const consents = async (): Promise<Readonly<{ terms: boolean; storage: boolean; epoch: number }> | null> => {
    const answer = record(await invokeHealth(deps.rpc, doName, 'consent_list', '{}'));
    const rows = Array.isArray(answer?.consents) ? answer!.consents.map(record) : null;
    if (!rows) return null;
    const live = (purpose: string) => rows.find(row => row?.source === SOURCE && row.purpose === purpose && row.status === 'granted');
    const storage = live('storage_compute');
    return { terms: Boolean(live('provider_terms')), storage: Boolean(storage), epoch: typeof storage?.epoch === 'number' ? storage.epoch : 0 };
  };

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
      const send = (consentEpoch: number) => invokeHealth(deps.rpc, doName, 'ingest', JSON.stringify({
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
  const collect = async <T>(fetchPage: (access: string, next: string | null) => Promise<Readonly<{ records: readonly T[]; next: string | null; dropped: number }>>): Promise<T[]> => {
    const out: T[] = [];
    let next: string | null = null;
    for (let pages = 0; pages < PAGE_LIMIT; pages += 1) {
      const page = await withAccess(access => fetchPage(access, next));
      out.push(...page.records);
      if (page.dropped) deps.log({ hop: 'whoop', ok: false, code: 'record_dropped' });
      if (!page.next) return out;
      next = page.next;
    }
    return out;
  };
  const windowBatch = async (from: number, to: number, epoch: number): Promise<number> => {
    const range = { start: new Date(from).toISOString(), end: new Date(to).toISOString() };
    const sleeps = await collect((access, next) => client!.sleeps(access, { ...range, next }));
    const recoveries = await collect((access, next) => client!.recoveries(access, { ...range, next }));
    const workouts = await collect((access, next) => client!.workouts(access, { ...range, next }));
    const byId = new Map(sleeps.map(sleep => [sleep.id, sleep]));
    // A recovery whose night fell just outside the window still needs its sleep to be placed on a day.
    let lookups = 0;
    for (const recovery of recoveries) {
      if (byId.has(recovery.sleep_id) || lookups >= LOOKUPS_PER_WINDOW) continue;
      lookups += 1;
      const sleep = await withAccess(access => client!.sleep(access, recovery.sleep_id));
      if (sleep) byId.set(sleep.id, sleep);
    }
    const recoveryOf = new Map(recoveries.map(recovery => [recovery.sleep_id, recovery]));
    const samples = [...byId.values()].flatMap(sleep => whoopNightSamples({ sleep, recovery: recoveryOf.get(sleep.id) ?? null })).concat(workouts.flatMap(whoopWorkoutSamples));
    return ingest({ samples, deletions: [] }, epoch);
  };

  const finish = async (result: SyncResult, code: string, next: number | null): Promise<SyncResult> => {
    deps.log({ hop: 'whoop', ok: result === 'synced' || result === 'idle', code });
    if (next !== null) await deps.arm(next);
    return result;
  };

  const sync = async (): Promise<SyncResult> => {
    const conn = connection();
    if (!conn || !client) return 'idle';
    const started = deps.now();
    let progress = cursor();
    let changed = 0;
    try {
      const consent = await consents();
      if (!consent) return await finish('failed', 'consent_unreadable', started + RETRY_MS);
      if (!consent.terms || !consent.storage) return await finish('consent_required', 'consent_required', started + SYNC_EVERY_MS);
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
    if (!match || !conn || !client || !/^[A-Za-z0-9-]{1,64}$/.test(input.id) || !/^[A-Za-z0-9-]{1,64}$/.test(input.trace)) return 'ignored';
    const seen = `whoop:seen:${input.trace}`;
    if (kv.get<number>(seen) !== undefined) return 'duplicate';
    const [, kind, action] = match as unknown as [string, 'sleep' | 'recovery' | 'workout', 'updated' | 'deleted'];
    let changed = 0;
    try {
      const consent = await consents();
      if (!consent) return 'failed';
      if (!consent.terms || !consent.storage) return 'consent_required';
      if (action === 'deleted') changed = await ingest({ samples: [], deletions: whoopDeletions(kind, input.id, Math.floor(deps.now() / 1000)) }, consent.epoch);
      else if (kind === 'workout') {
        const workout: WhoopWorkout | null = await withAccess(access => client!.workout(access, input.id));
        changed = workout ? await ingest({ samples: whoopWorkoutSamples(workout), deletions: [] }, consent.epoch) : 0;
      } else {
        // A recovery's id is its sleep's id, so both kinds start from the sleep.
        const sleep: WhoopSleep | null = await withAccess(access => client!.sleep(access, input.id));
        const recovery: WhoopRecovery | null = sleep ? await withAccess(access => client!.cycleRecovery(access, sleep.cycle_id)) : null;
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
    if (!client) return { error: 'not_configured' };
    try {
      const consent = await consents();
      if (!consent) return { error: 'unavailable' };
      if (!consent.terms || !consent.storage) return { error: 'consent_required' };
      const state = newState(), hash = await sha256(state);
      const session = await rpc('connect_session_issue', `connsess.issue.${doName}.${SOURCE}.${CHANNEL}.${hash}`, { p_provider: SOURCE, p_channel: CHANNEL, p_ticket_hash: hash });
      if (typeof session !== 'string') return { error: 'unavailable' };
      return { authorize_url: client.authorizeUrl(state), expires_at: deps.now() + ATTEMPT_TTL_MS };
    } catch { return { error: 'unavailable' }; }
  };

  const exchange = async (input: Readonly<{ code: string | null; denied: boolean }>): Promise<ExchangeResult> => {
    if (!client || input.denied || !input.code) return input.denied || !input.code ? 'denied' : 'failed';
    try {
      const tokens = await client.exchange(input.code);
      const account = await client.profile(tokens.access);
      const previous = connection();
      // One WHOOP account per owner: a different account replaces the old connection, whose saved access is dropped.
      if (previous && previous.account !== account) await rpc('connection_revoke', `connrevoke.${doName}.${previous.id}`, { p_connection: previous.id }).catch(() => undefined);
      let id: string;
      try { id = await store(account, tokens); }
      catch (error) { return error instanceof OwnerDirectoryError && error.sqlState === '23505' ? 'already_linked' : 'failed'; }
      cache = { id, tokens };
      kv.put('whoop:conn', { id, account });
      kv.put('whoop:cursor', FRESH);
      await deps.arm(deps.now());
      deps.log({ hop: 'whoop', ok: true, code: 'linked' });
      return 'linked';
    } catch (error) {
      deps.log({ hop: 'whoop', ok: false, code: error instanceof WhoopError ? `exchange_${error.kind}` : 'exchange_failed' });
      return 'failed';
    }
  };

  const status = async (): Promise<Readonly<{ provider: 'whoop'; state: ProviderState; last_sync_at: string | null }>> => {
    const last = cursor().last_sync_at;
    const last_sync_at = last === null ? null : new Date(last).toISOString();
    const conn = connection();
    if (!conn) return { provider: 'whoop', state: 'not_connected', last_sync_at };
    try {
      const listed = await rpc('connection_list', `connlist.${doName}`, {});
      const row = Array.isArray(listed) ? listed.map(record).find(item => item?.id === conn.id) : null;
      if (!row) return { provider: 'whoop', state: 'not_connected', last_sync_at };
      if (row.status === 'failing') return { provider: 'whoop', state: 'needs_reconnect', last_sync_at };
      const consent = await consents();
      return { provider: 'whoop', state: consent && consent.terms && consent.storage ? 'connected' : 'consent_required', last_sync_at };
    } catch { return { provider: 'whoop', state: 'connected', last_sync_at }; }
  };

  // The saved access is removed whether or not WHOOP confirms. What WHOOP has already shared stays stored until the owner
  // withdraws storage consent for this source, as for every source.
  const disconnect = async (): Promise<Readonly<{ revoked_at_provider: boolean }>> => {
    const conn = connection();
    let revoked = false;
    if (conn && client) {
      try { revoked = await withAccess(access => client.revoke(access)); } catch { revoked = false; }
      try { await rpc('connection_revoke', `connrevoke.${doName}.${conn.id}`, { p_connection: conn.id }); } catch { /* the next call to the provider fails closed on a missing secret */ }
    }
    cache = null;
    for (const key of ['whoop:conn', 'whoop:cursor']) kv.delete(key);
    for (const [key] of [...kv.list<number>({ prefix: 'whoop:seen:' })]) kv.delete(key);
    await deps.disarm();
    deps.log({ hop: 'whoop', ok: true, code: 'disconnected' });
    return { revoked_at_provider: revoked };
  };

  return { connect, exchange, status, disconnect, hint, sync };
};
export type WhoopOwner = ReturnType<typeof whoopOwner>;
