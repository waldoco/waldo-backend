import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { HEALTH_TRIGGER_FLOOR_MS, HEALTH_TRIGGER_ID } from '../src/health/trigger';
import { HEALTH_ZONE_CHANGE_PATH, notifyOwnerZoneChange, verifiedZoneChange } from '../src/health/zone-change-route';

const SECRET = 'fictional-router-secret';
const DAY = '2026-10-21';

// The Worker's request, captured instead of sent.
const signed = async (doName = 'owner-a', day = DAY) => {
  let sent!: Request;
  const owners = { idFromName: (name: string) => name as never, get: () => ({ fetch: async (request: Request) => { sent = request; return Response.json({ ok: true }); } }) };
  await notifyOwnerZoneChange(owners, SECRET, doName, day);
  return sent;
};
const resend = async (request: Request, over: { headers?: Record<string, string>; body?: unknown; method?: string } = {}) =>
  new Request(request.url, { method: over.method ?? request.method, headers: { ...Object.fromEntries(request.headers), ...over.headers }, ...((over.method ?? request.method) === 'POST' ? { body: over.body === undefined ? await request.text() : JSON.stringify(over.body) } : {}) });
const isOwnerA = (name: string) => name === 'owner-a';

describe('the zone-change route', () => {
  it('carries the owner\'s day and nothing else', async () => {
    const request = await signed();
    expect(new URL(request.url).pathname).toBe(HEALTH_ZONE_CHANGE_PATH);
    expect(await request.clone().json()).toEqual({ day: DAY });
    expect(await verifiedZoneChange(request, SECRET, isOwnerA)).toBe(DAY);
  });

  it('refuses a forged, re-addressed, re-dated, padded or unsigned request', async () => {
    const cases = {
      forged: await resend(await signed(), { headers: { 'x-waldo-zone-sig': '0'.repeat(64) } }),
      otherOwner: await signed('owner-b'),
      reAddressed: await resend(await signed('owner-b'), { headers: { 'x-waldo-do-name': 'owner-a' } }),
      reDated: await resend(await signed(), { body: { day: '2026-10-22' } }),
      padded: await resend(await signed(), { body: { day: DAY, recovery: 'low' } }),
      notADay: await resend(await signed(), { body: { day: 'today' } }),
      wrongMethod: await resend(await signed(), { method: 'GET' }),
    };
    for (const [label, request] of Object.entries(cases)) expect([label, await verifiedZoneChange(request, SECRET, isOwnerA)]).toEqual([label, null]);
    expect(await verifiedZoneChange(await signed(), undefined, isOwnerA)).toBeNull();
    expect(await verifiedZoneChange(await signed(), 'another-secret', isOwnerA)).toBeNull();
  });

  it('fails the notice when the owner object does not take it', async () => {
    const owners = { idFromName: (name: string) => name as never, get: () => ({ fetch: async () => Response.json({ error: 'unavailable' }, { status: 403 }) }) };
    await expect(notifyOwnerZoneChange(owners, SECRET, 'owner-a', DAY)).rejects.toThrow('not taken');
  });
});

let sequence = 0;
describe('the owner object on a zone change', () => {
  const owner = (work: (o: { instance: OwnerDO; state: DurableObjectState; doName: string }) => Promise<void>) => {
    const doName = `health-zone-${sequence++}`;
    return runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(doName)), async (_instance, state) => {
      state.storage.kv.put('do_name', doName);
      const instance = new OwnerDO(state, { ...env, WALDO_ROUTER_HMAC_SECRET: SECRET, OPENAI_API_KEY: 'fictional-model-key', WALDO_OWNER_TIMEZONE: 'UTC' } as never);
      await work({ instance, state, doName });
    });
  };
  const has = (state: DurableObjectState, table: string) => state.storage.sql.exec("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", table).toArray().length > 0;
  const entry = (state: DurableObjectState) => !has(state, 'schedule') ? [] : state.storage.sql.exec<{ id: string; kind: string; due_at: number }>('SELECT id, kind, due_at FROM schedule WHERE id = ?', HEALTH_TRIGGER_ID).toArray();
  const pending = (state: DurableObjectState) => !has(state, 'health_trigger_pending') ? [] : state.storage.sql.exec<{ day: string }>('SELECT day FROM health_trigger_pending').toArray();

  it('marks the day and arms one evaluation, however many notices arrive', async () => {
    await owner(async ({ instance, state, doName }) => {
      const before = Date.now();
      for (let i = 0; i < 3; i += 1) expect((await instance.fetch(await signed(doName))).status).toBe(200);
      expect(pending(state)).toEqual([{ day: DAY }]);
      const armed = entry(state);
      expect(armed.map(row => [row.id, row.kind])).toEqual([[HEALTH_TRIGGER_ID, 'patrol']]);
      expect(armed[0]!.due_at).toBeGreaterThanOrEqual(before);
      expect(armed[0]!.due_at).toBeLessThan(before + HEALTH_TRIGGER_FLOOR_MS);
    });
  });

  it('refuses a notice signed for another owner and arms nothing', async () => {
    await owner(async ({ instance, state }) => {
      expect((await instance.fetch(await signed('someone-else'))).status).toBe(403);
      expect([entry(state), pending(state)]).toEqual([[], []]);
    });
  });

  it('arms nothing for an owner who turned health proposals off', async () => {
    await owner(async ({ instance, state, doName }) => {
      state.storage.sql.exec('CREATE TABLE IF NOT EXISTS schedule_preferences (kind TEXT PRIMARY KEY, enabled INTEGER NOT NULL)');
      state.storage.sql.exec("INSERT INTO schedule_preferences (kind, enabled) VALUES ('health_proposals', 0)");
      expect((await instance.fetch(await signed(doName))).status).toBe(200);
      expect(entry(state)).toEqual([]);
    });
  });
});
