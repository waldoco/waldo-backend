import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { readMemoryResultSchema } from '@waldo/contracts';
import { claimStore, type ClaimStore } from '../src/memory/claims';
import { forgetPurge } from '../src/memory/forget-purge';
import { semanticRecallFromEnv, type SemanticRecall } from '../src/memory/semantic-recall';
import { memoryHandlers, type MemoryToolContext } from '../src/tools/live/memory';
import { fakeEmbeddings, type FakeEmbeddings } from './support/fake-embeddings';

// Semantic recall through the real memory tools, with the flag on: a paraphrase finds the claim, and once the owner forgets
// it, its row in claim_vectors is gone in the forget's own commit and no question brings it back. Synthetic fixtures only.
const OWNER = 'owner:1';
const CHAT = 'telegram-1';
const DENTIST = 'Dr Rao does the teeth cleaning, at the clinic on 4th Cross';
let sequence = 0;
type World = Readonly<{ sql: SqlStorage; store: ClaimStore; semantic: SemanticRecall; ai: FakeEmbeddings; settle: () => Promise<void>; tool: (name: string, args: unknown, ctx: MemoryToolContext) => Promise<unknown> }>;
const inOwner = <R>(work: (world: World) => R | Promise<R>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`forget-semantic-${sequence++}`)), (_instance, state) => {
    const sql = state.storage.sql, transaction = <T>(fn: () => T) => state.storage.transactionSync(fn);
    const store = claimStore(sql, transaction);
    const ai = fakeEmbeddings();
    const background: Promise<unknown>[] = [];
    const semantic = semanticRecallFromEnv({ MEMORY_SEMANTIC_RECALL: '1', AI: ai }, { sql, transaction, defer: (job) => background.push(job) })!;
    const handlers = memoryHandlers({ sql, store, transaction, conversationRef: CHAT, hideHistory: async () => undefined, semantic });
    const tool = async (name: string, args: unknown, ctx: MemoryToolContext) => { const handler = handlers.find((each) => each.name === name)!; return handler.handle(handler.schema.parse(args), ctx); };
    return work({ sql, store, semantic, ai, tool, settle: async () => { while (background.length) await background.shift(); } });
  });
const ownerSays = (text: string) => ({
  authenticatedUserId: OWNER, trigger: 'user_message',
  memoryTurn: { ownerId: OWNER, conversationRef: CHAT, current: { message_ref: 'tg-1', text }, recent: [] },
}) as unknown as MemoryToolContext;
const machine = { authenticatedUserId: OWNER, trigger: 'user_message' } as unknown as MemoryToolContext;
const texts = (result: unknown) => (result as { data: { claims: { text: string }[] } }).data.claims.map((claim) => claim.text);
const vectors = (sql: SqlStorage) => sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM claim_vectors').one().n;

describe('semantic recall through the memory tools, flag on', () => {
  it('remember embeds after its commit; read_memory finds the claim by a paraphrase; forget_memory takes the vector with the claim', async () => {
    await inOwner(async ({ sql, ai, tool, settle }) => {
      expect(await tool('remember', { kind: 'fact', text: DENTIST, evidence_quote: 'Dr Rao does the teeth cleaning' }, ownerSays(DENTIST))).toMatchObject({ ok: true, data: { status: 'stored' } });
      await settle();
      expect(vectors(sql)).toBe(1);
      expect(ai.inputs).toEqual([DENTIST]);

      const found = await tool('read_memory', { query: 'my dentist' }, machine);
      expect(texts(found)).toEqual([DENTIST]);
      expect(readMemoryResultSchema.safeParse((found as { data: unknown }).data).success).toBe(true);

      expect(await tool('forget_memory', { topic: 'Dr Rao', scope_note: 'the dentist' }, ownerSays('please forget Dr Rao'))).toMatchObject({ ok: true, data: { removed_ids: [1] } });
      expect(vectors(sql)).toBe(0);
      expect(texts(await tool('read_memory', { query: 'my dentist' }, machine))).toEqual([]);
      expect(texts(await tool('read_memory', { query: 'who looks after my teeth' }, machine))).toEqual([]);
      await settle();
      expect(vectors(sql)).toBe(0);
    });
  });

  it('read_memory falls back to words when Workers AI fails', async () => {
    await inOwner(async ({ store, semantic, ai, tool }) => {
      store.add({ kind: 'fact', text: DENTIST, source: 'stated', evidence: 'x', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-26T09:00:00Z');
      await semantic.sync();
      ai.fail = true;
      expect(texts(await tool('read_memory', { query: 'my dentist' }, machine))).toEqual([]);
      expect(texts(await tool('read_memory', { query: 'clinic' }, machine))).toEqual([DENTIST]);
    });
  });

  it('a topic forget run by the purge job drops the vectors of every claim it deletes or redacts', async () => {
    await inOwner(async ({ sql, store, semantic }) => {
      store.add({ kind: 'fact', text: DENTIST, source: 'stated', evidence: 'x', origin: 'owner', source_ref: 'owner, tg-1' }, '2026-10-26T09:00:00Z');
      store.add({ kind: 'fact', text: 'Coffee with Meera every Friday', source: 'stated', evidence: 'y', origin: 'owner', source_ref: 'owner, tg-2' }, '2026-10-26T09:00:00Z');
      await semantic.sync();
      expect(vectors(sql)).toBe(2);
      const job = forgetPurge({ sql, store, stores: [], now: () => Date.parse('2026-10-26T10:00:00Z'), arm: async () => undefined });
      await job.track(['Rao'], 'everywhere');
      expect(await semantic.near('my dentist')).toEqual([]);
      expect(sql.exec<{ claim_id: number }>('SELECT claim_id FROM claim_vectors').toArray()).toEqual([{ claim_id: 2 }]);
    });
  });
});
