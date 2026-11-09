import { healthIngestReceiptV1Schema, healthSampleV1Schema, type HealthSampleV1 } from '../../../../contracts/src/app/health-ingest';
import { sleepJustEnded, workoutJustEnded } from '../wake-notice';
import { invokeHealth } from '../../channels/app-health';
import { HANDOFF_CODE_TTL_MS, newHandoff } from '../../channels/connect-confirm';
import { md5Hex } from '../../channels/md5';
import { hex } from '../../identity/owner-directory';
import type { ClientPins } from '../../connectors/mcp-oauth';
import { OAuthProxyError, type OAuthProxy } from '../../connectors/oauth-proxy-client';
import type { EdgeReply } from './whoop-client';

// The owner object's side of a wearable provider reached through the oauth-proxy Edge Function: connect, sync, disconnect,
// and the pieces a provider's webhook hint needs. The edge exchanges the code, makes each provider request, and refreshes the
// token with a compare-and-set; this object never receives a token, a code's result or the client secret. It is the one
// retry owner per connection: it refreshes once, single-file, with the version a failing call reported, and then retries
// once. Every reading goes through the same signed waldo.health_ingest the app uses, so consent, epochs, revisions and
// idempotency are the database's. Nothing here stores a reading or a zone; the object keeps ids, dates, a token version and
// counters, under keys prefixed with the source.
const BACKFILL_DAYS = 30;
const WINDOW_DAYS = 7;
const RECONCILE_DAYS = 3;
export const DAY_MS = 86_400_000;
export const PROVIDER_SYNC_EVERY_MS = DAY_MS;
const SYNC_EVERY_MS = PROVIDER_SYNC_EVERY_MS;
const RETRY_MS = 15 * 60_000;
const PAGE_LIMIT = 20;
const BATCH_MAX = 128;
// The edge reports a token expired this long before it lapses, so a call never leaves with one about to.
const EXPIRY_SKEW_MS = 120_000;
const CHANNEL = 'app';

type Rpc = (fn: string, message: string, args: Record<string, string | number>) => Promise<unknown>;
export type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): boolean; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
export type ProviderLog<Source extends string> = Readonly<{ hop: Source; ok: boolean; code: string }>;
export type ProviderOwnerDeps<Config, Source extends string> = Readonly<{
  // Read when used: the owner object learns its own name after it is built.
  doName(): string;
  rpc: Rpc | null;
  // The client id and redirect address only. The client secret is the edge's.
  config: Config | null;
  proxy: OAuthProxy | null;
  kv: Kv;
  now(): number;
  timezone(): string;
  // Recomputes the owner's derived rows after readings were committed, and tells the health trigger about a zone change.
  // woke: the committed readings carry a night that just ended (WAKE_BRIEF). workout: they carry a workout that just ended
  // (WORKOUT_WAKE).
  produce(woke?: boolean, workout?: boolean): Promise<unknown>;
  // WAKE_BRIEF: how fresh a night's end must be to count as the owner just waking. Absent, a sync never says so.
  wakeFreshMs?: number;
  // WORKOUT_WAKE: present, a sync or hint that commits a workout that just ended says so. Absent, none does.
  workoutWake?: true;
  arm(at: number): Promise<void>;
  disarm(): Promise<void>;
  log(line: ProviderLog<Source>): void;
}>;

export type ProviderCall = (method: 'GET' | 'DELETE', path: string, query?: Readonly<Record<string, string>>) => Promise<EdgeReply>;
export type ProviderPage<T> = Readonly<{ records: readonly T[]; next: string | null; dropped: number }>;
export type Collect = <T>(fetchPage: (next: string | null) => Promise<ProviderPage<T>>) => Promise<T[]>;
export type Guard = <T>(work: () => Promise<T>) => Promise<T>;
// What differs between providers. window: every sample for [from, to), fetched with the owner's token through api.
export type ProviderSpec<Config, Api, Source extends string> = Readonly<{
  source: Source;
  scopes: string;
  pins(config: Config): ClientPins;
  startUrl(config: Config, state: string, handoff: string): string;
  newState(): string;
  client(call: ProviderCall): Api;
  // The milliseconds to wait when the provider itself answered with a rate limit; null for any other error.
  rateLimitMs(error: unknown): number | null;
  window(api: Api, range: Readonly<{ from: number; to: number }>, io: Readonly<{ collect: Collect; guard: Guard }>): Promise<readonly HealthSampleV1[]>;
  // Ends the owner's sharing at the provider, where the provider has a call for it beyond revoking the token.
  revokeAtProvider?(api: Api): Promise<boolean>;
}>;

export type GrantPurpose = 'storage_compute' | 'model_processing';
// consent_required names the grants that are not live, so the owner is sent to exactly those.
export type ConnectResult = Readonly<{ authorize_url: string; expires_at: number }> | Readonly<{ error: 'not_configured' | 'unavailable' }> | Readonly<{ error: 'consent_required'; missing: readonly GrantPurpose[] }>;
export type ExchangeResult = 'linked' | 'denied' | 'already_linked' | 'consent_required' | 'failed';
export type ProviderState = 'not_connected' | 'connected' | 'needs_reconnect' | 'consent_required';
export type SyncResult = 'idle' | 'synced' | 'needs_reconnect' | 'consent_required' | 'rate_limited' | 'failed';
export type HintResult = 'handled' | 'duplicate' | 'ignored' | 'needs_reconnect' | 'consent_required' | 'rate_limited' | 'failed';

// The owner must connect again: the provider no longer accepts the saved access.
class NeedsReconnect extends Error {}
class ConsentGone extends Error {}
class RateLimited extends Error { constructor(readonly afterMs: number) { super('rate limited'); } }
class Failed extends Error {}

// What the object keeps of a connection: the edge's id for it, the provider's account id, the version of the token last
// used (so a refresh can say which token failed), when that token lapses, and when the owner connected (absent on a
// connection made before Waldo recorded it). Never a token.
type Conn = Readonly<{ id: string; account: string; version: string; expires_at: number | null; linked_at?: number }>;
type Cursor = Readonly<{ backfilled: boolean; next_from: number | null; last_sync_at: number | null }>;
const FRESH: Cursor = { backfilled: false, next_from: null, last_sync_at: null };

const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const record = (value: unknown): Record<string, unknown> | null => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);

export const providerOwner = <Config, Api, Source extends string>(deps: ProviderOwnerDeps<Config, Source>, spec: ProviderSpec<Config, Api, Source>) => {
  const { kv } = deps, { source } = spec;
  const key = (name: string) => `${source}:${name}`;
  const log = (ok: boolean, code: string) => deps.log({ hop: source, ok, code });
  const doName = () => deps.doName();
  const connection = (): Conn | null => kv.get<Conn>(key('conn')) ?? null;
  const cursor = (): Cursor => ({ ...FRESH, ...(kv.get<Cursor>(key('cursor')) ?? {}) });
  const rpc = async (fn: string, message: string, args: Record<string, string | number>): Promise<unknown> => {
    if (!deps.rpc) throw new Failed('no database');
    return deps.rpc(fn, message, { p_do_name: doName(), ...args });
  };

  // ---- Tokens: the edge's. This object passes a connection id and a version ----
  const proxy = deps.proxy, config = deps.config;
  const reconnecting = () => kv.get<boolean>(key('reconnect')) === true;
  const needReconnect = (): NeedsReconnect => { kv.put(key('reconnect'), true); return new NeedsReconnect('reconnect'); };
  const remember = (conn: Conn): Conn => { kv.put(key('conn'), conn); return conn; };
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
  // A request to the provider through the edge. A token about to lapse is refreshed first; one the edge reports expired or
  // refused is refreshed once and the request tried once more. A second refusal means the owner revoked access.
  const call: ProviderCall = async (method, path, query) => {
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
  const api = spec.client(call);
  // The provider's own answers: a rate limit waits for its window to reset.
  const guard: Guard = async <T>(work: () => Promise<T>): Promise<T> => {
    try { return await work(); }
    catch (error) { const wait = spec.rateLimitMs(error); if (wait !== null) throw new RateLimited(wait); throw error; }
  };

  // ---- Consent: the database's answer, read before each connect and sync ----
  // The provider's express authorization for storing its data and using it with AI is the owner's two grants for this
  // source. Both must be live to connect and to sync; the database separately refuses readings without storage.
  const consents = async (): Promise<Readonly<{ storage: boolean; model: boolean; epoch: number }> | null> => {
    const answer = record(await invokeHealth(deps.rpc, doName(), 'consent_list', '{}'));
    const rows = Array.isArray(answer?.consents) ? answer!.consents.map(record) : null;
    if (!rows) return null;
    const live = (purpose: string) => rows.find(row => row?.source === source && row.purpose === purpose && row.status === 'granted');
    const storage = live('storage_compute');
    return { storage: Boolean(storage), model: Boolean(live('model_processing')), epoch: typeof storage?.epoch === 'number' ? storage.epoch : 0 };
  };
  const missingGrants = (grants: Readonly<{ storage: boolean; model: boolean }>): GrantPurpose[] => [...(grants.storage ? [] : ['storage_compute' as const]), ...(grants.model ? [] : ['model_processing' as const])];

  // ---- Ingest: the app's own signed write, in batches the contract accepts ----
  type Deletion = Readonly<{ sample_id: string; revision: number }>;
  type Staged = Readonly<{ samples: readonly HealthSampleV1[]; deletions: readonly Deletion[] }>;
  // pass.woke / pass.workout: whether this pass committed a night or a workout that just ended; only the yes leaves this
  // object, never the time, sport or detail.
  type Pass = { woke: boolean; workout: boolean };
  const ingest = async (staged: Staged, epoch: number, pass: Pass): Promise<number> => {
    const samples = staged.samples.filter(sample => healthSampleV1Schema.safeParse(sample).success);
    if (samples.length !== staged.samples.length) log(false, 'sample_dropped');
    let committed = 0;
    const changes = [...samples.map(sample => ({ sample })), ...staged.deletions.map(deletion => ({ deletion }))];
    for (let at = 0; at < changes.length; at += BATCH_MAX) {
      const slice = changes.slice(at, at + BATCH_MAX);
      const batchSamples = slice.flatMap(change => 'sample' in change ? [change.sample] : []);
      const batchDeletions = slice.flatMap(change => 'deletion' in change ? [change.deletion] : []);
      // The same changes always make the same request id, so a retry is a replay the database answers, never a second write.
      const id = `${source}-${md5Hex(slice.map(change => 'sample' in change ? `${change.sample.sample_id}@${change.sample.revision}` : `${change.deletion.sample_id}@${change.deletion.revision}x`).sort().join('|'))}`;
      const send = (consentEpoch: number) => invokeHealth(deps.rpc, doName(), 'ingest', JSON.stringify({
        request_id: id, source, consent_epoch: consentEpoch, timezone: deps.timezone(), anchor_before: null, anchor_after: `${source}:${id}`, samples: batchSamples, deletions: batchDeletions,
      }));
      let answer = record(await send(epoch));
      if (answer?.error === 'epoch_conflict') { const fresh = await consents(); if (!fresh?.storage) throw new ConsentGone(); answer = record(await send(fresh.epoch)); }
      if (answer?.error === 'consent_required' || answer?.error === 'consent_withdrawn') throw new ConsentGone();
      const receipt = healthIngestReceiptV1Schema.safeParse(answer);
      if (!receipt.success) throw new Failed('ingest refused');
      if (!receipt.data.replayed) committed += receipt.data.accepted + receipt.data.deleted;
    }
    if (committed > 0 && deps.wakeFreshMs !== undefined && sleepJustEnded(samples, deps.now(), deps.wakeFreshMs)) pass.woke = true;
    if (committed > 0 && deps.workoutWake && workoutJustEnded(samples, deps.now())) pass.workout = true;
    return committed;
  };

  const classify = (error: unknown): SyncResult => {
    if (error instanceof NeedsReconnect) return 'needs_reconnect';
    if (error instanceof ConsentGone) return 'consent_required';
    if (error instanceof RateLimited) return 'rate_limited';
    return 'failed';
  };

  // ---- Sync: a month back on connect, the last days on every later pass ----
  const collect: Collect = async <T>(fetchPage: (next: string | null) => Promise<ProviderPage<T>>): Promise<T[]> => {
    const out: T[] = [];
    let next: string | null = null;
    for (let pages = 0; pages < PAGE_LIMIT; pages += 1) {
      const page: ProviderPage<T> = await guard(() => fetchPage(next));
      out.push(...page.records);
      if (page.dropped) log(false, 'record_dropped');
      if (!page.next) return out;
      next = page.next;
    }
    return out;
  };

  const finish = async (result: SyncResult, code: string, next: number | null): Promise<SyncResult> => {
    log(result === 'synced' || result === 'idle', code);
    // The entry is a daily interval, so the scheduler keeps it armed after this run; a sooner `next` is a retry, and no `next` ends it.
    if (next !== null) await deps.arm(next);
    else await deps.disarm();
    return result;
  };

  // A hint can name changes older than the daily reconcile reaches; the next pass then starts from the oldest of them,
  // never further back than the first backfill.
  const markDirty = (from: number) => {
    const earlier = Math.max(from, deps.now() - BACKFILL_DAYS * DAY_MS), current = kv.get<number>(key('dirty_from'));
    if (current === undefined || earlier < current) kv.put(key('dirty_from'), earlier);
  };

  const sync = async (): Promise<SyncResult> => {
    const conn = connection();
    if (!conn || !proxy) return 'idle';
    const started = deps.now();
    let progress = cursor();
    let changed = 0;
    const pass: Pass = { woke: false, workout: false };
    const dirty = kv.get<number>(key('dirty_from'));
    try {
      const consent = await consents();
      if (!consent) return await finish('failed', 'consent_unreadable', started + RETRY_MS);
      if (missingGrants(consent).length > 0) return await finish('consent_required', 'consent_required', started + SYNC_EVERY_MS);
      const windows: [number, number][] = [];
      const first = progress.backfilled ? Math.min(started - RECONCILE_DAYS * DAY_MS, dirty ?? Infinity) : progress.next_from ?? started - BACKFILL_DAYS * DAY_MS;
      for (let from = first; from < started; from += WINDOW_DAYS * DAY_MS) windows.push([from, Math.min(from + WINDOW_DAYS * DAY_MS, started)]);
      for (const [from, to] of windows) {
        const samples = await spec.window(api, { from, to }, { collect, guard });
        changed += await ingest({ samples, deletions: [] }, consent.epoch, pass);
        // A committed window is never fetched again, so a failure later in the month resumes where it stopped.
        if (!progress.backfilled) { progress = { ...progress, next_from: to }; kv.put(key('cursor'), progress); }
      }
      kv.put(key('cursor'), { backfilled: true, next_from: null, last_sync_at: started });
      // A hint that arrived during this pass keeps its mark for the next one.
      if (dirty !== undefined && kv.get<number>(key('dirty_from')) === dirty) kv.delete(key('dirty_from'));
      if (changed > 0) await deps.produce(pass.woke, pass.workout).catch(() => log(false, 'produce_failed'));
      return await finish('synced', 'synced', started + SYNC_EVERY_MS);
    } catch (error) {
      if (changed > 0) await deps.produce(pass.woke, pass.workout).catch(() => undefined);
      const result = classify(error);
      // Committed pages stay committed; nothing is zero-filled for the rest. A reconnect or a consent waits for the owner.
      return finish(result, result === 'failed' ? 'failed' : result, result === 'rate_limited' ? started + (error as RateLimited).afterMs : result === 'failed' ? started + RETRY_MS : result === 'consent_required' ? started + SYNC_EVERY_MS : null);
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
      const state = spec.newState(), hash = await sha256(state), handoff = await newHandoff();
      const session = await rpc('connect_session_issue_handoff', `connsess.issue_handoff.${doName()}.${source}.${CHANNEL}.${hash}.${handoff.hash}`, { p_provider: source, p_channel: CHANNEL, p_ticket_hash: hash, p_handoff_hash: handoff.hash });
      if (typeof session !== 'string') return { error: 'unavailable' };
      return { authorize_url: spec.startUrl(config, state, handoff.code), expires_at: deps.now() + HANDOFF_CODE_TTL_MS };
    } catch { return { error: 'unavailable' }; }
  };

  const exchange = async (input: Readonly<{ code: string | null; denied: boolean }>): Promise<ExchangeResult> => {
    if (!config || !proxy || input.denied || !input.code) return input.denied || !input.code ? 'denied' : 'failed';
    try {
      // The grants can be withdrawn between starting a connection and returning from the provider; the code is then left unused.
      const grants = await consents();
      if (!grants) return 'failed';
      if (missingGrants(grants).length > 0) return 'consent_required';
      const linked = await proxy.exchange(doName(), source, spec.pins(config), input.code, { scope: spec.scopes });
      const previous = connection();
      // One account per owner and provider: a different account replaces the old connection, whose saved access is dropped.
      if (previous && previous.id !== linked.id) await proxy.revoke(doName(), previous.id).catch(() => undefined);
      remember({ id: linked.id, account: linked.account, version: linked.version, expires_at: linked.expires_at ?? null, linked_at: deps.now() });
      kv.put(key('cursor'), FRESH);
      kv.delete(key('reconnect'));
      kv.delete(key('dirty_from'));
      await deps.arm(deps.now());
      log(true, 'linked');
      return 'linked';
    } catch (error) {
      const code = error instanceof OAuthProxyError ? error.failure.code : 'failed';
      log(false, `exchange_${code}`);
      return code === 'account_linked' ? 'already_linked' : 'failed';
    }
  };

  // A directory or consent read that fails reads as connected for the health routes; strict callers get the failure instead,
  // so they never show a state Waldo could not check.
  const status = async (strict = false): Promise<Readonly<{ provider: Source; state: ProviderState; last_sync_at: string | null }>> => {
    const last = cursor().last_sync_at;
    const last_sync_at = last === null ? null : new Date(last).toISOString();
    const conn = connection();
    if (!conn) return { provider: source, state: 'not_connected', last_sync_at };
    try {
      const listed = await rpc('connection_list', `connlist.${doName()}`, {});
      const row = Array.isArray(listed) ? listed.map(record).find(item => item?.id === conn.id) : null;
      if (!row) return { provider: source, state: 'not_connected', last_sync_at };
      if (row.status === 'failing' || reconnecting()) return { provider: source, state: 'needs_reconnect', last_sync_at };
      const consent = await consents();
      return { provider: source, state: consent && missingGrants(consent).length === 0 ? 'connected' : 'consent_required', last_sync_at };
    } catch (error) { if (strict) throw error; return { provider: source, state: 'connected', last_sync_at }; }
  };

  // The saved access is removed whether or not the provider confirms. What it has already shared stays stored until the
  // owner withdraws storage consent for this source, as for every source.
  const disconnect = async (): Promise<Readonly<{ revoked_at_provider: boolean }>> => {
    const conn = connection();
    let revoked = false;
    if (conn && proxy) {
      if (spec.revokeAtProvider) { try { revoked = await guard(() => spec.revokeAtProvider!(api)); } catch { revoked = false; } }
      try { await proxy.revoke(doName(), conn.id); } catch { /* the owner disconnects again; the edge refuses a call on a connection it no longer holds */ }
    }
    for (const name of ['conn', 'cursor', 'reconnect', 'dirty_from']) kv.delete(key(name));
    for (const [seen] of [...kv.list<number>({ prefix: key('seen:') })]) kv.delete(seen);
    await deps.disarm();
    log(true, 'disconnected');
    return { revoked_at_provider: revoked };
  };

  const connectedAt = (): number | null => connection()?.linked_at ?? null;
  // Whether this Worker can start a connection at all: the client id and redirect, and an edge to hold the tokens.
  const configured = (): boolean => config !== null && proxy !== null;

  // What a provider's webhook hint works with: the same token path, consent read, ingest and error classes as a sync.
  const kit = { api, key, log, connection, hasProxy: () => proxy !== null, consents, missingGrants, ingest, guard, classify, markDirty, produce: deps.produce, now: deps.now, arm: deps.arm, kv };
  return { owner: { connect, exchange, status, connectedAt, configured, disconnect, sync }, kit };
};
export type ProviderKit<Api> = ReturnType<typeof providerOwner<unknown, Api, string>>['kit'];
