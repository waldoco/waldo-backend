import { describe, expect, it, vi } from 'vitest';
import { whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { createWhatsAppMediaUploader, deliverWhatsAppFile } from '../src/channels/whatsapp-api';
import { egressGuardedCaller } from '../src/channels/egress-guard';
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
    const outcome = await deliverWhatsAppFile(call, 15550001111, { bytes: new Uint8Array(4), mime: 'text/html', filename: 'page.html' }, 'Open page.html here: https://waldo.example/console/workspace/file?id=f1&revision=1');
    expect(outcome).toEqual({ status: 'degraded', reason: 'unsupported_type' });
    const [body] = sentBodies(graph as unknown as ReturnType<typeof graphOk>);
    expect(body.text.body).toContain("WhatsApp can't carry page.html");
    expect(body.text.body).toContain('https://waldo.example/console/workspace/file?id=f1&revision=1');
    expect(body.text.preview_url).toBeUndefined();

    expect(await deliverWhatsAppFile(call, 15550001111, pdf, 'fallback')).toEqual({ status: 'sent', providerMessageId: 'wamid.doc' });
    open = false;
    graph.mockClear();
    expect(await deliverWhatsAppFile(call, 15550001111, pdf, 'fallback')).toEqual({ status: 'blocked' });
    expect(graph).not.toHaveBeenCalled();
  });
});
