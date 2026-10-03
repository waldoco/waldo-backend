import { browserTaskCheckpointSchema, type BrowserTaskCheckpoint, type BrowserCommand } from '@waldo/contracts';
import { ownerPresenceBinding, type PresenceBinding } from '../identity/owner-message-admission';
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
    const due = record.phase === 'closed' ? null : record.phase === 'cleanup_pending' ? options.now() + 30000 : record.session.expiresAt;
    await options.storage.put({ [BROWSER_TASK_KEY]: record, [BROWSER_TASK_DUE_KEY]: due });
    if (due !== null) {
      const existing = await options.storage.getAlarm();
      await armAlarm(options.storage, Math.max(options.now() + 250, existing === null ? due : Math.min(existing, due)));
    }
  };
  const admit = async (operation: BrowserCommand['operation'], evidence: Evidence = {}, consume = true) => {
      if (!config || !binding || !config.enabled || !await current() || await options.storage.get(REVOKED_KEY) === config.driver.runId) return null;
      if (evidence.approvalRef && (!evidence.proposalId || !options.approved(evidence.approvalRef, evidence.proposalId))) return null;
      const request: BrowserOwnerGrantRequest = { principal, tenant, doName: binding.do_name, presence: binding.presence_id, revision: binding.admission_revision, task: config.driver.runId, manifest: config.manifestDigest, page: config.driver.pageUrl, operation, evidence: Object.freeze({ ...evidence }) };
      Object.freeze(request);
      const grant = await config.grant(request);
      if (!grant || !grant.ref || grant.ref.length > 200 || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= options.now()
        || Object.keys(request).some(key => JSON.stringify(grant[key as keyof BrowserOwnerGrantRequest]) !== JSON.stringify(request[key as keyof BrowserOwnerGrantRequest]))
        || !await current() || await options.storage.get(REVOKED_KEY) === config.driver.runId) return null;
      const used = (await options.storage.get<number>('browser_owner_task_admissions_v1')) ?? 0;
      if (!Number.isSafeInteger(used) || used >= 32) return null;
      if (consume) await options.storage.put('browser_owner_task_admissions_v1', used + 1);
      return grant.ref;
    };
  const make = () => config && binding ? browserTaskContinuity({
    enabled: config.enabled, ownerId: principal, taskId: config.driver.runId, manifestDigest: config.manifestDigest,
    driver: config.driver, now: options.now, newId: options.newId,
    store: { exclusive, load: async () => (await options.storage.get(BROWSER_TASK_KEY)) ?? null, save },
    admit,
  }) : null;
  let maintenance: Promise<void> | undefined;
  return {
    principal,
    async resolve(authenticatedPrincipal: string) {
      if (authenticatedPrincipal !== principal || !await current()) return null;
      return make();
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
        const parsed = browserTaskCheckpointSchema.safeParse(await options.storage.get(BROWSER_TASK_KEY));
        if (!parsed.success || parsed.data.phase === 'closed') return;
        // A missing driver cannot certify closure; retain private uncertainty without
        // spinning the shared alarm. Provider TTL remains the physical bound.
        await options.storage.put(BROWSER_TASK_DUE_KEY, options.now() + 30000);
        if (!config) return;
        const record = parsed.data;
        if (record.session.expiresAt <= options.now() || !config.enabled || !await current()
          || await options.storage.get(REVOKED_KEY) === record.taskId || record.phase === 'cleanup_pending' || !await admit('extract', {}, false)) await this.stop();
      })().finally(() => { maintenance = undefined; });
      return maintenance;
    },
  };
}
