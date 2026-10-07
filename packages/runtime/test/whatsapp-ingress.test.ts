import { claimNewWhatsAppMessages, WAMID_RETENTION_MS } from '../src/channels/whatsapp-api';
import { describe, expect, it, vi } from 'vitest';
import { WA_UPDATE_BASE, createWhatsAppMediaDownloader, whatsappIngressUpdates, whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { gatedCaller } from '../src/channels/telegram-api';

describe('whatsapp ingress normalization', () => {
  it('text from the bound subject becomes a telegram-shaped message update in the 9e12 namespace', () => {
    const { updates, seq } = whatsappIngressUpdates([
      { id: 'wamid.1', from: '15550001111', type: 'text', text: { body: 'hello waldo' } },
    ], '15550001111', 0);
    expect(seq).toBe(1);
    expect(updates).toEqual([{ update_id: WA_UPDATE_BASE + 1, message: { from: { id: 15550001111, is_bot:false }, chat: { id: 15550001111, type: 'private' }, text: 'hello waldo' } }]);
  });

  it('an approval reply synthesizes the callback_query the approval desk expects', () => {
    const { updates } = whatsappIngressUpdates([{ id: 'wamid.2', from: '15550001111', type: 'text', text: { body: 'a:p12' } }], '15550001111', 0);
    expect(updates[0]).toMatchObject({ callback_query: { from: { id: 15550001111, is_bot:false }, data: 'a:p12' } });
  });

  it('E1: a verification artifact in inbound text is redacted before the turn exists', () => {
    const { updates } = whatsappIngressUpdates([
      { id: 'wamid.otp', from: '15550001111', type: 'text', text: { body: 'Fwd: Your WhatsApp code: 123-456. Do not share it.' } },
      { id: 'wamid.link', from: '15550001111', type: 'text', text: { body: 'sign me in https://togdshayyxycitzckpqv.supabase.co/auth/v1/verify?token=pkce_LIVE&type=magiclink please' } },
      { id: 'wamid.chat', from: '15550001111', type: 'text', text: { body: 'dinner at 8?' } },
    ], '15550001111', 0);
    const json = JSON.stringify(updates);
    expect(json).not.toContain('123-456');
    expect(json).not.toContain('pkce_LIVE');
    const otpText = (updates[0] as { message: { text: string } }).message.text;
    expect(otpText).toContain('[quarantined: otp artifact');
    expect(otpText).toContain('Do not share it.');
    const linkText = (updates[1] as { message: { text: string } }).message.text;
    expect(linkText).toContain('sign me in');
    expect(linkText).toContain('[quarantined:');
    expect((updates[2] as { message: { text: string } }).message.text).toBe('dinner at 8?');
  });

  it('E1: a message that IS the artifact arrives as a pure quarantine marker; approval replies are never filtered', () => {
    const { updates } = whatsappIngressUpdates([
      { id: 'wamid.pure', from: '15550001111', type: 'text', text: { body: 'G-729314' } },
      { id: 'wamid.approve', from: '15550001111', type: 'text', text: { body: 'a:p12' } },
    ], '15550001111', 0);
    expect(JSON.stringify(updates)).not.toContain('729314');
    expect((updates[0] as { message: { text: string } }).message.text).toBe('[quarantined: otp artifact - see your WhatsApp thread]');
    expect(updates[1]).toMatchObject({ callback_query: { data: 'a:p12' } });
  });

  it('foreign senders, non-text and empty messages never become turns', () => {
    const { updates, seq } = whatsappIngressUpdates([
      { id: 'wamid.3', from: '15550009999', type: 'text', text: { body: 'intruder' } },
      { id: 'wamid.4', from: '15550001111', type: 'audio' },
      { id: 'wamid.5', from: '15550001111', type: 'text', text: { body: '   ' } },
    ], '15550001111', 7);
    expect(updates).toEqual([]);
    expect(seq).toBe(7);
  });
});

describe('whatsapp telegram shim', () => {
  it('sendMessage maps to a Cloud API text send; approval buttons flatten to reply instructions', async () => {
    const graph = vi.fn(async () => Response.json({ messages: [{ id: 'wamid.out' }] }));
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    await shim('sendMessage', {
      chat_id: 15550001111, text: 'Send this email?',
      reply_markup: { inline_keyboard: [[{ text: 'Send it', callback_data: 'a:p1' }, { text: 'Not now', callback_data: 's:p1' }]] },
    });
    const [url, init] = graph.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v21.0/pn1/messages');
    const body = JSON.parse(String(init.body));
    expect(body.to).toBe('15550001111');
    expect(body.text.body).toBe('Send this email?\n\n- Send it: reply "a:p1"\n- Not now: reply "s:p1"');
    expect(JSON.stringify(body)).not.toContain('tok');
  });

  it('non-send methods return no successful receipt, and the unlinked gate drops sends before any fetch', async () => {
    const graph = vi.fn(async () => Response.json({}));
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    expect(await shim('answerCallbackQuery', { callback_query_id: 'q' })).toBeUndefined();
    expect(graph).not.toHaveBeenCalled();
    let linked = false;
    const gated = gatedCaller(shim, () => !linked);
    await gated('sendMessage', { chat_id: 1, text: 'dropped' });
    expect(graph).not.toHaveBeenCalled();
    linked = true;
    await gated('sendMessage', { chat_id: 1, text: 'through' });
    expect(graph).toHaveBeenCalledTimes(1);
  });
});

describe('whatsapp photos (A6)', () => {
  it('an image becomes the telegram-shaped photo update the shared media path reads; caption rides as the turn text', () => {
    const { updates, seq } = whatsappIngressUpdates([
      { id: 'wamid.p1', from: '15550001111', type: 'image', image: { id: 'media-p1', mime_type: 'image/jpeg', caption: 'log lunch: dal, rice' } },
    ], '15550001111', 0);
    expect(seq).toBe(1);
    expect(updates[0]).toEqual({
      update_id: WA_UPDATE_BASE + 1,
      message: {
        from: { id: 15550001111, is_bot:false },
        chat: { id: 15550001111, type: 'private' },
        photo: [{ file_id: 'media-p1' }],
        caption: 'log lunch: dal, rice',
      },
    });
  });

  it('an image without caption carries no text; images without a media id or from a foreign sender are skipped', () => {
    const { updates, seq } = whatsappIngressUpdates([
      { id: 'wamid.p2', from: '15550001111', type: 'image', image: { id: 'media-p2', mime_type: 'image/jpeg' } },
      { id: 'wamid.p3', from: '15550001111', type: 'image' },
      { id: 'wamid.p4', from: '15550009999', type: 'image', image: { id: 'media-p4' } },
    ], '15550001111', 4);
    expect(seq).toBe(5);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toEqual({
      update_id: WA_UPDATE_BASE + 5,
      message: {
        from: { id: 15550001111, is_bot:false },
        chat: { id: 15550001111, type: 'private' },
        photo: [{ file_id: 'media-p2' }],
      },
    });
  });

  it('a caption carrying a verification artifact is quarantined like any owner text', () => {
    const { updates } = whatsappIngressUpdates([
      { id: 'wamid.p5', from: '15550001111', type: 'image', image: { id: 'media-p5', caption: 'G-729314' } },
    ], '15550001111', 0);
    expect(JSON.stringify(updates)).not.toContain('729314');
    expect((updates[0] as { message: { caption: string } }).message.caption).toBe('[quarantined: otp artifact - see your WhatsApp thread]');
  });
});

describe('whatsapp voice notes (W4)', () => {
  it('a voice note becomes the telegram-shaped voice update the shared transcriber path reads', () => {
    const { updates, seq } = whatsappIngressUpdates([
      { id: 'wamid.v1', from: '15550001111', type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', voice: true } },
    ], '15550001111', 0);
    expect(seq).toBe(1);
    expect(updates[0]).toEqual({
      update_id: WA_UPDATE_BASE + 1,
      message: {
        from: { id: 15550001111, is_bot:false },
        chat: { id: 15550001111, type: 'private' },
        voice: { file_id: 'media-1', mime_type: 'audio/ogg; codecs=opus' },
      },
    });
  });

  it('an audio file (voice=false) becomes the audio media update; audio without a media id is skipped', () => {
    const { updates, seq } = whatsappIngressUpdates([
      { id: 'wamid.a1', from: '15550001111', type: 'audio', audio: { id: 'media-2', mime_type: 'audio/mpeg', voice: false } },
      { id: 'wamid.a2', from: '15550001111', type: 'audio' },
      { id: 'wamid.a3', from: '15550009999', type: 'audio', audio: { id: 'media-3', voice: true } },
    ], '15550001111', 4);
    expect(seq).toBe(5);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ message: { audio: { file_id: 'media-2', mime_type: 'audio/mpeg' } } });
  });

  it('the downloader does the Graph two-step with the bearer on both calls, never in a URL', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const graph = vi.fn(async (input: unknown) => {
      const url = String(input);
      return url.includes('/media-9')
        ? Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc' })
        : new Response(bytes);
    });
    const download = createWhatsAppMediaDownloader('wabearer-t0ken', graph as unknown as typeof fetch);
    expect([...await download('media-9')]).toEqual([1, 2, 3]);
    expect(graph).toHaveBeenCalledTimes(2);
    const [lookupUrl, lookupInit] = graph.mock.calls[0] as unknown as [string, RequestInit];
    const [fileUrl, fileInit] = graph.mock.calls[1] as unknown as [string, RequestInit];
    expect(lookupUrl).toBe('https://graph.facebook.com/v21.0/media-9');
    expect(fileUrl).toBe('https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=abc');
    for (const init of [lookupInit, fileInit]) expect((init.headers as Record<string, string>).authorization).toBe('Bearer wabearer-t0ken');
    expect(lookupUrl + fileUrl).not.toContain('wabearer-t0ken');
  });

  it('the downloader refuses a download URL off the Meta media hosts before sending the bearer', async () => {
    const graph = vi.fn(async () => Response.json({ url: 'https://evil.example/bytes' }));
    const download = createWhatsAppMediaDownloader('wabearer-t0ken', graph as unknown as typeof fetch);
    await expect(download('media-9')).rejects.toThrow('no usable url');
    expect(graph).toHaveBeenCalledTimes(1);
  });

  describe('replayed wamids', () => {
    const fakeKv = () => { const map = new Map<string, unknown>(); return { map, kv: { get: <T>(k: string) => map.get(k) as T | undefined, put: (k: string, v: unknown) => { map.set(k, v); }, delete: (k: string) => map.delete(k), list: <T>({ prefix }: { prefix: string }) => [...map].filter(([k]) => k.startsWith(prefix)) as [string, T][] } }; };
    it('a redelivered wamid is dropped, a new one passes, and an id-less message cannot be deduped', () => {
      const { kv } = fakeKv();
      expect(claimNewWhatsAppMessages(kv, [{ id: 'wamid.A' }, { id: 'wamid.B' }, {}], 1000)).toHaveLength(3);
      expect(claimNewWhatsAppMessages(kv, [{ id: 'wamid.A' }, { id: 'wamid.C' }], 2000)).toEqual([{ id: 'wamid.C' }]);
    });
    it('the same wamid twice in one payload runs once', () => {
      const { kv } = fakeKv();
      expect(claimNewWhatsAppMessages(kv, [{ id: 'wamid.A' }, { id: 'wamid.A' }], 1000)).toEqual([{ id: 'wamid.A' }]);
    });
    it('records expire after Meta\'s 7 day retry window and are swept', () => {
      const { kv, map } = fakeKv();
      claimNewWhatsAppMessages(kv, [{ id: 'wamid.A' }], 1000);
      expect(claimNewWhatsAppMessages(kv, [{ id: 'wamid.A' }], 1000 + WAMID_RETENTION_MS - 1)).toEqual([]);
      expect(claimNewWhatsAppMessages(kv, [{ id: 'wamid.A' }], 1000 + WAMID_RETENTION_MS)).toEqual([{ id: 'wamid.A' }]);
      expect(map.size).toBe(1);
    });
  });
});

it('ordinary normalized WhatsApp text is accepted by the actual shared polling schema',async()=>{
 const {TelegramPollingAdapter}=await import('../src/channels/telegram-polling');
 const {updates}=whatsappIngressUpdates([{from:'15550001111',id:'wamid.normalized',type:'text',text:{body:'Read supplied material.'}}],'15550001111',0);
 const polled=await new TelegramPollingAdapter({getUpdates:async()=>updates}).poll(0);
 expect(polled.accepted).toHaveLength(1);expect(polled.dropped).toBe(0);expect(polled.accepted[0]?.text).toBe('Read supplied material.');
});
