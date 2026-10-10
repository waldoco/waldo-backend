import { describe, expect, it, vi } from 'vitest';
import { appRightsRequest, type AppRightsHost } from '../src/channels/app-rights';
import { rightsJobs, type RightsHost, type RightsStorage } from '../src/rights/jobs';
import { mintRightsCapability, readRightsCapability } from '../src/rights/capability';
import { rightsInventory, purgeOwnerR2, purgeWorkspaceR2 } from '../src/rights/custody';
import { appRightsReceiptV1Schema } from '../../contracts/src/app/rights';
const secret = 'synthetic-rights-router-secret-000000000000000000';
const owner = 'synthetic-owner-a', session = 'a'.repeat(64), receiptId = 'a0000000-0000-4000-8000-000000000001';
const memory = () => {
  const values = new Map<string, unknown>(); let queue = Promise.resolve();
  const base = { get: async <T>(key: string) => structuredClone(values.get(key)) as T | undefined, put: async (key: string, value: unknown) => { values.set(key, structuredClone(value)); }, list: async <T>(options: { prefix?: string }) => new Map([...values].filter(([key]) => key.startsWith(options.prefix ?? '')).map(([key, value]) => [key, structuredClone(value) as T])) };
  return { ...base, transaction: async <T>(fn: (store: typeof base) => Promise<T>) => { const prior = queue; let unlock!: () => void; queue = new Promise(resolve => { unlock = resolve; }); await prior; try { return await fn(base); } finally { unlock(); } } } as unknown as RightsStorage;
};
const fixture = async () => {
  let now = 1000, live = true; const inventory = await rightsInventory(), storage = memory(); const deleted: string[] = [];
  const host: RightsHost = { owner, session, secret, storage, now: () => now, assertCurrent: async () => { if (!live) throw new Error('revoked'); }, inventory: async () => inventory,
    buildExport: async () => new TextEncoder().encode('{"version":"rights-export.v1"}'), saveExport: vi.fn(async () => ({ artifact_id: 'file-0001', revision: 1, sha256: 'b'.repeat(64), byte_size: 29, download_path: '/app/v1/files/file-0001/content?revision=1' })),
    lockOwner: vi.fn(async () => { live = false; }), deleteStore: vi.fn(async store => { deleted.push(store); return store === 'audit' ? 'retained' as const : 'completed' as const; }) };
  return { host, inventory, deleted, setLive: (value: boolean) => { live = value; }, advance: (ms: number) => { now += ms; } };
};
const request = (path: string, body?: unknown) => new Request(`https://app.invalid${path}`, { method: body ? 'POST' : 'GET', headers: body ? { 'content-type': 'application/json' } : {}, ...(body ? { body: JSON.stringify(body) } : {}) });
describe('owner data rights and opaque capabilities', () => {
  it('limits capabilities by owner, purpose, expiry and authenticated ciphertext', async () => {
    const claim = { version: 1 as const, owner, receipt: receiptId, kind: 'status' as const, nonce: 'c'.repeat(64), expires: 2000 }, token = await mintRightsCapability(secret, claim);
    expect(token).not.toContain(owner); expect(await readRightsCapability(secret, token, 'status', 1000)).toEqual(claim);
    expect(await readRightsCapability(secret, token, 'submit', 1000)).toBeNull(); expect(await readRightsCapability(secret, token, 'status', 2000)).toBeNull();
    expect(await readRightsCapability(secret, token.slice(0, -5) + 'aaaaa', 'status', 1000)).toBeNull(); expect(await readRightsCapability('wrong-synthetic-secret-000000000000000000', token, 'status', 1000)).toBeNull();
  });
  it('prepares without effects and submits once after local/session locking; status survives revocation', async () => {
    const f = await fixture(), jobs = rightsJobs(f.host), prepared = await jobs.prepare('delete-operation-0001', f.inventory.revision);
    expect(f.deleted).toEqual([]); expect(f.host.lockOwner).not.toHaveBeenCalled(); expect(await jobs.prepare('delete-operation-0001', f.inventory.revision)).toEqual(prepared);
    f.setLive(false); const done = await jobs.submit(prepared.submission_capability);
    expect(done.state).toBe('completed_with_limits'); expect(done.limits).not.toContain('auth_identity_erasure_unverified'); expect(f.deleted.at(-1)).toBe('directory'); expect(f.deleted).not.toContain('external_providers'); expect(done.job_revision).toBeGreaterThan(prepared.receipt.job_revision);
    const effects = f.deleted.length; expect(await jobs.submit(prepared.submission_capability)).toEqual(done); expect(f.deleted.length).toBe(effects); expect(await rightsJobs(f.host).status(prepared.status_capability)).toEqual(done);
    await expect(jobs.status(prepared.submission_capability)).rejects.toThrow('rights_rejected'); await expect(rightsJobs({ ...f.host, owner: 'synthetic-owner-b' }).status(prepared.status_capability)).rejects.toThrow('rights_rejected');
  });
  it('persists failed purge custody, defers directory erasure and recovers only incomplete phases on restart', async () => {
    const f = await fixture(); let fail = true;
    f.host.deleteStore = vi.fn(async store => { f.deleted.push(store); if (store === 'health_plane' && fail) throw new Error('offline'); return store === 'audit' ? 'retained' : 'completed'; });
    const prepared = await rightsJobs(f.host).prepare('delete-operation-0002', f.inventory.revision), failed = await rightsJobs(f.host).submit(prepared.submission_capability);
    expect(failed.state).toBe('incomplete'); expect(failed.phases.find(p => p.store === 'health_plane')?.error).toBe('unconfirmed'); expect(f.deleted).not.toContain('directory');
    const ownerDeletes = f.deleted.filter(s => s === 'owner_runtime').length; fail = false;
    const [done] = await rightsJobs(f.host).resume(); expect(done?.state).toBe('completed_with_limits'); expect(ownerDeletes).toBe(0); expect(f.deleted.filter(s => s === 'owner_runtime')).toHaveLength(1); expect(done?.phases.find(p => p.store === 'health_plane')?.attempts).toBe(2); expect(await rightsJobs(f.host).status(prepared.status_capability)).toEqual(done);
  });
  it('rejects stale scope, expired submission and changed session replay before data effects', async () => {
    const f = await fixture(); await expect(rightsJobs(f.host).prepare('delete-operation-0003', 'f'.repeat(64))).rejects.toThrow('rights_conflict');
    const prepared = await rightsJobs(f.host).prepare('delete-operation-0003', f.inventory.revision); await expect(rightsJobs({ ...f.host, session: 'd'.repeat(64) }).prepare('delete-operation-0003', f.inventory.revision)).rejects.toThrow('rights_conflict');
    f.advance(24 * 60 * 60_000); await expect(rightsJobs(f.host).submit(prepared.submission_capability)).rejects.toThrow('rights_rejected'); expect(f.deleted).toEqual([]); expect((await rightsJobs(f.host).status(prepared.status_capability)).state).toBe('prepared');
  });
  it('serializes concurrent confirmed submission and preserves failed Auth identity custody', async () => {
    const f = await fixture(), jobs = rightsJobs(f.host), prepared = await jobs.prepare('delete-operation-0004', f.inventory.revision);
    const done = await Promise.all([jobs.submit(prepared.submission_capability), rightsJobs(f.host).submit(prepared.submission_capability)]);
    expect(done[0]).toEqual(done[1]); expect(f.deleted.filter(store => store === 'auth_identity')).toHaveLength(1); expect(f.deleted.filter(store => store === 'owner_runtime')).toHaveLength(1);
    const blocked = await fixture(); blocked.host.deleteStore = vi.fn(async store => { blocked.deleted.push(store); if (store === 'auth_identity') throw Error('signed erasure unavailable'); return store === 'audit' ? 'retained' : 'completed'; });
    const ticket = await rightsJobs(blocked.host).prepare('delete-operation-0005', blocked.inventory.revision), incomplete = await rightsJobs(blocked.host).submit(ticket.submission_capability);
    expect(incomplete.state).toBe('incomplete'); expect(incomplete.limits).toContain('auth_identity_erasure_unverified'); expect(blocked.deleted).not.toContain('directory'); expect((await rightsJobs(blocked.host).status(ticket.status_capability)).job_revision).toBe(incomplete.job_revision);
  });
  it('exports verified immutable files and keeps export access session fenced', async () => {
    const f = await fixture(), jobs = rightsJobs(f.host), result = await jobs.export('export-operation-0001', f.inventory.revision);
    expect(appRightsReceiptV1Schema.safeParse(result).success).toBe(true); expect(result.file?.revision).toBe(1); expect(result.job_revision).toBeGreaterThan(1); expect(await jobs.export('export-operation-0001', f.inventory.revision)).toEqual(result); expect(f.host.saveExport).toHaveBeenCalledTimes(1);
    await expect(rightsJobs({ ...f.host, session: 'd'.repeat(64) }).readExport(result.receipt_id)).rejects.toThrow('rights_rejected'); f.setLive(false); await expect(jobs.readExport(result.receipt_id)).rejects.toThrow('revoked');
  });
  it('serves narrowly scoped status, rejecting ambient extras and wrong origin', async () => {
    const f = await fixture(), host = { ...f.host, rateLimit: async () => true, push: {} } as AppRightsHost;
    const prepared = await (await appRightsRequest(request('/app/v1/rights/delete/prepare', { operation_id: 'api-delete-00001', expected_inventory_revision: f.inventory.revision }), host))!.json() as { status_capability: string; submission_capability: string };
    f.setLive(false); expect((await appRightsRequest(request('/app/v1/rights/receipts/status', { status_capability: prepared.status_capability }), host))?.status).toBe(200);
    expect((await appRightsRequest(request('/app/v1/rights/delete/submit', { submission_capability: prepared.submission_capability, confirmed: true, owner: 'other' }), host))?.status).toBe(400);
    const cross = request('/app/v1/rights/delete/submit', { submission_capability: prepared.submission_capability, confirmed: true }); cross.headers.set('origin', 'https://evil.invalid'); expect((await appRightsRequest(cross, host))?.status).toBe(403); expect(f.deleted).toEqual([]);
    expect((await appRightsRequest(request('/app/v1/rights/inventory'), { ...host, rateLimit: async () => false }))?.status).toBe(429);
  });
});
describe('owner scoped retained byte cleanup', () => {
  it('deletes artifact bodies and orphan revisions without touching another owner', async () => {
    const objects = new Set(['artifacts/by-owner/owner-a/body1','artifacts/by-owner/owner-a/orphan','artifacts/exports/by-owner/owner-a/binary','artifacts/by-owner/owner-b/private']);
    const bucket = { list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: [...objects].filter(k => k.startsWith(prefix)).map(key => ({ key })), truncated: false })), delete: vi.fn(async (keys: string[]) => { keys.forEach(key => objects.delete(key)); }) };
    await purgeOwnerR2(bucket as never, 'owner-a'); expect([...objects]).toEqual(['artifacts/by-owner/owner-b/private']);
  });
  it('refuses forged workspace mapping before any byte access', async () => {
    const bucket = { list: vi.fn(), delete: vi.fn() }; await expect(purgeWorkspaceR2(bucket as never, { ownerId: receiptId, environment: 'staging', namespace: 'owner', doName: 'owner-a', doId: 'wrong' }, { doName: 'owner-a', doId: 'actual' })).rejects.toThrow('rights_unavailable'); expect(bucket.delete).not.toHaveBeenCalled();
  });
  it('does not claim purge if independent absence read still finds bytes', async () => {
    const bucket = { list: async () => ({ objects: [{ key: 'artifacts/by-owner/owner-a/persisted' }], truncated: false }), delete: vi.fn() }; await expect(purgeOwnerR2(bucket as never, 'owner-a')).rejects.toThrow('rights_unconfirmed');
  });
});
