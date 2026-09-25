import { describe, expect, it, vi } from 'vitest';
import { WA_UPDATE_BASE, whatsappIngressUpdates, whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { gatedCaller } from '../src/channels/telegram-api';

describe('whatsapp ingress normalization', () => {
  it('text from the bound subject becomes a telegram-shaped message update in the 9e12 namespace', () => {
    const { updates, seq } = whatsappIngressUpdates([
      { id: 'wamid.1', from: '15550001111', type: 'text', text: { body: 'hello waldo' } },
    ], '15550001111', 0);
    expect(seq).toBe(1);
    expect(updates).toEqual([{ update_id: WA_UPDATE_BASE + 1, message: { from: { id: 15550001111 }, chat: { id: 15550001111, type: 'private' }, text: 'hello waldo' } }]);
  });

  it('an approval reply synthesizes the callback_query the approval desk expects', () => {
    const { updates } = whatsappIngressUpdates([{ id: 'wamid.2', from: '15550001111', type: 'text', text: { body: 'a:p12' } }], '15550001111', 0);
    expect(updates[0]).toMatchObject({ callback_query: { from: { id: 15550001111 }, data: 'a:p12' } });
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

  it('non-send methods are logged no-ops, and the unlinked gate drops sends before any fetch', async () => {
    const graph = vi.fn(async () => Response.json({}));
    const shim = whatsappTelegramShim('tok', 'pn1', '15550001111', graph as unknown as typeof fetch);
    expect(await shim('answerCallbackQuery', { callback_query_id: 'q' })).toEqual({});
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
