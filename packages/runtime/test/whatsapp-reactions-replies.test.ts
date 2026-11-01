import { describe, expect, it, vi } from 'vitest';
import { whatsappIngressUpdates, whatsappTelegramShim, whatsappTurnMessage, type WaIngressMessage } from '../src/channels/whatsapp-api';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';
import { clearWhatsAppContext, forgetWhatsAppContext, noteWhatsAppReaction, recordWhatsAppSent, takeWhatsAppReactionNotes, whatsappSentText, WHATSAPP_CONTEXT_RETENTION_MS } from '../src/channels/whatsapp-context';
import { clearWhatsAppNumber } from '../src/channels/whatsapp-window';
import { OUTBOX_CUSTODY, SEND_NOW_ONLY } from '../src/channels/delivery-routes';

const OWNER = '15550001111';
const kvStore = () => {
  const map = new Map<string, unknown>();
  return {
    map,
    get: <T>(key: string) => map.get(key) as T | undefined,
    put: (key: string, value: unknown) => { map.set(key, structuredClone(value)); },
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { prefix: string }) => [...map.entries()].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
};
const poll = async (messages: readonly unknown[], sent: (id: string) => string | null) => {
  const { updates, sources } = whatsappIngressUpdates(messages as WaIngressMessage[], OWNER, 0, sent);
  return { sources, ...(await new TelegramPollingAdapter({ getUpdates: async () => updates }, 0).poll(0)) };
};

describe('whatsapp swipe-replies', () => {
  const sent = (id: string) => id === 'wamid.waldo' ? 'Your train is at 07:40.' : null;

  it('a reply to a message Waldo sent carries its words, authored by Waldo; each update names its wamid', async () => {
    const { accepted, unsupported, sources } = await poll([
      { id: 'wamid.a', from: OWNER, type: 'text', text: { body: 'move it later' }, context: { from: '15550009999', id: 'wamid.waldo' } },
      { id: 'wamid.b', from: OWNER, type: 'text', text: { body: 'and this?' }, context: { from: OWNER, id: 'wamid.mine' } },
    ], sent);
    expect(unsupported).toEqual([]);
    expect(accepted[0]?.replyTo).toMatchObject({ text: 'Your train is at 07:40.', authorIsBot: true, provenance: { author: 'waldo', forwarded: false } });
    expect(accepted[1]?.replyTo).toBeUndefined();
    expect(sources).toEqual(['wamid.a', 'wamid.b']);
  });

  it('a forward never carries a quote, even one naming a message Waldo sent', async () => {
    const { accepted } = await poll([
      { id: 'wamid.f', from: OWNER, type: 'text', text: { body: 'look' }, context: { forwarded: true, id: 'wamid.waldo' } },
    ], sent);
    expect(accepted[0]?.replyTo).toBeUndefined();
    expect(accepted[0]?.parts.every(part => part.authorship === 'forwarded')).toBe(true);
  });

  it('a reaction, a system notice and a welcome request are not turn messages', () => {
    expect(['reaction', 'system', 'request_welcome'].map(type => whatsappTurnMessage({ type }))).toEqual([false, false, false]);
    expect(['text', 'sticker', 'video'].map(type => whatsappTurnMessage({ type }))).toEqual([true, true, true]);
  });
});

describe('whatsapp context store', () => {
  it('keeps what Waldo sent with health-like numbers masked, and only for 30 days', () => {
    const kv = kvStore();
    recordWhatsAppSent(kv, 'wamid.1', 'Your resting heart rate was 52 bpm today.', 1_000);
    expect(whatsappSentText(kv, 'wamid.1', 1_000)).not.toContain('52');
    expect(whatsappSentText(kv, 'wamid.1', 1_000 + WHATSAPP_CONTEXT_RETENTION_MS)).toBeNull();
    expect(whatsappSentText(kv, 'wamid.other', 1_000)).toBeNull();
  });

  it('masks a secret-bearing link before keeping what Waldo sent', () => {
    const kv = kvStore();
    recordWhatsAppSent(kv, 'wamid.1', 'Reconnect here: https://accounts.google.com/o/oauth2/v2/auth?client_id=x&state=abc', 1);
    expect(whatsappSentText(kv, 'wamid.1', 2)).toBe('Reconnect here: [link removed]');
  });

  it('keeps one waiting line per message, replaced by a later reaction and removed when taken back; taking empties it', () => {
    const kv = kvStore();
    recordWhatsAppSent(kv, 'wamid.1', 'Booked for 7.', 1);
    noteWhatsAppReaction(kv, 'wamid.1', '❤️', 2);
    noteWhatsAppReaction(kv, 'wamid.1', '👍', 3);
    noteWhatsAppReaction(kv, 'wamid.unknown', '😂', 3);
    expect(takeWhatsAppReactionNotes(kv, 4)).toEqual(['[Owner reacted 👍 to your message: "Booked for 7."]']);
    expect(takeWhatsAppReactionNotes(kv, 5)).toEqual([]);
    noteWhatsAppReaction(kv, 'wamid.1', '🎉', 6);
    noteWhatsAppReaction(kv, 'wamid.1', undefined, 7);
    expect(takeWhatsAppReactionNotes(kv, 8)).toEqual([]);
  });

  it('owner forget removes kept messages and waiting lines carrying the literal', () => {
    const kv = kvStore();
    recordWhatsAppSent(kv, 'wamid.1', 'Dinner with Priya at 8.', 1);
    recordWhatsAppSent(kv, 'wamid.2', 'Booked the train.', 1);
    noteWhatsAppReaction(kv, 'wamid.1', '❤️', 2);
    expect(forgetWhatsAppContext(kv, ['Priya'])).toEqual({ rewritten: 2, remaining: 0 });
    expect(whatsappSentText(kv, 'wamid.1', 3)).toBeNull();
    expect(whatsappSentText(kv, 'wamid.2', 3)).toBe('Booked the train.');
    expect(takeWhatsAppReactionNotes(kv, 3)).toEqual([]);
  });

  it('a number change clears what the old number could name', () => {
    const kv = kvStore();
    kv.put('whatsapp_subject', OWNER);
    recordWhatsAppSent(kv, 'wamid.1', 'Booked.', 1);
    noteWhatsAppReaction(kv, 'wamid.1', '❤️', 2);
    clearWhatsAppNumber(kv);
    expect([...kv.map.keys()].filter(key => key.startsWith('wa_sent:') || key.startsWith('wa_reaction_note:'))).toEqual([]);
    clearWhatsAppContext(kv);
  });
});

describe('whatsapp shim: quotes, sent words and reactions', () => {
  const graph = () => {
    const bodies: Record<string, unknown>[] = [];
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return Response.json({ messages: [{ id: `wamid.out.${bodies.length}` }] });
    }) as unknown as typeof fetch;
    return { bodies, fetcher };
  };

  it('a long quoted reply quotes on its first part only, every part of a turn reply is heard with its wamid, and a system send is not', async () => {
    const { bodies, fetcher } = graph();
    const heard: [string, string][] = [];
    const shim = whatsappTelegramShim('token', 'phone', OWNER, fetcher, { onSent: (id, text) => heard.push([id, text]) });
    await shim('sendMessage', { chat_id: Number(OWNER), text: 'a'.repeat(5_000), quote_message_id: 'wamid.ask', turn_reply: true });
    expect(bodies.map(body => body.context)).toEqual([{ message_id: 'wamid.ask' }, undefined]);
    expect(heard.map(([id, text]) => [id, text.length])).toEqual([['wamid.out.1', 4096], ['wamid.out.2', 904]]);
    await shim('sendMessage', { chat_id: Number(OWNER), text: 'Console (link works once): https://waldo.example/console?t=secret' });
    expect(heard).toHaveLength(2);
  });

  it('a delivery-outbox send (a Brief, a reminder) is heard like a turn reply; a send-now-only system send is not', async () => {
    const { fetcher } = graph();
    const heard: string[] = [];
    const shim = whatsappTelegramShim('token', 'phone', OWNER, fetcher, { onSent: (_id, text) => heard.push(text) });
    await shim('sendMessage', { chat_id: Number(OWNER), text: 'Morning. Three meetings today.', [OUTBOX_CUSTODY]: true });
    await shim('sendMessage', { chat_id: Number(OWNER), text: 'Your code is 123456', [SEND_NOW_ONLY]: true });
    expect(heard).toEqual(['Morning. Three meetings today.']);
  });

  it('a reaction goes out as the Cloud API reaction message', async () => {
    const { bodies, fetcher } = graph();
    await whatsappTelegramShim('token', 'phone', OWNER, fetcher)('sendReaction', { message_id: 'wamid.ask', emoji: '❤️' });
    expect(bodies).toEqual([{ messaging_product: 'whatsapp', to: `+${OWNER}`, type: 'reaction', reaction: { message_id: 'wamid.ask', emoji: '❤️' } }]);
  });
});
