// Text-first WhatsApp linking, one test per safeguard against handing one person's Waldo to another's WhatsApp.
// The database half (single use, expiry, sender and owner binding, claim races) is pgTAP:
// supabase/tests/waldo_whatsapp_text_first_link.sql.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleWhatsAppWebhook, type WhatsAppTextFirst } from '../src/channels/whatsapp-webhook';
import { consoleReturnTarget, handleConsole } from '../src/channels/console-signin';
import { WHATSAPP_LINK_CONFIRM_ACTION, whatsappLinkConfirmAction, whatsappLinkConfirmPage } from '../src/channels/whatsapp-link-console';
import { whatsappLinkDirectory, whatsappLinkToken, whatsappLinkTokenHash, type WhatsAppLinkDirectory } from '../src/identity/whatsapp-link';
import type { OwnerDirectory } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';
import { chatChannelLinks } from '../src/channels/chat-channel-links';

const SECRET = 'fictional-app-secret';
const SENDER = '15550001111';
const sign = async (body: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
};
const inbound = async (text: string, from = SENDER) => {
  const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, messages: [{ from, id: `wamid.${crypto.randomUUID()}`, timestamp: '1700000000', type: 'text', text: { body: text } }] } }] }] });
  return new Request('https://waldo.example/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } });
};
const env = { OWNER_DO: {} as DurableObjectNamespace, WHATSAPP_APP_SECRET: SECRET, WHATSAPP_ACCESS_TOKEN: 'fictional-token', WHATSAPP_PHONE_NUMBER_ID: 'pn1', WHATSAPP_ONBOARDING_URL: 'https://www.heywaldo.in/waitlist' };
const unlinked: OwnerDirectory = { byPresence: async () => null, redeem: vi.fn(async () => null) };
const links = (open: WhatsAppLinkDirectory['open']): WhatsAppLinkDirectory => ({ open: vi.fn(open), subject: vi.fn(async () => null), consume: vi.fn(async () => 'rejected' as const) });

const run = async (request: Request, directory: OwnerDirectory, textFirst: WhatsAppTextFirst | null, graphReply = () => Response.json({ messages: [{ id: 'wamid.reply' }] })) => {
  const sent: { to: string; text: { body: string; preview_url?: boolean } }[] = [];
  const logs: string[] = [];
  const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { sent.push(JSON.parse(String(init?.body))); return graphReply(); });
  const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
  const work: Promise<unknown>[] = [];
  try {
    const response = await handleWhatsAppWebhook(request, env, (p) => work.push(p), directory, textFirst);
    await Promise.all(work);
    return { response, sent, logs };
  } finally { graph.mockRestore(); log.mockRestore(); }
};

afterEach(() => vi.restoreAllMocks());

describe('the reply to an unlinked sender', () => {
  it('a member with this number on file gets a single one-tap link, bound to a token whose hash alone reaches the directory', async () => {
    const directory = links(async () => 'opened');
    const { response, sent, logs } = await run(await inbound('hi waldo'), unlinked, { links: directory, throttle: async () => true });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(`+${SENDER}`);
    const url = /https:\/\/waldo\.example(\/console\/whatsapp\/link\/[A-Za-z0-9_-]{43})(?=\s|$)/.exec(sent[0]!.text.body)?.[1];
    const token = whatsappLinkToken(url ?? '');
    expect(token).not.toBeNull();
    expect(directory.open).toHaveBeenCalledWith(SENDER, await whatsappLinkTokenHash(token!));
    expect(JSON.stringify(vi.mocked(directory.open).mock.calls)).not.toContain(token!);
    expect(sent[0]!.text.preview_url).toBeUndefined();
    expect(logs.join('\n')).not.toContain(token!);
  });

  it('a sender no owner has on file gets the waitlist, never a sign-in link', async () => {
    const { sent } = await run(await inbound('hello?'), unlinked, { links: links(async () => 'waitlist'), throttle: async () => true });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text.body).toContain('https://www.heywaldo.in/waitlist');
    expect(sent[0]!.text.body).not.toContain('/console/whatsapp/link');
  });

  it('a sender no single owner has on file is pointed at the console link flow as well as the waitlist', async () => {
    const { sent } = await run(await inbound('hi'), unlinked, { links: links(async () => 'waitlist'), throttle: async () => true });
    expect(sent[0]!.text.body).toContain('Already on Waldo?');
    expect(sent[0]!.text.body).toContain('https://waldo.example/console#/connections');
  });

  it('a throttled sender, one whose earlier link is still live, or one that became linked meanwhile, gets no reply', async () => {
    const throttled = links(async () => 'opened');
    expect((await run(await inbound('again'), unlinked, { links: throttled, throttle: async () => false })).sent).toEqual([]);
    expect(throttled.open).not.toHaveBeenCalled();
    for (const answer of ['pending', 'linked'] as const)
      expect((await run(await inbound('again'), unlinked, { links: links(async () => answer), throttle: async () => true })).sent).toEqual([]);
  });

  it('the throttle key is a hash, never the number, and allows three replies per sender per hour', async () => {
    const throttle = vi.fn(async () => true);
    await run(await inbound('hi'), unlinked, { links: links(async () => 'waitlist'), throttle });
    const [key, limit, windowSeconds] = throttle.mock.calls[0] as unknown as [string, number, number];
    expect(key).toMatch(/^walink\.[0-9a-f]{64}$/);
    expect(key).not.toContain(SENDER);
    expect([limit, windowSeconds]).toEqual([3, 3600]);
  });

  it('a "waldo CODE" text still redeems the console code and opens no link request', async () => {
    const redeem = vi.fn(async () => ({ doName: 'do-a', subject: SENDER, timezone: null }));
    const directory = links(async () => 'opened');
    const { sent } = await run(await inbound('waldo ABCDEFGH23'), { byPresence: async () => null, redeem }, { links: directory, throttle: async () => true });
    expect(redeem).toHaveBeenCalledWith('whatsapp', SENDER, 'ABCDEFGH23');
    expect(directory.open).not.toHaveBeenCalled();
    expect(sent.map((body) => body.text.body)).toEqual(['Linked. This chat now talks to your Waldo.']);
  });

  it('Verify with WhatsApp: the code the app issues, sent as the wa.me link fills it in, redeems from the number on file in one message', async () => {
    const CODE = 'ABCDEFGHJK';
    const OWN = '919800000101';
    const chat = chatChannelLinks({ env: { WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'pn1', WHATSAPP_WALDO_NUMBER: '919226067544' }, kv: { get: () => undefined }, doName: 'do-a',
      auth: { issueLinkCode: async () => CODE, issueProviderLinkCode: async () => CODE, whatsAppHandleHint: async () => null } as unknown as ConsoleAuth });
    const issued = await chat.issue('whatsapp');
    const prefilled = new URL(issued!.send_url!);
    expect(prefilled.origin + prefilled.pathname).toBe('https://wa.me/919226067544');
    const redeem = vi.fn(async () => ({ doName: 'do-a', subject: OWN, timezone: null }));
    const throttle = vi.fn(async () => true);
    const { response, sent, logs } = await run(await inbound(prefilled.searchParams.get('text')!, OWN), { byPresence: async () => null, redeem }, { links: links(async () => 'opened'), throttle });
    expect(response.status).toBe(200);
    expect(redeem).toHaveBeenCalledWith('whatsapp', OWN, CODE);
    expect(throttle.mock.calls.map(call => (call as unknown as [string, number, number]).slice(1))).toEqual([[5, 3600]]);
    expect(sent.map((body) => body.text.body)).toEqual(['Linked. This chat now talks to your Waldo.']);
    expect(logs.join('\n')).not.toContain(CODE);
  });

  it('without a directory an unlinked sender gets no reply at all', async () => {
    expect((await run(await inbound('hi'), unlinked, null)).sent).toEqual([]);
  });

  it('a reply Graph refuses is logged by its HTTP status and Meta code, never by the number, a message id or Graph\'s text', async () => {
    const refusal = () => Response.json({ error: { code: 131030, message: `(#131030) Recipient ${SENDER} not in allowed list`, error_data: { details: 'FICTIONAL-DETAIL wamid.fictional' } } }, { status: 400 });
    const { sent, logs } = await run(await inbound('hi waldo'), unlinked, { links: links(async () => 'waitlist'), throttle: async () => true }, refusal);
    expect(sent).toHaveLength(1);
    expect(logs.map(line => JSON.parse(line)).filter(line => line.ok === false)).toEqual([{ hop: 'whatsapp_text_first', ok: false, error: 'Error', status: 400, code: 131030 }]);
    for (const leak of [SENDER, 'wamid.', 'FICTIONAL-DETAIL', 'allowed list']) expect(logs.join('\n')).not.toContain(leak);
  });
});

describe('senders and callbacks that never reach an owner', () => {
  const signed = async (value: object) => {
    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, ...value } }] }] });
    return new Request('https://waldo.example/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } });
  };
  // The Supabase settings let the hidden-number reply reach its per-sender limit (an RPC); the link directory is a fake.
  const directoryEnv = { SUPABASE_PROJECT_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router' };
  const harness = async (request: Request, owners: OwnerDirectory = unlinked) => {
    const ownerFetch = vi.fn(async (_url: string, _init: RequestInit) => new Response('ok'));
    const idFromName = vi.fn((name: string) => name);
    const namespace = { idFromName, get: () => ({ fetch: ownerFetch }) } as unknown as DurableObjectNamespace;
    const directory = links(async () => 'opened');
    const throttle = vi.fn(async () => true);
    const sent: { to?: string; recipient?: string; text: { body: string } }[] = [];
    const rpcs: string[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const rpc = String(input).split('/rpc/')[1];
      if (rpc) { rpcs.push(rpc); return Response.json(true); }
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ messages: [{ id: 'wamid.reply' }] });
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const work: Promise<unknown>[] = [];
    try {
      const response = await handleWhatsAppWebhook(request, { ...env, ...directoryEnv, OWNER_DO: namespace }, (p) => work.push(p), owners, { links: directory, throttle });
      await Promise.all(work);
      return { response, ownerFetch, idFromName, open: directory.open, throttle, sent, rpcs };
    } finally { graph.mockRestore(); }
  };

  it('status callbacks for an unbound recipient, including a 131047 refusal, are acknowledged with no reply and no link', async () => {
    const { response, ownerFetch, open, throttle, sent } = await harness(await signed({ statuses: [
      { id: 'wamid.a', status: 'sent', recipient_id: SENDER, timestamp: '1700000000' },
      { id: 'wamid.b', status: 'failed', recipient_id: SENDER, timestamp: '1700000001', errors: [{ code: 131047 }] },
    ] }));
    expect(response.status).toBe(200);
    expect([ownerFetch.mock.calls.length, vi.mocked(open).mock.calls.length, throttle.mock.calls.length, sent.length]).toEqual([0, 0, 0, 0]);
  });

  it('an unbound sender never reaches any owner, so no owner records an inbound or opens its 24-hour window', async () => {
    const { response, ownerFetch, sent } = await harness(await inbound('hi waldo'));
    expect(response.status).toBe(200);
    expect(ownerFetch).not.toHaveBeenCalled();
    expect(sent).toHaveLength(1);
  });

  it('a sender with no phone number (a hidden user id only) gets only the hidden-number reply: no link, no owner', async () => {
    const { response, ownerFetch, open, throttle, sent } = await harness(await signed({ messages: [{ from_user_id: 'US.hidden-1', id: 'wamid.h', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }] }));
    expect(response.status).toBe(200);
    expect([ownerFetch.mock.calls.length, vi.mocked(open).mock.calls.length, throttle.mock.calls.length]).toEqual([0, 0, 0]);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ recipient: 'US.hidden-1', text: { body: expect.stringContaining("didn't share this chat's phone number") } });
    expect(sent[0]!.text.body).not.toContain('/console/whatsapp/link/');
  });

  it('one payload with a linked, an unbound and a hidden sender: one answer each, of the right kind, and no cross-talk', async () => {
    const LINKED = '15550002222';
    const owners: OwnerDirectory = { byPresence: async (_provider, subject) => (subject === LINKED ? { doName: 'do-bob', subject: LINKED, timezone: null } : null), redeem: vi.fn(async () => null) };
    const { response, ownerFetch, idFromName, open, throttle, sent, rpcs } = await harness(await signed({ messages: [
      { from: LINKED, id: 'wamid.l', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
      { from: SENDER, id: 'wamid.u', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
      { from_user_id: 'US.hidden-1', id: 'wamid.h', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
    ] }), owners);
    expect(response.status).toBe(200);
    // The linked sender is admitted to its owner and gets no reply from the webhook.
    expect(idFromName.mock.calls).toEqual([['do-bob']]);
    expect(ownerFetch).toHaveBeenCalledTimes(1);
    expect(new URL(ownerFetch.mock.calls[0]![0]).pathname).toBe('/whatsapp-admit');
    expect(JSON.parse(String(ownerFetch.mock.calls[0]![1].body)).messages.map((m: { id: string }) => m.id)).toEqual(['wamid.l']);
    // The unbound phone sender gets exactly one text-first link; the link directory and throttle saw only that number.
    expect(vi.mocked(open).mock.calls.map(([subject]) => subject)).toEqual([SENDER]);
    expect(throttle).toHaveBeenCalledTimes(1);
    const toSender = sent.filter(body => body.to === `+${SENDER}`);
    expect(toSender).toHaveLength(1);
    expect(toSender[0]!.text.body).toContain('/console/whatsapp/link/');
    // The hidden sender gets exactly one hidden-number reply, addressed by BSUID, and never a link.
    const toHidden = sent.filter(body => body.recipient === 'US.hidden-1');
    expect(toHidden).toHaveLength(1);
    expect(toHidden[0]!.text.body).toContain("didn't share this chat's phone number");
    expect(toHidden[0]!.text.body).not.toContain('/console/whatsapp/link/');
    expect(rpcs).toEqual(['whatsapp_onboarding_allowed']);
    // Nothing else was sent: no reply to the linked sender, and no second reply to anyone.
    expect(sent).toHaveLength(2);
    expect(sent.some(body => body.to === `+${LINKED}` || body.recipient === LINKED)).toBe(false);
  });

  it('in one payload with a linked sender, only that owner is admitted and named; the unbound and hidden senders reach no owner', async () => {
    const LINKED = '15550002222';
    const owners: OwnerDirectory = { byPresence: async (_provider, subject) => (subject === LINKED ? { doName: 'do-bob', subject: LINKED, timezone: null } : null), redeem: vi.fn(async () => null) };
    const { response, ownerFetch, idFromName } = await harness(await signed({ messages: [
      { from: SENDER, id: 'wamid.u', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
      { from_user_id: 'US.hidden-1', id: 'wamid.h', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
      { from: LINKED, id: 'wamid.l', timestamp: '1700000000', type: 'text', text: { body: 'hi' } },
    ] }), owners);
    expect(response.status).toBe(200);
    expect(idFromName.mock.calls).toEqual([['do-bob']]);
    expect(ownerFetch).toHaveBeenCalledTimes(1);
    const [url, init] = ownerFetch.mock.calls[0]!;
    expect(new URL(url).pathname).toBe('/whatsapp-admit');
    expect(new Headers(init.headers).get('x-waldo-do-name')).toBe('do-bob');
    expect(JSON.parse(String(init.body)).messages.map((m: { id: string }) => m.id)).toEqual(['wamid.l']);
  });
});

describe('the sign-in continuation', () => {
  const target = `/console/whatsapp/link/${'A'.repeat(43)}`;
  const owners = () => {
    const fetch = vi.fn(async () => new Response('console page'));
    return { fetch, ns: { idFromName: (name: string) => name, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
  };
  const auth = (overrides: Partial<ConsoleAuth> = {}) => ({ readOwnerCookie: vi.fn(async () => null), ownerCookie: vi.fn(async (doName: string) => `${doName}.session.sig`), ...overrides }) as unknown as ConsoleAuth;

  it('accepts exactly a link path, never a broader or foreign redirect', () => {
    expect(consoleReturnTarget([target])).toBe(target);
    for (const bad of [`${target}/`, `${target}?x=1`, `${target}#x`, `/console/whatsapp/link/${'A'.repeat(42)}`, `/console/whatsapp/link/${'A'.repeat(44)}`, `/console/whatsapp/link/${'A'.repeat(42)}.`, `https://evil.test${target}`, `//evil.test${target}`, '/console/whatsapp/link/'])
      expect(consoleReturnTarget([bad])).toBeNull();
    expect(consoleReturnTarget([target, target])).toBeNull();
  });

  it('a signed-out visitor is sent to sign-in and the owner DO is never reached', async () => {
    const ns = owners();
    const response = (await handleConsole(new Request(`https://w.test${target}`), { OWNER_DO: ns.ns }, auth()))!;
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe(`/console/signin?return_to=${encodeURIComponent(target)}`);
    expect(ns.fetch).not.toHaveBeenCalled();
    const html = await (await handleConsole(new Request(`https://w.test/console/signin?return_to=${encodeURIComponent(target)}`), { OWNER_DO: ns.ns }, auth()))!.text();
    expect(html).toContain('link your WhatsApp number');
    expect(html).toContain(`name="return_to" value="${target}"`);
  });

  it('after sign-in the owner lands back on the confirm page, which still has to be confirmed', async () => {
    const verified = (await handleConsole(new Request('https://w.test/console/verify', { method: 'POST', body: new URLSearchParams({ email: 'owner@example.com', code: '123456', return_to: target }) }),
      { OWNER_DO: owners().ns, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as unknown as RateLimit },
      auth({ verify: async () => 'do-a', throttle: async () => true } as Partial<ConsoleAuth>)))!;
    expect(verified.status).toBe(303);
    expect(verified.headers.get('location')).toBe(target);
  });
});

describe('the confirm page and the bind', () => {
  const token = 'B'.repeat(43);
  const path = `/console/whatsapp/link/${token}`;
  const dir = (overrides: Partial<WhatsAppLinkDirectory> = {}): WhatsAppLinkDirectory => ({
    open: vi.fn(async () => 'waitlist' as const), subject: vi.fn(async () => SENDER), consume: vi.fn(async () => 'linked' as const), ...overrides,
  });
  const confirmForm = (fields: Record<string, string>) => { const form = new FormData(); for (const [k, v] of Object.entries(fields)) form.set(k, v); return form; };

  it('shows the full number with an explicit confirm and binds nothing on view', async () => {
    const directory = dir();
    const response = await whatsappLinkConfirmPage(path, 'do-a', 'csrf-1', directory);
    const html = await response.text();
    expect(response.status).toBe(200);
    expect(html).toContain('+15550001111');
    expect(html).toContain('Yes, link +15550001111');
    expect(html).toContain('name="csrf" value="csrf-1"');
    expect(html).toContain(`name="action" value="${WHATSAPP_LINK_CONFIRM_ACTION}"`);
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(directory.subject).toHaveBeenCalledWith('do-a', await whatsappLinkTokenHash(token));
    expect(directory.consume).not.toHaveBeenCalled();
  });

  it('a link that is not live for this owner shows no number', async () => {
    const response = await whatsappLinkConfirmPage(path, 'do-other', 'csrf-1', dir({ subject: vi.fn(async () => null) }));
    expect(response.status).toBe(404);
    expect(await response.text()).not.toContain('5550001111');
    const malformed = dir();
    expect((await whatsappLinkConfirmPage('/console/whatsapp/link/short', 'do-a', 'csrf-1', malformed)).status).toBe(404);
    expect(malformed.subject).not.toHaveBeenCalled();
  });

  it('a confirm without this session\'s CSRF token binds nothing', async () => {
    const directory = dir();
    const onLinked = vi.fn();
    for (const form of [confirmForm({ action: WHATSAPP_LINK_CONFIRM_ACTION, token, subject: SENDER }), confirmForm({ csrf: 'csrf-forged', action: WHATSAPP_LINK_CONFIRM_ACTION, token, subject: SENDER })])
      expect((await whatsappLinkConfirmAction(form, 'csrf-1', 'do-a', directory, onLinked)).status).toBe(403);
    expect((await whatsappLinkConfirmAction(confirmForm({ csrf: 'csrf-1', token, subject: SENDER }), 'csrf-1', '', directory, onLinked)).status).toBe(403);
    expect(directory.consume).not.toHaveBeenCalled();
    expect(onLinked).not.toHaveBeenCalled();
  });

  it('a confirmed link is consumed for this owner and number, and only a linked answer rebinds', async () => {
    const onLinked = vi.fn();
    const linked = dir();
    expect((await whatsappLinkConfirmAction(confirmForm({ csrf: 'csrf-1', action: WHATSAPP_LINK_CONFIRM_ACTION, token, subject: SENDER }), 'csrf-1', 'do-a', linked, onLinked)).status).toBe(200);
    expect(linked.consume).toHaveBeenCalledWith('do-a', await whatsappLinkTokenHash(token), SENDER);
    expect(onLinked).toHaveBeenCalledWith(SENDER);
    onLinked.mockClear();
    for (const [answer, status] of [['rejected', 404], ['claimed', 409]] as const) {
      expect((await whatsappLinkConfirmAction(confirmForm({ csrf: 'csrf-1', token, subject: SENDER }), 'csrf-1', 'do-a', dir({ consume: vi.fn(async () => answer) }), onLinked)).status).toBe(status);
    }
    const claimed = await whatsappLinkConfirmAction(confirmForm({ csrf: 'csrf-1', token, subject: SENDER }), 'csrf-1', 'do-a', dir({ consume: vi.fn(async () => 'claimed' as const) }), onLinked);
    expect(await claimed.text()).toContain('is already in use on another Waldo account');
    expect(onLinked).not.toHaveBeenCalled();
    const malformed = dir();
    expect((await whatsappLinkConfirmAction(confirmForm({ csrf: 'csrf-1', token: 'short', subject: SENDER }), 'csrf-1', 'do-a', malformed, onLinked)).status).toBe(404);
    expect((await whatsappLinkConfirmAction(confirmForm({ csrf: 'csrf-1', token, subject: '+15550001111' }), 'csrf-1', 'do-a', malformed, onLinked)).status).toBe(404);
    expect(malformed.consume).not.toHaveBeenCalled();
  });
});

describe('the directory calls', () => {
  const env = { SUPABASE_PROJECT_URL: 'https://db.example', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router' };
  const rpc = (answer: unknown) => vi.fn(async (_url: string, _init?: RequestInit) => Response.json(answer));
  const hash = 'c'.repeat(64);

  it('signs the messages the database functions check and passes the hash, never a token', async () => {
    const fetcher = rpc('opened');
    expect(await whatsappLinkDirectory(env, fetcher as unknown as typeof fetch)!.open(SENDER, hash)).toBe('opened');
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://db.example/rest/v1/rpc/open_presence_link_request');
    expect(JSON.parse(String(init?.body))).toMatchObject({ p_provider: 'whatsapp', p_subject: SENDER, p_token_hash: hash });
    const viewer = rpc(SENDER);
    expect(await whatsappLinkDirectory(env, viewer as unknown as typeof fetch)!.subject('do-a', hash)).toBe(SENDER);
    const consumer = rpc('claimed');
    expect(await whatsappLinkDirectory(env, consumer as unknown as typeof fetch)!.consume('do-a', hash, SENDER)).toBe('claimed');
    expect(JSON.parse(String(consumer.mock.calls[0]![1]?.body))).toMatchObject({ p_do_name: 'do-a', p_token_hash: hash, p_subject: SENDER });
  });

  it('an answer outside the contract is an error, never read as success', async () => {
    await expect(whatsappLinkDirectory(env, rpc('yes') as unknown as typeof fetch)!.open(SENDER, hash)).rejects.toThrow('answered unexpectedly');
    await expect(whatsappLinkDirectory(env, rpc(true) as unknown as typeof fetch)!.consume('do-a', hash, SENDER)).rejects.toThrow('answered unexpectedly');
    await expect(whatsappLinkDirectory(env, rpc('+15550001111') as unknown as typeof fetch)!.subject('do-a', hash)).rejects.toThrow('answered unexpectedly');
    expect(await whatsappLinkDirectory(env, rpc(null) as unknown as typeof fetch)!.subject('do-a', hash)).toBeNull();
    expect(whatsappLinkDirectory({})).toBeNull();
  });
});
