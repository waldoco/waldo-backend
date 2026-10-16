import { describe, expect, it, vi } from 'vitest';
import { whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { createWhatsAppMediaUploader, deliverWhatsAppFile } from '../src/channels/whatsapp-api';
import { egressGuardedCaller } from '../src/channels/egress-guard';
import { WA_LAST_INBOUND_KEY, WHATSAPP_HELD_RETENTION_MS, deliverHeldWhatsApp, recordWhatsAppInbound, whatsappTemplateConfig, whatsappWindowCaller } from '../src/channels/whatsapp-window';
import { gatedCaller } from '../src/channels/telegram-api';
import { DOCX_MIME as DOCX } from '../src/channels/document-render';

const graphOk = () => vi.fn(async (_url: string, _init?: RequestInit) => Response.json({ messages: [{ id: 'wamid.out' }] }));
const sentBodies = (graph: ReturnType<typeof graphOk>) => graph.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));

describe('whatsapp link previews', () => {
  it('a text with an http(s) link asks for a preview when the caller has not disabled one', async () => {
    const graph = graphOk();
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    await shim('sendMessage', { chat_id: 15550001111, text: 'Here is the page: https://example.com/menu' });
    expect(sentBodies(graph)[0].text).toEqual({ body: 'Here is the page: https://example.com/menu', preview_url: true });
  });

  it('a text without a link, or with only a bare domain, carries no preview flag', async () => {
    const graph = graphOk();
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    await shim('sendMessage', { chat_id: 15550001111, text: 'No links here' });
    await shim('sendMessage', { chat_id: 15550001111, text: 'Try example.com later' });
    expect(sentBodies(graph).map(body => body.text)).toEqual([{ body: 'No links here' }, { body: 'Try example.com later' }]);
  });

  it('a caller that disabled previews gets none, so the egress guard still stops unrequested link fetches', async () => {
    const graph = graphOk();
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    await shim('sendMessage', { chat_id: 15550001111, text: 'https://example.com/a', link_preview_options: { is_disabled: true } });
    await egressGuardedCaller(shim, () => undefined)('sendMessage', { chat_id: 15550001111, text: 'Unsubscribe: https://mail.example.com/u/once' });
    expect(sentBodies(graph).map(body => body.text)).toEqual([{ body: 'https://example.com/a' }, { body: 'Unsubscribe: https://mail.example.com/u/once' }]);
  });
});

describe('whatsapp outbound files', () => {
  const pdf = { bytes: new TextEncoder().encode('%PDF-1.4 test'), mime: 'application/pdf', filename: 'plan.pdf' };
  const graphFiles = () => vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('/media') ? Response.json({ id: 'media-77' }) : Response.json({ messages: [{ id: 'wamid.doc' }] }));

  it('uploads the bytes as multipart to the phone number media edge, then sends the document by media id', async () => {
    const graph = graphFiles();
    const upload = createWhatsAppMediaUploader('tok', 'pn1', graph as unknown as typeof fetch);
    expect(await upload(pdf)).toBe('media-77');
    const [url, init] = graph.mock.calls[0]!;
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/media');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer tok');
    const form = init?.body as FormData;
    expect(form.get('messaging_product')).toBe('whatsapp');
    expect(form.get('type')).toBe('application/pdf');
    const file = form.get('file') as unknown as File;
    expect(file.name).toBe('plan.pdf');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(pdf.bytes);

    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    expect(await shim('sendDocument', { chat_id: 15550001111, file: pdf })).toEqual({ messages: [{ id: 'wamid.doc' }] });
    expect(JSON.parse(String(graph.mock.calls[2]![1]?.body))).toEqual({ messaging_product: 'whatsapp', to: '15550001111', type: 'document', document: { id: 'media-77', filename: 'plan.pdf' } });
  });

  it('a jpeg or png goes as an image message; docx, xlsx, pptx and txt go as documents', async () => {
    const graph = graphFiles();
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    const bytes = new Uint8Array([1, 2, 3]);
    await shim('sendDocument', { chat_id: 1, file: { bytes, mime: 'image/png', filename: 'chart.png' } });
    for (const [mime, filename] of [[DOCX, 'notes.docx'], ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'sheet.xlsx'], ['application/vnd.openxmlformats-officedocument.presentationml.presentation', 'deck.pptx'], ['text/plain', 'list.txt']] as const)
      await shim('sendDocument', { chat_id: 1, file: { bytes, mime, filename } });
    const sends = graph.mock.calls.filter(([url]) => url.endsWith('/messages')).map(([, init]) => JSON.parse(String(init?.body)));
    expect(sends.map(body => body.type)).toEqual(['image', 'document', 'document', 'document', 'document']);
    expect(sends[0].image).toEqual({ id: 'media-77' });
  });

  it('a type WhatsApp cannot carry, or a file over its cap, is refused before any upload', async () => {
    const graph = graphFiles();
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    await expect(shim('sendDocument', { chat_id: 1, file: { bytes: new Uint8Array(4), mime: 'text/html', filename: 'page.html' } })).rejects.toMatchObject({ reason: 'unsupported_type' });
    await expect(shim('sendDocument', { chat_id: 1, file: { bytes: new Uint8Array(4), mime: 'image/gif', filename: 'a.gif' } })).rejects.toMatchObject({ reason: 'unsupported_type' });
    await expect(shim('sendDocument', { chat_id: 1, file: { bytes: new Uint8Array(5 * 1024 * 1024 + 1), mime: 'image/jpeg', filename: 'big.jpg' } })).rejects.toMatchObject({ reason: 'too_large' });
    await expect(shim('sendDocument', { chat_id: 1, file: { bytes: new Uint8Array(0), mime: 'application/pdf', filename: 'empty.pdf' } })).rejects.toMatchObject({ reason: 'empty' });
    await expect(shim('sendDocument', { chat_id: 1, file: { bytes: new Uint8Array(4), mime: 'application/pdf', filename: '' } })).rejects.toMatchObject({ reason: 'invalid_filename' });
    expect(graph).not.toHaveBeenCalled();
  });

  it('an upload Meta refuses, or one that returns no media id, fails without sending a message', async () => {
    const refused = vi.fn(async () => Response.json({ error: { code: 131053 } }, { status: 400 }));
    await expect(createWhatsAppMediaUploader('tok', 'pn1', refused as unknown as typeof fetch)(pdf)).rejects.toThrow('whatsapp media upload 400');
    const noId = vi.fn(async (_url: string) => Response.json({}));
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', noId as unknown as typeof fetch);
    await expect(shim('sendDocument', { chat_id: 1, file: pdf })).rejects.toThrow('whatsapp media upload returned no id');
    expect(noId.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(0);
  });

  it('delivery degrades to a guarded text with the owner link when WhatsApp refuses the file, and sends nothing when the gate is shut', async () => {
    const graph = graphFiles();
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    let open = true;
    const call = egressGuardedCaller(gatedCaller(shim, () => !open), () => undefined);
    const outcome = await deliverWhatsAppFile(call, 15550001111, { bytes: new Uint8Array(4), mime: 'text/html', filename: 'page.html' }, async () => 'Open page.html here: https://waldo.example/console/workspace/file?id=f1&revision=1');
    expect(outcome).toEqual({ status: 'degraded', reason: 'unsupported_type' });
    const [body] = sentBodies(graph as unknown as ReturnType<typeof graphOk>);
    expect(body.text.body).toContain("WhatsApp can't carry page.html");
    expect(body.text.body).toContain('https://waldo.example/console/workspace/file?id=f1&revision=1');
    expect(body.text.preview_url).toBeUndefined();

    expect(await deliverWhatsAppFile(call, 15550001111, pdf, async () => 'fallback')).toEqual({ status: 'sent', providerMessageId: 'wamid.doc' });
    open = false;
    graph.mockClear();
    expect(await deliverWhatsAppFile(call, 15550001111, pdf, async () => 'fallback')).toEqual({ status: 'blocked' });
    expect(graph).not.toHaveBeenCalled();
  });
});

describe('whatsapp 24-hour window', () => {
  const HOUR = 60 * 60 * 1000;
  const T0 = 1_700_000_000_000;
  const fakeKv = () => { const map = new Map<string, unknown>(); return { map, kv: { get: <T>(k: string) => map.get(k) as T | undefined, put: (k: string, v: unknown) => { map.set(k, v); }, delete: (k: string) => map.delete(k), list: <T>({ prefix }: { prefix: string }) => [...map].filter(([k]) => k.startsWith(prefix)) as [string, T][] } }; };
  const template = { name: 'waldo_update_ready', language: 'en' };
  const setup = (clock: { now: number }, graph = graphOk(), tpl: typeof template | null = template) => {
    const { kv, map } = fakeKv();
    const log = vi.fn();
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    const call = whatsappWindowCaller(shim, { kv, template: tpl, now: () => clock.now, log });
    return { kv, map, log, graph, call };
  };

  it('records the message\'s own send time, clamps a future one, never moves back, and falls back to receipt time', () => {
    const { kv } = fakeKv();
    recordWhatsAppInbound(kv, [{ timestamp: String((T0 - HOUR) / 1000) }], T0);
    expect(kv.get(WA_LAST_INBOUND_KEY)).toBe(T0 - HOUR);
    recordWhatsAppInbound(kv, [{ timestamp: String((T0 - 30 * HOUR) / 1000) }], T0);
    expect(kv.get(WA_LAST_INBOUND_KEY)).toBe(T0 - HOUR);
    recordWhatsAppInbound(kv, [{ timestamp: String((T0 + HOUR) / 1000) }], T0);
    expect(kv.get(WA_LAST_INBOUND_KEY)).toBe(T0);
    recordWhatsAppInbound(kv, [{ timestamp: 'soon' }, {}], T0 + 5);
    expect(kv.get(WA_LAST_INBOUND_KEY)).toBe(T0 + 5);
  });

  it('inside the window a message goes out as free-form text', async () => {
    const clock = { now: T0 };
    const { kv, call, graph } = setup(clock);
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    clock.now = T0 + 23 * HOUR;
    expect(await call('sendMessage', { chat_id: 1, text: 'Your 6 pm reminder' })).toEqual({ messages: [{ id: 'wamid.out' }] });
    expect(sentBodies(graph)).toEqual([{ messaging_product: 'whatsapp', to: '15550001111', type: 'text', text: { body: 'Your 6 pm reminder' } }]);
  });

  it('outside the window the text is held, one approved template knocks, and a second message does not knock again', async () => {
    const clock = { now: T0 };
    const { kv, map, call, graph } = setup(clock);
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    clock.now = T0 + 25 * HOUR;
    expect(await call('sendMessage', { chat_id: 1, text: 'PRIVATE reminder one' })).toBeUndefined();
    expect(await call('sendMessage', { chat_id: 1, text: 'PRIVATE reminder two' })).toBeUndefined();
    const bodies = sentBodies(graph);
    expect(bodies).toEqual([{ messaging_product: 'whatsapp', to: '15550001111', type: 'template', template: { name: 'waldo_update_ready', language: { code: 'en' } } }]);
    expect(JSON.stringify(bodies)).not.toContain('PRIVATE');
    expect([...map.keys()].filter(key => key.startsWith('wa_held:'))).toHaveLength(2);
  });

  it('an owner with no recorded inbound is outside the window', async () => {
    const { call, graph } = setup({ now: T0 });
    expect(await call('sendMessage', { chat_id: 1, text: 'hello' })).toBeUndefined();
    expect(sentBodies(graph).map(body => body.type)).toEqual(['template']);
  });

  it('with no template configured nothing free-form leaves outside the window; the message is held and logged once', async () => {
    const { call, graph, log, map } = setup({ now: T0 }, graphOk(), null);
    await call('sendMessage', { chat_id: 1, text: 'one' });
    await call('sendMessage', { chat_id: 1, text: 'two' });
    expect(graph).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([event]) => event.code === 'template_unconfigured')).toHaveLength(1);
    expect([...map.keys()].filter(key => key.startsWith('wa_held:'))).toHaveLength(2);
    expect(whatsappTemplateConfig({ WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en_US' })).toEqual({ name: 'waldo_update_ready', language: 'en_US' });
    for (const bad of [{}, { WHATSAPP_REENGAGE_TEMPLATE: 'Has Spaces', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en' }, { WHATSAPP_REENGAGE_TEMPLATE: 'ok_name', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'english' }])
      expect(whatsappTemplateConfig(bad)).toBeNull();
  });

  it('a 131047 refusal inside our window holds and knocks; any other refusal propagates and holds nothing', async () => {
    const clock = { now: T0 };
    let refusal = 131047;
    const graph = vi.fn(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).type === 'template'
      ? Response.json({ messages: [{ id: 'wamid.knock' }] })
      : Response.json({ error: { code: refusal, message: 'refused' } }, { status: 400 }));
    const { kv, map, call } = setup(clock, graph as unknown as ReturnType<typeof graphOk>);
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    expect(await call('sendMessage', { chat_id: 1, text: 'held' })).toBeUndefined();
    expect(graph.mock.calls.map(([, init]) => JSON.parse(String(init?.body)).type)).toEqual(['text', 'template']);
    refusal = 131026;
    await expect(call('sendMessage', { chat_id: 1, text: 'not held' })).rejects.toMatchObject({ code: 131026 });
    expect([...map.keys()].filter(key => key.startsWith('wa_held:'))).toHaveLength(1);
  });

  it('a failed knock is logged and retried with the next held message; a new reply re-arms the knock', async () => {
    const clock = { now: T0 };
    let knockFails = true;
    const graph = vi.fn(async () => knockFails ? Response.json({ error: { code: 132001 } }, { status: 404 }) : Response.json({ messages: [{ id: 'wamid.k' }] }));
    const { kv, call, log } = setup(clock, graph as unknown as ReturnType<typeof graphOk>);
    await call('sendMessage', { chat_id: 1, text: 'a' });
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ code: 132001 }));
    knockFails = false;
    await call('sendMessage', { chat_id: 1, text: 'b' });
    await call('sendMessage', { chat_id: 1, text: 'c' });
    expect(graph).toHaveBeenCalledTimes(2);
    recordWhatsAppInbound(kv, [{ timestamp: String(T0 / 1000) }], T0);
    clock.now = T0 + 30 * HOUR;
    await call('sendMessage', { chat_id: 1, text: 'd' });
    expect(graph).toHaveBeenCalledTimes(3);
  });

  it('held messages go out in order once the owner replies, expired ones are dropped, and a failed send keeps the rest', async () => {
    const clock = { now: T0 };
    const { kv, map, call, graph } = setup(clock);
    for (const text of ['first', 'second', 'third']) await call('sendMessage', { chat_id: 1, text });
    graph.mockClear();
    clock.now = T0 + 2 * HOUR;
    recordWhatsAppInbound(kv, [{ timestamp: String(clock.now / 1000) }], clock.now);
    let fail = 'second';
    graph.mockImplementation(async (_url: string, init?: RequestInit) => JSON.parse(String(init?.body)).text?.body === fail ? Response.json({ error: { code: 131000 } }, { status: 500 }) : Response.json({ messages: [{ id: 'wamid.h' }] }));
    const log = vi.fn();
    await deliverHeldWhatsApp(kv, call, clock.now, log);
    expect(sentBodies(graph).map(body => body.text.body)).toEqual(['first', 'second']);
    expect([...map.keys()].filter(key => key.startsWith('wa_held:'))).toHaveLength(1);
    fail = '';
    graph.mockClear();
    await deliverHeldWhatsApp(kv, call, clock.now, log);
    expect(sentBodies(graph).map(body => body.text.body)).toEqual(['third']);

    clock.now += 25 * HOUR;
    expect(await call('sendMessage', { chat_id: 1, text: 'too old' })).toBeUndefined();
    graph.mockClear();
    clock.now += WHATSAPP_HELD_RETENTION_MS;
    recordWhatsAppInbound(kv, [{ timestamp: String(clock.now / 1000) }], clock.now);
    await deliverHeldWhatsApp(kv, call, clock.now, log);
    expect(graph).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith({ hop: 'whatsapp_held', ok: true, expired: 1 });
  });

  it('methods other than sendMessage pass straight through', async () => {
    const { call, graph } = setup({ now: T0 });
    expect(await call('sendChatAction', { chat_id: 1, action: 'typing' })).toBeUndefined();
    expect(graph).not.toHaveBeenCalled();
  });
});
