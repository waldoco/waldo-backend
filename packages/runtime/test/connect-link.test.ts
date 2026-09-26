import { describe, expect, it } from 'vitest';
import { handleConnectTicket, newTicket, ticketHash, BEGIN_SESSION_PATH } from '../src/channels/connect-link';

const TICKET = 'AbCdEfGhIjKlMnOpQrStUv'; // 22 base64url chars

const envWith = (rpcResult: unknown, doReply: { url?: string | null } = { url: 'https://accounts.google.com/o/oauth2/v2/auth?x=1' }) => {
  const rpcCalls: Array<{ fn: string; message: string; args: Record<string, string> }> = [];
  const doCalls: Array<{ path: string; body: string }> = [];
  const env = {
    SUPABASE_PROJECT_URL: 'https://proj.example',
    SUPABASE_PUBLISHABLE_KEY: 'pk',
    WALDO_ROUTER_HMAC_SECRET: 'router-secret',
    TELEGRAM_OWNER_DO: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async (input: string, init?: RequestInit) => {
          doCalls.push({ path: new URL(input).pathname, body: String(init?.body ?? '') });
          return Response.json(doReply);
        },
      }),
    },
  };
  const fetcher = async (url: unknown, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}'));
    rpcCalls.push({ fn: String(url).split('/rpc/')[1]!, message: '(sig checked below)', args: body });
    return new Response(JSON.stringify(rpcResult), { status: 200 });
  };
  return { env, rpcCalls, doCalls, fetcher };
};

// signedRpc builds its own fetch; inject ours via the env seam (signedRpc takes a fetcher param
// in owner-directory, so exercise handleConnectTicket with a fetch-injectable env).
import { signedRpc } from '../src/identity/owner-directory';

const ticketEnv = (rpcResult: unknown, doReply?: { url?: string | null }) => {
  const { env, rpcCalls, doCalls, fetcher } = envWith(rpcResult, doReply);
  // signedRpc(env, fetcher) - but handleConnectTicket calls signedRpc(env) with default fetch.
  // So we test through a wrapped env whose global fetch is stubbed by vitest.
  return { env, rpcCalls, doCalls, fetcher };
};

describe('connect ticket helpers', () => {
  it('newTicket is 22 base64url chars and hashes deterministically', async () => {
    const ticket = newTicket();
    expect(ticket).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await ticketHash(TICKET)).toBe(await ticketHash(TICKET));
    expect(await ticketHash(TICKET)).not.toBe(TICKET);
  });
});

describe('handleConnectTicket', () => {
  const run = async (ticket: string, rpcResult: unknown, doReply?: { url?: string | null }, form: 'query' | 'path' = 'query') => {
    const { env, rpcCalls, doCalls, fetcher } = ticketEnv(rpcResult, doReply);
    const original = globalThis.fetch;
    globalThis.fetch = fetcher as typeof fetch;
    try {
      const url = form === 'path' ? `https://waldo.example/c/${ticket}` : `https://waldo.example/c/?t=${ticket}`;
      const response = await handleConnectTicket(new Request(url), env as never);
      return { response, rpcCalls, doCalls };
    } finally {
      globalThis.fetch = original;
    }
  };

  it('rejects a malformed ticket without any RPC', async () => {
    const { response, rpcCalls } = await run('short', null);
    expect(response.status).toBe(404);
    expect(rpcCalls).toHaveLength(0);
  });

  it('unknown ticket -> invalid page, no DO call', async () => {
    const { response, doCalls } = await run(TICKET, null);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain('not valid');
    expect(doCalls).toHaveLength(0);
  });

  it('expired ticket -> expired page, no DO call', async () => {
    const { response, doCalls } = await run(TICKET, { status: 'expired' });
    expect(response.status).toBe(410);
    expect(await response.text()).toContain('expired');
    expect(doCalls).toHaveLength(0);
  });

  it('completed ticket -> invalid page (never ok again)', async () => {
    const { response } = await run(TICKET, { status: 'completed' });
    expect(response.status).toBe(400);
  });

  it('ok ticket -> DO mints consent, 302 with no-store and no-referrer', async () => {
    const { response, rpcCalls, doCalls } = await run(TICKET, { status: 'ok', do_name: '5458446350', provider: 'google', session: 's1' });
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe('https://accounts.google.com/o/oauth2/v2/auth?x=1');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(rpcCalls[0]!.fn).toBe('connect_session_resolve');
    expect(rpcCalls[0]!.args.p_ticket_hash).toBe(await ticketHash(TICKET));
    expect(doCalls[0]!.path).toBe(BEGIN_SESSION_PATH);
    expect(JSON.parse(doCalls[0]!.body).ticket_hash).toBe(await ticketHash(TICKET));
  });

  it('legacy /c/<ticket> path links still resolve until their TTL lapses', async () => {
    const { response, rpcCalls } = await run(TICKET, { status: 'ok', do_name: '5458446350', provider: 'google', session: 's1' }, undefined, 'path');
    expect(response.status).toBe(302);
    expect(rpcCalls[0]!.args.p_ticket_hash).toBe(await ticketHash(TICKET));
  });

  it('DO mint failure -> failed page, never a naked 500', async () => {
    const { response } = await run(TICKET, { status: 'ok', do_name: '5458446350' }, { url: null });
    expect(response.status).toBe(502);
    expect(await response.text()).toContain('could not be connected');
  });
});
