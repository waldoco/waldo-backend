import { describe, expect, it } from 'vitest';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { consoleAccess } from '../src/channels/console';
import { CONTROLS_PATH } from '../src/channels/dashboard-controls';
import { CONTROL_ACTION_PATH } from '../src/channels/dashboard-control-actions';
import { MEMORY_CONTROL_PATH } from '../src/channels/dashboard-memory-actions';

// The owner pins, unpins and edits a memory claim from the console. Pin and edit change what Waldo holds as the owner's
// own word on every turn, so they need a fresh email code; unpin only takes a line out.
const root = 'https://telegram-owner';
const HOUR = 60 * 60_000;
type Read = { csrf: string; revision: string; data: { actions?: string[] } };
type Row = { id: number; text: string; status: string; origin: string | null; source: string; verification_status: string | null; source_ref: string | null; supersedes_id: number | null; pinned: string | null; pin_order: number | null };

const owner = async (name: string) => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name));
  const token = await runInDurableObject(stub, (instance, state) => {
    Object.assign((instance as unknown as { env: Record<string, unknown> }).env, { TELEGRAM_BOT_TOKEN: '123:synthetic', OPENAI_API_KEY: 'synthetic-key' });
    return consoleAccess(state.storage).grant();
  });
  const headers = (extra: Record<string, string> = {}) => ({ cookie: `waldo_console=${token}`, accept: 'application/json', ...extra });
  expect((await stub.fetch(`${root}${CONTROLS_PATH}?view=day`, { headers: headers() })).status).toBe(200);
  const codeAge = (age: number) => runInDurableObject(stub, async (_instance, state) => {
    const sessions = (await state.storage.get<Record<string, Record<string, unknown>>>('console:sessions'))!;
    sessions[token] = { ...sessions[token]!, verified_at: Date.now() - age };
    await state.storage.put('console:sessions', sessions);
  });
  const seed = (kind: string, text: string, origin: string, source: string, verification: string | null) => runInDurableObject(stub, (_instance, state) => {
    state.storage.sql.exec('INSERT INTO claims (kind, text, source, evidence, origin, status, created_at, last_seen_at, verification_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      kind, text, source, 'synthetic note', origin, 'active', '2026-10-01', '2026-10-01', verification);
    return state.storage.sql.exec<{ id: number }>('SELECT id FROM claims ORDER BY id DESC LIMIT 1').one().id;
  });
  const row = (id: number) => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<Row>('SELECT * FROM claims WHERE id = ?', id).toArray()[0]);
  const rows = () => runInDurableObject(stub, (_instance, state) => state.storage.sql.exec<Row>('SELECT * FROM claims ORDER BY id').toArray());
  const scoped = (id: number) => runInDurableObject(stub, (_instance, state) => `${state.id}:claim:${id}`);
  const read = async (id: string): Promise<Read> => {
    const response = await stub.fetch(`${root}${MEMORY_CONTROL_PATH}?${new URLSearchParams({ id })}`, { headers: headers() });
    expect(response.status).toBe(200);
    return response.json();
  };
  const act = async (id: string, action: string, value?: string, request = `${action}-${crypto.randomUUID()}`) => {
    const current = await read(id);
    return stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: headers({ 'content-type': 'application/x-www-form-urlencoded' }),
      body: new URLSearchParams({ csrf: current.csrf, revision: current.revision, view: 'memory', action, id, request_id: request.slice(0, 80), ...(value === undefined ? {} : { value }) }) });
  };
  return { stub, token, codeAge, seed, row, rows, scoped, read, act };
};

describe('console pin and unpin', () => {
  it('pins an owner fact to the profile, at the end of the block, then unpins it', async () => {
    const o = await owner('console-pin-owner');
    await o.codeAge(60_000);
    const first = await o.seed('fact', 'Lives in Leeds', 'owner', 'stated', 'owner-grounded');
    const second = await o.seed('preference', 'Prefers mornings', 'owner', 'stated', 'owner-grounded');
    const id = await o.scoped(second);
    expect((await o.read(await o.scoped(first))).data.actions).toContain('spot.pin');
    expect((await o.act(await o.scoped(first), 'spot.pin', 'profile')).status).toBe(200);
    const pinned = await o.act(id, 'spot.pin', 'profile');
    expect(pinned.status).toBe(200);
    expect(await pinned.json()).toMatchObject({ receipt: { state: 'recorded' } });
    expect(await o.row(second)).toMatchObject({ pinned: 'profile', pin_order: (await o.row(first))!.pin_order! + 1 });
    expect((await o.read(id)).data.actions).toEqual(expect.arrayContaining(['spot.unpin']));
    expect((await o.read(id)).data.actions).not.toContain('spot.pin');
    expect((await o.act(id, 'spot.unpin')).status).toBe(200);
    expect(await o.row(second)).toMatchObject({ pinned: null, pin_order: null });
  });

  it('pins to the facts block when asked, and refuses any other block', async () => {
    const o = await owner('console-pin-facts-owner');
    await o.codeAge(60_000);
    const claim = await o.seed('routine', 'Swims on Fridays', 'owner', 'stated', 'owner-grounded');
    const id = await o.scoped(claim);
    expect((await o.act(id, 'spot.pin', 'top')).status).toBe(409);
    expect((await o.row(claim))!.pinned).toBeNull();
    expect((await o.act(id, 'spot.pin', 'facts')).status).toBe(200);
    expect((await o.row(claim))!.pinned).toBe('facts');
  });

  it('offers no pin for a kind the blocks do not carry', async () => {
    const o = await owner('console-pin-kind-owner');
    await o.codeAge(60_000);
    const claim = await o.seed('event', 'Dentist on Tuesday', 'owner', 'stated', 'owner-grounded');
    const id = await o.scoped(claim);
    expect((await o.read(id)).data.actions).not.toContain('spot.pin');
    const refused = await o.act(id, 'spot.pin', 'profile');
    expect(refused.status).toBe(409);
    expect((await o.row(claim))!.pinned).toBeNull();
  });

  it('refuses a pin without an email code from the last two hours, and unpins without one', async () => {
    const o = await owner('console-pin-step-up-owner');
    const claim = await o.seed('fact', 'Has two cats', 'owner', 'stated', 'owner-grounded');
    const id = await o.scoped(claim);
    await o.codeAge(3 * HOUR);
    const refused = await o.act(id, 'spot.pin', 'profile');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'step_up_required' });
    expect((await o.row(claim))!.pinned).toBeNull();
    await o.codeAge(60_000);
    expect((await o.act(id, 'spot.pin', 'profile')).status).toBe(200);
    await o.codeAge(3 * HOUR);
    expect((await o.act(id, 'spot.unpin')).status).toBe(200);
    expect((await o.row(claim))!.pinned).toBeNull();
  });
});

describe('console edit', () => {
  it('replaces the claim with the owner\'s text: the old row is superseded and the new one is theirs, keeping its pin', async () => {
    const o = await owner('console-edit-owner');
    await o.codeAge(60_000);
    const claim = await o.seed('preference', 'Likes tea', 'owner', 'stated', 'owner-grounded');
    await runInDurableObject(o.stub, (_instance, state) => state.storage.sql.exec("UPDATE claims SET pinned = 'profile', pin_order = 0 WHERE id = ?", claim).toArray());
    const edited = await o.act(await o.scoped(claim), 'spot.edit', '  Likes green tea, no sugar  ');
    expect(edited.status).toBe(200);
    expect(await edited.json()).toMatchObject({ receipt: { state: 'recorded' } });
    const [old, next] = (await o.rows()).filter((row) => row.id >= claim);
    expect(old).toMatchObject({ id: claim, text: 'Likes tea', status: 'superseded' });
    expect(next).toMatchObject({ text: 'Likes green tea, no sugar', status: 'active', origin: 'owner', source: 'stated', verification_status: 'owner-grounded',
      source_ref: 'owner, console:spot.edit', supersedes_id: claim, pinned: 'profile' });
  });

  it('keeps a health number the owner types as their own statement', async () => {
    const o = await owner('console-edit-health-owner');
    await o.codeAge(60_000);
    const claim = await o.seed('health', 'Resting heart rate is around 60', 'owner', 'stated', 'owner-grounded');
    expect((await o.act(await o.scoped(claim), 'spot.edit', 'Resting heart rate is around 58')).status).toBe(200);
    expect((await o.rows()).at(-1)).toMatchObject({ text: 'Resting heart rate is around 58', status: 'active', verification_status: 'owner-grounded' });
  });

  it('refuses empty text, text over the limit and a credential, and changes nothing', async () => {
    const o = await owner('console-edit-refusal-owner');
    await o.codeAge(60_000);
    const claim = await o.seed('fact', 'Works at Acme', 'owner', 'stated', 'owner-grounded');
    const id = await o.scoped(claim);
    for (const value of ['   ', 'x'.repeat(1001), 'My API key is sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij']) {
      const refused = await o.act(id, 'spot.edit', value);
      expect(refused.status, value.slice(0, 20)).toBe(409);
    }
    expect((await o.rows()).filter((row) => row.status === 'active').map((row) => row.text)).toEqual(['Works at Acme']);
  });

  it('refuses an edit without an email code from the last two hours', async () => {
    const o = await owner('console-edit-step-up-owner');
    const claim = await o.seed('fact', 'Drives a blue car', 'owner', 'stated', 'owner-grounded');
    await o.codeAge(3 * HOUR);
    const refused = await o.act(await o.scoped(claim), 'spot.edit', 'Drives a red car');
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ error: 'step_up_required' });
    expect((await o.row(claim))!.status).toBe('active');
  });

  it('keeps another owner\'s session out', async () => {
    const a = await owner('console-edit-owner-a');
    const b = await owner('console-edit-owner-b');
    await a.codeAge(60_000);
    const claim = await a.seed('fact', 'Owner A fact', 'owner', 'stated', 'owner-grounded');
    const foreign = await a.scoped(claim);
    const crossed = { cookie: `waldo_console=${b.token}`, accept: 'application/json' };
    expect((await a.stub.fetch(`${root}${MEMORY_CONTROL_PATH}?${new URLSearchParams({ id: foreign })}`, { headers: crossed })).status).toBe(401);
    const posted = await a.stub.fetch(root + CONTROL_ACTION_PATH, { method: 'POST', headers: { ...crossed, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ csrf: 'x', revision: 'f'.repeat(64), view: 'memory', action: 'spot.edit', id: foreign, value: 'Planted', request_id: 'cross-owner-edit' }) });
    expect(posted.status).toBe(401);
    expect((await a.row(claim))!.text).toBe('Owner A fact');
  });
});
