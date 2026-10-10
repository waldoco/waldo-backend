import type { ProactivityBook } from './book';
import { ProactivityConflict, SourceCursorExpired, type Coverage, type Delivery, type FreshCheck, type Observation, type ProactiveDecision, type SourceKey, type Sweep, type Watch } from './types';

export type SourceAdmission = Readonly<{ ownerKey: string; epoch: number; connected: boolean; available: boolean }>;
export type ProactivityPorts = Readonly<{
  // Existing identity/OAuth/source policy owns this check. A token temporarily needing
  // reauthentication is connected:true, available:false; it is not a disconnect/forget.
  admit(source: SourceKey, purpose: 'discovery' | 'watch' | 'delivery'): Promise<SourceAdmission>;
  fetchPage(sweep: Sweep): Promise<Readonly<{ observations: readonly Observation[]; nextPageToken: string | null; nextCursor: string | null }>>;
  discovered(coverage: Coverage, observations: readonly Observation[]): Promise<void>;
  checkCurrent(watch: Watch): Promise<Readonly<{ check: FreshCheck; observations: readonly Observation[] }>>;
  decide(watch: Watch, check: FreshCheck): Promise<ProactiveDecision>;
  enqueue(delivery: Delivery): Promise<Readonly<{ state: 'queued' | 'delivered' | 'blocked' | 'unknown'; receiptRef?: string; reason?: string }>>;
  now(): number;
}>;
export type ProactivityCycleResult = Readonly<{ pages: number; discoveries: number; checks: number; queued: number; delivered: number; blocked: number; failures: readonly Readonly<{ stage: 'discovery' | 'watch' | 'delivery'; id: string; code: string }>[] }>;

async function readmit(book: ProactivityBook, ports: ProactivityPorts, source: SourceKey, purpose: 'discovery' | 'watch' | 'delivery', expectedEpoch?: number): Promise<boolean> {
  const current = await ports.admit(source, purpose);
  if (current.ownerKey !== book.ownerKey || !Number.isSafeInteger(current.epoch) || current.epoch < 1) throw new ProactivityConflict('source_revoked');
  book.setSourceAccess({ ...source, epoch: current.epoch, connected: current.connected });
  return current.connected && current.available && (expectedEpoch === undefined || current.epoch === expectedEpoch);
}
async function watchAdmitted(book: ProactivityBook, ports: ProactivityPorts, watch: Watch, purpose: 'watch' | 'delivery'): Promise<boolean> {
  for (const source of watch.sources) if (!await readmit(book, ports, source, purpose, source.epoch)) return false;
  const current = book.watch(watch.id);
  return current?.state === 'active' && current.revision === watch.revision;
}
const code = (error: unknown) => error instanceof ProactivityConflict ? error.code : 'provider_unavailable';

// Waiting is durable state plus bounded wake work. This orchestrator makes no effects/grants:
// model judgment, provider reads and the existing result/outbox adapter are explicit ports.
export async function runProactivityCycle(book: ProactivityBook, ports: ProactivityPorts, sources: readonly SourceKey[], options: Readonly<{ maxPages?: number; maxWakes?: number; maxDeliveries?: number; fallbackMs?: number; deliveryLifetimeMs?: number }> = {}): Promise<ProactivityCycleResult> {
  const totals = { pages: 0, discoveries: 0, checks: 0, queued: 0, delivered: 0, blocked: 0 };
  const failures: { stage: 'discovery' | 'watch' | 'delivery'; id: string; code: string }[] = [];
  const fallback = options.fallbackMs ?? 60 * 60_000, lifetime = options.deliveryLifetimeMs ?? 24 * 60 * 60_000;
  for (const source of sources) {
    let sweep: Sweep | null = null;
    try {
      if (!book.processingAllowed(source) || !await readmit(book, ports, source, 'discovery')) { totals.blocked++; continue; }
      const access = book.access(source)!;
      sweep = book.beginSweep(source, access.epoch);
      for (let page = 0; page < (options.maxPages ?? 4) && sweep.state === 'running'; page++) {
        if (!await readmit(book, ports, source, 'discovery', sweep.epoch)) { totals.blocked++; break; }
        const regime = book.processingRegime(sweep);
        const value = await ports.fetchPage(sweep);
        if (book.processingRegime(sweep) !== regime || !await readmit(book, ports, source, 'discovery', sweep.epoch)) { totals.blocked++; break; }
        sweep = book.applyPage(sweep.id, sweep.revision, value); totals.pages++;
      }
      if (sweep.state === 'complete' && await readmit(book, ports, source, 'discovery', sweep.epoch)) {
        // Accepted page refs and a committed coverage receipt reach the existing model path.
        await ports.discovered(book.coverage(source)!, book.observations(source)); totals.discoveries++;
      }
    } catch (error) {
      if (error instanceof SourceCursorExpired && sweep) book.invalidateCursor(sweep.id, sweep.revision);
      failures.push({ stage: 'discovery', id: sweep?.id ?? source.accountId, code: error instanceof SourceCursorExpired ? 'cursor_expired' : code(error) });
    }
  }
  for (const pending of book.dueWakes().slice(0, options.maxWakes ?? 20)) {
    try {
      const watch = book.watch(pending.watchId)!;
      if (!await watchAdmitted(book, ports, watch, 'watch')) { totals.blocked++; continue; }
      const wake = book.claimWake(pending.id), regime = JSON.stringify(watch.sources.map(source => book.processingRegime(source)));
      const deferIfActive = () => { const latest = book.watch(watch.id); if (latest?.state === 'active' && latest.revision === watch.revision) book.deferWake(pending.id, ports.now() + fallback); };
      const current = await ports.checkCurrent(watch);
      if (!await watchAdmitted(book, ports, watch, 'watch') || JSON.stringify(watch.sources.map(source => book.processingRegime(source))) !== regime) { totals.blocked++; deferIfActive(); continue; }
      book.observeFresh(current.observations); totals.checks++;
      // Provider-explicit completion and incomplete access need no interruption/model wake.
      const decision: ProactiveDecision = current.check.status !== 'open' || current.check.coverage !== 'complete'
        ? { disposition: 'silent', rationale: current.check.status === 'handled' ? 'Current source evidence shows this item was handled.' : 'Current source coverage cannot establish an open obligation.', text: '' }
        : await ports.decide(watch, current.check);
      if (!await watchAdmitted(book, ports, watch, 'watch') || JSON.stringify(watch.sources.map(source => book.processingRegime(source))) !== regime) { totals.blocked++; deferIfActive(); continue; }
      book.recordDecision(wake.id, current.check, decision, { nextCheckAt: ports.now() + fallback, expiresAt: ports.now() + lifetime });
    } catch (error) {
      failures.push({ stage: 'watch', id: pending.watchId, code: code(error) });
      try { book.deferWake(pending.id, ports.now() + fallback); } catch (deferError) { failures.push({ stage: 'watch', id: pending.watchId, code: code(deferError) }); }
    }
  }
  for (const candidate of book.deliveryCandidates().slice(0, options.maxDeliveries ?? 20)) {
    let claimed = false;
    try {
      const watch = book.watch(candidate.watchId)!;
      if (!await watchAdmitted(book, ports, watch, 'delivery')) { totals.blocked++; continue; }
      const current = await ports.checkCurrent(watch);
      if (!await watchAdmitted(book, ports, watch, 'delivery')) { totals.blocked++; continue; }
      book.observeFresh(current.observations);
      const checked = book.checkDelivery(candidate.id, current.check);
      if (checked.state !== 'pending') { totals.blocked++; continue; }
      const frozen = book.claimDelivery(checked.id); claimed = true;
      const result = await ports.enqueue(frozen);
      if (result.state === 'queued') totals.queued++;
      else {
        book.settleDelivery(frozen.id, { ...result, state: result.state });
        if (result.state === 'delivered') totals.delivered++; else totals.blocked++;
      }
    } catch (error) {
      failures.push({ stage: 'delivery', id: candidate.id, code: code(error) });
      if (claimed) book.settleDelivery(candidate.id, { state: 'unknown', reason: 'delivery_outcome_unconfirmed' });
    }
  }
  return { ...totals, failures };
}

// Use at the existing outbox's actual send boundary. A queued draft/result is not an ACK.
// Refuse changed source/responsibility revisions instead of regenerating frozen output.
export async function proactivityDeliveryEligible(book: ProactivityBook, ports: ProactivityPorts, deliveryId: string): Promise<boolean> {
  const delivery = book.delivery(deliveryId), watch = delivery && book.watch(delivery.watchId);
  if (!delivery || !watch || !['sending', 'unknown'].includes(delivery.state) || watch.revision !== delivery.watchRevision || !await watchAdmitted(book, ports, watch, 'delivery')) return false;
  if (delivery.expiresAt <= ports.now()) return false;
  const current = await ports.checkCurrent(watch);
  if (!await watchAdmitted(book, ports, watch, 'delivery')) return false;
  book.observeFresh(current.observations);
  return book.deliveryReceiptEligible(deliveryId, current.check);
}
