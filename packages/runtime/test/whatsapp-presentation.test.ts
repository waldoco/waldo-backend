import { expect, it, vi } from 'vitest';
import { whatsappTelegramShim } from '../src/channels/whatsapp-api';

it('keeps exact URL buttons in WhatsApp text fallback rather than recording a linkless send', async () => {
  const graph = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({messages:[{id:'wamid.fixture'}]}));
  const shim = whatsappTelegramShim('fictional-token','fixture-phone','15550001111',graph as typeof fetch);
  const url = 'https://connect.fixture.invalid/c/fixture?state=exact%2Bbytes';
  await shim('sendMessage',{text:'Connect account',reply_markup:{inline_keyboard:[[{text:'Connect',url}]]}});
  expect(JSON.parse(String(graph.mock.calls[0]![1]?.body)).text.body).toContain(url);
});

it('reports unsupported Telegram-only operations without no-op success', async () => {
  const graph = vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => Response.json({}));
  const shim = whatsappTelegramShim('fictional-token','fixture-phone','15550001111',graph as typeof fetch);
  expect(await shim('answerCallbackQuery',{callback_query_id:'fixture'})).toBeUndefined();
  expect(await shim('setMessageReaction',{message_id:1})).toBeUndefined();
  expect(graph).not.toHaveBeenCalled();
});

it('bounds an uncertain WhatsApp send, with no retry or fallback after network issue', async () => {
  vi.useFakeTimers();
  try {
    const graph = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve,reject) => init?.signal?.addEventListener('abort',()=>reject(new Error('fixture transport aborted')))));
    const {createWhatsAppCaller}=await import('../src/channels/whatsapp-api');
    const send=createWhatsAppCaller('fictional-token','fixture-phone',graph as typeof fetch);
    const pending=send({to:'15550001111',type:'text',text:{body:'one frozen message'}});
    const rejected=expect(pending).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(15001);
    await rejected;
    expect(graph).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {vi.useRealTimers();}
},2000);
it('bounds stalled WhatsApp response JSON even when the body ignores abort, without a second POST',async()=>{
 vi.useFakeTimers();
 try{
  const graph=vi.fn(async()=>({ok:true,json:()=>new Promise(()=>{})}) as unknown as Response);
  const {createWhatsAppCaller}=await import('../src/channels/whatsapp-api');
  const pending=createWhatsAppCaller('fictional-token','fixture-phone',graph as typeof fetch)({to:'15550001111',type:'text',text:{body:'frozen'}});
  const rejected=expect(pending).rejects.toThrow(/timed out/);
  await vi.advanceTimersByTimeAsync(15001);await rejected;
  expect(graph).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0);
 }finally{vi.useRealTimers();}
},2000);
