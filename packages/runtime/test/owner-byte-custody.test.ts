import { env } from 'cloudflare:workers';
import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { ownerByteCustody } from '../src/rights/write-custody';
import { r2ArtifactBodies } from '../src/channels/artifacts';
import { r2ArtifactBinaries } from '../src/channels/artifact-exports';

const stub = () => env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`byte-custody-${crypto.randomUUID()}`));
it('blocks writes at the durable owner lock even when the asynchronous admission check was already granted', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    const put = vi.fn(async () => {});
    const custody = ownerByteCustody(state.storage, async () => { state.storage.kv.put('rights:owner-lock', 'reviewed-delete'); });
    await expect(custody.put('owner/body', new Uint8Array([1]), put)).rejects.toThrow('rights_rejected');
    expect(put).not.toHaveBeenCalled(); expect(custody.pending()).toEqual([]);
  });
});
it('requires custody at every artifact byte write instead of dispatching an unregistered put', async () => {
  const bucket = { put: vi.fn(async () => {}) } as unknown as R2Bucket;
  await expect(r2ArtifactBodies(bucket, 'owner').put('body', 'one')).rejects.toThrow('rights_unavailable');
  await expect(r2ArtifactBinaries(bucket, 'owner').putBytes('binary', new Uint8Array([1]))).rejects.toThrow('rights_unavailable');
  expect(bucket.put).not.toHaveBeenCalled();
});

it('retains in-flight custody through lock, refuses late publication, then permits confirmed cleanup', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    let finish!: () => void;
    const custody = ownerByteCustody(state.storage, async () => {});
    const bytes = new Uint8Array([1, 2]), saved: Uint8Array[] = [];
    const operation = custody.put('owner/late', bytes, async immutable => { saved.push(immutable.slice()); await new Promise<void>(resolve => { finish = resolve; }); });
    const result = expect(operation).rejects.toThrow('rights_rejected');
    while (!finish) await new Promise(resolve => setTimeout(resolve, 0));
    bytes[0] = 9;
    expect(saved).toEqual([new Uint8Array([1, 2])]);
    expect(() => custody.assertQuiescent()).toThrow('rights_unavailable');
    state.storage.kv.put('rights:owner-lock', 'reviewed-delete');
    await expect(ownerByteCustody(state.storage, async () => {}).quiesce(1)).rejects.toThrow('rights_unavailable');
    finish(); await result;
    expect(custody.settled('owner/late')).toBe(true);
    await custody.quiesce();
    await expect(custody.put('owner/new', new Uint8Array([3]), async () => {})).rejects.toThrow('rights_rejected');
  });
});
it('recovers exact uncertain bytes after eviction but cannot settle corrupt or absent late-write evidence', async () => {
  const owner = stub();
  await runInDurableObject(owner, async (_instance, state) => {
    const custody = ownerByteCustody(state.storage, async () => {});
    await expect(custody.put('owner/unknown', new Uint8Array([4]), async () => { throw Error('lost acknowledgement'); })).rejects.toThrow('lost acknowledgement');
    expect(custody.pending()).toMatchObject([{ key: 'owner/unknown', state: 'uncertain' }]);
  });
  await evictDurableObject(owner);
  await runInDurableObject(owner, async (_instance, state) => {
    const custody = ownerByteCustody(state.storage, async () => {});
    expect(() => custody.assertQuiescent()).toThrow('rights_unavailable');
    expect(await custody.reconcile('owner/unknown', new Uint8Array([5]))).toBe(false);
    expect(() => custody.assertQuiescent()).toThrow('rights_unavailable');
    expect(await custody.reconcile('owner/unknown', new Uint8Array([4]))).toBe(true);
    expect(() => custody.assertQuiescent()).not.toThrow();
    await expect(custody.put('owner/unknown', new Uint8Array([4]), async () => {})).rejects.toThrow('rights_conflict');
  });
});

it('keeps the captured artifact invocation closed after cached owner admission awaits a newer run', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    let finishAdmission!: () => void, closed = false;
    const invocation = { scope: { admit() { if (closed) throw Error('old run closed'); } } };
    const custody = ownerByteCustody(state.storage, async () => { await new Promise<void>(resolve => { finishAdmission = resolve; }); });
    const bucket = { put: vi.fn(async () => {}) } as unknown as R2Bucket;
    const bodies = r2ArtifactBodies(bucket, 'owner', custody);
    const operation = bodies.put('old-body', 'private', invocation);
    const result = expect(operation).rejects.toThrow('old run closed');
    while (!finishAdmission) await new Promise(resolve => setTimeout(resolve, 0));
    // The owner remains active and the next run is open; only this invocation closes.
    closed = true; finishAdmission(); await result;
    expect(bucket.put).not.toHaveBeenCalled(); expect(custody.pending()).toEqual([]);
  });
});

it('settles export cleanup evidence while refusing publication for a captured invocation that closed during provider I/O', async () => {
  await runInDurableObject(stub(), async (_instance, state) => {
    let finishPut!: () => void, closed = false;
    const invocation = { scope: { admit() { if (closed) throw Error('old run closed'); } } };
    const custody = ownerByteCustody(state.storage, async () => {});
    const bucket = { put: vi.fn(async () => { await new Promise<void>(resolve => { finishPut = resolve; }); }) } as unknown as R2Bucket;
    const binaries = r2ArtifactBinaries(bucket, 'owner', custody);
    const operation = binaries.putBytes('old-export', new Uint8Array([1]), invocation);
    const result = expect(operation).rejects.toThrow('old run closed');
    while (!finishPut) await new Promise(resolve => setTimeout(resolve, 0));
    closed = true; finishPut(); await result;
    expect(custody.settled('artifacts/exports/by-owner/owner/old-export')).toBe(true);
    expect(custody.pending()).toEqual([]);
  });
});
