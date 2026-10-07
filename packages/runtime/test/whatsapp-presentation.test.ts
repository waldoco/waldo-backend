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
