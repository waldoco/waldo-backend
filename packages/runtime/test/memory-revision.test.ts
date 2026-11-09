import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appControlProjectionV1Schema } from '../../contracts/src/app/controls';
import { applyClaimOps, applyPromotion, claimStore, memoryRevision, type ClaimStore } from '../src/memory/claims';
import { confirmWelcomeNode, correctWelcomeNode } from '../src/onboarding/welcome';
import { ensureSchema } from '../src/tracer/schema';

// An open app screen learns that memory changed from one per-owner count on the day view. Every writer of claims, patterns
// and links moves it inside its own transaction, whatever started the write; re-reading a claim does not.
vi.mock('openai', () => ({ default: class { responses = { create: async () => { throw new Error('memory revision fixture forbids model calls'); } }; } }));
const { OwnerDO } = await import('../src/channels/owner-do');
const AT = '2026-10-30T04:00:00Z', LATER = '2026-10-31T04:00:00Z';
let sequence = 0;
const withStore = <T>(fn: (store: ClaimStore, sql: SqlStorage, transaction: <R>(work: () => R) => R) => T, name = `memory-revision-${sequence++}`) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), (_instance, state) => {
    const transaction = <R>(work: () => R) => state.storage.transactionSync(work);
    return fn(claimStore(state.storage.sql, transaction), state.storage.sql, transaction);
  });
const said = (store: ClaimStore, text: string, at = AT) => {
  store.add({ kind: 'observation', text, source: 'stated', evidence: `"${text}"`, origin: 'owner', source_ref: `owner, tg-${sequence++}` }, at);
  return store.allClaims().find((claim) => claim.text === text)!.id;
};

describe('memory_revision', () => {
  it('moves with every memory writer and never with a re-read', async () => {
    await withStore((store, sql) => {
      const moved: string[] = [];
      const step = (name: string, write: () => unknown) => { const before = memoryRevision(sql); write(); if (memoryRevision(sql) > before) moved.push(name); };
      expect(memoryRevision(sql)).toBe(0);
      let first = 0, second = 0, inferred = 0, read = 0, node = 0, other = 0;
      step('add', () => { first = said(store, 'Writes before ten'); second = said(store, 'Mutes chat until noon', LATER); });
      step('seen', () => store.seen(first, LATER));
      step('add inferred', () => { store.add({ kind: 'preference', text: 'Prefers tea', source: 'inferred', evidence: 'read', origin: 'agent' }, AT); inferred = store.claims().find((claim) => claim.text === 'Prefers tea')!.id; });
      step('nightly confirm', () => store.confirm(inferred, 'owner agreed', AT));
      step('owner confirm', () => store.ownerGround(inferred, AT, 'owner, console'));
      step('pin', () => store.pin(inferred, 'profile', 1));
      step('unpin', () => store.unpin(inferred));
      step('correct', () => store.correct(first, { kind: 'observation', text: 'Writes before eleven', source: 'stated', evidence: 'x', origin: 'owner', source_ref: 'owner, tg-fix' }, AT));
      step('dismiss', () => store.setStatus(inferred, 'dismissed'));
      step('node', () => { node = store.saveNode({ id: null, domain: 'work', label: 'Deep mornings', summary: 'Focus first', strength: 0.5, status: 'active', supporting_spots: [second] }, AT); other = store.saveNode({ id: null, domain: 'work', label: 'Quiet noons', summary: 'Chat later', strength: 0.5, status: 'active', supporting_spots: [second] }, AT); });
      step('node edit', () => store.saveNode({ ...store.nodes().find((row) => row.id === node)!, strength: 0.6, supporting_spots: [second] }, AT));
      step('edge', () => store.saveEdge({ from_id: node, to_id: other, relation: 'co-occurs with', strength: 0.4, evidence_count: 1 }));
      step('welcome read', () => { store.add({ kind: 'observation', text: 'Investor threads first', source: 'inferred', evidence: 'welcome build', origin: 'untrusted', source_ref: 'welcome:gmail:t1' }, AT); read = store.allClaims().find((claim) => claim.text === 'Investor threads first')!.id; });
      const mail = store.saveNode({ id: null, domain: 'work', label: 'Investor mornings', summary: 'Mail first', strength: 0.5, status: 'active', supporting_spots: [read] }, AT);
      step('node confirm', () => confirmWelcomeNode(store, mail, AT));
      step('node correct', () => correctWelcomeNode(store, mail, 'Investors after standup', AT));
      step('promotion', () => applyPromotion(store, JSON.stringify({ nodes: [{ id: node, domain: 'work', label: 'Deep mornings', summary: 'Focus before noon', strength: 0.7, status: 'active', supporting_spots: [second, store.claims().find((claim) => claim.text === 'Writes before eleven')!.id], durable: true, reason: 'two days' }], edges: [], promoted: [] }), LATER));
      step('chat ops', () => applyClaimOps(store, JSON.stringify({ add: [{ kind: 'fact', text: 'Lives in Pune', source: 'stated', evidence: 'Lives in Pune', touches_forgotten: false, aliases_touch_forgotten: false, aliases: [] }], seen: [], confirm: [], dismiss: [], corrections: [], forget_claims: [], forget_nodes: [], forget_topic: null }), AT));
      step('purge', () => store.purge([second], AT));
      step('settle', () => store.settle([second]));
      step('forget node', () => store.forgetNode(node));
      step('forget', () => store.forget(inferred));
      expect(moved).toEqual(['add', 'add inferred', 'nightly confirm', 'owner confirm', 'pin', 'unpin', 'correct', 'dismiss', 'node', 'node edit', 'edge', 'welcome read', 'node confirm', 'node correct', 'promotion', 'chat ops', 'purge', 'settle', 'forget node', 'forget']);
    });
  });

  it('a write that rolls back leaves it where it was', async () => {
    await withStore((store, sql, transaction) => {
      said(store, 'Writes before ten');
      const before = memoryRevision(sql);
      expect(() => transaction(() => { said(store, 'Never kept'); throw new Error('abandoned'); })).toThrow('abandoned');
      expect(store.allClaims().map((claim) => claim.text)).not.toContain('Never kept');
      expect(memoryRevision(sql)).toBe(before);
    });
  });

  it('leaves nothing in storage that changes what a reverted Worker\'s writers count: each still changes exactly one row', async () => {
    await withStore((store, sql) => {
      store.add({ kind: 'fact', text: 'Lives in Pune', source: 'stated', evidence: 'Lives in Pune', origin: 'owner', source_ref: 'owner, tg-pin' }, AT);
      const id = store.allClaims().find((claim) => claim.text === 'Lives in Pune')!.id;
      expect(store.pin(id, 'profile', 1)).toBe(true);
      expect(sql.exec("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name NOT LIKE 'claim_recall_%'").toArray()).toEqual([]);
      // The writers' row-count checks as they read before memory_revision, run on storage this store has opened.
      expect(sql.exec(`UPDATE claims SET origin = 'owner', verification_status = 'owner-grounded',
        source = CASE WHEN source IN ('inferred', 'waldo_confirmed') THEN 'confirmed' ELSE source END,
        source_ref = COALESCE(source_ref, ?), evidence = evidence || ' | confirmed: ' || ?, last_seen_at = ?
        WHERE id = ? AND status IN ('active', 'promoted')`, 'owner, console', 'owner, console', AT, id).rowsWritten).toBe(1);
      expect(sql.exec('UPDATE claims SET pinned = NULL, pin_order = NULL WHERE id = ? AND pinned IS NOT NULL', id).rowsWritten).toBe(1);
      expect(sql.exec("UPDATE claims SET status = 'superseded', valid_to = ? WHERE id = ? AND status = 'active'", AT, id).rowsWritten).toBe(1);
    });
  });

  it('is each owner\'s own: a write for one owner never moves another\'s', async () => {
    const a = `memory-revision-owner-a-${sequence++}`, b = `memory-revision-owner-b-${sequence++}`;
    await withStore((store) => said(store, 'Owner B note'), b);
    const bBefore = await withStore((_store, sql) => memoryRevision(sql), b);
    await withStore((store) => { said(store, 'Owner A note'); said(store, 'Owner A second'); }, a);
    expect(await withStore((_store, sql) => memoryRevision(sql), b)).toBe(bBefore);
  });
});

describe('the day view carries it from controls=8', () => {
  const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9c', HASH = 'a'.repeat(64);
  const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
  beforeEach(() => {
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
      const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
      if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
      if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
      if (fn === 'console_session_inventory') return Response.json([{ session: HASH, created_at: new Date().toISOString(), last_seen_at: new Date().toISOString(), expires_at: new Date(Date.now() + 3_600_000).toISOString(), rotated_to: null, signed_in_at: new Date().toISOString() }]);
      if (fn === 'assert_channel_presence') return Response.json(false);
      if (fn === 'google_connections' || fn === 'connections_list' || fn === 'health_log_recent') return Response.json([]);
      return Response.json(null);
    });
  });
  afterEach(() => { vi.unstubAllGlobals(); });
  const read = async (owner: InstanceType<typeof OwnerDO>, name: string, contract?: string) => {
    const response = await owner.fetch(new Request('https://telegram-owner/app/v1/controls?view=day', { headers: { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': HASH, ...(contract ? { 'x-waldo-app-contract': contract } : {}) } }));
    if (response.status !== 200) throw new Error(`day read ${response.status} ${await response.text()}`);
    const parsed = appControlProjectionV1Schema.parse(await response.json());
    if (parsed.view !== 'day') throw new Error('not the day view');
    return parsed;
  };

  it('moves after a memory change, never reaches a build below 8, and never makes a day action stale', async () => {
    const name = `memory-revision-day-${sequence++}`;
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
      ensureSchema(state.storage); state.storage.kv.put('do_name', name);
      await state.storage.put('origin', 'https://fixture.invalid');
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined, GOOGLE_CLIENT_ID: 'synthetic-client', GOOGLE_CLIENT_SECRET: 'synthetic-secret' });
      try {
        const before = await read(owner, name, 'controls=8');
        expect(before.data.memory_revision).toBeTypeOf('number');
        said(claimStore(state.storage.sql, (work) => state.storage.transactionSync(work)), 'Writes before ten');
        const after = await read(owner, name, 'controls=8');
        expect(after.data.memory_revision).toBeGreaterThan(before.data.memory_revision!);
        expect(after.revision).toBe(before.revision);
        for (const contract of [undefined, 'controls=7', 'controls=3']) {
          const older = await read(owner, name, contract);
          expect('memory_revision' in older.data).toBe(false);
          expect(older.revision).toBe(after.revision);
        }
      } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
    });
  });
});
