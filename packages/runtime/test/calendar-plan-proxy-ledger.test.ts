import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { approvalDesk } from '../src/channels/approvals';
import type { StoredPlan } from '../src/channels/calendar-plan';
import { ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { googleProxy } from '../src/connectors/connections';
import { sha256Hex } from '../src/connectors/google';
import { pinProxyIntentRoute } from '../src/connectors/proxy-intent-route';

// A day plan on the Vault rail: the real desk and effect ledger, the real runtime proxy client, and the real connector-proxy
// edge with its intent ledger, in front of a fake Google Calendar. One approval makes several writes, and the edge refuses
// a second payload under one key, so each write must carry its own key.
const ROUTER = 'fictional-router';
const cfg: Record<string, string> = { SUPABASE_URL: 'https://db.invalid', SUPABASE_SERVICE_ROLE_KEY: 'fictional-service', WALDO_ROUTER_HMAC_SECRET: ROUTER, GOOGLE_CLIENT_ID: 'fictional-client', GOOGLE_CLIENT_SECRET: 'fictional-secret' };
const SCOPES = ['https://www.googleapis.com/auth/calendar.events'];
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';
const NOW = Date.parse('2026-11-05T02:00:00Z');
const OWNER = 447700900123;
const PLAN: StoredPlan = { day: '2026-11-05', time_zone: 'Asia/Kolkata', reason: 'your day, laid out', operation_ref: 'tool:plan-1', blocks: [
  { title: 'Write the board memo', start: '2026-11-05T09:30:00+05:30', end: '2026-11-05T11:30:00+05:30', block: 'deep_work' },
  { title: 'Lunch and a walk', start: '2026-11-05T13:00:00+05:30', end: '2026-11-05T14:00:00+05:30', block: 'rest' },
  { title: 'Reply to Priya', start: '2026-11-05T14:00:00+05:30', end: '2026-11-05T14:30:00+05:30' },
] };

type GoogleEvent = { id: string; summary: string; start: unknown; end: unknown; etag: string; status: string; extendedProperties?: { private?: Record<string, string> } };
type World = {
  events: Map<string, GoogleEvent>;
  ledger: Map<string, { digest: string; done: boolean; result?: unknown }>;
  inserts: number; patches: number;
  refuseInsert: Set<number>;
};
let serve: (request: Request) => Promise<Response>;
let world: World;

// The edge's own transport: its database RPCs (the intent ledger with proxy_idem_claim's semantics) and Google.
// Google stores a PATCH's null as absent, so an event read back carries only the fields it has.
const time = (value: unknown) => Object.fromEntries(Object.entries(value as Record<string, unknown>).filter(([, field]) => field !== null));
const edgeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
  const url = String(input), method = init?.method ?? 'GET';
  if (url.startsWith('https://db.invalid/rest/v1/rpc/')) {
    const fn = url.split('/').at(-1)!, args = JSON.parse(String(init?.body ?? '{}')) as Record<string, string>;
    if (args.p_do_name !== 'owner' || args.p_connection !== 'conn') return Response.json(fn === 'proxy_access' ? [] : null);
    if (fn === 'proxy_access') return Response.json([{ secret: 'fictional-refresh', scopes: SCOPES }]);
    if (fn === 'proxy_health') return Response.json(true);
    if (fn === 'proxy_idem_claim') {
      const prior = world.ledger.get(args.p_key!);
      if (!prior) { world.ledger.set(args.p_key!, { digest: args.p_digest!, done: false }); return Response.json({ state: 'new' }); }
      return Response.json(prior.digest !== args.p_digest ? { state: 'conflict' } : prior.done ? { state: 'done', result: prior.result } : { state: 'pending' });
    }
    if (fn === 'proxy_idem_store') {
      const row = world.ledger.get(args.p_key!);
      if (!row || row.done) return Response.json(false);
      Object.assign(row, { done: true, result: (args as Record<string, unknown>).p_result });
      return Response.json(true);
    }
  }
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'fictional-access', expires_in: 3600 });
  if (url.startsWith(EVENTS)) {
    const id = decodeURIComponent(new URL(url).pathname.split('/events')[1]?.slice(1) ?? '');
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method === 'POST') {
      const index = world.inserts++;
      if (world.refuseInsert.has(index)) return Response.json({ error: { message: 'bad request' } }, { status: 400 });
      if (world.events.has(body.id as string)) return Response.json({ error: { message: 'duplicate' } }, { status: 409 });
      const event = { id: body.id as string, summary: body.summary as string, start: time(body.start), end: time(body.end), etag: `"v${world.inserts + world.patches}"`, status: 'confirmed', extendedProperties: body.extendedProperties as GoogleEvent['extendedProperties'] };
      world.events.set(event.id, event);
      return Response.json(event);
    }
    const event = world.events.get(id);
    if (!event) return Response.json({ error: { message: 'not found' } }, { status: 404 });
    if (method === 'GET') return Response.json(event);
    if (method === 'PATCH') {
      const match = new Headers(init?.headers).get('if-match');
      if (match && match !== event.etag) return Response.json({ error: { message: 'precondition failed' } }, { status: 412 });
      world.patches++;
      const next = { ...event, ...body, etag: `"v${world.inserts + world.patches}"`, extendedProperties: { private: { ...event.extendedProperties?.private, ...(body.extendedProperties as GoogleEvent['extendedProperties'])?.private } } } as GoogleEvent;
      world.events.set(id, next);
      return Response.json(next);
    }
  }
  throw new Error(`unexpected fictional transport: ${method} ${url}`);
};

beforeAll(async () => {
  vi.stubGlobal('Deno', { env: { get: (name: string) => cfg[name] }, serve: (handler: typeof serve) => { serve = handler; } });
  vi.stubGlobal('fetch', vi.fn(edgeFetch));
  await import('../../../supabase/functions/connector-proxy/index.ts');
});
afterAll(() => { vi.unstubAllGlobals(); });

const ROUTE = { id: 'conn', rail: 'proxy' as const };
const harness = (state: DurableObjectState, options: Readonly<{ loseReply?: (body: Record<string, unknown>) => boolean }> = {}) => {
  world = { events: new Map(), ledger: new Map(), inserts: 0, patches: 0, refuseInsert: new Set() };
  // The runtime reaches the edge as it does in production: a signed POST to the connector-proxy function.
  const proxy = googleProxy({ SUPABASE_PROJECT_URL: 'https://edge.invalid', SUPABASE_PUBLISHABLE_KEY: 'pub', WALDO_ROUTER_HMAC_SECRET: ROUTER }, async (input, init) => {
    const response = await serve(new Request(String(input), init));
    if (options.loseReply?.(JSON.parse(String(init?.body)))) throw new Error('connection reset after the edge answered');
    return response;
  })!;
  let n = 0;
  const desk = approvalDesk(state.storage.sql, {
    notice: async () => undefined, owner: OWNER, surface: 'telegram', appIdentity: () => true,
    call: async () => ({ message_id: 1, chat: { id: OWNER } }),
    // As the owner object routes a Google intent: pinned on the approval, then the Vault client for that connection.
    google: async (intent) => {
      const route = pinProxyIntentRoute(state.storage.sql, intent, 'google:calendar', [ROUTE], ROUTE);
      return route ? { ...proxy.client('owner', route.id, undefined, intent), account: { connection_id: route.id, email: 'owner@example.test' } } : null;
    },
    newId: () => String(++n), now: () => NOW, timezone: 'Asia/Kolkata', log: () => undefined,
    commit: work => state.storage.transactionSync(work), effects: ownerEffectLedger(state.storage, () => NOW),
  });
  const status = (id: string) => state.storage.sql.exec<{ status: string }>('SELECT status FROM ledger WHERE id = ?', id).one().status;
  const live = () => [...world.events.values()].filter(event => event.status !== 'cancelled').map(event => event.summary);
  const routes = () => state.storage.sql.exec<{ intent_id: string; connection: string }>('SELECT intent_id, connection FROM proxy_intent_routes').toArray().map(row => ({ ...row }));
  return { desk, proxy, status, live, routes };
};
const owner = (work: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`calendar-plan-proxy-${crypto.randomUUID()}`)), (_instance, state) => work(state));
const marker = (step: string) => sha256Hex(`tool:plan-1:${step}`);

describe('a day plan through the connector proxy\'s intent ledger', () => {
  it('golden: one approval adds all three blocks, each write under its own key and all on the approval\'s one route', async () => {
    await owner(async state => {
      const h = harness(state);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      const out = await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect([out.toast, h.status(id)]).toEqual(['Done', 'done']);
      expect(h.live()).toEqual(PLAN.blocks.map(block => block.title));
      expect(world.inserts).toBe(3);
      const keys = await Promise.all(PLAN.blocks.map(async (_, i) => `approval:${id}:apply:${await marker(`apply:${i}`)}`));
      expect([...world.ledger.keys()]).toEqual(keys);
      expect([...world.ledger.values()].every(row => row.done)).toBe(true);
      expect(h.routes()).toEqual([{ intent_id: `approval:${id}:apply`, connection: 'conn' }]);
    });
  });

  it('a refused block 2 rolls block 1 back, and the plan reads not done with nothing left', async () => {
    await owner(async state => {
      const h = harness(state);
      world.refuseInsert.add(1);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      const out = await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect([out.toast, h.status(id), h.live()]).toEqual(['Not done', 'failed', []]);
      expect(out.message).toContain('removed the 1 block already added');
      expect(world.ledger.get(`approval:${id}:apply:${await marker('rollback:0')}`)?.done).toBe(true);
    });
  });

  it('undo removes all three blocks, each removal under its own key and on the route the add used', async () => {
    await owner(async state => {
      const h = harness(state);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      const undone = await h.desk.decide(id, 'u', 'trace', { surface: 'telegram' });
      expect([undone.toast, h.status(id), h.live()]).toEqual(['Undone', 'undone', []]);
      for (const i of [0, 1, 2]) expect(world.ledger.get(`approval:${id}:undo:${await marker(`undo:${i}`)}`)?.done).toBe(true);
      expect(h.routes()).toEqual([{ intent_id: `approval:${id}:apply`, connection: 'conn' }]);
    });
  });

  it('a replay of the same approval adds nothing twice: at the desk, and as the same writes sent again to the proxy', async () => {
    await owner(async state => {
      const h = harness(state);
      const id = await h.desk.proposeCalendarPlan(PLAN);
      await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect((await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' })).toast).toBe('Already handled.');
      // The same writes again under the same approval: the edge answers each from its ledger and Google sees no insert.
      const client = h.proxy.client('owner', 'conn', undefined, { id: `approval:${id}:apply` });
      for (const [i, block] of PLAN.blocks.entries()) {
        const at = await marker(`apply:${i}`);
        expect(await client.createEvent({ title: block.title, start: block.start, end: block.end, id: at, operationMarker: at, ...(block.block ? { block: block.block } : {}) })).toMatchObject({ id: at });
      }
      expect([world.inserts, h.live().length]).toEqual([3, 3]);
      // A changed payload under one write's key is still refused: the per-write key keeps the edge's conflict guard.
      const first = await marker('apply:0');
      await expect(client.createEvent({ title: 'Something else', start: PLAN.blocks[0]!.start, end: PLAN.blocks[0]!.end, id: first, operationMarker: first })).rejects.toMatchObject({ message: 'intent_conflict' });
      expect(world.inserts).toBe(3);
    });
  });

  it('a reply lost after the edge added block 2 is found by readback, and the plan lands whole with each block added once', async () => {
    await owner(async state => {
      let lost = false;
      const h = harness(state, { loseReply: body => body.method === 'createEvent' && !lost && (lost = (body.args as { title: string }[])[0]!.title === PLAN.blocks[1]!.title) });
      const id = await h.desk.proposeCalendarPlan(PLAN);
      const out = await h.desk.decide(id, 'a', 'trace', { surface: 'telegram' });
      expect([out.toast, h.status(id), world.inserts, h.live()]).toEqual(['Done', 'done', 3, PLAN.blocks.map(block => block.title)]);
    });
  });
});
