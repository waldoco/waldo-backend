import { describe, expect, it, vi } from 'vitest';
import { whatsappTelegramShim } from '../src/channels/whatsapp-api';
import { egressGuardedCaller } from '../src/channels/egress-guard';

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
