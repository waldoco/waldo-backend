import { afterEach, describe, expect, it, vi } from 'vitest';
import { LLM_ATTACHMENTS_MAX } from '@waldo/contracts';
import {
  IMESSAGE_MEDIA_MAX_BYTES, IMESSAGE_MEDIA_REPLIES, openIMessageMedia, photonAttachmentSource,
  type IMessageMedia, type PhotonAttachmentSource,
} from '../src/channels/imessage/photon-media';
import { renderIMessage } from '../src/channels/imessage/console';

// Every value here is fictional. The secret and token are distinctive so a leak into any output is found by substring.
const SECRET = 'fictional-photon-project-secret-7f3a9c';
const TOKEN = 'fictional-photon-bearer-token-51e0d2';
const ENV = { PHOTON_PROJECT_ID: 'proj-fixture', PHOTON_PROJECT_SECRET: SECRET };
const SENDER = 'owner@example.invalid';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 5, 6]);
const signal = () => new AbortController().signal;

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const photon = (overrides: Partial<Record<'token' | 'message' | 'data', Route>> = {}) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const message = { message: { guid: 'msg-1', sender: { address: SENDER }, content: { attachments: [
    { guid: 'att-photo', mimeType: 'image/png', totalBytes: String(PNG.length) },
    { guid: 'att-pdf', mimeType: 'application/pdf', totalBytes: String(PDF.length) },
  ] } } };
  const routes: Record<'token' | 'message' | 'data', Route> = {
    token: () => Response.json({ succeed: true, data: { type: 'shared', token: TOKEN, expiresIn: 3600 } }),
    message: () => Response.json(message),
    data: (url) => new Response(url.includes('att-pdf') ? PDF : PNG),
    ...overrides,
  };
  const fetcher = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    calls.push({ url, init });
    if (url === 'https://spectrum.photon.codes/projects/proj-fixture/imessage/tokens') return routes.token(url, init);
    if (url === 'https://imessage.spectrum.photon.codes/v1/messages/msg-1') return routes.message(url, init);
    if (url.startsWith('https://imessage.spectrum.photon.codes/v1/attachments/')) return routes.data(url, init);
    throw new Error('unexpected egress');
  }) as typeof fetch;
  return { fetcher, calls };
};
const request = (ids = ['att-photo']) => ({ messageGuid: 'msg-1', sender: SENDER, files: ids.map(id => ({ id, mimeType: id === 'att-pdf' ? 'application/pdf' : 'image/png' })), maxBytes: IMESSAGE_MEDIA_MAX_BYTES, signal: signal() });

afterEach(() => { vi.restoreAllMocks(); });

describe('photonAttachmentSource', () => {
  it('is absent until the project id and secret are both set', () => {
    expect(photonAttachmentSource({})).toBeNull();
    expect(photonAttachmentSource({ PHOTON_PROJECT_ID: 'proj-fixture' })).toBeNull();
    expect(photonAttachmentSource({ PHOTON_PROJECT_SECRET: SECRET })).toBeNull();
    expect(photonAttachmentSource({ PHOTON_PROJECT_ID: 'proj/../x', PHOTON_PROJECT_SECRET: SECRET })).toBeNull();
  });

  it('mints a project token, checks the message is the sender\'s, then reads each attachment over the documented HTTP route', async () => {
    const { fetcher, calls } = photon();
    const result = await photonAttachmentSource(ENV, fetcher)!(request(['att-photo', 'att-pdf']));
    expect(result).toEqual({ ok: true, bytes: [PNG, PDF] });
    expect(calls.map(c => `${c.init.method ?? 'GET'} ${c.url}`)).toEqual([
      'POST https://spectrum.photon.codes/projects/proj-fixture/imessage/tokens',
      'GET https://imessage.spectrum.photon.codes/v1/messages/msg-1',
      'GET https://imessage.spectrum.photon.codes/v1/attachments/att-photo/data',
      'GET https://imessage.spectrum.photon.codes/v1/attachments/att-pdf/data',
    ]);
    expect(new Headers(calls[0]!.init.headers).get('authorization')).toBe(`Basic ${btoa(`proj-fixture:${SECRET}`)}`);
    for (const call of calls.slice(1)) expect(new Headers(call.init.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
    for (const call of calls) expect(call.init.redirect).toBe('manual');
  });

  it.each([
    ['an internal address', 'https://10.0.0.8'], ['a private address', 'https://192.168.1.4'], ['a 172.16/12 address', 'https://172.20.0.1'],
    ['the metadata address', 'https://169.254.169.254'], ['localhost', 'https://localhost'], ['loopback', 'https://127.0.0.1'],
    ['a host off the allowlist', 'https://imessage.spectrum.photon.codes.example.invalid'], ['a lookalike', 'https://photon.codes'],
    ['plain http', 'http://imessage.spectrum.photon.codes'], ['another port', 'https://imessage.spectrum.photon.codes:8443'],
    ['credentials in the origin', 'https://user:pass@imessage.spectrum.photon.codes'],
  ])('refuses %s before any request', async (_name, origin) => {
    const { fetcher, calls } = photon();
    for (const origins of [{ token: origin, imessage: 'https://imessage.spectrum.photon.codes' }, { token: 'https://spectrum.photon.codes', imessage: origin }]) {
      expect(await photonAttachmentSource(ENV, fetcher, origins)!(request())).toEqual({ ok: false, code: 'egress_refused' });
    }
    expect(calls).toEqual([]);
  });

  it.each([
    ['another sender', { message: { sender: { address: 'someone-else@example.invalid' }, content: { attachments: [{ guid: 'att-photo', mimeType: 'image/png' }] } } }],
    ['no sender', { message: { content: { attachments: [{ guid: 'att-photo', mimeType: 'image/png' }] } } }],
    ['Waldo itself', { message: { isFromMe: true, sender: { address: SENDER }, content: { attachments: [{ guid: 'att-photo', mimeType: 'image/png' }] } } }],
    ['a message without that attachment', { message: { sender: { address: SENDER }, content: { attachments: [{ guid: 'att-other', mimeType: 'image/png' }] } } }],
    ['a different type than the host named', { message: { sender: { address: SENDER }, content: { attachments: [{ guid: 'att-photo', mimeType: 'application/x-msdownload' }] } } }],
  ])('refuses an attachment that belongs to %s and never reads it', async (_name, body) => {
    const { fetcher, calls } = photon({ message: () => Response.json(body) });
    expect(await photonAttachmentSource(ENV, fetcher)!(request())).toEqual({ ok: false, code: 'not_in_message' });
    expect(calls.some(c => c.url.includes('/data'))).toBe(false);
  });

  it('bounds size by what Photon declares and by what it streams', async () => {
    const declared = photon({ message: () => Response.json({ message: { sender: { address: SENDER }, content: { attachments: [{ guid: 'att-photo', mimeType: 'image/png', totalBytes: '9' }] } } }) });
    expect(await photonAttachmentSource(ENV, declared.fetcher)!({ ...request(), maxBytes: 8 })).toEqual({ ok: false, code: 'too_large' });
    expect(declared.calls.some(c => c.url.includes('/data'))).toBe(false);
    const streamed = photon({ data: () => new Response(new Uint8Array(9)) });
    expect(await photonAttachmentSource(ENV, streamed.fetcher)!({ ...request(), maxBytes: 8 })).toEqual({ ok: false, code: 'too_large' });
    const together = photon();
    expect(await photonAttachmentSource(ENV, together.fetcher)!({ ...request(['att-photo', 'att-pdf']), maxBytes: PNG.length + PDF.length - 1 })).toEqual({ ok: false, code: 'too_large' });
    // With no declared sizes, the bound over a whole message is what the files stream, each one under it on its own.
    const undeclared = photon({ message: () => Response.json({ message: { sender: { address: SENDER }, content: { attachments: [{ guid: 'att-photo', mimeType: 'image/png' }, { guid: 'att-pdf', mimeType: 'application/pdf' }] } } }) });
    expect(await photonAttachmentSource(ENV, undeclared.fetcher)!({ ...request(['att-photo', 'att-pdf']), maxBytes: Math.max(PNG.length, PDF.length) + 1 })).toEqual({ ok: false, code: 'too_large' });
  });

  it.each([
    ['a refused token', { token: () => new Response('{"succeed":false}', { status: 401 }) }, 'token_refused'],
    ['a dedicated-line token', { token: () => Response.json({ succeed: true, data: { type: 'dedicated', auth: { line: TOKEN }, numbers: {}, expiresIn: 3600 } }) }, 'token_unsupported'],
    ['a missing message', { message: () => new Response('not found', { status: 404 }) }, 'not_in_message'],
    ['an expired attachment', { data: () => new Response('gone', { status: 404 }) }, 'attachment_unavailable'],
    ['a redirect', { data: () => new Response(null, { status: 302, headers: { location: 'https://169.254.169.254/latest' } }) }, 'unexpected_response'],
    ['a network failure', { data: () => { throw new Error(`connect failed for https://imessage.spectrum.photon.codes Bearer ${TOKEN}`); } }, 'unreachable'],
  ] as const)('fails closed on %s and never writes the secret or token anywhere', async (_name, routes, code) => {
    const lines: string[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    const result = await photonAttachmentSource(ENV, photon(routes).fetcher)!(request());
    expect(result).toEqual({ ok: false, code });
    const seen = JSON.stringify([result, lines]);
    for (const secret of [SECRET, TOKEN, btoa(`proj-fixture:${SECRET}`)]) expect(seen).not.toContain(secret);
  });

  it('stops when the turn is cancelled', async () => {
    const controller = new AbortController();
    const { fetcher } = photon({ data: (_url, init) => { controller.abort(); init.signal?.throwIfAborted(); return new Response(PNG); } });
    expect(await photonAttachmentSource(ENV, fetcher)!({ ...request(), signal: controller.signal })).toEqual({ ok: false, code: 'unreachable' });
  });
});

describe('openIMessageMedia', () => {
  const photo = { id: 'att-photo', name: 'IMG_0001.png', mimeType: 'image/png', size: PNG.length };
  const pdf = { id: 'att-pdf', name: 'notes.pdf', mimeType: 'application/pdf', size: PDF.length };
  const media = (...files: IMessageMedia['files'][number][]): IMessageMedia => ({ messageGuid: 'msg-1', files });
  const opened = (bytes: readonly Uint8Array[]): PhotonAttachmentSource => vi.fn(async () => ({ ok: true as const, bytes }));
  const deps = (source: PhotonAttachmentSource | null, enabled = true) => ({ enabled, source, sender: SENDER, signal: signal(), admit: vi.fn() });

  it('opens a photo and a document into model attachments with a note for each', async () => {
    const d = deps(opened([PNG, PDF]));
    const result = await openIMessageMedia(media(photo, pdf), d);
    expect(result).toEqual({ kind: 'opened',
      parts: [{ authorship: 'media_note', text: '[Owner sent a photo, attached.]' }, { authorship: 'media_note', text: '[Owner sent a file "notes.pdf", attached.]' }],
      attachments: [{ kind: 'image', mime_type: 'image/png', filename: 'IMG_0001.png', data_base64: btoa(String.fromCharCode(...PNG)) },
        { kind: 'file', mime_type: 'application/pdf', filename: 'notes.pdf', data_base64: btoa(String.fromCharCode(...PDF)) }] });
    expect(d.source).toHaveBeenCalledWith(expect.objectContaining({ messageGuid: 'msg-1', sender: SENDER, files: [{ id: 'att-photo', mimeType: 'image/png' }, { id: 'att-pdf', mimeType: 'application/pdf' }], maxBytes: IMESSAGE_MEDIA_MAX_BYTES }));
    expect(d.admit).toHaveBeenCalledTimes(2);
  });

  it('answers once and fetches nothing while IMESSAGE_MEDIA is off', async () => {
    const d = deps(opened([PNG]), false);
    expect(await openIMessageMedia(media(photo), d)).toEqual({ kind: 'reply', text: "I got your photo but couldn't open it here; send it in the app." });
    expect(await openIMessageMedia(media(pdf, photo), d)).toEqual({ kind: 'reply', text: "I got your files but couldn't open them here; send them in the app." });
    expect(d.source).not.toHaveBeenCalled();
  });

  it.each([
    ['a voice note', [{ ...photo, name: 'Audio Message.caf', mimeType: 'audio/x-caf' }], IMESSAGE_MEDIA_REPLIES.voice],
    ['an audio file with a generic type', [{ ...photo, name: 'Audio Message.caf', mimeType: 'application/octet-stream' }], IMESSAGE_MEDIA_REPLIES.voice],
    ['more files than one turn carries', Array.from({ length: LLM_ATTACHMENTS_MAX + 1 }, (_, i) => ({ ...photo, id: `att-${i}` })), `I got your photos but can open at most ${LLM_ATTACHMENTS_MAX} at once here; send them in smaller batches or in the app.`],
    ['a video', [{ ...photo, name: 'clip.mov', mimeType: 'video/quicktime' }], "I got your file but can't read that format here; send it in the app."],
    ['a HEIC photo', [{ ...photo, name: 'IMG_0002.heic', mimeType: 'image/heic' }], "I got your photo but can't read that format here; send it in the app."],
    ['an oversized photo', [{ ...photo, size: IMESSAGE_MEDIA_MAX_BYTES + 1 }], "I got your photo but it is too large to open here; send it in the app."],
    ['files too large together', [{ ...photo, size: IMESSAGE_MEDIA_MAX_BYTES / 2 + 1 }, { ...pdf, size: IMESSAGE_MEDIA_MAX_BYTES / 2 }], "I got your files but they are too large to open here; send them in the app."],
    ['a Mac host file Photon does not hold', [{ name: photo.name, mimeType: photo.mimeType, size: photo.size }], "I got your photo but couldn't open it here; send it in the app."],
  ])('refuses %s honestly without fetching', async (_name, files, text) => {
    const d = deps(opened([PNG]));
    expect(await openIMessageMedia(media(...files), d)).toEqual({ kind: 'reply', text });
    expect(d.source).not.toHaveBeenCalled();
  });

  it('a voice note stays refused with the flag off', async () => {
    expect(await openIMessageMedia(media({ ...photo, mimeType: 'audio/mp4', name: 'voice.m4a' }), deps(null, false))).toEqual({ kind: 'reply', text: IMESSAGE_MEDIA_REPLIES.voice });
  });

  it.each([
    ['Photon is not configured', null],
    ['the fetch fails', vi.fn(async () => ({ ok: false as const, code: 'attachment_unavailable' as const }))],
    ['Photon returns the wrong number of files', opened([])],
  ])('falls back to the one honest reply when %s', async (_name, source) => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
    expect(await openIMessageMedia(media(photo), deps(source))).toEqual({ kind: 'reply', text: "I got your photo but couldn't open it here; send it in the app." });
    expect(lines.join('\n')).not.toMatch(/att-photo|IMG_0001|msg-1|owner@/);
  });

  it('the console says what happens to a photo or file, by the flag, and claims tapbacks only for a host that verified them', () => {
    const off = renderIMessage([], 'csrf', {}), on = renderIMessage([], 'csrf', { media: true });
    const TAPBACKS = 'Groups, SMS and voice notes are not supported. Waldo sends a tapback only from a host whose row says tapbacks verified.';
    expect(off).toContain(`Direct iMessage text only. Photos and files get a reply asking you to send them in the app. ${TAPBACKS}`);
    expect(on).toContain(`Direct iMessages: text, and photos and documents sent to your Waldo number. ${TAPBACKS}`);
    for (const page of [off, on]) expect(page).not.toContain('reactions are not supported');
    const row = { bridge_id: 'imb_' + '0'.repeat(32), account_id: 'ima_' + '0'.repeat(32), state: 'active', kind: 'owner', subject: 'owner@example.invalid', chat_guid: 'iMessage;-;owner@example.invalid', host_version: 'h1', online: true, textReady: true } as never;
    expect(renderIMessage([{ ...(row as object), tapbacksReady: true } as never], 'csrf')).toContain('online · text verified · tapbacks verified');
    expect(renderIMessage([{ ...(row as object), tapbacksReady: false } as never], 'csrf')).toContain('online · text verified · tapbacks not verified');
  });

  it('a closed turn stops before and after the fetch', async () => {
    const d = { ...deps(opened([PNG])), admit: vi.fn(() => { throw new Error('closed'); }) };
    await expect(openIMessageMedia(media(photo), d)).rejects.toThrow('closed');
    expect(d.source).not.toHaveBeenCalled();
  });
});
