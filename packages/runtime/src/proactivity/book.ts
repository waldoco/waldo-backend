import { notificationAllowed, processingAllowed, validatePolicy } from './windows';
import { ProactivityConflict, type Coverage, type Delivery, type FreshCheck, type Observation, type ProactivityPolicy, type SourceAccess, type SourceKey, type SourceRef, type Sweep, type Watch, type WatchWake, type ProactiveDecision } from './types';

type Sql = Pick<SqlStorage, 'exec'>;
type Deps = Readonly<{ ownerKey: string; now(): number; newId(): string; transaction<T>(work: () => T): T }>;
type JsonRow = { value: string };
const key = (source: SourceKey) => JSON.stringify([source.source, source.accountId, source.collection]);
const sameKey = (left: SourceKey, right: SourceKey) => key(left) === key(right);
const validString = (value: string) => typeof value === 'string' && value.length > 0 && value.length <= 2048;
const assertKey = (value: SourceKey) => {
  if (!['mail', 'calendar', 'tasks', 'drive', 'workspace', 'web', 'conversation'].includes(value.source) || !validString(value.accountId) || !validString(value.collection)) throw new ProactivityConflict('invalid_input');
};
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;
const future = (value: number) => Number.isSafeInteger(value) && value >= 0;
const assertCondition = (condition: Watch['condition']) => {
  if (!condition || !['clock', 'cadence', 'event', 'source_change'].includes(condition.kind)
    || condition.kind === 'cadence' && (!positive(condition.intervalMs) || condition.intervalMs < 60_000)
    || condition.kind === 'clock' && !future(condition.at)
    || condition.kind === 'source_change' && (!Array.isArray(condition.resourceIds) || condition.resourceIds.length > 1000 || condition.resourceIds.some(id => !validString(id)))
    || condition.kind === 'event' && (!['message', 'document', 'location'].includes(condition.eventType) || condition.resourceId !== null && !validString(condition.resourceId))) throw new ProactivityConflict('invalid_input');
};

// All rows live in the existing owner DO. No source bodies, health readings, credentials or
// grants are copied here; references point back to their existing custody. Host OAuth/identity
// admission remains authoritative and is rechecked by the runner across every async boundary.
export function createProactivityBook(sql: Sql, deps: Deps) {
  if (!validString(deps.ownerKey)) throw new ProactivityConflict('invalid_input');
  for (const table of ['policy', 'access', 'sweep', 'coverage', 'observation', 'watch', 'wake', 'delivery']) sql.exec(`CREATE TABLE IF NOT EXISTS owner_proactivity_${table} (owner_key TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(owner_key, id))`);
  const read = <T>(table: string, id: string): T | null => {
    const row = sql.exec<JsonRow>(`SELECT value FROM owner_proactivity_${table} WHERE owner_key = ? AND id = ?`, deps.ownerKey, id).toArray()[0];
    return row ? JSON.parse(row.value) as T : null;
  };
  const put = (table: string, id: string, value: unknown) => sql.exec(`INSERT INTO owner_proactivity_${table}(owner_key, id, value) VALUES (?, ?, ?) ON CONFLICT(owner_key, id) DO UPDATE SET value = excluded.value`, deps.ownerKey, id, JSON.stringify(value));
  const all = <T>(table: string): T[] => sql.exec<JsonRow>(`SELECT value FROM owner_proactivity_${table} WHERE owner_key = ? ORDER BY id`, deps.ownerKey).toArray().map(row => JSON.parse(row.value) as T);
  const defaultPolicy = (): ProactivityPolicy => ({ revision: 1, enabled: true, timezone: 'UTC', volume: 'normal', followups: true, processingWindows: [], notificationWindows: [], quietHours: null });
  const policy = (): ProactivityPolicy => read<ProactivityPolicy>('policy', 'owner') ?? defaultPolicy();
  const accountPolicy = (accountId: string): ProactivityPolicy => read<ProactivityPolicy>('policy', JSON.stringify(['account', accountId])) ?? { ...policy(), revision: 1 };
  const sourcePolicy = (source: SourceKey): ProactivityPolicy => read<ProactivityPolicy>('policy', key(source)) ?? { ...accountPolicy(source.accountId), revision: 1 };
  const regimes = (source: SourceKey) => [policy(), accountPolicy(source.accountId), sourcePolicy(source)];
  const access = (source: SourceKey) => read<SourceAccess>('access', key(source));
  const sourceCurrent = (source: SourceKey & { epoch: number }) => {
    const current = access(source);
    return current?.connected === true && current.epoch === source.epoch;
  };
  const assertSources = (sources: readonly (SourceKey & { epoch: number })[]) => {
    if (sources.some(source => !sourceCurrent(source))) throw new ProactivityConflict('source_revoked');
  };
  const observationId = (ref: Pick<SourceRef, 'source' | 'accountId' | 'collection' | 'resourceId'>) => JSON.stringify([key(ref), ref.resourceId]);
  const observations = (source?: SourceKey) => all<Observation>('observation').filter(row => !source || sameKey(source, row));
  const observe = (value: Observation) => {
    assertKey(value);
    if (!validString(value.resourceId) || !validString(value.revision) || !future(value.observedAt) || typeof value.deleted !== 'boolean' || value.contentRef !== null && !validString(value.contentRef)) throw new ProactivityConflict('invalid_input');
    const id = observationId(value), previous = read<Observation>('observation', id);
    if (previous && previous.observedAt > value.observedAt) return false;
    if (previous && previous.observedAt === value.observedAt && previous.revision !== value.revision) throw new ProactivityConflict('stale_source');
    put('observation', id, value);
    return !previous || previous.revision !== value.revision || previous.deleted !== value.deleted;
  };
  const fresh = (watch: Watch, check: FreshCheck, maxAgeMs: number): boolean => {
    const now = deps.now();
    return check.status === 'open' && check.coverage === 'complete' && check.evidenceRefs.length > 0
      && check.responsibilityRevision === watch.responsibilityRevision && check.audience === watch.audience
      && check.checkedAt <= now && check.checkedAt >= now - maxAgeMs
      && watch.sources.every(source => check.refs.some(ref => sameKey(source, ref)))
      && check.refs.every(ref => watch.sources.some(source => sameKey(source, ref)) && (() => {
        const current = read<Observation>('observation', observationId(ref));
        return current?.deleted === false && current.revision === ref.revision;
      })());
  };
  const currentWatch = (id: string): Watch | null => read<Watch>('watch', id);
  const active = (watch: Watch): boolean => watch.state === 'active' && (watch.expiresAt === null || watch.expiresAt > deps.now()) && watch.sources.every(sourceCurrent);
  const notificationPermitted = (value: ProactivityPolicy) => value.volume !== 'low' && value.followups !== false && notificationAllowed(value, deps.now());
  const deliveryAllowed = (delivery: Delivery) => notificationPermitted(policy()) && delivery.sources.every(source => regimes(source).every(notificationPermitted));
  const blockWatchDeliveries = (watchId: string, reason: string) => {
    for (const delivery of all<Delivery>('delivery')) {
      if (delivery.watchId !== watchId || ['delivered', 'silent', 'blocked'].includes(delivery.state)) continue;
      put('delivery', delivery.id, { ...delivery, state: delivery.state === 'sending' || delivery.state === 'unknown' ? 'unknown' : 'blocked', reason });
    }
    for (const wake of all<WatchWake>('wake')) if (wake.watchId === watchId && ['pending', 'checking'].includes(wake.state)) put('wake', wake.id, { ...wake, state: 'blocked' });
  };
  return {
    ownerKey: deps.ownerKey,
    policy,
    sourcePolicy, accountPolicy,
    updateAccountPolicy(accountId: string, expectedRevision: number, next: Omit<ProactivityPolicy, 'revision'>): ProactivityPolicy {
      if (!validString(accountId)) throw new ProactivityConflict('invalid_input');
      if (accountPolicy(accountId).revision !== expectedRevision) throw new ProactivityConflict('stale_revision');
      const updated = { ...next, revision: expectedRevision + 1 }; validatePolicy(updated);
      put('policy', JSON.stringify(['account', accountId]), updated); return updated;
    },
    synchronizeOwnerPreferences(next: Pick<ProactivityPolicy, 'timezone' | 'quietHours' | 'volume' | 'followups'>): void {
      const current = policy();
      if (JSON.stringify([current.timezone, current.quietHours, current.volume ?? 'normal', current.followups ?? true]) === JSON.stringify([next.timezone, next.quietHours, next.volume ?? 'normal', next.followups ?? true])) return;
      const updated = { ...current, ...next, revision: current.revision + 1 }; validatePolicy(updated); put('policy', 'owner', updated);
    },
    processingRegime(source: SourceKey): string {
      // Notification timing cannot grant content access. Only the read policy belongs in this fence.
      return JSON.stringify(regimes(source).map(value => [value.enabled, value.followups ?? true, value.timezone, value.processingWindows]));
    },
    accountProcessingAllowed(accountId: string): boolean { return [policy(), accountPolicy(accountId)].every(value => value.followups !== false && processingAllowed(value, deps.now())); },
    accountProcessingRegime(accountId: string): string { return JSON.stringify([policy(), accountPolicy(accountId)].map(value => [value.enabled, value.followups ?? true, value.timezone, value.processingWindows])); },
    discoveryAllowed(): boolean { return policy().followups !== false && processingAllowed(policy(), deps.now()); },
    updatePolicy(expectedRevision: number, next: Omit<ProactivityPolicy, 'revision'>, source?: SourceKey): ProactivityPolicy {
      if (source) assertKey(source);
      const current = source ? sourcePolicy(source) : policy();
      if (current.revision !== expectedRevision) throw new ProactivityConflict('stale_revision');
      const updated = { ...next, revision: expectedRevision + 1 }; validatePolicy(updated);
      put('policy', source ? key(source) : 'owner', updated);
      return updated;
    },
    access,
    sourceAccess(): readonly SourceAccess[] { return all<SourceAccess>('access'); },
    setSourceAccess(next: SourceAccess): void {
      assertKey(next);
      if (!positive(next.epoch) || typeof next.connected !== 'boolean') throw new ProactivityConflict('invalid_input');
      deps.transaction(() => {
        const previous = access(next);
        if (previous && next.epoch < previous.epoch) throw new ProactivityConflict('stale_revision');
        if (previous && next.epoch === previous.epoch && !previous.connected && next.connected) throw new ProactivityConflict('source_revoked');
        put('access', key(next), next);
        if (!next.connected || previous && previous.epoch !== next.epoch) {
          for (const watch of all<Watch>('watch')) if (watch.sources.some(source => sameKey(source, next)) && watch.state !== 'satisfied' && watch.state !== 'cancelled') {
            put('watch', watch.id, { ...watch, revision: watch.revision + 1, state: 'cancelled', closureRef: 'source_access_changed' });
            blockWatchDeliveries(watch.id, 'source_access_changed');
          }
          for (const sweep of all<Sweep>('sweep')) if (sameKey(sweep, next) && sweep.state === 'running') put('sweep', sweep.id, { ...sweep, state: 'invalidated', revision: sweep.revision + 1 });
          sql.exec('DELETE FROM owner_proactivity_coverage WHERE owner_key = ? AND id = ?', deps.ownerKey, key(next));
          for (const row of observations(next)) sql.exec('DELETE FROM owner_proactivity_observation WHERE owner_key = ? AND id = ?', deps.ownerKey, observationId(row));
        }
      });
    },
    processingAllowed(source: SourceKey): boolean { return regimes(source).every(value => value.followups !== false && processingAllowed(value, deps.now())); },
    beginSweep(source: SourceKey, epoch: number, mode: Sweep['mode'] = 'changes'): Sweep {
      assertKey(source); assertSources([{ ...source, epoch }]);
      if (!this.processingAllowed(source)) throw new ProactivityConflict('not_available');
      const existing = all<Sweep>('sweep').find(sweep => sameKey(sweep, source) && sweep.epoch === epoch && sweep.state === 'running');
      if (existing) return existing;
      const coverage = read<Coverage>('coverage', key(source));
      const sweep: Sweep = { ...source, id: deps.newId(), epoch, revision: 1, mode: coverage?.epoch === epoch && mode === 'changes' ? 'changes' : 'baseline', state: 'running', cursor: mode === 'changes' && coverage?.epoch === epoch ? coverage.cursor : null, pageToken: null, startedAt: deps.now(), completedAt: null, applied: 0 };
      put('sweep', sweep.id, sweep); return sweep;
    },
    sweep(id: string): Sweep | null { return read<Sweep>('sweep', id); },
    coverage(source: SourceKey): Coverage | null { return read<Coverage>('coverage', key(source)); },
    applyPage(id: string, expectedRevision: number, page: Readonly<{ observations: readonly Observation[]; nextPageToken: string | null; nextCursor: string | null }>): Sweep {
      return deps.transaction(() => {
        const sweep = read<Sweep>('sweep', id);
        if (!sweep || sweep.state !== 'running' || sweep.revision !== expectedRevision) throw new ProactivityConflict('stale_revision');
        assertSources([sweep]);
        if (!this.processingAllowed(sweep)) throw new ProactivityConflict('not_available');
        if (page.observations.length > 1000 || page.observations.some(row => !sameKey(row, sweep)) || page.nextPageToken !== null && (!validString(page.nextPageToken) || page.nextPageToken === sweep.pageToken) || page.nextCursor !== null && !validString(page.nextCursor)) throw new ProactivityConflict('invalid_input');
        for (const row of page.observations) if (observe(row)) {
          for (const watch of all<Watch>('watch')) if (active(watch) && watch.condition.kind === 'source_change'
            && watch.sources.some(source => sameKey(source, row))
            && (watch.condition.resourceIds.length === 0 || watch.condition.resourceIds.includes(row.resourceId))) {
            this.wake(watch.id, JSON.stringify(['source', row.source, row.accountId, row.collection, row.resourceId, row.revision, row.deleted]), row.observedAt);
          }
        }
        const complete = page.nextPageToken === null;
        const next: Sweep = { ...sweep, revision: sweep.revision + 1, pageToken: page.nextPageToken, applied: sweep.applied + page.observations.length, state: complete ? 'complete' : 'running', completedAt: complete ? deps.now() : null };
        put('sweep', id, next);
        // A partial page never advances a source cursor; failed application rolls back all rows.
        if (complete) put('coverage', key(sweep), { source: sweep.source, accountId: sweep.accountId, collection: sweep.collection, epoch: sweep.epoch, cursor: page.nextCursor, completedAt: deps.now(), applied: next.applied } satisfies Coverage);
        return next;
      });
    },
    invalidateCursor(id: string, expectedRevision: number): void {
      deps.transaction(() => {
        const sweep = read<Sweep>('sweep', id);
        if (!sweep || sweep.revision !== expectedRevision) throw new ProactivityConflict('stale_revision');
        put('sweep', id, { ...sweep, state: 'invalidated', revision: sweep.revision + 1 });
        sql.exec('DELETE FROM owner_proactivity_coverage WHERE owner_key = ? AND id = ?', deps.ownerKey, key(sweep));
      });
    },
    observations,
    observeFresh(values: readonly Observation[]): void { deps.transaction(() => { for (const value of values) { if (!access(value)?.connected) throw new ProactivityConflict('source_revoked'); observe(value); } }); },
    createWatch(input: Omit<Watch, 'id' | 'revision' | 'state' | 'createdAt' | 'closureRef'>): Watch {
      if (!validString(input.responsibilityId) || !validString(input.audience) || !positive(input.responsibilityRevision) || !future(input.nextCheckAt) || input.expiresAt !== null && (!future(input.expiresAt) || input.expiresAt <= deps.now()) || input.sources.length > 32) throw new ProactivityConflict('invalid_input');
      for (const source of input.sources) assertKey(source);
      assertSources(input.sources);
      assertCondition(input.condition);
      if (input.subscription && (!validString(input.subscription.id) || input.subscription.renewAt > input.subscription.expiresAt || input.subscription.expiresAt <= deps.now())) throw new ProactivityConflict('invalid_input');
      const watch: Watch = { ...input, id: deps.newId(), revision: 1, state: 'active', createdAt: deps.now(), closureRef: null };
      put('watch', watch.id, watch); return watch;
    },
    watch: currentWatch,
    watches(): readonly Watch[] { return all<Watch>('watch'); },
    controlWatch(id: string, expectedRevision: number, action: 'pause' | 'resume' | 'cancel' | 'complete', closureRef: string | null = null): Watch {
      return deps.transaction(() => {
        const current = currentWatch(id);
        if (!current || current.revision !== expectedRevision) throw new ProactivityConflict('stale_revision');
        if (['cancelled', 'expired', 'satisfied'].includes(current.state) || action === 'complete' && !validString(closureRef ?? '')) throw new ProactivityConflict('not_available');
        if (action === 'resume') assertSources(current.sources);
        const next: Watch = { ...current, revision: current.revision + 1, state: action === 'resume' ? 'active' : action === 'pause' ? 'paused' : action === 'cancel' ? 'cancelled' : 'satisfied', closureRef };
        put('watch', id, next); blockWatchDeliveries(id, `watch_${action}`); return next;
      });
    },
    reviseWatch(id: string, expectedRevision: number, change: Pick<Watch, 'responsibilityRevision' | 'audience' | 'condition' | 'nextCheckAt' | 'expiresAt'>): Watch {
      return deps.transaction(() => {
        const current = currentWatch(id);
        if (!current || current.revision !== expectedRevision) throw new ProactivityConflict('stale_revision');
        if (!active(current) || !positive(change.responsibilityRevision) || !validString(change.audience) || !future(change.nextCheckAt) || change.expiresAt !== null && change.expiresAt <= deps.now()) throw new ProactivityConflict('invalid_input');
        assertCondition(change.condition);
        const next = { ...current, ...change, revision: current.revision + 1 };
        put('watch', id, next); blockWatchDeliveries(id, 'watch_corrected'); return next;
      });
    },
    renewSubscription(id: string, expectedRevision: number, subscription: NonNullable<Watch['subscription']>): Watch {
      const current = currentWatch(id);
      if (!current || current.revision !== expectedRevision) throw new ProactivityConflict('stale_revision');
      if (!active(current) || !validString(subscription.id) || !future(subscription.renewAt) || subscription.renewAt > subscription.expiresAt || subscription.expiresAt <= deps.now()) throw new ProactivityConflict('invalid_input');
      const next = { ...current, subscription }; put('watch', id, next); return next;
    },
    subscriptionsDue(): readonly Watch[] { return all<Watch>('watch').filter(watch => active(watch) && watch.subscription !== null && watch.subscription.renewAt <= deps.now()); },
    wake(id: string, eventKey: string, observedAt: number): WatchWake | null {
      const watch = currentWatch(id);
      if (!watch || !active(watch) || typeof eventKey !== 'string' || !eventKey || eventKey.length > 16_384 || !future(observedAt) || observedAt > deps.now() || observedAt < watch.createdAt) return null;
      const wakeId = JSON.stringify([id, watch.revision, eventKey]), previous = read<WatchWake>('wake', wakeId);
      if (previous) return previous;
      const wake: WatchWake = { id: wakeId, watchId: id, watchRevision: watch.revision, eventKey, observedAt, state: 'pending', checkedAt: null, decisionId: null };
      put('wake', wake.id, wake); return wake;
    },
    dueWakes(): readonly WatchWake[] {
      deps.transaction(() => {
        for (const watch of all<Watch>('watch')) {
          if (watch.state === 'active' && watch.expiresAt !== null && watch.expiresAt <= deps.now()) {
            put('watch', watch.id, { ...watch, state: 'expired', revision: watch.revision + 1 }); blockWatchDeliveries(watch.id, 'watch_expired');
          } else if (active(watch) && watch.nextCheckAt <= deps.now() && (watch.condition.kind !== 'clock' || watch.condition.at <= deps.now())) this.wake(watch.id, `fallback:${watch.nextCheckAt}`, deps.now());
        }
      });
      if (!this.discoveryAllowed()) return [];
      return all<WatchWake>('wake').filter(wake => wake.state === 'pending' && (() => { const watch = currentWatch(wake.watchId); return watch && active(watch) && watch.revision === wake.watchRevision && watch.sources.every(source => this.processingAllowed(source)); })());
    },
    claimWake(id: string): WatchWake {
      const wake = read<WatchWake>('wake', id), watch = wake && currentWatch(wake.watchId);
      if (!wake || wake.state !== 'pending' || !watch || !active(watch) || watch.revision !== wake.watchRevision) throw new ProactivityConflict('stale_revision');
      const next = { ...wake, state: 'checking' as const }; put('wake', id, next); return next;
    },
    deferWake(id: string, nextCheckAt: number): void {
      deps.transaction(() => {
        const wake = read<WatchWake>('wake', id), watch = wake && currentWatch(wake.watchId);
        if (!wake || !watch || wake.state !== 'checking' || watch.revision !== wake.watchRevision || !future(nextCheckAt) || nextCheckAt <= deps.now()) throw new ProactivityConflict('stale_revision');
        put('wake', id, { ...wake, state: 'checked', checkedAt: deps.now() }); put('watch', watch.id, { ...watch, nextCheckAt });
      });
    },
    recordDecision(wakeId: string, check: FreshCheck, decision: ProactiveDecision, options: Readonly<{ nextCheckAt: number; expiresAt: number; maxAgeMs?: number }>): Delivery {
      return deps.transaction(() => {
        const wake = read<WatchWake>('wake', wakeId), watch = wake && currentWatch(wake.watchId);
        if (!wake || !watch || !active(watch) || watch.revision !== wake.watchRevision) throw new ProactivityConflict('stale_revision');
        if (wake.decisionId) return read<Delivery>('delivery', wake.decisionId)!;
        if (wake.state !== 'checking') throw new ProactivityConflict('stale_revision');
        assertSources(watch.sources);
        if (!['notify', 'batch', 'silent'].includes(decision.disposition) || decision.rationale.length > 8192 || !validString(decision.rationale) || typeof decision.text !== 'string' || decision.text.length > 64000 || !future(options.nextCheckAt) || options.nextCheckAt <= deps.now() || !future(options.expiresAt) || options.expiresAt <= deps.now()) throw new ProactivityConflict('invalid_input');
        if (decision.disposition !== 'silent' && (!decision.text.trim() || !fresh(watch, check, options.maxAgeMs ?? 60_000))) throw new ProactivityConflict('stale_source');
        const eligibleAt = decision.disposition === 'batch' ? decision.batchAt : deps.now();
        if (eligibleAt === undefined || !future(eligibleAt) || eligibleAt >= options.expiresAt) throw new ProactivityConflict('invalid_input');
        const id = deps.newId();
        const delivery: Delivery = { id, watchId: watch.id, watchRevision: watch.revision, responsibilityId: watch.responsibilityId, responsibilityRevision: watch.responsibilityRevision, audience: watch.audience, sources: watch.sources, refs: check.refs, check, disposition: decision.disposition, rationale: decision.rationale, text: decision.disposition === 'silent' ? '' : decision.text, state: decision.disposition === 'silent' ? 'silent' : 'held', createdAt: deps.now(), eligibleAt, expiresAt: options.expiresAt, attemptedAt: null, deliveredAt: null, receiptRef: null, reason: decision.disposition === 'silent' ? check.status : null };
        put('delivery', id, delivery); put('wake', wake.id, { ...wake, state: 'checked', checkedAt: deps.now(), decisionId: id }); put('watch', watch.id, { ...watch, nextCheckAt: options.nextCheckAt });
        return delivery;
      });
    },
    deliveries(): readonly Delivery[] { return all<Delivery>('delivery'); },
    delivery(id: string): Delivery | null { return read<Delivery>('delivery', id); },
    deliveryCandidates(): readonly Delivery[] {
      return all<Delivery>('delivery').filter(delivery => ['held', 'pending'].includes(delivery.state) && delivery.eligibleAt <= deps.now() && delivery.expiresAt > deps.now() && deliveryAllowed(delivery));
    },
    checkDelivery(id: string, check: FreshCheck, maxAgeMs = 60_000): Delivery {
      const delivery = read<Delivery>('delivery', id), watch = delivery && currentWatch(delivery.watchId);
      if (!delivery || !watch || !['held', 'pending'].includes(delivery.state)) throw new ProactivityConflict('stale_revision');
      if (!active(watch) || watch.revision !== delivery.watchRevision || !sourceCurrentForDelivery(delivery) || delivery.expiresAt <= deps.now() || check.status === 'handled') {
        const blocked: Delivery = { ...delivery, state: 'blocked', reason: check.status === 'handled' ? 'already_handled' : 'current_scope_changed' }; put('delivery', id, blocked); return blocked;
      }
      if (!fresh(watch, check, maxAgeMs) || check.refs.length !== delivery.refs.length || check.refs.some(ref => !delivery.refs.some(previous => sameKey(ref, previous) && ref.resourceId === previous.resourceId && ref.revision === previous.revision))) {
        const blocked: Delivery = { ...delivery, state: 'blocked', reason: 'source_changed' }; put('delivery', id, blocked); return blocked;
      }
      const next: Delivery = { ...delivery, check, state: deliveryAllowed(delivery) ? 'pending' : 'held' }; put('delivery', id, next); return next;
    },
    claimDelivery(id: string, maxAgeMs = 60_000): Delivery {
      const delivery = read<Delivery>('delivery', id), watch = delivery && currentWatch(delivery.watchId);
      if (!delivery || !watch || delivery.state !== 'pending' || !active(watch) || watch.revision !== delivery.watchRevision || !sourceCurrentForDelivery(delivery) || delivery.eligibleAt > deps.now() || delivery.expiresAt <= deps.now() || !deliveryAllowed(delivery) || !fresh(watch, delivery.check, maxAgeMs)) throw new ProactivityConflict('stale_source');
      const next: Delivery = { ...delivery, state: 'sending', attemptedAt: deps.now() }; put('delivery', id, next); return next;
    },
    deliveryReceiptEligible(id: string, check: FreshCheck, maxAgeMs = 60_000): boolean {
      const delivery = read<Delivery>('delivery', id), watch = delivery && currentWatch(delivery.watchId);
      return !!delivery && !!watch && ['sending', 'unknown'].includes(delivery.state) && active(watch) && watch.revision === delivery.watchRevision
        && sourceCurrentForDelivery(delivery) && delivery.expiresAt > deps.now() && deliveryAllowed(delivery) && fresh(watch, check, maxAgeMs)
        && check.refs.length === delivery.refs.length && check.refs.every(ref => delivery.refs.some(previous => sameKey(ref, previous) && ref.resourceId === previous.resourceId && ref.revision === previous.revision));
    },
    settleDelivery(id: string, result: Readonly<{ state: 'delivered' | 'blocked' | 'unknown'; receiptRef?: string; reason?: string }>): Delivery {
      const delivery = read<Delivery>('delivery', id);
      if (!delivery || !['sending', 'unknown', 'delivered'].includes(delivery.state)) throw new ProactivityConflict('stale_revision');
      if (delivery.state === 'delivered') return delivery;
      if (result.state === 'delivered' && !validString(result.receiptRef ?? '')) throw new ProactivityConflict('invalid_input');
      const next: Delivery = { ...delivery, state: result.state, deliveredAt: result.state === 'delivered' ? deps.now() : null, receiptRef: result.receiptRef ?? null, reason: result.reason ?? null }; put('delivery', id, next); return next;
    },
    recover(): void {
      deps.transaction(() => {
        for (const wake of all<WatchWake>('wake')) if (wake.state === 'checking') put('wake', wake.id, { ...wake, state: 'pending' });
        // A lost ACK never licenses another send; existing outbox/provider reconciliation owns it.
        for (const delivery of all<Delivery>('delivery')) {
          if (delivery.state === 'sending') put('delivery', delivery.id, { ...delivery, state: 'unknown', reason: 'interrupted_delivery' });
          else if (['held', 'pending'].includes(delivery.state) && delivery.expiresAt <= deps.now()) put('delivery', delivery.id, { ...delivery, state: 'blocked', reason: 'expired' });
        }
      });
    },
  };
  function sourceCurrentForDelivery(delivery: Delivery): boolean { return delivery.sources.every(sourceCurrent); }
}
export type ProactivityBook = ReturnType<typeof createProactivityBook>;
