// A WhatsApp turn reads the owner's skill book as an app turn does: on Meta's signed webhook shape, through the owner object,
// the model sees the index, loads a skill the owner never named, and its reply still goes out as a WhatsApp text.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { handleWhatsAppWebhook } from '../src/channels/whatsapp-webhook';
import { CURATED_SKILLS } from '../src/skills/curated-owner';
import type { OwnerDirectory } from '../src/identity/owner-directory';
import type { LLMGatewayRequest } from '../src/llm/provider';

const SKILL = CURATED_SKILLS.find(skill => skill.name === 'day-brief')!;
const REPLY = 'Three meetings today; the board prep at 11 matters most.';
const model = vi.hoisted(() => ({ systems: [] as string[], tools: [] as string[][], step: 0 }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    model.systems.push(request.system ?? '');
    model.tools.push((request.tools ?? []).map(tool => tool.name));
    return model.step++ === 0 ? done('', [{ call_id: 'load', name: 'skills_load', arguments: JSON.stringify({ name: SKILL.name, version: SKILL.version }) }]) : done(REPLY);
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const SUBJECT = '15550003333';
const APP_SECRET = 'fictional-app-secret';
const sign = async (body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(APP_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return `sha256=${[...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map(b => b.toString(16).padStart(2, '0')).join('')}`;
};
const deliver = async (instance: InstanceType<typeof OwnerDO>, name: string, text: string) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: 'fictional-waba', changes: [{ field: 'messages', value: {
    messaging_product: 'whatsapp', metadata: { display_phone_number: '15550000000', phone_number_id: 'fictional-phone-id' },
    contacts: [{ profile: { name: 'Fictional Owner' }, wa_id: SUBJECT }], messages: [{ from: SUBJECT, id: 'wamid.skill', timestamp: String(Math.floor(Date.now() / 1000)), text: { body: text }, type: 'text' }],
  } }] }] });
  const owners = { idFromName: (id: string) => id, get: () => ({ fetch: (url: string, init?: RequestInit) => instance.fetch(new Request(url, init)) }) } as unknown as DurableObjectNamespace;
  const directory: OwnerDirectory = { byPresence: async () => ({ doName: name, subject: SUBJECT, timezone: null }), redeem: async () => null };
  const request = new Request('https://w.test/whatsapp/webhook', { method: 'POST', body, headers: { 'x-hub-signature-256': await sign(body) } });
  expect((await handleWhatsAppWebhook(request, { OWNER_DO: owners, WHATSAPP_APP_SECRET: APP_SECRET }, () => undefined, directory)).status).toBe(200);
  await Promise.all([...(instance as unknown as { whatsappInflight: Set<Promise<void>> }).whatsappInflight]);
};

it('a WhatsApp turn loads a reviewed skill unprompted, keeps its tools and approval rule, and replies as a WhatsApp text', async () => {
  const name = 'wa-skills';
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sent: string[] = [];
    const net = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => { sent.push(String(init?.body)); return Response.json({ messages: [{ id: 'wamid.out' }] }); });
    const instance = new OwnerDO(state, { ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id' });
    try {
      await deliver(instance, name, 'What does today look like?');
      expect(model.systems).toHaveLength(2);
      expect(model.systems[0]).toContain(`- ${SKILL.name}@${SKILL.version}: ${SKILL.trigger_condition}`);
      expect(model.systems[0]).not.toContain(SKILL.body_markdown);
      expect(model.systems[1]).toContain(SKILL.body_markdown);
      expect(model.systems[0]).toContain('Approval delivery: text_callback');
      expect(model.tools[0]).toContain('skills_load');
      expect(model.tools[1]).toEqual(model.tools[0]);
      const traced = state.storage.sql.exec<{ hop: string; ok: number }>("SELECT hop, ok FROM trace_log WHERE hop LIKE 'tool_%' AND hop != 'tool_eligibility' ORDER BY rowid").toArray();
      expect(traced.map(row => [row.hop, row.ok])).toEqual([['tool_skills_load', 1]]);
      const replies = sent.filter(body => body.includes('"messaging_product"') && body.includes(REPLY));
      expect(replies).toHaveLength(1);
      expect(JSON.parse(replies[0]!)).toMatchObject({ to: `+${SUBJECT}`, type: 'text' });
    } finally { net.mockRestore(); await state.storage.deleteAlarm(); }
  });
}, 60_000);
