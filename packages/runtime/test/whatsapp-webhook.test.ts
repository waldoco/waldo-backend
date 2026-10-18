import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleWhatsAppWebhook, type WhatsAppWebhookEnv } from '../src/channels/whatsapp-webhook';
import type { OwnerDirectory } from '../src/identity/owner-directory';

const namespace = () => {
  const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response('ok'));
  const idFromName = vi.fn((name: string) => name);
  return { fetch, idFromName, ns: { idFromName, get: () => ({ fetch }) } as unknown as DurableObjectNamespace };
};

const sign = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const hex = [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
};

const payload = (messages: { from: string; text?: string }[], statuses = false) => JSON.stringify({
  entry: [{ changes: [{ value: {
    metadata: { phone_number_id: 'pn1' },
    messages: messages.map((m, i) => ({ from: m.from, id: `wamid.${i}`, type: 'text', text: { body: m.text ?? 'hi' } })),
    ...(statuses ? { statuses: [{ id: 'wamid.0', status: 'delivered' }] } : {}),
  } }] }],
});

const post = async (secret: string | null, body: string, appSecret = 'appsecret') => new Request('https://w.test/whatsapp/webhook', {
  method: 'POST', body,
  headers: secret === null ? {} : { 'x-hub-signature-256': await sign(appSecret, body) },
});

const run = async (request: Request, env: WhatsAppWebhookEnv, directory?: OwnerDirectory) => {
  const pending: Promise<unknown>[] = [];
  const response = await handleWhatsAppWebhook(request, env, (work) => pending.push(work), directory);
  await Promise.all(pending);
  return response;
};

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('handleWhatsAppWebhook', () => {
  it('a forwarded "waldo CODE" from an unlinked sender is never redeemed; the same text typed is', async () => {
    const { ns } = namespace();
    const redeem = vi.fn(async () => null);
    const directory: OwnerDirectory = { byPresence: async () => null, redeem };
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_ACCESS_TOKEN: 'fictional-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ messages: [{ id: 'wamid.out' }] })));
    const body = (context?: Record<string, unknown>) => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' },
      messages: [{ ...(context ? { context } : {}), from: '15550009999', id: 'wamid.code', timestamp: '1700000000', type: 'text', text: { body: 'waldo ABCDEFGH23' } }] } }] }] });
    for (const context of [{ forwarded: true }, { frequently_forwarded: true }]) expect((await run(await post('sig', body(context)), env, directory)).status).toBe(200);
    expect(redeem).not.toHaveBeenCalled();
    expect((await run(await post('sig', body()), env, directory)).status).toBe(200);
    expect(redeem).toHaveBeenCalledTimes(1);
  });
  it('GET verify: echoes the challenge for the right token, 403 otherwise', async () => {
    const { ns } = namespace();
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_VERIFY_TOKEN: 'vt' };
    const ok = await run(new Request('https://w.test/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt&hub.challenge=ch123'), env);
    expect(ok.status).toBe(200);
    expect(await ok.text()).toBe('ch123');
    expect((await run(new Request('https://w.test/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=ch123'), env)).status).toBe(403);
  });

  it('bad or missing signature is a 403 and never routes', async () => {
    const { fetch, ns } = namespace();
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' };
    const body = payload([{ from: '15550001111' }]);
    expect((await run(await post(null, body), env)).status).toBe(403);
    expect((await run(new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } }), env)).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('routes a verified message to the right owner DO with the whatsapp subject and owner name headers', async () => {
    const { fetch, idFromName, ns } = namespace();
    const directory: OwnerDirectory = {
      byPresence: async (provider, subject) => {
        expect(provider).toBe('whatsapp');
        return subject === '15550001111' ? { doName: 'do-a', subject, timezone: 'Asia/Kolkata' } : null;
      },
      redeem: async () => null,
    };
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' };
    const body = payload([{ from: '15550001111' }], true);
    expect((await run(await post('x', body), env, directory)).status).toBe(200);
    expect(idFromName).toHaveBeenCalledWith('do-a');
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/whatsapp-admit', {
      method: 'POST', body: expect.any(String),
      headers: { 'x-waldo-origin': 'https://w.test', 'x-waldo-whatsapp-subject': '15550001111', 'x-waldo-do-name': 'do-a', 'x-waldo-timezone': 'Asia/Kolkata' },
    });
    // the forwarded body carries only that sender's messages, never the status callbacks
    const forwarded = JSON.parse(String(fetch.mock.calls[0]![1]!.body)) as { messages: unknown[]; statuses?: unknown[] };
    expect(forwarded.messages).toHaveLength(1);
    expect(forwarded.statuses).toBeUndefined();
  });

  it('admission: a definite refusal (400, 403 such as a sender the owner has not bound, 404) is acknowledged; anything else answers 503', async () => {
    const directory: OwnerDirectory = { byPresence: async () => ({ doName: 'do-a', subject: '15550001111', timezone: null }), redeem: async () => null };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const replies: [() => Promise<Response>, number][] = [
      [async () => new Response('forbidden', { status: 403 }), 200], [async () => new Response('bad request', { status: 400 }), 200],
      [async () => new Response('not found', { status: 404 }), 200],
      [async () => new Response('conflict', { status: 409 }), 503], [async () => new Response('slow down', { status: 429 }), 503],
      [async () => new Response('unavailable', { status: 503 }), 503], [async () => { throw new Error('owner unreachable'); }, 503],
    ];
    try {
      for (const [reply, expected] of replies) {
        const { fetch, ns } = namespace();
        fetch.mockImplementation(reply);
        expect((await run(await post('x', payload([{ from: '15550001111' }])), { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' }, directory)).status).toBe(expected);
      }
      expect(log.mock.calls.map(([line]) => String(line)).filter(line => line.includes('"hop":"whatsapp_admit"'))).toHaveLength(7);
    } finally { log.mockRestore(); }
  });

  it('after an unlink the old sender wakes no DO, while another owner keeps routing', async () => {
    const { fetch, idFromName, ns } = namespace();
    // Only active presences route; unlink_presence retires the row, so the directory stops answering for that number.
    const active = new Map([['15550001111', 'do-a'], ['15550002222', 'do-b']]);
    const directory: OwnerDirectory = { byPresence: async (_provider, subject) => active.has(subject) ? { doName: active.get(subject)!, subject, timezone: null } : null, redeem: async () => null };
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' };
    active.delete('15550001111');
    expect((await run(await post('x', payload([{ from: '15550001111', text: 'still me?' }, { from: '15550002222' }])), env, directory)).status).toBe(200);
    expect(idFromName.mock.calls).toEqual([['do-b']]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('a multi-sender payload routes each owner only their own messages', async () => {
    const { fetch, ns } = namespace();
    const directory: OwnerDirectory = {
      byPresence: async (_p, subject) => ({ '15550001111': { doName: 'do-a', subject, timezone: null }, '15550002222': { doName: 'do-b', subject, timezone: null } })[subject] ?? null,
      redeem: async () => null,
    };
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' };
    await run(await post('x', payload([{ from: '15550001111', text: 'one' }, { from: '15550002222', text: 'two' }])), env, directory);
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const call of fetch.mock.calls) {
      const value = JSON.parse(String(call[1]!.body)) as { messages: { from: string; text: { body: string } }[] };
      expect(value.messages).toHaveLength(1);
      const only = value.messages[0]!;
      expect(['one', 'two']).toContain(only.text.body);
    }
  });

  it('an unknown sender wakes no DO; a valid link code redeems and replies, a bad one declines', async () => {
    const { fetch, ns } = namespace();
    const graph = vi.fn(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    vi.stubGlobal('fetch', graph);
    const redeem = vi.fn(async (_p: string, _s: string, code: string) => code === 'GOOD12' ? { doName: 'do-a', subject: '15550003333', timezone: null } : null);
    const directory: OwnerDirectory = { byPresence: async () => null, redeem };
    const env: WhatsAppWebhookEnv = {
      OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_ACCESS_TOKEN: 'wabearer-t0ken', WHATSAPP_PHONE_NUMBER_ID: 'pn1',
    };
    // unknown sender, no code: nothing happens
    await run(await post('x', payload([{ from: '15550003333', text: 'hello' }])), env, directory);
    expect(fetch).not.toHaveBeenCalled();
    expect(redeem).not.toHaveBeenCalled();
    // valid code
    await run(await post('x', payload([{ from: '15550003333', text: 'waldo GOOD12' }])), env, directory);
    expect(redeem).toHaveBeenCalledWith('whatsapp', '15550003333', 'GOOD12');
    expect(JSON.parse(String((graph.mock.calls[0] as unknown as [string, RequestInit])[1].body)).text.body).toContain('Linked');
    // bad code
    await run(await post('x', payload([{ from: '15550003333', text: 'waldo WRONG1' }])), env, directory);
    expect(JSON.parse(String((graph.mock.calls[1] as unknown as [string, RequestInit])[1].body)).text.body).toContain('did not work');
    // both replies address the sender in E.164, with its plus
    expect((graph.mock.calls as unknown as [string, RequestInit][]).map(([, init]) => JSON.parse(String(init.body)).to)).toEqual(['+15550003333', '+15550003333']);
    // the bearer token stays in the authorization header, never in the body
    expect(String((graph.mock.calls[0] as unknown as [string, RequestInit])[1].body)).not.toContain('wabearer-t0ken');
    expect((graph.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toMatchObject({ authorization: 'Bearer wabearer-t0ken' });
  });

  it('a link-code reply that fails is logged by its name, HTTP status and Meta code, never by the number, a message id or Graph\'s text', async () => {
    const { ns } = namespace();
    const directory: OwnerDirectory = { byPresence: async () => null, redeem: async () => null };
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_ACCESS_TOKEN: 'fictional-token', WHATSAPP_PHONE_NUMBER_ID: 'pn1' };
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const refusal = { error: { code: 131030, message: '(#131030) Recipient 15550003333 not in allowed list', error_data: { details: 'FICTIONAL-DETAIL wamid.fictional' } } };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json(refusal, { status: 400 })));
    await run(await post('x', payload([{ from: '15550003333', text: 'waldo GOOD12' }])), env, directory);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network unreachable for 15550003333'); }));
    await run(await post('x', payload([{ from: '15550003333', text: 'waldo GOOD12' }])), env, directory);
    expect(logs.map(line => JSON.parse(line))).toEqual([
      { hop: 'whatsapp_link_code', ok: false, error: 'Error', status: 400, code: 131030 },
      { hop: 'whatsapp_link_code', ok: false, error: 'TypeError' },
    ]);
    for (const leak of ['15550003333', 'wamid.', 'FICTIONAL-DETAIL', 'allowed list', 'unreachable']) expect(logs.join('\n')).not.toContain(leak);
  });

  it('a stranger sending a bare code, or a status-only callback, wakes nothing and redeems nothing', async () => {
    const { fetch, ns } = namespace();
    vi.stubGlobal('fetch', vi.fn());
    const redeem = vi.fn(async () => null);
    const directory: OwnerDirectory = { byPresence: async () => null, redeem };
    const env: WhatsAppWebhookEnv = { OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_ACCESS_TOKEN: 't', WHATSAPP_PHONE_NUMBER_ID: 'pn1' };
    await run(await post('x', payload([{ from: '15550004444', text: 'GOOD12' }])), env, directory);
    await run(await post('x', payload([], true)), env, directory);
    expect(redeem).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});

describe('handleWhatsAppWebhook: a send Meta refuses later for the 24-hour window', () => {
  const statuses = (rows: object[]) => JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, statuses: rows } }] }] });
  const refused = (id: string, recipient: string, timestamp: unknown = '1700000000') => ({ id, status: 'failed', timestamp, recipient_id: recipient, errors: [{ code: 131047, title: 'Re-engagement message' }] });
  const directory: OwnerDirectory = { byPresence: async (_p, subject) => subject === '15550001111' ? { doName: 'do-a', subject, timezone: null } : null, redeem: async () => null };
  const env = (ns: DurableObjectNamespace): WhatsAppWebhookEnv => ({ OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret' });

  it('goes to the recipient owner\'s Durable Object with only the refused message ids; other statuses and strangers go nowhere', async () => {
    const { fetch, ns } = namespace();
    const body = statuses([
      refused('wamid.a', '15550001111'),
      { id: 'wamid.b', status: 'delivered', recipient_id: '15550001111' },
      { id: 'wamid.c', status: 'failed', recipient_id: '15550001111', errors: [{ code: 131026 }] },
      refused('wamid.d', '15550009999'),
      refused('wamid.e', '15550001111', 'yesterday'),
    ]);
    expect((await run(await post('x', body), env(ns), directory)).status).toBe(200);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith('https://telegram-owner/whatsapp-status', {
      method: 'POST', body: JSON.stringify({ refused: [{ id: 'wamid.a', at: 1_700_000_000_000 }, { id: 'wamid.e', at: null }] }), headers: { 'x-waldo-whatsapp-subject': '15550001111' },
    });
  });

  it('logs every failed status by its numeric error codes alone: no recipient, message id or error text, and nothing for other statuses', async () => {
    const { ns } = namespace();
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const body = statuses([
      { id: 'wamid.s1', status: 'failed', timestamp: '1700000000', recipient_id: '15550001111',
        errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable to 15550001111', error_data: { details: 'FICTIONAL-DETAIL' } }] },
      refused('wamid.s2', '15550001111'),
      { id: 'wamid.s3', status: 'delivered', timestamp: '1700000000', recipient_id: '15550001111' },
      { id: 'wamid.s4', status: 'failed', recipient_id: '15550009999', errors: [{ code: '131000' }, { code: 131042 }, {}, null] },
      { id: 'wamid.s5', status: 'failed', recipient_id: '15550009999' },
    ]);
    expect((await run(await post('x', body), env(ns), directory)).status).toBe(200);
    expect(logs.map(line => JSON.parse(line))).toEqual([
      { hop: 'whatsapp_status_failed', codes: [131026] },
      { hop: 'whatsapp_status_failed', codes: [131047] },
      { hop: 'whatsapp_status_failed', codes: [131042] },
      { hop: 'whatsapp_status_failed', codes: [] },
    ]);
    for (const leak of ['15550001111', '15550009999', 'wamid.', 'undeliverable', 'FICTIONAL-DETAIL', 'Re-engagement']) expect(logs.join('\n')).not.toContain(leak);
  });

  it('logs a failed status for a recipient no owner has, though routing skips it, by its codes alone', async () => {
    const { fetch, ns } = namespace();
    const unlinked: OwnerDirectory = { byPresence: vi.fn(async () => null), redeem: async () => null };
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const body = statuses([
      { id: 'wamid.u1', status: 'failed', timestamp: '1700000000', recipient_id: '15550007777',
        errors: [{ code: 131026, title: 'Message undeliverable', message: 'Message undeliverable to 15550007777' }] },
      refused('wamid.u2', '15550007777'),
    ]);
    expect((await run(await post('x', body), env(ns), unlinked)).status).toBe(200);
    expect(unlinked.byPresence).toHaveBeenCalledWith('whatsapp', '15550007777');
    expect(fetch).not.toHaveBeenCalled();
    expect(logs.map(line => JSON.parse(line))).toEqual([{ hop: 'whatsapp_status_failed', codes: [131026] }, { hop: 'whatsapp_status_failed', codes: [131047] }]);
    for (const leak of ['15550007777', 'wamid.', 'undeliverable', 'Re-engagement']) expect(logs.join('\n')).not.toContain(leak);
  });

  it('answers 503 when the owner could not take it for now, so Meta delivers the callback again', async () => {
    for (const reply of [async () => new Response('unavailable', { status: 503 }), async () => { throw new Error('owner unreachable'); }]) {
      const { fetch, ns } = namespace();
      fetch.mockImplementation(reply);
      expect((await run(await post('x', statuses([refused('wamid.a', '15550001111')])), env(ns), directory)).status).toBe(503);
    }
  });

  it('acknowledges a definite refusal from the owner (a 4xx), which a redelivery could never change', async () => {
    for (const status of [400, 403]) {
      const { fetch, ns } = namespace();
      fetch.mockImplementation(async () => new Response('refused', { status }));
      expect((await run(await post('x', statuses([refused('wamid.a', '15550001111')])), env(ns), directory)).status).toBe(200);
    }
  });
});

describe('handleWhatsAppWebhook: staging debug logging', () => {
  const failedStatus = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: 'pn1' }, statuses: [
    { id: 'wamid.d1', status: 'failed', timestamp: '1700000000', recipient_id: '15550005555',
      errors: [{ code: 131031, title: 'FICTIONAL-TITLE', message: 'FICTIONAL-MESSAGE', error_data: { details: 'FICTIONAL-DETAIL' } }],
      pricing: { billable: false, pricing_model: 'PMP', category: 'service' } },
  ] } }] }] });
  const unlinked: OwnerDirectory = { byPresence: async () => null, redeem: async () => null };
  const debugEnv = (ns: DurableObjectNamespace, environment: string, flag = 'true'): WhatsAppWebhookEnv =>
    ({ OWNER_DO: ns, WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_DEBUG_LOG: flag, WALDO_ENVIRONMENT: environment });
  const capture = () => {
    const logs: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    return logs;
  };

  it('on staging, logs the whole signed payload, Meta\'s error text and pricing included, beside the codes-only line', async () => {
    const logs = capture();
    expect((await run(await post('x', failedStatus), debugEnv(namespace().ns, 'staging'), unlinked)).status).toBe(200);
    expect(logs.map(line => JSON.parse(line))).toEqual([
      { hop: 'whatsapp_debug_payload', payload: JSON.parse(failedStatus) },
      { hop: 'whatsapp_status_failed', codes: [131031] },
    ]);
  });

  it('never logs the payload outside staging, whatever the flag says, or on staging with the flag off', async () => {
    const unnamed: WhatsAppWebhookEnv = { OWNER_DO: namespace().ns, WHATSAPP_APP_SECRET: 'appsecret', WHATSAPP_DEBUG_LOG: 'true' };
    for (const env of [debugEnv(namespace().ns, 'production'), debugEnv(namespace().ns, 'preview'), unnamed, debugEnv(namespace().ns, 'staging', 'false'), debugEnv(namespace().ns, 'staging', '')]) {
      const logs = capture();
      await run(await post('x', failedStatus), env, unlinked);
      expect(logs.map(line => JSON.parse(line))).toEqual([{ hop: 'whatsapp_status_failed', codes: [131031] }]);
      for (const leak of ['15550005555', 'wamid.', 'FICTIONAL']) expect(logs.join('\n')).not.toContain(leak);
      vi.restoreAllMocks();
    }
  });

  it('logs nothing for a payload whose signature fails, and never the verify token', async () => {
    const logs = capture();
    const env = { ...debugEnv(namespace().ns, 'staging'), WHATSAPP_VERIFY_TOKEN: 'vt-fictional' };
    const forged = new Request('https://w.test/whatsapp/webhook', { method: 'POST', body: failedStatus, headers: { 'x-hub-signature-256': 'sha256=deadbeef' } });
    expect((await run(forged, env)).status).toBe(403);
    expect((await run(new Request('https://w.test/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=vt-fictional&hub.challenge=c1'), env)).status).toBe(200);
    expect(logs).toEqual([]);
  });

  it('on staging, a refused reply logs Graph\'s whole error body; in production only its numbers; never the access token', async () => {
    const refusal = { error: { code: 131031, message: '(#131031) FICTIONAL-MESSAGE', error_data: { details: 'FICTIONAL-DETAIL' } } };
    const cases = [
      ['staging', { hop: 'whatsapp_link_code', ok: false, error: 'Error', status: 400, code: 131031, body: JSON.stringify(refusal) }],
      ['production', { hop: 'whatsapp_link_code', ok: false, error: 'Error', status: 400, code: 131031 }],
    ] as const;
    for (const [environment, expected] of cases) {
      const logs = capture();
      vi.stubGlobal('fetch', vi.fn(async () => Response.json(refusal, { status: 400 })));
      const env = { ...debugEnv(namespace().ns, environment), WHATSAPP_ACCESS_TOKEN: 'fictional-bearer-token', WHATSAPP_PHONE_NUMBER_ID: 'pn1' };
      await run(await post('x', payload([{ from: '15550003333', text: 'waldo GOOD12' }])), env, unlinked);
      expect(logs.map(line => JSON.parse(line)).filter(line => line.hop === 'whatsapp_link_code')).toEqual([expected]);
      expect(logs.join('\n')).not.toContain('fictional-bearer-token');
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
    }
  });

  it('on staging, a reply that fails without a Graph answer logs the error text', async () => {
    const logs = capture();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('FICTIONAL network failure'); }));
    const env = { ...debugEnv(namespace().ns, 'staging'), WHATSAPP_ACCESS_TOKEN: 'fictional-bearer-token', WHATSAPP_PHONE_NUMBER_ID: 'pn1' };
    await run(await post('x', payload([{ from: '15550003333', text: 'waldo GOOD12' }])), env, unlinked);
    expect(logs.map(line => JSON.parse(line)).filter(line => line.hop === 'whatsapp_link_code'))
      .toEqual([{ hop: 'whatsapp_link_code', ok: false, error: 'TypeError', detail: 'TypeError: FICTIONAL network failure' }]);
  });
});
