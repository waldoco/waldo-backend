import { describe, expect, it } from 'vitest';
import { ownerFilePrefixes, purgeOwnerFiles } from '../src/channels/owner-files-purge';

const DO_ID = 'a'.repeat(64), OTHER_DO_ID = `${'a'.repeat(63)}b`, OWNER = '10000000-0000-4000-8000-000000000001';
const manifest = (state: unknown) => ({
  exec: <T>(query: string) => ({ toArray: () => (query.includes('sqlite_master') ? [{ name: 'workspace_manifest' }] : [{ state_json: JSON.stringify(state) }]) as T[] }),
}) as unknown as SqlStorage;
const noManifest = { exec: () => ({ toArray: () => [] }) } as unknown as SqlStorage;

// A bucket that lists at most `pageSize` keys per call, the way R2 does, and records every delete batch.
const bucket = (keys: string[], opts: { pageSize?: number; failDelete?: boolean; failList?: boolean } = {}) => {
  const live = new Set(keys), deletes: string[][] = [];
  const api = {
    list: async ({ prefix, limit }: { prefix: string; limit: number }) => {
      if (opts.failList) throw new Error('list down');
      const objects = [...live].filter(key => key.startsWith(prefix)).slice(0, Math.min(limit, opts.pageSize ?? limit)).map(key => ({ key }));
      return { objects, truncated: false };
    },
    delete: async (batch: string[]) => { if (opts.failDelete) throw new Error('delete down'); deletes.push(batch); for (const key of batch) live.delete(key); },
  };
  return { api: api as unknown as R2Bucket, live, deletes };
};

describe('owner file prefixes', () => {
  it('scopes artifacts and exports to the Durable Object id and adds the workspace prefix from the manifest binding', () => {
    expect(ownerFilePrefixes(DO_ID, manifest({ binding: { ownerId: OWNER, environment: 'staging', namespace: 'ns-1' }, files: [] }))).toEqual([
      `artifacts/by-owner/${DO_ID}/`, `artifacts/exports/by-owner/${DO_ID}/`, `workspace/v1/staging/ns-1/${OWNER}/`,
    ]);
  });
  it('has no workspace prefix when the workspace was never bound', () => {
    expect(ownerFilePrefixes(DO_ID, noManifest)).toEqual([`artifacts/by-owner/${DO_ID}/`, `artifacts/exports/by-owner/${DO_ID}/`]);
    expect(ownerFilePrefixes(DO_ID, manifest({ binding: null, files: [] }))).toHaveLength(2);
  });
  it('cannot name a prefix it cannot trust, so the caller must not proceed', () => {
    expect(ownerFilePrefixes(DO_ID, manifest({ binding: { ownerId: 'not-a-uuid', environment: 'staging', namespace: 'ns-1' } }))).toBeNull();
    expect(ownerFilePrefixes(DO_ID, manifest({ binding: { ownerId: OWNER, environment: '', namespace: 'ns-1' } }))).toBeNull();
    expect(ownerFilePrefixes('', noManifest)).toBeNull();
  });
});

describe('purging owner files', () => {
  const prefixes = [`artifacts/by-owner/${DO_ID}/`, `artifacts/exports/by-owner/${DO_ID}/`, `workspace/v1/staging/ns-1/${OWNER}/`];
  const mine = [`artifacts/by-owner/${DO_ID}/a`, `artifacts/exports/by-owner/${DO_ID}/b`, `workspace/v1/staging/ns-1/${OWNER}/f/b`];
  const others = [`artifacts/by-owner/${OTHER_DO_ID}/a`, 'workspace/v1/staging/ns-1/20000000-0000-4000-8000-000000000002/f/b', 'unrelated/key'];

  it('removes every object under the owner prefixes and nothing else', async () => {
    const { api, live } = bucket([...mine, ...others]);
    expect(await purgeOwnerFiles(api, prefixes)).toBe(true);
    expect([...live].sort()).toEqual([...others].sort());
  });
  it('pages through more objects than one list returns', async () => {
    const many = Array.from({ length: 7 }, (_, i) => `artifacts/by-owner/${DO_ID}/k${i}`);
    const { api, live, deletes } = bucket([...many, ...others], { pageSize: 3 });
    expect(await purgeOwnerFiles(api, prefixes)).toBe(true);
    expect(deletes.length).toBe(3);
    expect(live.size).toBe(others.length);
  });
  it('does not claim success when a delete or a list fails', async () => {
    expect(await purgeOwnerFiles(bucket(mine, { failDelete: true }).api, prefixes)).toBe(false);
    expect(await purgeOwnerFiles(bucket(mine, { failList: true }).api, prefixes)).toBe(false);
  });
  it('does not claim success when the work bound is reached before the prefix is empty', async () => {
    const many = Array.from({ length: 60 }, (_, i) => `artifacts/by-owner/${DO_ID}/k${i}`);
    const { api, live } = bucket(many, { pageSize: 1 });
    expect(await purgeOwnerFiles(api, prefixes)).toBe(false);
    expect(live.size).toBeLessThan(60);
  });
  it('treats a missing bucket as nothing stored, and refuses a prefix that could cover other owners', async () => {
    expect(await purgeOwnerFiles(undefined, prefixes)).toBe(true);
    const { api, live } = bucket([...mine, ...others]);
    for (const bad of ['', 'artifacts/', `artifacts/by-owner/${DO_ID}`]) expect(await purgeOwnerFiles(api, [bad])).toBe(false);
    expect(live.size).toBe(mine.length + others.length);
  });
});
