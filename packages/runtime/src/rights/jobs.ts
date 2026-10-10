import type { AppRightsInventoryV1, AppRightsReceiptV1, AppRightsStoreV1 } from '../../../contracts/src/app/rights';
import { mintRightsCapability, readRightsCapability, rightsDigest } from './capability';

export class RightsError extends Error { constructor(readonly code: 'invalid' | 'rejected' | 'conflict' | 'unavailable' | 'not_found') { super(`rights_${code}`); } }
export type RightsStorage = Pick<DurableObjectStorage, 'get' | 'put' | 'transaction' | 'list'>;
type FileReceipt = NonNullable<AppRightsReceiptV1['file']>;
type Job = { receipt: AppRightsReceiptV1; owner: string; session: string; submit_hash?: string; status_hash?: string; prepared_tokens?: { submission_capability: string; submission_expires_at: number; status_capability: string; status_expires_at: number } };
export type RightsHost = {
  storage: RightsStorage; owner: string; session: string; secret: string; now(): number;
  assertCurrent(): Promise<void>; inventory(): Promise<AppRightsInventoryV1>;
  // Export producer must return owner-authorized revisions and explicit exclusions.
  buildExport(): Promise<Uint8Array>; saveExport(receiptId: string, bytes: Uint8Array): Promise<FileReceipt>;
  // This fences ongoing writes/alarms BEFORE any destructive phase or session revocation.
  lockOwner(receiptId: string): Promise<void>;
  deleteStore(store: AppRightsStoreV1, receiptId: string): Promise<'completed' | 'retained' | 'outside_control'>;
};
const key = (id: string) => `rights.job.${id}`;
const randomNonce = () => [...crypto.getRandomValues(new Uint8Array(32))].map(v => v.toString(16).padStart(2, '0')).join('');
const limits: AppRightsReceiptV1['limits'] = ['raw_health_separate_authority', 'credentials_excluded', 'provider_records_not_erased', 'backup_retention_unverified', 'offline_copy_cleanup_unverified', 'audit_retention', 'auth_identity_erasure_unverified'];
const publicReceipt = (job: Job): AppRightsReceiptV1 => structuredClone(job.receipt);
const queues = new WeakMap<object, Promise<unknown>>();
const serialized = async <T>(storage: RightsStorage, work: () => Promise<T>): Promise<T> => {
  const prior = queues.get(storage) ?? Promise.resolve();
  const next = prior.catch(() => undefined).then(work);
  queues.set(storage, next);
  try { return await next; } finally { if (queues.get(storage) === next) queues.delete(storage); }
};
export const rightsJobs = (host: RightsHost) => {
  const get = async (id: string) => { const job = await host.storage.get<Job>(key(id)); if (!job || job.owner !== host.owner) throw new RightsError('not_found'); return job; };
  const persist = (job: Job) => { job.receipt.job_revision += 1; return host.storage.put(key(job.receipt.receipt_id), job); };
  const create = async (kind: 'export' | 'delete', operationId: string, expected: string) => {
    await host.assertCurrent();
    const inventory = await host.inventory();
    if (inventory.revision !== expected) throw new RightsError('conflict');
    await host.assertCurrent();
    return host.storage.transaction(async store => {
      const operationKey = `rights.operation.${await rightsDigest(JSON.stringify([host.owner, kind, operationId]))}`;
      const priorId = await store.get<string>(operationKey);
      if (priorId) { const prior = await store.get<Job>(key(priorId)); if (!prior || prior.receipt.inventory_revision !== expected || prior.session !== host.session) throw new RightsError('conflict'); return prior; }
      const now = host.now(), id = crypto.randomUUID();
      const job: Job = { owner: host.owner, session: host.session, receipt: { version: 'rights.v1', receipt_id: id, operation_id: operationId, job_revision: 1, kind, state: kind === 'delete' ? 'prepared' : 'pending', inventory_revision: expected, created_at: now, updated_at: now, phases: inventory.stores.map(row => ({ store: row.store, state: row.deletion === 'outside_control' ? 'outside_control' : 'pending', attempts: 0, updated_at: now, error: null })), file: null, limits } };
      if (kind === 'delete') {
        const submission_expires_at = now + 24 * 60 * 60_000, status_expires_at = now + 30 * 24 * 60 * 60_000;
        const submit = await mintRightsCapability(host.secret, { version: 1, owner: host.owner, receipt: id, kind: 'submit', nonce: randomNonce(), expires: submission_expires_at });
        const status = await mintRightsCapability(host.secret, { version: 1, owner: host.owner, receipt: id, kind: 'status', nonce: randomNonce(), expires: status_expires_at });
        job.submit_hash = await rightsDigest(submit); job.status_hash = await rightsDigest(status);
        job.prepared_tokens = { submission_capability: submit, submission_expires_at, status_capability: status, status_expires_at };
      }
      await store.put(key(id), job); await store.put(operationKey, id); return job;
    });
  };
  const runExport = async (job: Job) => {
    if (job.receipt.file) return publicReceipt(job);
    job.receipt.state = 'running'; job.receipt.updated_at = host.now(); await persist(job);
    try {
      await host.assertCurrent(); const bytes = await host.buildExport(); await host.assertCurrent();
      // saveExport uses receiptId as its idempotency key; an uncertain save cannot
      // create a second export revision on retry.
      const file = await host.saveExport(job.receipt.receipt_id, bytes); await host.assertCurrent();
      job.receipt.file = file; job.receipt.state = 'completed_with_limits';
      for (const phase of job.receipt.phases) if (phase.state === 'pending') { phase.state = ['health_plane', 'auth_identity'].includes(phase.store) ? 'retained' : 'completed'; phase.updated_at = host.now(); }
    } catch { job.receipt.state = 'incomplete'; }
    job.receipt.updated_at = host.now(); await persist(job); return publicReceipt(job);
  };
  const runDelete = async (job: Job) => {
    if (job.receipt.state === 'prepared') throw new RightsError('rejected');
    if (job.receipt.state === 'completed_with_limits') return publicReceipt(job);
    job.receipt.state = 'running'; job.receipt.updated_at = host.now(); await persist(job);
    try { await host.lockOwner(job.receipt.receipt_id); }
    catch { job.receipt.state = 'incomplete'; await persist(job); return publicReceipt(job); }
    // Retain runtime manifests until byte/health custody is settled; directory
    // deletion comes last because those stores need its verified owner mapping.
    const order: AppRightsStoreV1[] = ['push_devices', 'health_plane', 'workspace', 'artifacts', 'audit', 'backups', 'external_providers', 'offline_devices', 'owner_runtime', 'auth_identity', 'directory'];
    const ordered = [...job.receipt.phases].sort((a, b) => order.indexOf(a.store) - order.indexOf(b.store));
    for (const phase of ordered) {
      if (['completed', 'retained', 'outside_control'].includes(phase.state)) continue;
      if (['owner_runtime', 'auth_identity', 'directory'].includes(phase.store) && job.receipt.phases.some(p => ['push_devices', 'health_plane', 'workspace', 'artifacts'].includes(p.store) && ['pending', 'running', 'failed'].includes(p.state))) break;
      if (['auth_identity', 'directory'].includes(phase.store) && job.receipt.phases.some(p => p.store === 'owner_runtime' && p.state !== 'completed')) break;
      if (phase.store === 'directory' && job.receipt.phases.some(p => p.store === 'auth_identity' && p.state !== 'completed')) break;
      phase.state = 'running'; phase.attempts += 1; phase.updated_at = host.now(); phase.error = null; await persist(job);
      try { phase.state = await host.deleteStore(phase.store, job.receipt.receipt_id); }
      catch { phase.state = 'failed'; phase.error = 'unconfirmed'; }
      phase.updated_at = host.now(); job.receipt.updated_at = host.now(); await persist(job);
    }
    if (job.receipt.phases.find(p => p.store === 'auth_identity')?.state === 'completed') job.receipt.limits = job.receipt.limits.filter(limit => limit !== 'auth_identity_erasure_unverified');
    job.receipt.state = job.receipt.phases.some(p => ['pending', 'running', 'failed'].includes(p.state)) ? 'incomplete' : 'completed_with_limits';
    job.receipt.updated_at = host.now(); await persist(job); return publicReceipt(job);
  };
  return {
    async inventory() { await host.assertCurrent(); return host.inventory(); },
    async export(operationId: string, expected: string) { return serialized(host.storage, async () => runExport(await create('export', operationId, expected))); },
    async prepare(operationId: string, expected: string) { const job = await create('delete', operationId, expected); await host.assertCurrent(); if (!job.prepared_tokens || job.receipt.state !== 'prepared') throw new RightsError('conflict'); return { receipt: publicReceipt(job), ...job.prepared_tokens }; },
    async submit(token: string) { return serialized(host.storage, async () => {
      const claim = await readRightsCapability(host.secret, token, 'submit', host.now());
      if (!claim || claim.owner !== host.owner) throw new RightsError('rejected');
      const job = await host.storage.transaction(async store => {
        const current = await store.get<Job>(key(claim.receipt));
        if (!current || current.owner !== host.owner || current.submit_hash !== await rightsDigest(token)) throw new RightsError('rejected');
        if (current.receipt.state === 'prepared') { current.receipt.state = 'pending'; current.receipt.job_revision += 1; current.receipt.updated_at = host.now(); delete current.prepared_tokens; await store.put(key(claim.receipt), current); }
        return current;
      });
      return runDelete(job);
    });
    },
    async status(token: string) {
      const claim = await readRightsCapability(host.secret, token, 'status', host.now());
      if (!claim || claim.owner !== host.owner) throw new RightsError('rejected');
      const job = await get(claim.receipt); if (job.status_hash !== await rightsDigest(token)) throw new RightsError('rejected');
      // A status capability cannot fetch exported bytes or reveal their location.
      const shown = publicReceipt(job); shown.file = null; return shown;
    },
    async readExport(id: string) { await host.assertCurrent(); const job = await get(id); if (job.session !== host.session || job.receipt.kind !== 'export') throw new RightsError('rejected'); return publicReceipt(job); },
    async resume() { return serialized(host.storage, async () => {
      const rows = await host.storage.list<Job>({ prefix: 'rights.job.' });
      const results: AppRightsReceiptV1[] = [];
      for (const job of rows.values()) if (job.owner === host.owner && job.receipt.kind === 'delete' && ['pending', 'running', 'incomplete'].includes(job.receipt.state)) results.push(await runDelete(job));
      return results;
    });
    },
  };
};
