import { describe, expect, it, vi } from 'vitest';
import { WA_UPDATE_BASE, whatsappIngressUpdates, whatsappTelegramShim, type WaIngressMessage } from '../src/channels/whatsapp-api';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';

const OWNER = '15550001111';
const poll = async (messages: readonly unknown[]) => {
  const { updates } = whatsappIngressUpdates(messages as WaIngressMessage[], OWNER, 0);
  return new TelegramPollingAdapter({ getUpdates: async () => updates }, 0).poll(0);
};

describe('whatsapp documents', () => {
  it('a document becomes the shared document update, with its name, type and caption', async () => {
    const { updates } = whatsappIngressUpdates([
      { id: 'wamid.d1', from: OWNER, type: 'document', document: { id: 'media-d1', filename: 'lab-report.pdf', mime_type: 'application/pdf', caption: 'what do these say?' } },
    ] as unknown as WaIngressMessage[], OWNER, 0);
    expect(updates).toEqual([{
      update_id: WA_UPDATE_BASE + 1,
      message: {
        from: { id: Number(OWNER), is_bot: false }, chat: { id: Number(OWNER), type: 'private' },
        document: { file_id: 'media-d1', file_name: 'lab-report.pdf', mime_type: 'application/pdf' },
        caption: 'what do these say?',
      },
    }]);
    const { accepted, unsupported } = await new TelegramPollingAdapter({ getUpdates: async () => updates }, 0).poll(0);
    expect(unsupported).toEqual([]);
    expect(accepted[0]?.media).toMatchObject({ kind: 'document', fileId: 'media-d1', fileName: 'lab-report.pdf', mimeType: 'application/pdf' });
    expect(accepted[0]?.parts).toEqual([{ authorship: 'owner', text: 'what do these say?' }]);
  });

  it('a document without a name or caption still parses; an over-long name is cut to the shared limit', async () => {
    const { accepted } = await poll([
      { id: 'wamid.d2', from: OWNER, type: 'document', document: { id: 'media-d2' } },
      { id: 'wamid.d3', from: OWNER, type: 'document', document: { id: 'media-d3', filename: `${'a'.repeat(300)}.pdf`, mime_type: 'application/pdf' } },
    ]);
    expect(accepted.map(turn => turn.media?.kind)).toEqual(['document', 'document']);
    expect(accepted[0]?.parts).toEqual([]);
    expect(accepted[1]?.media?.fileName?.length).toBe(256);
  });

  it('a forwarded document is marked forwarded, and its caption is someone else\'s words', async () => {
    const { accepted } = await poll([
      { id: 'wamid.d4', from: OWNER, type: 'document', document: { id: 'media-d4', filename: 'x.pdf', caption: 'a:p12' }, context: { forwarded: true } },
    ]);
    expect(accepted[0]?.media?.forwarded).toBe(true);
    expect(accepted[0]?.parts).toEqual([{ authorship: 'forwarded', text: 'a:p12' }]);
  });

  it('a verification code in a document caption is quarantined before the turn exists', () => {
    const { updates } = whatsappIngressUpdates([
      { id: 'wamid.d5', from: OWNER, type: 'document', document: { id: 'media-d5', caption: 'G-729314' } },
    ] as unknown as WaIngressMessage[], OWNER, 0);
    expect(JSON.stringify(updates)).not.toContain('729314');
  });

  it('a document without a media id never becomes a turn', () => {
    expect(whatsappIngressUpdates([{ id: 'wamid.d6', from: OWNER, type: 'document', document: {} }] as unknown as WaIngressMessage[], OWNER, 0).updates).toEqual([]);
  });
});

describe('whatsapp locations and contacts', () => {
  it('a shared location reaches Waldo as the owner\'s own words, with its name, address and coordinates', async () => {
    const { accepted } = await poll([
      { id: 'wamid.l1', from: OWNER, type: 'location', location: { latitude: 18.5204, longitude: 73.8567, name: 'Arc Maestro', address: 'Ghole Road, Pune' } },
      { id: 'wamid.l2', from: OWNER, type: 'location', location: { latitude: -33.8688, longitude: 151.2093 } },
    ]);
    expect(accepted.map(turn => turn.text)).toEqual([
      'Shared a location: Arc Maestro, Ghole Road, Pune (18.5204, 73.8567)',
      'Shared a location: (-33.8688, 151.2093)',
    ]);
    expect(accepted.every(turn => turn.parts.every(part => part.authorship === 'owner'))).toBe(true);
  });

  it('a location without usable coordinates is not invented', async () => {
    const { accepted, unsupported } = await poll([{ id: 'wamid.l3', from: OWNER, type: 'location', location: { latitude: 'north' } }]);
    expect(accepted).toEqual([]);
    expect(unsupported).toHaveLength(1);
  });

  it('a shared contact card reaches Waldo as text naming the person and their numbers and emails', async () => {
    const { accepted } = await poll([{
      id: 'wamid.c1', from: OWNER, type: 'contacts',
      contacts: [{ name: { formatted_name: 'Asha Rao' }, phones: [{ phone: '+91 98765 43210' }], emails: [{ email: 'asha@example.com' }] }],
    }]);
    expect(accepted[0]?.text).toBe('Shared a contact: Asha Rao, +91 98765 43210, asha@example.com');
  });

  it('a forwarded location or contact is someone else\'s words', async () => {
    const { accepted } = await poll([
      { id: 'wamid.l4', from: OWNER, type: 'location', location: { latitude: 1, longitude: 2 }, context: { forwarded: true } },
    ]);
    expect(accepted[0]?.parts).toEqual([{ authorship: 'forwarded', text: 'Shared a location: (1, 2)' }]);
  });
});

describe('whatsapp types Waldo cannot open', () => {
  it('a video, an animated sticker or an unknown type gets the honest unsupported reply instead of silence', async () => {
    const { accepted, unsupported } = await poll([
      { id: 'wamid.v1', from: OWNER, type: 'video', video: { id: 'media-v1' } },
      { id: 'wamid.s1', from: OWNER, type: 'sticker', sticker: { id: 'media-s1', animated: true } },
      { id: 'wamid.u1', from: OWNER, type: 'unsupported' },
    ]);
    expect(accepted).toEqual([]);
    expect(unsupported.map(turn => turn.chatId)).toEqual([Number(OWNER), Number(OWNER), Number(OWNER)]);
  });

  it('a captioned video reaches the turn as its caption, saying the video was not watched', async () => {
    const { accepted, unsupported } = await poll([
      { id: 'wamid.v3', from: OWNER, type: 'video', video: { id: 'media-v3', caption: '  is this form right?  ' } },
      { id: 'wamid.v4', from: OWNER, type: 'video', video: { id: 'media-v4', caption: '   ' } },
    ]);
    expect(accepted.map(turn => turn.parts)).toEqual([[{ authorship: 'owner', text: "Sent a video Waldo can't watch yet. Its caption: is this form right?" }]]);
    expect(unsupported).toHaveLength(1);
  });

  it('a reaction to one of Waldo\'s messages needs no answer, and a foreign sender is still ignored', () => {
    const { updates } = whatsappIngressUpdates([
      { id: 'wamid.r1', from: OWNER, type: 'reaction', reaction: { message_id: 'wamid.out', emoji: '👍' } },
      { id: 'wamid.v2', from: '15550009999', type: 'video', video: { id: 'media-v2' } },
    ] as unknown as WaIngressMessage[], OWNER, 0);
    expect(updates).toEqual([]);
  });
});

describe('whatsapp read receipts and typing', () => {
  const graph = () => vi.fn(async () => Response.json({ success: true }));

  it('typing marks the owner\'s latest message read and shows the typing indicator', async () => {
    const fetcher = graph();
    const shim = whatsappTelegramShim('tok', 'pn1', OWNER, fetcher as unknown as typeof fetch, { lastInbound: () => 'wamid.in', now: () => 1_000 });
    await shim('sendChatAction', { chat_id: Number(OWNER), action: 'typing' });
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://graph.facebook.com/v26.0/pn1/messages');
    expect(JSON.parse(String(init.body))).toEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.in', typing_indicator: { type: 'text' } });
  });

  it('the listener\'s 4-second typing ticks refresh the indicator at most every 20 seconds per message', async () => {
    const fetcher = graph();
    let clock = 0;
    let latest = 'wamid.a';
    const shim = whatsappTelegramShim('tok', 'pn1', OWNER, fetcher as unknown as typeof fetch, { lastInbound: () => latest, now: () => clock });
    for (clock = 0; clock < 24_000; clock += 4_000) await shim('sendChatAction', { chat_id: Number(OWNER), action: 'typing' });
    expect(fetcher).toHaveBeenCalledTimes(2);
    latest = 'wamid.b';
    await shim('sendChatAction', { chat_id: Number(OWNER), action: 'typing' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('with no inbound message to point at, typing sends nothing', async () => {
    const fetcher = graph();
    const shim = whatsappTelegramShim('tok', 'pn1', OWNER, fetcher as unknown as typeof fetch, { lastInbound: () => null });
    expect(await shim('sendChatAction', { chat_id: Number(OWNER), action: 'typing' })).toBeUndefined();
    const bare = whatsappTelegramShim('tok', 'pn1', OWNER, fetcher as unknown as typeof fetch);
    expect(await bare('sendChatAction', { chat_id: Number(OWNER), action: 'typing' })).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
