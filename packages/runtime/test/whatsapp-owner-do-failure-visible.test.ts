// A WhatsApp message that fails after it is claimed must not vanish: a turn that started and failed gets a fixed notice, and
// a payload that could not be admitted keeps nothing, so Meta's redelivery runs it.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { WHATSAPP_PARTIAL_NOTICE } from '../src/channels/whatsapp-api';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

vi.mock('openai', () => ({ default: class {
  responses = { create: async () => ({ id: 'fixture', output_text: '{}', output: [], usage: { input_tokens: 1, output_tokens: 1 } }) };
} }));

const harness = async (name: string, work: (instance: OwnerDO, state: DurableObjectState, turn: ReturnType<typeof vi.fn>, sent: string[]) => Promise<void>,mockTurn=true) => {
  await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const sent: string[] = [];
    const graph = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      sent.push(String(init?.body)); return Response.json({ messages: [{ id: 'wamid.out' }] });
    });
    const instance = new OwnerDO(state, {
      ...env, TELEGRAM_BOT_TOKEN: 'fictional-telegram-token', OPENAI_API_KEY: 'fictional-model-key',
      WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
    });
    const turn = vi.spyOn(instance as unknown as { turn(): Promise<void> }, 'turn');
    if(mockTurn)turn.mockImplementation(async()=>undefined);
    try { await work(instance, state, turn as never, sent); } finally { await state.storage.deleteAlarm(); turn.mockRestore(); graph.mockRestore(); }
  });
};
// Admission acks before the turns run; the drain runs them, as the alarm after the ack would.
const postMany = async (instance: OwnerDO, ids: string[]) => {
  const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
    method: 'POST', headers: { 'x-waldo-whatsapp-subject': '15550001111' },
    body: JSON.stringify({ messages: ids.map(id => ({ from: '15550001111', id, type: 'text', text: { body: 'PRIVATE_WA_TEXT' } })) }),
  }));
  await drainWhatsAppTurns(instance);
  return response;
};
const post = (instance: OwnerDO, id: string) => postMany(instance, [id]);

it('a storage fault while admitting a payload keeps none of it and tells nobody: Meta gets no 200, and its redelivery runs every message', async () => {
  await harness('whatsapp-admission-fault', async (instance, state, turn, sent) => {
    const kv = state.storage.kv as unknown as { put(key: string, value: unknown): void };
    const original = kv.put.bind(state.storage.kv);
    let faulted = false;
    // The sequence is written last in the admitting step, after both rows: the fault rolls the claims and rows back with it.
    const put = vi.spyOn(kv, 'put').mockImplementation((key, value) => {
      if (key === 'wa_seq' && !faulted) { faulted = true; throw new Error('storage fault'); }
      return original(key, value);
    });
    await expect(postMany(instance, ['wamid.fault.A', 'wamid.fault.B'])).rejects.toThrow('storage fault');
    put.mockRestore();
    expect(turn).not.toHaveBeenCalled();
    expect([state.storage.kv.get('wamid:wamid.fault.A'), state.storage.kv.get('wamid:wamid.fault.B'), state.storage.kv.get('wa_seq')]).toEqual([undefined, undefined, undefined]);
    expect(sent).toEqual([]);
    expect((await postMany(instance, ['wamid.fault.A', 'wamid.fault.B'])).status).toBe(200);
    expect(turn).toHaveBeenCalledTimes(2);
  });
});

it('a turn that throws tells the owner once and the same wamid is still not replayed', async () => {
  await harness('whatsapp-turn-throw-notice', async (instance, state, turn, sent) => {
    turn.mockImplementationOnce(async () => { throw new Error('turn failed'); });
    await post(instance, 'wamid.throw.N').catch(() => undefined);
    expect(sent.filter(body => body.includes(WHATSAPP_PARTIAL_NOTICE))).toHaveLength(1);
    expect(state.storage.kv.get('wamid:wamid.throw.N')).toBeDefined();
    await post(instance, 'wamid.throw.N');
    expect(turn).toHaveBeenCalledTimes(1);
  });
});

it('actual WhatsApp DO turn and listener propagate uncertain final issue to one check-first notice without replay',async()=>{
 await harness('whatsapp-actual-final-uncertainty',async(instance,state,turn,sent)=>{
  await state.storage.deleteAll();
  const {TelegramOwnerListener}=await import('../src/channels/telegram-listener');
  const {whatsappTelegramShim}=await import('../src/channels/whatsapp-api');let effects=0;
  const call=whatsappTelegramShim('fictional-token','fictional-phone-id','15550001111',async(_url,init)=>{
   const text=JSON.parse(String(init?.body)).text.body;sent.push(text);
   if(text==='Saved result.')throw Error('post-issue unknown');
   return Response.json({messages:[{id:'wamid.notice'}]});
  });
  const api={sendMessage:(payload:any)=>call('sendMessage',payload),setMessageReaction:async()=>undefined,sendChatAction:async()=>undefined};
  const listener=new TelegramOwnerListener({surface:'whatsapp',ownerTelegramId:15550001111,api,respond:async()=>{effects++;return 'Saved result.';},saveOffset:offset=>state.storage.put('wa_offset',offset)});
  const setup=vi.spyOn(instance as any,'setup').mockReturnValue({listener,api,owner:15550001111,call,ready:Promise.resolve(),log:()=>{},control:{absorbed:()=>false}});
  try{
   await post(instance,'wamid.actual-uncertain').catch(()=>undefined);
   expect(sent).toEqual(['Saved result.',WHATSAPP_PARTIAL_NOTICE]);expect(effects).toBe(1);
   expect(state.storage.kv.get('wamid:wamid.actual-uncertain')).toBeDefined();
   await post(instance,'wamid.actual-uncertain');expect(effects).toBe(1);expect(sent).toHaveLength(2);
  }finally{setup.mockRestore();}
 },false);
});

it('words the notice as Waldo: a turn that started may have had effects, so it says to check first', () => {
  expect(WHATSAPP_PARTIAL_NOTICE).toBe('I may have only partly handled your last message. Check what went through before you send it again.');
});
