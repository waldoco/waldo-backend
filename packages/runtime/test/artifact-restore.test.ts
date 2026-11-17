import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { TOOL_PERMISSIONS } from '@waldo/contracts';
import { artifactBook, artifactHandlers, inMemoryArtifactBodies, type ArtifactBodies } from '../src/channels/artifacts';
import { RECEIPT_TOOLS } from '../src/conversation/artifact-link-guard';

let sequence = 0;
const clock = { timezone: 'UTC', now: () => new Date('2026-11-06T10:00:00Z') };
const withBook = <T>(fn: (o: { book: ReturnType<typeof artifactBook>; bodies: ArtifactBodies; sql: SqlStorage }) => Promise<T>, bodies: ArtifactBodies = inMemoryArtifactBodies()) =>
  runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName(`artifact-restore-${sequence++}`)), async (_instance, state) =>
    fn({ book: artifactBook(state.storage.sql, bodies, clock, () => 'abc123'), bodies, sql: state.storage.sql }));
const text = async (book: ReturnType<typeof artifactBook>, id: string) => (await book.read(id, 0, 8000))?.text;

describe('artifact restore', () => {
  it('brings an earlier revision back as a new revision, and the restore can itself be undone', async () => {
    await withBook(async ({ book }) => {
      const meta = await book.create({ name: 'Trip plan', kind: 'document', body_markdown: 'v1: Goa on Friday' }, 'tool:create_artifact');
      await book.revise({ artifact_id: meta.id, expected_revision: 1, body_markdown: 'v2: wire the deposit to the new account' }, 'tool:revise_artifact');
      const restored = await book.restore({ artifact_id: meta.id, revision: 1, expected_revision: 2 }, 'tool:restore_artifact');
      expect(restored).toMatchObject({ status: 'ok', restored_from: 1, meta: { revision: 3, provenance: 'tool:restore_artifact' } });
      expect(await text(book, meta.id)).toBe('v1: Goa on Friday');
      const again = await book.restore({ artifact_id: meta.id, revision: 2, expected_revision: 3 }, 'tool:restore_artifact');
      expect(again).toMatchObject({ status: 'ok', meta: { revision: 4 } });
      expect(await text(book, meta.id)).toBe('v2: wire the deposit to the new account');
      expect(book.revisions(meta.id)).toEqual([1, 2, 3, 4]);
    });
  });

  it('is compare-and-swap: a stale expected_revision conflicts and writes nothing', async () => {
    await withBook(async ({ book }) => {
      const meta = await book.create({ name: 'Notes', kind: 'document', body_markdown: 'v1' }, 'test');
      await book.revise({ artifact_id: meta.id, expected_revision: 1, body_markdown: 'v2' }, 'test');
      expect(await book.restore({ artifact_id: meta.id, revision: 1, expected_revision: 1 }, 'test')).toEqual({ status: 'conflict', current_revision: 2 });
      expect(await text(book, meta.id)).toBe('v2');
      expect(book.byId(meta.id)!.revision).toBe(2);
    });
  });

  it('refuses the current revision, a later one, and an unknown artifact, writing nothing', async () => {
    await withBook(async ({ book }) => {
      const meta = await book.create({ name: 'Notes', kind: 'document', body_markdown: 'v1' }, 'test');
      expect(await book.restore({ artifact_id: meta.id, revision: 1, expected_revision: 1 }, 'test')).toEqual({ status: 'current' });
      expect(await book.restore({ artifact_id: meta.id, revision: 5, expected_revision: 1 }, 'test')).toEqual({ status: 'not_kept', kept: [1] });
      expect(await book.restore({ artifact_id: 'art:nope', revision: 1, expected_revision: 2 }, 'test')).toEqual({ status: 'not_found' });
      expect(book.byId(meta.id)!.revision).toBe(1);
    });
  });

  it('keeps the revision an older artifact was at once it is revised; revisions before that are not kept', async () => {
    await withBook(async ({ book, bodies, sql }) => {
      await bodies.put('artifacts/art:old/r3/k', 'from before revisions were kept');
      sql.exec(`INSERT INTO artifacts (id, name, kind, revision, byte_size, r2_key, provenance, taint, created_at, updated_at)
        VALUES ('art:old', 'Old', 'document', 3, 31, 'artifacts/art:old/r3/k', 'tool:revise_artifact', 'external', 1, 1)`);
      await book.revise({ artifact_id: 'art:old', expected_revision: 3, body_markdown: 'overwritten' }, 'test');
      expect(await book.restore({ artifact_id: 'art:old', revision: 2, expected_revision: 4 }, 'test')).toEqual({ status: 'not_kept', kept: [3, 4] });
      expect(await book.restore({ artifact_id: 'art:old', revision: 3, expected_revision: 4 }, 'test')).toMatchObject({ status: 'ok', meta: { revision: 5 } });
      expect(await text(book, 'art:old')).toBe('from before revisions were kept');
    });
  });

  it('a kept revision whose body cannot be read is reported, never restored empty', async () => {
    const stored = new Map<string, string>();
    const bodies: ArtifactBodies = { put: async (key, body) => { stored.set(key, body); }, get: async (key) => stored.get(key) ?? null };
    await withBook(async ({ book }) => {
      const meta = await book.create({ name: 'Notes', kind: 'document', body_markdown: 'v1' }, 'test');
      const first = book.byId(meta.id)!.r2_key;
      await book.revise({ artifact_id: meta.id, expected_revision: 1, body_markdown: 'v2' }, 'test');
      stored.delete(first);
      expect(await book.restore({ artifact_id: meta.id, revision: 1, expected_revision: 2 }, 'test')).toEqual({ status: 'body_unavailable' });
      expect(await text(book, meta.id)).toBe('v2');
    }, bodies);
  });

  it('two artifacts keep their own revisions', async () => {
    await withBook(async ({ sql, bodies }) => {
      let n = 0;
      const book = artifactBook(sql, bodies, clock, () => `id${++n}`);
      const a = await book.create({ name: 'A', kind: 'document', body_markdown: 'a1' }, 'test');
      const b = await book.create({ name: 'B', kind: 'document', body_markdown: 'b1' }, 'test');
      await book.revise({ artifact_id: b.id, expected_revision: 1, body_markdown: 'b2' }, 'test');
      expect(book.revisions(a.id)).toEqual([1]);
      expect(book.revisions(b.id)).toEqual([1, 2]);
      expect(await book.restore({ artifact_id: a.id, revision: 2, expected_revision: 1 }, 'test')).toEqual({ status: 'not_kept', kept: [1] });
    });
  });
});

describe('restore_artifact tool', () => {
  it('answers the new revision and the one it came from, with the same delivery receipt as a revise', async () => {
    await withBook(async ({ book }) => {
      const tools = artifactHandlers(book);
      const restore = tools.find((tool) => tool.name === 'restore_artifact')!;
      expect(restore.mutates_state).toBe(true);
      expect(restore.trigger_allowlist).toEqual(['user_message']);
      expect(TOOL_PERMISSIONS.user_message).toContain('restore_artifact');
      expect(RECEIPT_TOOLS.has('restore_artifact')).toBe(true);
      const meta = await book.create({ name: 'Notes', kind: 'document', body_markdown: 'v1' }, 'test');
      await book.revise({ artifact_id: meta.id, expected_revision: 1, body_markdown: 'v2' }, 'test');
      expect(await restore.handle({ artifact_id: meta.id, revision: 1, expected_revision: 2 } as never)).toEqual({
        ok: true,
        data: { artifact_id: meta.id, revision: 3, restored_from: 1, delivery: { status: 'saved_internal', url: null, audience: 'unverified' } },
        source_taint: null,
      });
    });
  });

  it('names the kept revisions when asked for one that is not kept, and the current revision on a conflict', async () => {
    await withBook(async ({ book }) => {
      const restore = artifactHandlers(book).find((tool) => tool.name === 'restore_artifact')!;
      const meta = await book.create({ name: 'Notes', kind: 'document', body_markdown: 'v1' }, 'test');
      await book.revise({ artifact_id: meta.id, expected_revision: 1, body_markdown: 'v2' }, 'test');
      const missing = await restore.handle({ artifact_id: meta.id, revision: 7, expected_revision: 2 } as never);
      expect(missing).toMatchObject({ ok: false, code: 'rejected' });
      expect((missing as { error: string }).error).toContain('1, 2');
      const stale = await restore.handle({ artifact_id: meta.id, revision: 1, expected_revision: 1 } as never);
      expect((stale as { error: string }).error).toContain('revision 2');
      const current = await restore.handle({ artifact_id: meta.id, revision: 2, expected_revision: 2 } as never);
      expect(current).toMatchObject({ ok: false, code: 'rejected' });
      expect(await restore.handle({ artifact_id: 'art:nope', revision: 1, expected_revision: 2 } as never)).toMatchObject({ ok: false, code: 'not_found' });
      expect(book.byId(meta.id)!.revision).toBe(2);
    });
  });
});
