import { describe, expect, it } from 'vitest';
import { EXTERNAL_ORIGIN_TOOLS, TOOL_PERMISSIONS } from '@waldo/contracts';
import { artifactBook, artifactHandlers, inMemoryArtifactBodies, r2ArtifactBodies, type ArtifactMeta } from '../src/channels/artifacts';

type Row = ArtifactMeta;
const fakeSql = () => {
  const rows = new Map<string, Row>();
  return {
    rows,
    exec(query: string, ...args: unknown[]) {
      if (query.startsWith('CREATE TABLE')) return { toArray: () => [] as Row[] };
      if (query.startsWith('INSERT INTO artifacts')) {
        const [id, name, kind, revision, byte_size, r2_key, provenance, taint, created_at, updated_at] = args as [string, string, Row['kind'], number, number, string, string, string, number, number];
        rows.set(id, { id, name, kind, revision, byte_size, r2_key, provenance, taint, created_at, updated_at });
        return { toArray: () => [] as Row[] };
      }
      if (query.startsWith('UPDATE artifacts SET')) {
        const [revision, byte_size, r2_key, provenance, updated_at, id] = args as [number, number, string, string, number, string];
        const row = rows.get(id)!;
        rows.set(id, { ...row, revision, byte_size, r2_key, provenance, updated_at });
        return { toArray: () => [] as Row[] };
      }
      if (query.startsWith('SELECT * FROM artifacts WHERE id')) {
        const row = rows.get(args[0] as string);
        return { toArray: () => (row ? [row] : []) };
      }
      if (query.startsWith('SELECT * FROM artifacts WHERE kind')) {
        return { toArray: () => [...rows.values()].filter((r) => r.kind === args[0]).sort((a, b) => b.updated_at - a.updated_at) };
      }
      if (query.startsWith('SELECT * FROM artifacts ORDER BY')) {
        return { toArray: () => [...rows.values()].sort((a, b) => b.updated_at - a.updated_at) };
      }
      throw new Error(`unexpected query: ${query}`);
    },
  };
};

const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-09-27T01:00:00Z') };
const book = () => artifactBook(fakeSql() as never, inMemoryArtifactBodies(), clock, () => 'abc123');
const seqBook = () => { let n = 0; return artifactBook(fakeSql() as never, inMemoryArtifactBodies(), clock, () => `id${++n}`); };
const createArgs = { name: 'Flight shortlist', kind: 'shortlist' as const, body_markdown: '# Options\n\n1. Early flight' };

describe('artifact book (A5)', () => {
  it('create stores metadata and the body; list shows metadata only; read slices with next_offset', async () => {
    const store = book();
    const meta = await store.create(createArgs, 'tool:create_artifact');
    expect(meta).toMatchObject({ id: 'art:abc123', name: 'Flight shortlist', kind: 'shortlist', revision: 1, taint: 'external' });
    expect(meta.byte_size).toBe(new TextEncoder().encode(createArgs.body_markdown).length);
    expect(store.list()).toHaveLength(1);
    expect(JSON.stringify(store.list())).not.toContain('Early flight');
    const first = await store.read(meta.id, 0, 10);
    expect(first).toMatchObject({ text: '# Options\n', total_chars: createArgs.body_markdown.length, next_offset: 10 });
    const rest = await store.read(meta.id, 10, 8000);
    expect(rest!.text).toBe(createArgs.body_markdown.slice(10));
    expect(rest!.next_offset).toBeNull();
  });

  it('revise is compare-and-swap: a stale expected_revision conflicts and writes nothing', async () => {
    const store = book();
    const meta = await store.create(createArgs, 'tool:create_artifact');
    const stale = await store.revise({ artifact_id: meta.id, expected_revision: 2, body_markdown: 'clobber' }, 'tool:revise_artifact');
    expect(stale).toEqual({ status: 'conflict', current_revision: 1 });
    expect((await store.read(meta.id, 0, 8000))!.text).toBe(createArgs.body_markdown);
    const ok = await store.revise({ artifact_id: meta.id, expected_revision: 1, body_markdown: '# v2' }, 'tool:revise_artifact');
    expect(ok).toMatchObject({ status: 'ok', meta: { revision: 2, r2_key: `artifacts/${meta.id}/r2` } });
    expect((await store.read(meta.id, 0, 8000))!.text).toBe('# v2');
    expect(store.byId(meta.id)!.byte_size).toBe(4);
  });

  it('revise and read report not_found for unknown ids; a missing body reads as not_found, never invented content', async () => {
    const store = book();
    expect(await store.revise({ artifact_id: 'art:nope', expected_revision: 1, body_markdown: 'x' }, 'tool:revise_artifact')).toEqual({ status: 'not_found' });
    expect(await store.read('art:nope', 0, 100)).toBeNull();
    const bodies = inMemoryArtifactBodies();
    const meta = await artifactBook(fakeSql() as never, bodies, clock, () => 'abc123').create(createArgs, 'tool:create_artifact');
    const orphan = artifactBook(fakeSql() as never, bodies, clock, () => 'zzz999');
    // a fresh book over a different sql (empty rows) never sees it; a book sharing the sql but
    // with an emptied body store reports unreadable instead of hallucinating:
    const sql = fakeSql();
    const shared = artifactBook(sql as never, bodies, clock, () => 'abc123');
    await shared.create(createArgs, 'tool:create_artifact');
    const lost = artifactBook(sql as never, inMemoryArtifactBodies(), clock, () => 'abc123');
    expect(await lost.read('art:abc123', 0, 100)).toBeNull();
    expect(meta.id).toBe('art:abc123');
    expect(orphan.byId(meta.id)).toBeNull();
  });
});

describe('artifact handlers (A5)', () => {
  const handlers = artifactHandlers(book());
  const byName = (name: string) => handlers.find((h) => h.name === name)!;

  it('create returns a taint-null mutation ack with the id and revision', async () => {
    const result = await byName('create_artifact').handle(createArgs as never);
    expect(result).toMatchObject({ ok: true, data: { artifact_id: 'art:abc123', revision: 1, delivery: { status: 'saved_internal', url: null, audience: 'unverified' } }, source_taint: null });
    expect(JSON.stringify(result)).not.toContain('Early flight');
  });

  it('keeps internal storage distinct from publication for create and revise', async () => {
    const store = book();
    const hs = artifactHandlers(store);
    const create = hs.find(h => h.name === 'create_artifact')!;
    const revise = hs.find(h => h.name === 'revise_artifact')!;
    const created = await create.handle(createArgs as never);
    const revised = await revise.handle({artifact_id:'art:abc123',expected_revision:1,body_markdown:'updated'} as never);
    for (const result of [created,revised]) {
      expect(result).toMatchObject({ok:true,data:{delivery:{status:'saved_internal',url:null,audience:'unverified'}}});
      expect(JSON.stringify(result)).not.toContain('https://');
    }
    expect(create.description).toContain('Never build a URL');
    expect(create.description).toContain('delivery is unavailable');
    expect((await store.read('art:abc123',0,100))!.text).toBe('updated');
  });

  it('read stamps every result external and never leaks a body on the failure arm', async () => {
    expect(EXTERNAL_ORIGIN_TOOLS).toContain('read_artifact');
    await byName('create_artifact').handle(createArgs as never);
    const ok = await byName('read_artifact').handle({ artifact_id: 'art:abc123', offset: 0, length: 4000 } as never);
    expect(ok).toMatchObject({ ok: true, source_taint: 'external', data: { artifact_id: 'art:abc123', total_chars: createArgs.body_markdown.length, next_offset: null } });
    const missing = await byName('read_artifact').handle({ artifact_id: 'art:nope', offset: 0, length: 4000 } as never);
    expect(missing).toMatchObject({ ok: false, code: 'not_found', source_taint: 'external' });
  });

  it('revise conflict names the current revision so the model can retry correctly', async () => {
    const store = book();
    const hs = artifactHandlers(store);
    await hs.find((h) => h.name === 'create_artifact')!.handle(createArgs as never);
    const conflict = await hs.find((h) => h.name === 'revise_artifact')!.handle({ artifact_id: 'art:abc123', expected_revision: 9, body_markdown: 'x' } as never);
    expect(conflict).toMatchObject({ ok: false, code: 'rejected' });
    expect((conflict as { error: string }).error).toContain('revision 1');
    const unknown = await hs.find((h) => h.name === 'revise_artifact')!.handle({ artifact_id: 'art:nope', expected_revision: 1, body_markdown: 'x' } as never);
    expect(unknown).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('list filters by kind and stays metadata-only', async () => {
    const store = seqBook();
    const hs = artifactHandlers(store);
    await hs.find((h) => h.name === 'create_artifact')!.handle(createArgs as never);
    await hs.find((h) => h.name === 'create_artifact')!.handle({ name: 'Research brief', kind: 'research', body_markdown: '# Findings' } as never);
    const all = await hs.find((h) => h.name === 'list_artifacts')!.handle({} as never);
    expect((all as { data: { artifacts: unknown[] } }).data.artifacts).toHaveLength(2);
    const filtered = await hs.find((h) => h.name === 'list_artifacts')!.handle({ kind: 'research' } as never);
    const data = (filtered as { data: { artifacts: { name: string }[] } }).data;
    expect(data.artifacts).toHaveLength(1);
    expect(data.artifacts[0]!.name).toBe('Research brief');
    expect(JSON.stringify(data)).not.toContain('Findings');
  });

  it('writes stay on the owner-confirmed write ACLs; reads on the explore/user read ACLs - nothing else', () => {
    for (const trigger of TOOL_PERMISSIONS.brief ?? []) expect(trigger).not.toMatch(/artifact/);
    expect(TOOL_PERMISSIONS.handoff_act).toEqual(expect.arrayContaining(['create_artifact', 'revise_artifact']));
    expect(TOOL_PERMISSIONS.user_message).toEqual(expect.arrayContaining(['create_artifact', 'revise_artifact', 'list_artifacts', 'read_artifact']));
    expect(TOOL_PERMISSIONS.handoff_explore).toEqual(expect.arrayContaining(['list_artifacts', 'read_artifact']));
    expect(TOOL_PERMISSIONS.handoff_explore).not.toContain('create_artifact');
    for (const [trigger, tools] of Object.entries(TOOL_PERMISSIONS)) {
      if (['handoff_act', 'user_message'].includes(trigger)) continue;
      expect(tools).not.toContain('create_artifact');
      expect(tools).not.toContain('revise_artifact');
      if (trigger !== 'handoff_explore') {
        expect(tools).not.toContain('list_artifacts');
        expect(tools).not.toContain('read_artifact');
      }
    }
  });
});


describe('R2 owner artifact bodies', () => {
  const bucket = () => {
    const objects = new Map<string, string>();
    const calls: string[] = [];
    return {
      objects, calls,
      binding: {
        async put(key: string, body: string) { calls.push(key); objects.set(key, body); },
        async get(key: string) { calls.push(key); const body = objects.get(key); return body === undefined ? null : { async text() { return body; } }; },
      } as unknown as R2Bucket,
    };
  };

  it('same logical id in separate owners never overwrites or reads the other body, including revise and restart', async () => {
    const shared = bucket();
    const sqlA = fakeSql();
    const sqlB = fakeSql();
    const make = (sql: ReturnType<typeof fakeSql>, owner: string) => artifactBook(sql as never, r2ArtifactBodies(shared.binding, owner), clock, () => 'same-id');
    const a = make(sqlA, 'owner-a');
    const b = make(sqlB, 'owner-b');
    const metaA = await a.create({ ...createArgs, body_markdown: 'owner A private' }, 'test');
    const metaB = await b.create({ ...createArgs, body_markdown: 'owner B private' }, 'test');
    expect(metaA.id).toBe(metaB.id);
    expect((await a.read(metaA.id, 0, 8000))?.text).toBe('owner A private');
    expect((await b.read(metaB.id, 0, 8000))?.text).toBe('owner B private');
    await a.revise({ artifact_id: metaA.id, expected_revision: 1, body_markdown: 'owner A revision' }, 'test');
    await b.revise({ artifact_id: metaB.id, expected_revision: 1, body_markdown: 'owner B revision' }, 'test');
    expect((await make(sqlA, 'owner-a').read(metaA.id, 0, 8000))?.text).toBe('owner A revision');
    expect((await make(sqlB, 'owner-b').read(metaB.id, 0, 8000))?.text).toBe('owner B revision');
    expect(shared.objects.size).toBe(4);
    expect(shared.calls.every((key) => key.startsWith('artifacts/by-owner/'))).toBe(true);
  });

  it('does not read legacy unscoped bodies, even when metadata references them', async () => {
    const shared = bucket();
    shared.objects.set('artifacts/art:legacy', 'legacy cannot be attributed by a shared key');
    const store = r2ArtifactBodies(shared.binding, 'owner-a');
    expect(await store.get('artifacts/art:legacy')).toBeNull();
    expect(shared.calls).not.toContain('artifacts/art:legacy');
  });

  it('encodes namespaces and logical keys injectively instead of joining path segments', async () => {
    const shared = bucket();
    const a = r2ArtifactBodies(shared.binding, 'a/b');
    const b = r2ArtifactBodies(shared.binding, 'a%2Fb');
    await a.put('artifacts/art:x/r2', 'slash owner');
    await b.put('artifacts/art:x/r2', 'percent owner');
    expect(await a.get('artifacts/art:x/r2')).toBe('slash owner');
    expect(await b.get('artifacts/art:x/r2')).toBe('percent owner');
    expect(shared.objects.size).toBe(2);
    expect([...shared.objects.keys()].every((key) => key.split('/').length === 4)).toBe(true);
  });

  it('refuses a missing or empty owner scope rather than silently using the shared namespace', () => {
    const shared = bucket();
    for (const owner of ['', ' ', undefined, null, 42]) {
      expect(() => r2ArtifactBodies(shared.binding, owner as string)).toThrow('Artifact owner scope is required');
    }
    expect(shared.calls).toEqual([]);
  });
});
