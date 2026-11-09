// The 24-hour window through the real owner runtime: a proactive send outside it knocks with the approved
// template and holds the text; the owner's reply delivers what was held before that reply's own turn runs.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { whatsappHeld } from '../src/channels/whatsapp-window';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

it('outside the window a proactive text becomes one template knock; the reply delivers it before its turn', async () => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName('whatsapp-window-knock')), async (_instance, state) => {
    const events: string[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      events.push(body.type === 'template' ? `template:${body.template.name}:${body.template.language.code}` : `text:${body.text?.body}`);
      return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      WHATSAPP_REENGAGE_TEMPLATE: 'waldo_update_ready', WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE: 'en',
    });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn').mockImplementation(async () => { events.push('turn'); });
    const admit = async (id: string, sentAt: number) => {
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
        body: JSON.stringify({ messages: [{ from: '15550001111', id, timestamp: String(Math.floor(sentAt / 1000)), type: 'text', text: { body: 'hi' } }] }),
      }));
      await drainWhatsAppTurns(instance);
      return response;
    };
    try {
      expect((await admit('wamid.old', Date.now() - 30 * 60 * 60 * 1000)).status).toBe(200);
      const runtime = (instance as unknown as { setup(channel: string): { api: { sendMessage(request: object): Promise<unknown> }; owner: number } }).setup('whatsapp');
      expect(whatsappHeld(await runtime.api.sendMessage({ chat_id: runtime.owner, text: 'Your reminder: call the bank' }))).toBe(true);
      expect(events).toEqual(['turn', 'template:waldo_update_ready:en']);
      expect((await admit('wamid.reply', Date.now())).status).toBe(200);
      expect(events).toEqual(['turn', 'template:waldo_update_ready:en', 'text:Your reminder: call the bank', 'turn']);
      expect([...state.storage.kv.list({ prefix: 'wa_held:' })]).toEqual([]);
    } finally { await state.storage.deleteAlarm(); turn.mockRestore(); graph.mockRestore(); }
  });
});
