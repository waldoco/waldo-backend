import { browserTaskCheckpointSchema, type BrowserTaskCheckpoint, type BrowserCommand } from '@waldo/contracts';
import { ownerPresenceBinding, type PresenceBinding } from '../identity/owner-message-admission';
import type { BrowserSourceGuard } from './public-fixture-browser';
import { armAlarm } from '../scheduler/alarm-slot';
import { browserTaskContinuity, type BrowserTaskDriver } from './browser-task-continuity';

export type BrowserOwnerBinding = PresenceBinding;
type Evidence = Readonly<{ actionDigest?: string; bindingDigest?: string; stateDigest?: string; proposalId?: string; approvalRef?: string }>;
export type BrowserOwnerGrantRequest = Readonly<{ principal: string; tenant: string; doName: string; presence: string; revision: string; task: string; manifest: string; page: string; operation: string; evidence: Evidence }>;
export type BrowserOwnerConfiguration = Readonly<{
  enabled: boolean; binding: BrowserOwnerBinding; manifestDigest: string; driver: BrowserTaskDriver;
  lookup(): Promise<unknown>;
  grant(request: BrowserOwnerGrantRequest): Promise<(BrowserOwnerGrantRequest & Readonly<{ ref: string; expiresAt: number }>) | null>;
}>;
export const BROWSER_TASK_KEY = 'browser_owner_task_v1';
export const BROWSER_TASK_DUE_KEY = 'browser_owner_task_due_v1';
export const BROWSER_TASK_CLEANUP_KEY = 'browser_owner_task_cleanup_v1';
const MAX_CLEANUP_ATTEMPTS = 3;
type CleanupState = Readonly<{ taskId: string; attempts: number; status: 'retry_pending' | 'exhausted' | 'identity_unavailable' | 'driver_unavailable' | 'configuration_mismatch' | 'closed'; at: number }>;
const REVOKED_KEY = 'browser_owner_task_revoked_v1';
const locks = new WeakMap<DurableObjectStorage, Promise<unknown>>();
export function browserOwnerHost(options: Readonly<{
  storage: DurableObjectStorage; config?: BrowserOwnerConfiguration;
  physical(): Readonly<{ doName: string | undefined; subject: string | undefined; matches: boolean }>;
  approved(approval: string, proposal: string): boolean;
  now(): number; newId(): string;
}>) {
  const config = options.config ? Object.freeze({ ...options.config, binding: Object.freeze({ ...options.config.binding }), driver: Object.freeze({ ...options.config.driver }) }) : undefined;
  const binding = config ? Object.freeze({ ...config.binding }) : null;
  const principal = binding ? `prn_${binding.owner_id.replaceAll('-', '').toLowerCase()}` : '';
  const tenant = binding ? `ten_${binding.owner_id.replaceAll('-', '').toLowerCase()}` : '';
  const current = async () => {
    if (!config || !binding || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(binding.owner_id)) return false;
    try { const page = new URL(config.driver.pageUrl); if (page.protocol !== 'https:' || page.origin !== config.driver.origin || page.username || page.password) return false; } catch { return false; }
    const physical = options.physical();
    if (!physical.matches || physical.doName !== binding.do_name || physical.subject !== binding.subject) return false;
    let resolved: unknown;
    try { resolved = await config.lookup(); } catch { return false; }
    try { const row = ownerPresenceBinding(resolved); return Object.keys(binding).every(key => row[key as keyof PresenceBinding] === binding[key as keyof PresenceBinding]); } catch { return false; }
  };
  const exclusive = async <T>(work: () => Promise<T>) => {
    const next = (locks.get(options.storage) ?? Promise.resolve()).then(work);
    locks.set(options.storage, next.catch(() => undefined)); return next;
  };
  const save = async (value: BrowserTaskCheckpoint) => {
    const record = browserTaskCheckpointSchema.parse(value);
    const cleanup = await options.storage.get<CleanupState>(BROWSER_TASK_CLEANUP_KEY);
    const lost = record.phase === 'cleanup_pending' && record.session.providerSessionId === 'pending';
    if (lost) await options.storage.put(BROWSER_TASK_CLEANUP_KEY, { taskId: record.taskId, attempts: 0, status: 'identity_unavailable', at: options.now() });
    const exhausted = cleanup?.status === 'exhausted' || (cleanup?.attempts ?? 0) >= MAX_CLEANUP_ATTEMPTS;
    const due = record.phase === 'closed' || lost || exhausted ? null : record.phase === 'cleanup_pending' ? options.now() + 30000 : record.session.expiresAt;
    await options.storage.put({ [BROWSER_TASK_KEY]: record, [BROWSER_TASK_DUE_KEY]: due });
    if (due !== null) {
      const existing = await options.storage.getAlarm();
      await armAlarm(options.storage, Math.max(options.now() + 250, existing === null ? due : Math.min(existing, due)));
    }
  };
  const admit = async (operation: BrowserCommand['operation'], evidence: Evidence = {}, consume = true, source?: BrowserSourceGuard) => {
      await source?.();
      if (!config || !binding || !config.enabled || !await current() || await options.storage.get(REVOKED_KEY) === config.driver.runId) return null;
      await source?.();
      if (evidence.approvalRef && (!evidence.proposalId || !options.approved(evidence.approvalRef, evidence.proposalId))) return null;
      const request: BrowserOwnerGrantRequest = { principal, tenant, doName: binding.do_name, presence: binding.presence_id, revision: binding.admission_revision, task: config.driver.runId, manifest: config.manifestDigest, page: config.driver.pageUrl, operation, evidence: Object.freeze({ ...evidence }) };
      Object.freeze(request);
      const grant = await config.grant(request);
      if (!grant || !grant.ref || grant.ref.length > 200 || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= options.now()
        || Object.keys(request).some(key => JSON.stringify(grant[key as keyof BrowserOwnerGrantRequest]) !== JSON.stringify(request[key as keyof BrowserOwnerGrantRequest]))
        || !await current() || await options.storage.get(REVOKED_KEY) === config.driver.runId) return null;
      await source?.();
      const used = (await options.storage.get<number>('browser_owner_task_admissions_v1')) ?? 0;
      if (!Number.isSafeInteger(used) || used >= 32) return null;
      if (consume) await options.storage.put('browser_owner_task_admissions_v1', used + 1);
      await source?.();
      return grant.ref;
    };
  const make = (source?: BrowserSourceGuard) => config && binding ? browserTaskContinuity({
    enabled: config.enabled, ownerId: principal, taskId: config.driver.runId, manifestDigest: config.manifestDigest,
    driver: { ...config.driver,
      start: async lifetime => { await source?.(); return config.driver.start(lifetime, source); },
      navigate: async id => { await source?.(); const value = await config.driver.navigate(id, source); await source?.(); return value; },
      inspect: async id => { await source?.(); const value = await config.driver.inspect(id, source); await source?.(); return value; },
      fill: async (id, field, value, digest, before) => { await source?.(); return config.driver.fill(id, field, value, digest, async () => { await before(); await source?.(); }, source); },
      submit: async (id, digest, before) => { await source?.(); return config.driver.submit(id, digest, async () => { await before(); await source?.(); }, source); },
      verify: async digest => { await source?.(); const value = await config.driver.verify(digest, source); await source?.(); return value; },
      end: async id => {
      const previous = await options.storage.get<CleanupState>(BROWSER_TASK_CLEANUP_KEY);
      const valid = previous === undefined || previous.taskId === config.driver.runId && Number.isSafeInteger(previous.attempts) && previous.attempts >= 0;
      const attempts = valid ? previous?.attempts ?? 0 : MAX_CLEANUP_ATTEMPTS;
      if (attempts >= MAX_CLEANUP_ATTEMPTS) {
        await options.storage.put({ [BROWSER_TASK_CLEANUP_KEY]: { taskId: config.driver.runId, attempts, status: 'exhausted', at: options.now() }, [BROWSER_TASK_DUE_KEY]: null });
        throw Error('browser cleanup attempts exhausted');
      }
      // Persist the attempt before external I/O so reconstruction cannot replenish it.
      const next = attempts + 1;
      await options.storage.put(BROWSER_TASK_CLEANUP_KEY, { taskId: config.driver.runId, attempts: next, status: 'retry_pending', at: options.now() });
      try {
        await config.driver.end(id);
        await options.storage.put(BROWSER_TASK_CLEANUP_KEY, { taskId: config.driver.runId, attempts: next, status: 'closed', at: options.now() });
      } catch {
        await options.storage.put({ [BROWSER_TASK_CLEANUP_KEY]: { taskId: config.driver.runId, attempts: next, status: next >= MAX_CLEANUP_ATTEMPTS ? 'exhausted' : 'retry_pending', at: options.now() }, [BROWSER_TASK_DUE_KEY]: next >= MAX_CLEANUP_ATTEMPTS ? null : options.now() + 30000 });
        throw Error('browser cleanup remains unresolved');
      }
    } }, now: options.now, newId: options.newId,
    store: { exclusive, load: async () => (await options.storage.get(BROWSER_TASK_KEY)) ?? null, save },
    admit: (operation, evidence) => admit(operation, evidence, true, source),
  }) : null;
  let maintenance: Promise<void> | undefined;
  return {
    principal,
    async resolve(authenticatedPrincipal: string, source?: BrowserSourceGuard) {
      await source?.();
      if (authenticatedPrincipal !== principal || !await current()) return null;
      await source?.();
      return make(source);
    },
    // This fence is independent of the browser mutex and provider awaits.
    async revoke() {
      if (config) await options.storage.put(REVOKED_KEY, config.driver.runId);
    },
    async stop() {
      if (!config) return;
      await options.storage.put(REVOKED_KEY, config.driver.runId);
      const task = make();
      if (task && await options.storage.get(BROWSER_TASK_KEY)) await task.cancel(principal);
    },
    maintain(): Promise<void> {
      if (maintenance) return maintenance;
      maintenance = (async () => {
        const raw = await options.storage.get(BROWSER_TASK_KEY);
        const parsed = browserTaskCheckpointSchema.safeParse(raw);
        if (!parsed.success) {
          await options.storage.put({ [BROWSER_TASK_DUE_KEY]: null, browser_owner_task_quarantine_v1: { reason: raw == null ? 'missing_checkpoint' : 'malformed_checkpoint', at: options.now() }, ...(config ? { [REVOKED_KEY]: config.driver.runId } : {}) });
          return;
        }
        if (parsed.data.phase === 'closed') { await options.storage.put(BROWSER_TASK_DUE_KEY, null); return; }
        // A missing driver cannot certify closure; retain private uncertainty without
        // spinning the shared alarm. Provider TTL remains the physical bound.
        const record = parsed.data;
        const cleanup = await options.storage.get<CleanupState>(BROWSER_TASK_CLEANUP_KEY);
        const matches = config && record.taskId === config.driver.runId && record.manifestDigest === config.manifestDigest && record.origin === config.driver.origin && record.session.ownerId === principal && record.session.provider === config.driver.provider && record.session.mode === 'public' && record.session.contextHandle === null;
        if (!config || !matches || record.session.providerSessionId === 'pending' || cleanup?.status === 'exhausted') {
          await options.storage.put({ [BROWSER_TASK_DUE_KEY]: null, [REVOKED_KEY]: record.taskId,
            [BROWSER_TASK_CLEANUP_KEY]: cleanup?.status === 'exhausted' ? cleanup : { taskId: record.taskId, attempts: cleanup?.attempts ?? 0, status: !config ? 'driver_unavailable' : !matches ? 'configuration_mismatch' : 'identity_unavailable', at: options.now() } });
          return;
        }
        await options.storage.put(BROWSER_TASK_DUE_KEY, options.now() + 30000);
        if (record.session.expiresAt <= options.now() || !config.enabled || !await current()
          || await options.storage.get(REVOKED_KEY) === record.taskId || record.phase === 'cleanup_pending' || !await admit('extract', {}, false)) await this.stop();
      })().finally(() => { maintenance = undefined; });
      return maintenance;
    },
  };
}
