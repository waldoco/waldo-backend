import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import { handleConnectTicket, ticketHash } from '../src/channels/connect-link';
import { handleMcpCallback } from '../src/channels/mcp-oauth-routes';
import { routerSignature } from '../src/identity/owner-directory';
import { MCP_CATALOGUE } from '../src/connectors/mcp-catalogue';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { fakeMcpWorld, type FakeMcpWorld } from './support/fake-mcp-world';
import { presenceAuthority } from './helpers/directory-presence';
import { EDGE_ENV, loadEdge, vaultFake, WORKER_ENV, type VaultFake } from './support/oauth-edge-harness';

// The owner asks in an app thread to connect Notion. The real responder and tool loop run connect_app; the link reaches the
// thread under Waldo's reply and never any model request; the owner's browser takes the first-party hop, consents at a fake
// Notion, and lands on the real callback, which exchanges the code through the real oauth-proxy edge. The thread then hears
// that Notion is connected.
const model = vi.hoisted(() => ({ requests: [] as string[], all: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    model.all.push(JSON.stringify(request));
    if (request.response_format) return { ok: true as const, data: { model: request.model, text: '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    model.requests.push(JSON.stringify(request));
    const call = !request.tool_turns?.length && JSON.stringify(request.messages.at(-1)).includes('connect my Notion');
    return { ok: true as const, data: { model: request.model, text: call ? '' : 'Your Notion link is just below.', ...(call ? { tool_calls: [{ call_id: 'connect', name: 'connect_app', arguments: '{"connector_id":"notion"}' }] } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7a3c1e52-9d4b-4f86-a1c2-3e5f7a9b1d24', ORIGIN = 'https://waldo.fixture.invalid', STATE_SECRET = 'fixture-connect-app-state-secret';
const NOTION = MCP_CATALOGUE.find((entry) => entry.id === 'notion')!;
const NOTION_ORIGIN = new URL(NOTION.url).origin;
const LINK = /https:\/\/waldo\.fixture\.invalid\/c\/[A-Za-z0-9_-]{22}/;

let serve: (request: Request) => Promise<Response>;
beforeAll(async () => { serve = await loadEdge(); });
afterEach(() => { vi.restoreAllMocks(); });

type Ticket = { provider: string; channel: string; do_name: string; begun: boolean; status: 'issued' | 'completed' | 'revoked' };
type Rig = Readonly<{
  world: FakeMcpWorld; vault: VaultFake; tickets: Map<string, Ticket>; rpcs: string[]; state: DurableObjectState; owner: InstanceType<typeof OwnerDO>;
  thread(): Promise<string>; say(path: string, client: string, text: string): Promise<string>; read(path: string): Promise<{ id: string; role: string; text: string; parent_id: string | null }[]>;
  hop(link: string, init?: RequestInit): Promise<Response>; callback(back: URL, cookie?: string): Promise<Response>; drain(path: string, text: string): Promise<void>;
}>;

const withRig = (name: string, run: (rig: Rig) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  model.requests = []; model.all = [];
  const world = fakeMcpWorld({ origin: NOTION_ORIGIN, issuer: NOTION.issuer }), vault = vaultFake([name]);
  const tickets = new Map<string, Ticket>(), rpcs: string[] = [];
  const directory = async (fn: string, a: Record<string, string>): Promise<Response> => {
    rpcs.push(fn);
    const signed = async (message: string) => expect(a.p_sig).toBe(await routerSignature(WORKER_ENV.WALDO_ROUTER_HMAC_SECRET, Number(a.p_at), message));
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: a.p_do_name, session_hash: a.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: a.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    // The delivery outbox checks the owner is still admitted on the app before a message Waldo starts goes there.
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'common_owner_authority') return presenceAuthority(OWNER_ID, JSON.stringify(a));
    if (fn === 'connect_session_issue') {
      await signed(`connsess.issue.${a.p_do_name}.${a.p_provider}.${a.p_channel}.${a.p_ticket_hash}`);
      for (const ticket of tickets.values()) if (ticket.provider === a.p_provider && ticket.status === 'issued') ticket.status = 'revoked';
      tickets.set(a.p_ticket_hash!, { provider: a.p_provider!, channel: a.p_channel!, do_name: a.p_do_name!, begun: false, status: 'issued' });
      return Response.json('30000000-0000-0000-0000-000000000009');
    }
    if (fn === 'connect_session_resolve') {
      const ticket = tickets.get(a.p_ticket_hash!);
      if (!ticket) return Response.json(null);
      return Response.json(ticket.status !== 'issued' ? { status: ticket.status } : { status: 'ok', do_name: ticket.do_name, provider: ticket.provider, session: 's', begun: ticket.begun, handoff: false, owner_hint: 'o•••@example.test' });
    }
    if (fn === 'connect_session_begin') {
      const ticket = tickets.get(a.p_ticket_hash!);
      if (!ticket || ticket.begun || ticket.status !== 'issued') return Response.json(null);
      ticket.begun = true;
      return Response.json({ status: 'ok', do_name: ticket.do_name });
    }
    if (fn === 'connect_session_complete') {
      const ticket = tickets.get(a.p_ticket_hash!);
      if (!ticket?.begun || ticket.status !== 'issued') return Response.json(false);
      ticket.status = 'completed';
      return Response.json(true);
    }
    return new Response('unexpected', { status: 500 });
  };
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init), url = new URL(request.url);
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url.pathname)?.[1];
    if (url.origin === WORKER_ENV.SUPABASE_PROJECT_URL && url.pathname === '/functions/v1/oauth-proxy') return serve(request);
    if (url.origin === WORKER_ENV.SUPABASE_PROJECT_URL && fn) return directory(fn, JSON.parse(await request.text()) as Record<string, string>);
    if (url.origin === EDGE_ENV.SUPABASE_URL && fn) return vault.answer(fn, JSON.parse(await request.text()) as Record<string, unknown>);
    if (url.origin === NOTION_ORIGIN) return world.fetcher(request);
    return new Response('blocked in test', { status: 502 });
  }));
  claimStore(state.storage.sql);
  ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  state.storage.kv.put('app_subject', String(appSubjectFor(name)));
  state.storage.kv.put('origin', ORIGIN);
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const settings = { ...env, ...WORKER_ENV, WALDO_OAUTH_STATE_SECRET: STATE_SECRET, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined };
  const owner = new OwnerDO(state, settings as never);
  const routed = { ...settings, OWNER_DO: { idFromName: (n: string) => env.OWNER_DO!.idFromName(n), get: () => ({ fetch: (input: RequestInfo | URL, init?: RequestInit) => owner.fetch(new Request(input, init)) }) } } as never;
  const headers = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' };
  let operations = 0;
  const rig: Rig = {
    world, vault, tickets, rpcs, state, owner,
    thread: async () => (await (await owner.fetch(new Request('https://telegram-owner/app/v1/threads', { method: 'POST', headers, body: JSON.stringify({ operation_id: `0b6f3c1e-8a2d-4f5b-9c7e-${String(++operations).padStart(12, '0')}`, title: 'Setup' }) }))).json() as { thread_id: string }).thread_id,
    say: async (path, client, text) => {
      // A thread message names the thread revision it answers.
      const revision = path === '/chat/main' ? {} : { expected_revision: ((await (await owner.fetch(new Request(`https://telegram-owner/app/v1${path}`, { headers }))).json()) as { thread: { revision: number } }).thread.revision };
      const sent = await owner.fetch(new Request(`https://telegram-owner/app/v1${path}/messages`, { method: 'POST', headers, body: JSON.stringify({ client_message_id: client, text, ...revision }) }));
      expect(sent.status).toBe(202);
      const { message_id: id } = await sent.json() as { message_id: string };
      await vi.waitFor(() => expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
      return id;
    },
    read: async (path) => {
      type Page = { messages: { id: string; role: string; text: string; parent_id: string | null }[] };
      const body = await (await owner.fetch(new Request(`https://telegram-owner/app/v1${path}${path === '/chat/main' ? '?limit=50' : ''}`, { headers }))).json() as Page & { history?: Page };
      return (body.history ?? body).messages;
    },
    hop: (link, init) => handleConnectTicket(new Request(link, init), routed),
    callback: (back, cookie) => handleMcpCallback(new Request(back, cookie ? { headers: { cookie } } : {}), routed),
    drain: async (path, text) => {
      // A record the outbox holds is due a moment after it is queued; each pass stands in for the alarm that fires then.
      for (let pass = 0; pass < 40 && !(await rig.read(path)).some((message) => message.text === text); pass += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        await state.storage.deleteAlarm(); await owner.alarm();
      }
    },
  };
  try { await run(rig); } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); vi.unstubAllGlobals(); }
});

// The owner asks in a thread and gets the link under Waldo's reply there.
const ask = async (rig: Rig, path: string, client: string) => {
  const asked = await rig.say(path, client, 'Please connect my Notion');
  const reply = (await rig.read(path)).find((message) => message.role === 'assistant' && message.parent_id === asked)!;
  const link = LINK.exec(reply.text)?.[0];
  if (!link) throw new Error(`no connect link under the reply: ${reply.text}`);
  return { reply, link };
};
// Continue, from the browser that loaded the page: the hop's own origin names the form's page.
const pressContinue = (rig: Rig, link: string) => rig.hop(link, { method: 'POST', headers: { origin: ORIGIN } });
const bindingOf = (response: Response) => response.headers.get('set-cookie')!.split(';')[0]!;

it('connects Notion from an app thread: link under the reply, one Continue, the provider\'s consent, and "connected" in the same thread', async () => {
  await withRig('connect-app-chat-golden', async (rig) => {
    const thread = await rig.thread(), path = `/threads/${thread}`;
    const { reply, link } = await ask(rig, path, 'connect-client-01');
    expect(reply.text).toBe(`Your Notion link is just below.\n\nConnect Notion (the link works once, for 15 minutes): ${link}`);
    expect(model.requests.join('\n').replaceAll('\\"', '"')).toContain('"status":"sent","method":"link","surface":"app"');
    // The link is a credential: no model request ever holds it, and no owner id rides in it.
    expect(model.all.join('\n')).not.toContain('/c/');
    expect(link).not.toContain(OWNER_ID);
    const hash = await ticketHash(new URL(link).pathname.slice(3));
    expect(rig.tickets.get(hash)).toMatchObject({ provider: 'mcp:notion', channel: 'app', begun: false });
    // Discovery ran when the link was sent; the provider has seen no sign-in yet.
    expect(rig.world.hits.some((hit) => hit.includes('/authorize'))).toBe(false);

    const page = await rig.hop(link);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(html).toContain('Connect Notion?');
    expect(html).toContain('o•••@example.test');
    expect(html).toContain('labels read-only run without asking');
    expect(page.headers.get('content-security-policy')).toContain(`form-action 'self' ${NOTION_ORIGIN}`);
    // Loading the page (a link unfurler, a prefetch) spends nothing.
    expect(rig.tickets.get(hash)!.begun).toBe(false);

    const go = await pressContinue(rig, link);
    expect(go.status).toBe(303);
    const authorize = go.headers.get('location')!;
    expect(authorize.startsWith(`${NOTION_ORIGIN}/authorize?`)).toBe(true);
    expect(rig.tickets.get(hash)!.begun).toBe(true);

    const back = await rig.world.authorize(authorize, 'allow');
    const done = await rig.callback(back, bindingOf(go));
    expect(done.status).toBe(200);
    expect(await done.text()).toContain('Notion connected');
    expect(rig.tickets.get(hash)!.status).toBe('completed');
    expect(rig.vault.rows).toHaveLength(1);

    await rig.drain(path, 'Notion is connected.');
    const after = await rig.read(path);
    expect(after.filter((message) => message.text === 'Notion is connected.')).toHaveLength(1);
    // The confirmation answers in the thread that asked, not in main.
    expect((await rig.read('/chat/main')).some((message) => message.text === 'Notion is connected.')).toBe(false);
    // A reload of the callback replays the settled outcome and tells the thread nothing new.
    await rig.callback(back, bindingOf(go));
    await rig.drain(path, 'Notion is connected.');
    expect((await rig.read(path)).filter((message) => message.text === 'Notion is connected.')).toHaveLength(1);
  });
});

it('a link works once: a second Continue or a reload after it is refused, and a callback in another browser links nothing', async () => {
  await withRig('connect-app-chat-once', async (rig) => {
    const { link } = await ask(rig, '/chat/main', 'connect-client-02');
    const go = await pressContinue(rig, link);
    expect(go.status).toBe(303);
    // The same link pressed again, from any browser, or opened after Continue: already used.
    for (const again of [await pressContinue(rig, link), await rig.hop(link)]) {
      expect(again.status).toBe(410);
      expect(await again.text()).toContain('Each connect link starts one sign-in. Ask Waldo to connect Notion for a fresh one.');
    }
    // The sign-in came back in a browser that never pressed Continue (a forwarded consent page): nothing links.
    const back = await rig.world.authorize(go.headers.get('location')!, 'allow');
    expect((await rig.callback(back)).status).toBe(403);
    expect(rig.vault.rows).toHaveLength(0);
    // The owner's own browser still finishes it.
    expect((await rig.callback(back, bindingOf(go))).status).toBe(200);
    expect(rig.vault.rows).toHaveLength(1);
  });
});

it('a link opened after its 15 minutes reads as expired and spends nothing', async () => {
  await withRig('connect-app-chat-expired', async (rig) => {
    const { link } = await ask(rig, '/chat/main', 'connect-client-03');
    rig.state.storage.sql.exec('UPDATE mcp_attempts SET expires = ?', Date.now() - 1);
    const page = await rig.hop(link);
    expect(page.status).toBe(410);
    expect(await page.text()).toContain('Connect links last 15 minutes. Ask Waldo to connect Notion for a fresh one.');
    expect((await pressContinue(rig, link)).status).toBe(410);
    expect(rig.tickets.get(await ticketHash(new URL(link).pathname.slice(3)))!.begun).toBe(false);
  });
});

it('a new link revokes the one before it, and a refused consent is told to the chat that asked', async () => {
  await withRig('connect-app-chat-denied', async (rig) => {
    const first = await ask(rig, '/chat/main', 'connect-client-04');
    const second = await ask(rig, '/chat/main', 'connect-client-05');
    expect(rig.tickets.get(await ticketHash(new URL(first.link).pathname.slice(3)))!.status).toBe('revoked');
    expect((await rig.hop(first.link)).status).not.toBe(200);
    const go = await pressContinue(rig, second.link);
    const back = await rig.world.authorize(go.headers.get('location')!, 'deny');
    expect((await rig.callback(back, bindingOf(go))).status).toBe(400);
    await rig.drain('/chat/main', 'Notion was not connected: access was not granted.');
    expect((await rig.read('/chat/main')).some((message) => message.text === 'Notion was not connected: access was not granted.')).toBe(true);
    expect(rig.vault.rows).toHaveLength(0);
  });
});
