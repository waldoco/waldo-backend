import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { MEMORY_CONTROL_PATH } from '../src/channels/dashboard-memory-actions';
import { claimStore, turnMemoryPrompt } from '../src/memory/claims';

// The owner confirms or corrects a pattern from the console, as the app does. A read from mail or calendar stays out of
// every turn until the owner confirms it, so without this the console could never bring one in.
const root = 'https://telegram-owner';
type Read = { csrf: string; revision: string; data: { actions: string[]; review: { sources?: string[]; confirmation?: string } } };
type Node = { id: number; label: string; summary: string; status: string; supporting_spots: string };

const owner = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
    return consoleAccess(state.storage).grant();
  });
  const headers = (extra: Record<string, string> = {}, cookie = token) => ({ cookie: `waldo_console=${cookie}`, accept: 'application/json', ...extra });
  expect((await stub.fetch(`${root}${CONTROLS_PATH}?view=day`, { headers: headers() })).status).toBe(200);
  const codeAge = (age: number) => runInDurableObject(stub, async (_instance, state) => {
    const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
    sessions[token] = { ...sessions[token]!, verified_at: Date.now() - age };
    await state.storage.put('console:sessions', sessions);
  });
  // A pattern Waldo read from the owner's mail: its supports are outside content until the owner confirms them.
  const seedRead = (status = 'active') => runInDurableObject(stub, (_instance, state) => {
    const sql = state.storage.sql;
    const claim = (text: string, pointer: string) => sql.exec<{ id: number }>("INSERT INTO claims (kind, text, source, evidence, origin, status, created_at, last_seen_at, source_ref, verification_status) VALUES ('observation', ?, 'inferred', 'read from a thread', 'untrusted', 'active', '2026-10-01', '2026-10-01', ?, 'provisional') RETURNING id", text, `welcome:gmail:${pointer}`).one().id;
    const supports = [claim('Replies to investors before 9am', 't1'), claim('Books calls after lunch', 't2')];
    return sql.exec<{ id: number }>("INSERT INTO constellation_nodes (domain, label, summary, strength, status, first_seen, last_confirmed, supporting_spots) VALUES ('work', 'Investor mornings', 'Clears investor mail first thing', 0.6, ?, '2026-10-01', '2026-10-01', ?) RETURNING id", status, JSON.stringify(supports)).one().id;
  });
  const node = (id: number) => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<Node>('SELECT * FROM constellation_nodes WHERE id = ?', id).toArray()[0]);
  const turnBlock = () => runInDurableObject(stub, (_instance, state) => turnMemoryPrompt(claimStore(state.storage.sql), 'what is on today'));
  const scoped = (id: number) => runInDurableObject(stub, (_instance, state) => `${state.id}:node:${id}`);
  const read = (id: string, cookie = token) => stub.fetch(`${root}${MEMORY_CONTROL_PATH}?${new URLSearchParams({ id })}`, { headers: headers({}, cookie) });
  const act = async (id: string, action: string, value?: string) => {
    const current = await (await read(id)).json() as Read;
    return stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'memory', action, id, request_id: `${action.replace('.', '-')}-${crypto.randomUUID()}`, ...(value === undefined ? {} : { value }) }) });
  };
  const supportsOf = async (id: number) => JSON.parse((await node(id))!.supporting_spots) as number[];
  const claimRef = (id: number) => runInDurableObject(stub, (_instance, state) => `${state.id}:claim:${id}`);
  return { stub, token, codeAge, seedRead, node, turnBlock, scoped, read, act, supportsOf, claimRef };
};

describe('console pattern confirm and correct', () => {
  it('confirm brings a read from mail into the next turn\'s memory block, and shows where it came from', async () => {
    const o = await owner('console-node-confirm');
    const id = await o.seedRead(), target = await o.scoped(id);
    expect(await o.turnBlock()).not.toContain('Investor mornings');
    const before = await (await o.read(target)).json() as Read;
    expect(before.data.actions).toEqual(['node.confirm', 'node.correct', 'node.forget']);
    expect(before.data.review).toMatchObject({ sources: ['gmail'], confirmation: 'waldos_read' });
    const confirmed = await o.act(target, 'node.confirm');
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toMatchObject({ receipt: { state: 'recorded' } });
    expect(await o.turnBlock()).toContain(`[n${id} · gmail · confirmed] Investor mornings: Clears investor mail first thing`);
    const after = await (await o.read(target)).json() as Read;
    expect(after.data.actions).toEqual(['node.correct', 'node.forget']);
    expect(after.data.review.confirmation).toBe('confirmed');
    const evidence = await runInDurableObject(o.stub, (_instance, state) => state.storage.sql.exec<{ evidence: string }>("SELECT evidence FROM claims WHERE source_ref LIKE 'welcome:gmail:%'").toArray().map((row) => row.evidence));
    expect(evidence).toEqual([expect.stringContaining('confirmed: owner, console:node.confirm'), expect.stringContaining('confirmed: owner, console:node.confirm')]);
  });

  it('correct needs a recent email code, then rewrites both the label and the summary in the owner\'s words', async () => {
    const o = await owner('console-node-correct');
    const id = await o.seedRead(), target = await o.scoped(id);
    await o.codeAge(3 * 60 * 60_000);
    const refused = await o.act(target, 'node.correct', 'Writes to investors after standup');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: 'step_up_required' });
    expect(await o.node(id)).toMatchObject({ label: 'Investor mornings', summary: 'Clears investor mail first thing' });
    await o.codeAge(60_000);
    const corrected = await o.act(target, 'node.correct', '  Writes to investors after standup  ');
    expect(corrected.status).toBe(200);
    expect(await o.node(id)).toMatchObject({ label: 'Writes to investors after standup', summary: 'Writes to investors after standup', status: 'active' });
    const block = await o.turnBlock();
    expect(block).toContain(`[n${id} · their words · confirmed] Writes to investors after standup`);
    expect(block).not.toContain('Investor mornings');
  });

  it('correct takes the owner\'s words up to the app\'s 140 characters, and refuses longer text or a credential, changing nothing', async () => {
    const o = await owner('console-node-correct-bounds');
    const id = await o.seedRead(), target = await o.scoped(id);
    await o.codeAge(60_000);
    for (const value of ['   ', 'x'.repeat(141), 'My API key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij']) {
      const refused = await o.act(target, 'node.correct', value);
      expect(refused.status).toBe(409);
      expect(await o.node(id)).toMatchObject({ label: 'Investor mornings', summary: 'Clears investor mail first thing' });
    }
    expect(await o.turnBlock()).not.toContain('sk-proj');
    expect((await o.act(target, 'node.correct', 'y'.repeat(140))).status).toBe(200);
    expect(await o.node(id)).toMatchObject({ label: 'y'.repeat(140), summary: 'y'.repeat(140) });
  });

  it('a node that is not active offers neither confirm nor correct, and a confirm sent anyway changes nothing', async () => {
    const o = await owner('console-node-stale');
    const id = await o.seedRead('stale'), target = await o.scoped(id);
    expect((await (await o.read(target)).json() as Read).data.actions).toEqual(['node.forget']);
    const refused = await o.act(target, 'node.confirm');
    expect(refused.status).toBe(409);
    expect(await o.turnBlock()).not.toContain('Investor mornings');
    const supports = JSON.parse((await o.node(id))!.supporting_spots) as number[];
    const origins = await runInDurableObject(o.stub, (_instance, state) => state.storage.sql.exec<{ origin: string }>(`SELECT origin FROM claims WHERE id IN (${supports.join(',')})`).toArray().map((row) => row.origin));
    expect(origins).toEqual(['untrusted', 'untrusted']);
  });

  it('editing a support Waldo read from mail does not pass the node off as the owner\'s words', async () => {
    const o = await owner('console-node-edit-read');
    const id = await o.seedRead();
    await o.codeAge(60_000);
    for (const support of await o.supportsOf(id)) expect((await o.act(await o.claimRef(support), 'spot.edit', `Owner wording ${support}`)).status).toBe(200);
    const block = await o.turnBlock();
    expect(block).not.toContain('Investor mornings');
    expect(block).not.toContain('their words · confirmed] Investor');
  });

  it('only the owner can read or act on their pattern', async () => {
    const a = await owner('console-node-owner-a'), b = await owner('console-node-owner-b');
    const id = await a.seedRead(), target = await a.scoped(id);
    expect((await a.read(target, b.token)).status).toBe(401);
    expect((await b.read(target)).status).toBe(404);
    const crossed = await b.stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: { cookie: `waldo_console=${a.token}`, accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'x'.repeat(64), revision: 'a'.repeat(64), view: 'memory', action: 'node.confirm', id: target, request_id: 'cross-owner-confirm' }) });
    expect(crossed.status).toBe(401);
    expect(await a.turnBlock()).not.toContain('Investor mornings');
  });
});
