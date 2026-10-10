import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { createOwnerRightsHost } from '../src/channels/owner-rights-host';
import { ownerByteCustody } from '../src/rights/write-custody';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';

it('locks synchronously before host awaits and refuses erasure until late actual artifact bytes settle', async () => {
  const name = `rights-host-${crypto.randomUUID()}`, id = env.TELEGRAM_OWNER_DO!.idFromName(name), owner = env.TELEGRAM_OWNER_DO!.get(id);
  await runInDurableObject(owner, async (_instance, state) => {
    state.storage.kv.put('do_name', name);
    const objects = new Map<string, Uint8Array>(); let finishPut!: () => void, finishLock!: () => void;
    const bucket = { put: vi.fn(async (key: string, bytes: Uint8Array) => { await new Promise<void>(resolve => { finishPut = resolve; }); objects.set(key, bytes.slice()); }),
      get: async (key: string) => { const bytes = objects.get(key); return bytes ? { text: async () => new TextDecoder().decode(bytes) } : null; },
      list: vi.fn(async ({ prefix }: { prefix: string }) => ({ objects: [...objects.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key })), truncated: false })),
      delete: vi.fn(async (keys: string[]) => { keys.forEach(key => objects.delete(key)); }) } as unknown as R2Bucket;
    const receipt = crypto.randomUUID(), custody = ownerByteCustody(state.storage, async () => {});
    const book = artifactBook(state.storage.sql, r2ArtifactBodies(bucket, state.id.toString(), custody), { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID());
    const creating = book.create({ name: 'Late artifact', kind: 'document', body_markdown: 'owner original' }, 'owner');
    const failedCreation = expect(creating).rejects.toThrow('rights_rejected');
    while (!finishPut) await new Promise(resolve => setTimeout(resolve, 0));
    const host = createOwnerRightsHost({ env: { TELEGRAM_OWNER_DO: env.TELEGRAM_OWNER_DO, ARTIFACTS: bucket }, storage: state.storage, doName: name, doId: state.id.toString(), sessionHash: 'a'.repeat(64), assertCurrent: async () => {}, lock: async () => { await new Promise<void>(resolve => { finishLock = resolve; }); }, quiesce: async () => custody.assertQuiescent(), productState: async () => ({}), directoryMetadata: async () => ({}) });
    const locking = host.lockOwner(receipt);
    expect(state.storage.kv.get('rights:owner-lock')).toBe(receipt);
    await expect(custody.put('owner/new', new Uint8Array([1]), async () => {})).rejects.toThrow('rights_rejected');
    finishLock(); await locking;
    await expect(host.deleteStore('artifacts', receipt)).rejects.toThrow('rights_unavailable');
    expect(bucket.delete).not.toHaveBeenCalled();
    finishPut(); await failedCreation;
    expect(book.list()).toEqual([]); expect(objects.size).toBe(1);
    expect(await host.deleteStore('artifacts', receipt)).toBe('completed');
    expect(objects.size).toBe(0); expect(bucket.delete).toHaveBeenCalledOnce();
    await expect(host.deleteStore('owner_runtime', crypto.randomUUID())).rejects.toThrow('rights_not_locked');
  });
});

import { purgeOwnerR2, purgeWorkspaceR2 } from '../src/rights/custody';
it('refuses unproved truncated custody listings and noncanonical owner workspace prefixes',async()=>{
 const list=vi.fn(async()=>({objects:[],truncated:true})),remove=vi.fn(async()=>{}),bucket={list,delete:remove} as unknown as R2Bucket;
 await expect(purgeOwnerR2(bucket,'actual-owner')).rejects.toThrow('rights_unconfirmed');expect(list).toHaveBeenCalledOnce();expect(remove).not.toHaveBeenCalled();
 await expect(purgeWorkspaceR2(bucket,{ownerId:'-'.repeat(36),environment:'test',namespace:'owner',doName:'name',doId:'id'},{doName:'name',doId:'id'})).rejects.toThrow('rights_unavailable');expect(list).toHaveBeenCalledOnce();
 await expect(purgeWorkspaceR2(bucket,{ownerId:crypto.randomUUID(),environment:'test',namespace:'owner',doName:'name',doId:'id'},{doName:'name',doId:'id'})).rejects.toThrow('rights_unconfirmed');expect(remove).not.toHaveBeenCalled();
});
