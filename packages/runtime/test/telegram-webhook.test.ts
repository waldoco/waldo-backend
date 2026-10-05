import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleTelegramWebhook, type TelegramWebhookEnv } from '../src/channels/telegram-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const namespace = () => {
  const fetch = vi.fn(async () => new Response('ok'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};
const message = (from: number, text = 'hi') => JSON.stringify({ update_id: 1, message: { from: { id: from }, chat: { id: from, type: 'private' }, text } });
const post = (secret: string | null, body = message(42)) => new Request('https://w.test/telegram/webhook', {
  method: 'POST', body, headers: secret === null ? {} : { 'x-telegram-bot-api-secret-token': secret },
});
const run = async (request: Request, env: TelegramWebhookEnv, directory?: OwnerDirectory) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleTelegramWebhook(request, env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  return response;
};

afterEach(() => vi.unstubAllGlobals());

describe('handleTelegramWebhook', () => {
  it('forwards only directory identity to the authenticated inbox, never a caller header or baggage', async () => {
    const n = namespace();
    const verified = { owner_id: '10000000-0000-0000-0000-00000000000a', owner_email: 'verified@test.invalid' };
    const directory: OwnerDirectory = { byPresence: async () => ({ doName: 'do-a', subject: '42', timezone: null, traceIdentity: verified }), redeem: async () => null };
    const request = post('secret');
    request.headers.set('x-waldo-owner-trace', JSON.stringify({ owner_email: 'from-chat@test.invalid' }));
    await run(request, { TELEGRAM_WEBHOOK_SECRET: 'secret', TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_OWNER_DO: n.ns }, directory);
    const [, init] = n.fetch.mock.calls[0] as unknown as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(JSON.parse(decodeURIComponent(headers.get('x-waldo-owner-trace')!))).toEqual(verified);
    expect(headers.has('baggage')).toBe(false);
  });
  it('waits for authenticated owner inbox admission before answering', async () => {
    const { fetch, idFromName, ns } = namespace();
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', WALDO_OWNER_TELEGRAM_ID: '42', WALDO_OWNER_TIMEZONE: 'Asia/Kolkata' };
    expect((await run(post('s3cret'), env)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('42');
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/enqueue', {
      method: 'POST', body: message(42),
      signal: expect.any(AbortSignal),
      headers: { 'x-waldo-do-name': '42', 'x-waldo-inbox-secret': 's3cret', 'x-waldo-origin': 'https://w.test', 'x-waldo-telegram-subject': '42', 'x-waldo-timezone': 'Asia/Kolkata' },
    });
  });

  it('routes each sender to their own owner Durable Object', async () => {
    const { fetch, idFromName, ns } = namespace();
    const directory: OwnerDirectory = {
      byPresence: async (_provider, subject) => ({ '1': { doName: 'do-a', subject: '1', timezone: null }, '2': { doName: 'do-b', subject: '2', timezone: null } })[subject] ?? null,
      redeem: async () => null,
    };
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret' };
    await run(post('s3cret', message(1)), env, directory);
    await run(post('s3cret', message(2)), env, directory);
    expect(idFromName.mock.calls.map(([name]) => name)).toEqual(['do-a', 'do-b']);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('ignores unknown ordinary text and malformed coded setup without redemption', async () => {
    const {fetch,ns}=namespace();const redeem=vi.fn();const directory:OwnerDirectory={byPresence:async()=>null,redeem};
    await run(post('s3cret',message(7)),{TELEGRAM_OWNER_DO:ns,TELEGRAM_WEBHOOK_SECRET:'s3cret'},directory);
    await run(post('s3cret',message(7,'/start WRONG1')),{TELEGRAM_OWNER_DO:ns,TELEGRAM_WEBHOOK_SECRET:'s3cret'},directory);
    expect(fetch).not.toHaveBeenCalled();expect(redeem).not.toHaveBeenCalled();
  });
  it('guards coded setup before DO allocation then waits for durable admission', async()=>{
    const {fetch,idFromName,ns}=namespace();let release!:()=>void;const gate=new Promise<void>(r=>{release=r});fetch.mockImplementationOnce(async()=>{await gate;return new Response('ok')});
    const limit=vi.fn(async()=>({success:true}));const env:TelegramWebhookEnv={TELEGRAM_OWNER_DO:ns,TELEGRAM_WEBHOOK_SECRET:'s3cret',TELEGRAM_BOT_TOKEN:'7:token',RESPONSIBILITY_RATE_LIMITER:{limit}as unknown as RateLimit};
    let done=false;const result=run(post('s3cret',message(7,'/link ABCDEFGH23')),env).then(r=>{done=true;return r});
    await vi.waitFor(()=>expect(fetch).toHaveBeenCalled());expect(done).toBe(false);expect(limit).toHaveBeenCalledTimes(2);expect(idFromName).toHaveBeenCalledWith('telegram-link:7:7');
    expect(JSON.stringify(fetch.mock.calls)).not.toContain('ABCDEFGH23');release();expect((await result).status).toBe(200);
  });
  it('edge throttling and absent limiter allocate no routing object',async()=>{
    const {idFromName,ns}=namespace();const base={TELEGRAM_OWNER_DO:ns,TELEGRAM_WEBHOOK_SECRET:'s3cret',TELEGRAM_BOT_TOKEN:'7:token'};
    expect((await run(post('s3cret',message(7,'/start ABCDEFGH23')),base)).status).toBe(503);
    expect((await run(post('s3cret',message(7,'/start ABCDEFGH23')),{...base,RESPONSIBILITY_RATE_LIMITER:{limit:async()=>({success:false})}as unknown as RateLimit})).status).toBe(429);
    expect(idFromName).not.toHaveBeenCalled();
  });
  it('ignores link codes sent from a group chat', async () => {
    const { ns } = namespace();
    const redeem = vi.fn(async () => null);
    const group = JSON.stringify({ update_id: 3, message: { from: { id: 7 }, chat: { id: -5, type: 'group' }, text: '/link GOOD12' } });
    await run(post('s3cret', group), { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', TELEGRAM_BOT_TOKEN: 'bot' }, { byPresence: async () => null, redeem });
    expect(redeem).not.toHaveBeenCalled();
  });

  it('rejects a missing or wrong secret and hides the route when unconfigured', async () => {
    const { fetch, ns } = namespace();
    const env: TelegramWebhookEnv = { TELEGRAM_OWNER_DO: ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', WALDO_OWNER_TELEGRAM_ID: '42' };
    expect((await run(post(null), env)).status).toBe(403);
    expect((await run(post('s3cre'), env)).status).toBe(403);
    expect((await run(new Request('https://w.test/telegram/webhook'), env)).status).toBe(404);
    expect((await run(post('s3cret'), { ...env, TELEGRAM_WEBHOOK_SECRET: undefined })).status).toBe(404);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('does not return success before admission resolves, or when admission fails', async () => {
  const n = namespace(); let release!: (r: Response) => void;
  n.fetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));
  let finished = false; const result = run(post('s3cret'), { TELEGRAM_OWNER_DO: n.ns, TELEGRAM_WEBHOOK_SECRET: 's3cret', WALDO_OWNER_TELEGRAM_ID: '42' }).then(r => { finished = true; return r; });
  await vi.waitFor(() => expect(n.fetch).toHaveBeenCalled()); expect(finished).toBe(false); release(new Response('failed', {status:503})); expect((await result).status).toBe(503);
});
it('returns deliberate errors for malformed payload and failed directory', async () => {
  const n = namespace(); const env = { TELEGRAM_OWNER_DO: n.ns, TELEGRAM_WEBHOOK_SECRET: 's3cret' };
  expect((await run(post('s3cret', '{'), env)).status).toBe(400);
  expect((await run(post('s3cret'), env, { byPresence: async () => { throw new Error('offline'); }, redeem: async () => null })).status).toBe(503);
  expect(n.fetch).not.toHaveBeenCalled();
});
it('limiter error fails closed without routing-object allocation',async()=>{const{idFromName,ns}=namespace();const env:TelegramWebhookEnv={TELEGRAM_OWNER_DO:ns,TELEGRAM_WEBHOOK_SECRET:'s3cret',TELEGRAM_BOT_TOKEN:'7:token',RESPONSIBILITY_RATE_LIMITER:{limit:async()=>{throw Error('limiter fault')}}as unknown as RateLimit};expect((await run(post('s3cret',message(7,'/link ABCDEFGH23')),env)).status).toBe(503);expect(idFromName).not.toHaveBeenCalled()});

describe('status log', () => {
  const logs = () => { const spy = vi.spyOn(console, 'log').mockImplementation(() => {}); return { spy, lines: () => spy.mock.calls.map(c => String(c[0])).filter(l => l.includes('telegram_webhook')) }; };
  const dir = (route: unknown): OwnerDirectory => ({ byPresence: async () => route as never, redeem: async () => null as never } as unknown as OwnerDirectory);
  const env = (n: ReturnType<typeof namespace>): TelegramWebhookEnv => ({ TELEGRAM_WEBHOOK_SECRET: 's', TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_OWNER_DO: n.ns });
  it('names routed, no_route and owner refusal with a status word only', async () => {
    for (const [route, refuse, word, http] of [[{ doName: 'do-a', subject: '42', timezone: null }, false, 'routed', 200], [null, false, 'no_route', 200], [{ doName: 'do-a', subject: '42', timezone: null }, true, 'owner_refused_403', 503]] as const) {
      const n = namespace(); if (refuse) n.fetch.mockResolvedValue(new Response('no', { status: 403 }));
      const l = logs();
      await run(post('s', message(42, 'secret words')), env(n), dir(route));
      const [line] = l.lines();
      expect(JSON.parse(line)).toEqual({ hop: 'telegram_webhook', ok: http < 400, status: word, http });
      expect(line).not.toContain('secret words'); expect(line).not.toContain('42');
      l.spy.mockRestore();
    }
  });
});
