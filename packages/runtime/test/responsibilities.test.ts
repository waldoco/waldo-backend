import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { closeResponsibilityArgsSchema, trackResponsibilityArgsSchema } from '@waldo/contracts';
import { loopBook } from '../src/channels/loops';
import { responsibilityBook, responsibilityHandlers } from '../src/channels/responsibilities';
import { delegateTaskHandler, CHILD_READ_TOOLS } from '../src/conversation/subagent';

let sequence = 0;
const withSql = <T>(fn: (sql: SqlStorage) => T) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`resp-${sequence++}`)), (_instance, state) => fn(state.storage.sql));
const mk = (sql: SqlStorage) => { let n = 0; return responsibilityBook(sql, { newId: () => String(++n), now: () => 1000 + n }); };
const call = (handler: { schema: { parse(v: unknown): unknown }; handle: unknown }, args: unknown) => (handler.handle as (a: unknown, c: unknown) => Promise<{ ok: boolean; data?: unknown }>)(handler.schema.parse(args), { trigger: 'user_message' });
const delegateArgs = (task: string, extra: object = {}) => delegateArgsSchemaParse({ task, ...extra });
import { delegateTaskArgsSchema } from '@waldo/contracts';
const delegateArgsSchemaParse = (v: unknown) => delegateTaskArgsSchema.parse(v);
const ctx = {} as never;

describe('responsibilities', () => {
  it('a plain question creates nothing; tracking creates a record with a dependency-ordered todo', async () => {
    await withSql(async (sql) => {
      const book = mk(sql);
      expect(book.list('all')).toEqual([]);
      const [track, , list] = responsibilityHandlers(book);
      await call(track!, { title: 'Plan Bangalore trip', intent: 'Prepare only, no bookings', items: [{ title: 'flights' }, { title: 'hotel' }, { title: 'combine', depends_on: [0, 1] }] });
      const listed = (await call(list!, {})).data as { id: string; items: { id: string; depends_on: string[] }[] }[];
      expect(listed).toHaveLength(1);
      expect(listed[0]!.items[2]!.depends_on).toEqual([listed[0]!.items[0]!.id, listed[0]!.items[1]!.id]);
    });
  });

  it('rejects closing without an evidence ref, and closes with one', async () => {
    await withSql(async (sql) => {
      const book = mk(sql);
      expect(closeResponsibilityArgsSchema.safeParse({ id: 'r1', outcome: 'done' }).success).toBe(false);
      expect(closeResponsibilityArgsSchema.safeParse({ id: 'r1', outcome: 'done', evidence_ref: '   ' }).success).toBe(false);
      const { responsibility } = book.track(trackResponsibilityArgsSchema.parse({ title: 't', intent: 'i' }), 'user_message');
      expect(book.close({ id: responsibility.id, outcome: 'done', evidence_ref: ' ' })).toBe(false);
      expect(book.get(responsibility.id)!.status).toBe('open');
      expect(book.close({ id: responsibility.id, outcome: 'done', evidence_ref: 'owner: yes that is done' })).toBe(true);
      expect(book.get(responsibility.id)).toMatchObject({ status: 'done', closed_by_evidence: 'owner: yes that is done' });
    });
  });

  it('three parallel children write three items and the parent reads them all', async () => {
    await withSql(async (sql) => {
      const book = mk(sql);
      const { items } = book.track(trackResponsibilityArgsSchema.parse({ title: 'research', intent: 'compare', items: [{ title: 'a' }, { title: 'b' }, { title: 'c' }] }), 'user_message');
      const delegate = delegateTaskHandler(async (task) => ({ exit: 'completed', text: `found ${task}` }), { book });
      const results = await Promise.all(items.map((entry) => delegate.handle(delegateArgs(`look up ${entry.title}`, { item_id: entry.id }), ctx)));
      expect(results.every((result) => result.ok)).toBe(true);
      expect(book.items(items[0]!.responsibility_id).map((entry) => [entry.status, entry.result_ref])).toEqual([['done', 'found look up a'], ['done', 'found look up b'], ['done', 'found look up c']]);
    });
  });

  it('a redirect mid-run supersedes the late result', async () => {
    await withSql(async (sql) => {
      const book = mk(sql);
      const { items } = book.track(trackResponsibilityArgsSchema.parse({ title: 'r', intent: 'i', items: [{ title: 'a' }] }), 'user_message');
      const id = items[0]!.id;
      const delegate = delegateTaskHandler(async () => { book.update({ item_id: id, status: 'pending', result: 'owner redirected' }); return { exit: 'completed', text: 'stale answer' }; }, { book });
      const result = await delegate.handle(delegateArgs('x', { item_id: id }), ctx);
      expect(result.ok).toBe(false);
      expect(book.item(id)).toMatchObject({ status: 'pending', result_ref: 'owner redirected', superseded_result: 'stale answer' });
    });
  });

  it('cancel fences a background child so its late result is not applied', async () => {
    await withSql(async (sql) => {
      const book = mk(sql);
      const { items } = book.track(trackResponsibilityArgsSchema.parse({ title: 'r', intent: 'i', items: [{ title: 'a' }] }), 'user_message');
      const id = items[0]!.id;
      let job: { revision: number } | null = null;
      const delegate = delegateTaskHandler(async () => ({ exit: 'completed', text: '' }), { book, startBackground: async (j) => { job = j; return true; } });
      expect(await delegate.handle(delegateArgs('long', { item_id: id, background: true }), ctx)).toMatchObject({ ok: true, data: { status: 'started' } });
      expect(book.running().map((entry) => entry.id)).toEqual([id]);
      book.cancel(id);
      expect(book.finishWorker(id, job!.revision, { status: 'done', result: 'late' })).toBe('superseded');
      expect(book.item(id)!.status).toBe('cancelled');
    });
  });

  it('background needs a step and a starter; children cannot hold effect tools', async () => {
    await withSql(async (sql) => {
      const delegate = delegateTaskHandler(async () => ({ exit: 'completed', text: '' }), { book: mk(sql) });
      expect(await delegate.handle(delegateArgs('x', { background: true }), ctx)).toMatchObject({ ok: false });
      expect(await delegate.handle(delegateArgs('x', { tools: ['send_email'] }), ctx)).toMatchObject({ ok: false });
      expect(CHILD_READ_TOOLS).toContain('read_document');
      expect(CHILD_READ_TOOLS).not.toContain('send_email');
    });
  });

  it('carries old open loops across with their ids', async () => {
    await withSql(async (sql) => {
      let n = 0;
      const loops = loopBook(sql, { newId: () => String(++n), now: () => 5 });
      const a = loops.open({ title: 'find physio', due: null });
      const b = loops.open({ title: 'call back', due: '2026-10-09' });
      loops.close(b.id, 'done');
      const book = mk(sql);
      expect(book.adoptLoops()).toBe(2);
      expect(book.adoptLoops()).toBe(0);
      expect(book.get(a.id)).toMatchObject({ title: 'find physio', status: 'open' });
      expect(book.get(b.id)).toMatchObject({ status: 'done', next_check_at: '2026-10-09' });
    });
  });
  it('adopts a source-backed hypothesis once without overwriting existing owner responsibility context', async () => {
    await withSql(async sql => {
      let n = 0;
      const loops = loopBook(sql, { newId: () => String(++n), now: () => 5 }), book = mk(sql);
      const first = loops.open({ title: 'Check the source', due: null });
      expect(book.adoptLoops(id => id === first.id ? 'A bounded source hypothesis, with completion unknown.' : null)).toBe(1);
      expect(book.get(first.id)!.intent).toContain('completion unknown');
      const second = loops.open({ title: 'Different check', due: null });
      expect(book.adoptLoops(id => id === first.id ? 'Overwrite old context' : 'A new hypothesis')).toBe(1);
      expect(book.get(first.id)!.intent).toContain('completion unknown');
      expect(book.get(second.id)!.intent).toBe('A new hypothesis');
    });
  });
});
