import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { MEMORY_CONTROL_PATH } from '../src/channels/dashboard-memory-actions';
import { readMemoryGraph } from '../src/channels/memory-graph';
import { claimStore, textFingerprint, turnMemoryPrompt, type ClaimStore } from '../src/memory/claims';
import { confirmWelcomeNode } from '../src/onboarding/welcome';

// A pattern left citing a note that was replaced or dismissed is still Waldo's words in storage. It stays out of every turn,
// but the owner must be able to see it, correct it or forget it. A note being forgotten, or one a forget still holds, keeps
// the pattern hidden as before.
const AT = '2026-10-30T04:00:00Z';
let sequence = 0;
const withStore = <T>(fn: (store: ClaimStore, sql: SqlStorage) => T) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`incomplete-node-${sequence++}`)), (_instance, state) =>
    fn(claimStore(state.storage.sql, (work) => state.storage.transactionSync(work)), state.storage.sql));
const read = (store: ClaimStore, text: string) => {
  store.add({ kind: 'observation', text, source: 'inferred', evidence: 'welcome build', origin: 'untrusted', source_ref: `welcome:gmail:t${sequence++}` }, AT);
  return store.allClaims().find((claim) => claim.text === text)!.id;
};
const mailNode = (store: ClaimStore) => {
  const supports = [read(store, 'Replies to investors before nine'), read(store, 'Books calls after lunch')];
  return { id: store.saveNode({ id: null, domain: 'work', label: 'Investor mornings', summary: 'Clears investor mail first thing', strength: 0.6, status: 'active', supporting_spots: supports }, AT), supports };
};
const owner = { kind: 'observation', source: 'stated', origin: 'owner', evidence: 'owner, console:spot.edit', source_ref: 'owner, console:spot.edit' };
const graphNode = (sql: SqlStorage, id: number) => readMemoryGraph(sql, 'memory').nodes.find((node) => node.local_id === id);

describe('a pattern whose note was replaced or dismissed', () => {
  it('is listed as incomplete when a note was replaced, never confirmed, and stays out of every turn', async () => {
    await withStore((store, sql) => {
      const { id, supports } = mailNode(store);
      expect(store.correct(supports[0]!, { ...owner, text: 'Replies to investors after standup' }, AT)).toBe(true);
      const graph = readMemoryGraph(sql, 'memory');
      expect(graph.state).toBe('available');
      expect(graph.nodes.find((node) => node.local_id === id)).toMatchObject({
        label: 'Investor mornings', confirmation: 'waldos_read',
        support: { state: 'incomplete', claim_ids: [`memory:claim:${supports[1]}`], unavailable_count: 1 },
      });
      expect(turnMemoryPrompt(store, 'hi')).not.toContain('Investor mornings');
    });
  });

  it('is listed as incomplete when a note was dismissed, even after the owner confirmed its wording', async () => {
    await withStore((store, sql) => {
      const { id, supports } = mailNode(store);
      expect(confirmWelcomeNode(store, id, AT)).toBe(true);
      store.setStatus(supports[1]!, 'dismissed');
      expect(graphNode(sql, id)).toMatchObject({ confirmation: 'waldos_read', support: { state: 'incomplete', claim_ids: [`memory:claim:${supports[0]}`], unavailable_count: 1 } });
      expect(turnMemoryPrompt(store, 'hi')).not.toContain('Investor mornings');
    });
  });

  it('stays hidden while a note it cites is being forgotten, was forgotten, is held by a forget, or never existed', async () => {
    await withStore((store, sql) => {
      const { id, supports } = mailNode(store);
      store.purge([supports[0]!], AT);
      expect(graphNode(sql, id)).toBeUndefined();
    });
    await withStore((store, sql) => {
      const { id, supports } = mailNode(store);
      store.setStatus(supports[0]!, 'forgotten');
      expect(graphNode(sql, id)).toBeUndefined();
    });
    await withStore((store, sql) => {
      const { id, supports } = mailNode(store);
      store.setStatus(supports[0]!, 'dismissed');
      sql.exec('INSERT INTO topic_purge_pending (fingerprint, topic, created_at) VALUES (?, ?, ?)', textFingerprint('before nine'), 'before nine', AT);
      expect(graphNode(sql, id)).toBeUndefined();
      expect(JSON.stringify(readMemoryGraph(sql, 'memory'))).not.toContain('Investor mornings');
    });
    await withStore((store, sql) => {
      const { id } = mailNode(store);
      sql.exec('UPDATE constellation_nodes SET supporting_spots = ? WHERE id = ?', JSON.stringify([999]), id);
      expect(graphNode(sql, id)).toBeUndefined();
    });
  });
});

describe('the owner reaches an incomplete pattern from the console', () => {
  const root = 'https://telegram-owner';
  type Read = { csrf: string; revision: string; data: { actions: string[]; review: { confirmation?: string } } };
  const consoleOwner = async (name: string) => {
    const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
    const token = await runInDurableObject(stub, (instance, state) => {
      Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
      const sessions = consoleAccess(state.storage);
      return sessions.grant();
    });
    const headers = (extra: Record<string, string> = {}) => ({ cookie: `waldo_console=${token}`, accept: 'application/json', ...extra });
    expect((await stub.fetch(`${root}${CONTROLS_PATH}?view=day`, { headers: headers() })).status).toBe(200);
    await runInDurableObject(stub, async (_instance, state) => {
      const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
      sessions[token] = { ...sessions[token]!, verified_at: Date.now() - 60_000 };
      await state.storage.put('console:sessions', sessions);
    });
    const seeded = await runInDurableObject(stub, (_instance, state) => {
      const store = claimStore(state.storage.sql, (work) => state.storage.transactionSync(work));
      const { id, supports } = mailNode(store);
      store.setStatus(supports[0]!, 'dismissed');
      return { id, target: `${state.id}:node:${id}` };
    });
    const control = (id: string) => stub.fetch(`${root}${MEMORY_CONTROL_PATH}?${new URLSearchParams({ id })}`, { headers: headers() });
    const act = async (action: string, value?: string) => {
      const current = await (await control(seeded.target)).json() as Read;
      return stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }),
        body: new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'memory', action, id: seeded.target, request_id: `${action.replace('.', '-')}-${crypto.randomUUID()}`, ...(value === undefined ? {} : { value }) }) });
    };
    const store = () => runInDurableObject(stub, (_instance, state) => ({ nodes: claimStore(state.storage.sql).nodes(), graph: readMemoryGraph(state.storage.sql, 'memory'), barriers: claimStore(state.storage.sql).barriers() }));
    return { ...seeded, control, act, store };
  };

  it('offers correct and forget only, and a confirm sent anyway changes nothing', async () => {
    const o = await consoleOwner('incomplete-node-actions');
    const read = await (await o.control(o.target)).json() as Read;
    expect(read.data.actions).toEqual(['node.correct', 'node.forget']);
    expect(read.data.review.confirmation).toBe('waldos_read');
    expect((await o.act('node.confirm')).status).toBe(409);
    expect((await o.store()).graph.nodes.find((node) => node.local_id === o.id)?.confirmation).toBe('waldos_read');
  });

  it('forget removes it and keeps it from being learned again', async () => {
    const o = await consoleOwner('incomplete-node-forget');
    expect((await o.act('node.forget')).status).toBe(200);
    const after = await o.store();
    expect(after.nodes.map((node) => node.id)).not.toContain(o.id);
    expect(after.barriers.some((barrier) => barrier.topic_hash === textFingerprint('Investor mornings'))).toBe(true);
  });

  it('correct makes it whole again, resting on the owner\'s words', async () => {
    const o = await consoleOwner('incomplete-node-correct');
    expect((await o.act('node.correct', 'Writes to investors after standup')).status).toBe(200);
    expect((await o.store()).graph.nodes.find((node) => node.local_id === o.id)).toMatchObject({ label: 'Writes to investors after standup', confirmation: 'confirmed', support: { state: 'stored_links', unavailable_count: 0 } });
  });
});
