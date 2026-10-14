import { ownerTyped } from './helpers/owner-typed';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const model = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete(request: import('../src/llm/provider').LLMGatewayRequest) {
    model.requests.push(JSON.stringify(request));
    return { ok: true as const, data: { model: request.request.model, text: 'Noted.', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { telegramTurnEnvelope } = await import('../src/channels/telegram-turn');
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '5d1f8b3a-6c2e-4a90-9b17-30c4e5f6a7b8';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'b'.repeat(64), 'content-type': 'application/json' });

beforeEach(() => {
  model.requests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(String(input instanceof Request ? input.url : input))?.[1];
    const asked = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'assert_channel_presence') return Response.json(true);
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('the approval delivery each surface tells the model', () => {
  const delivery = (surface?: string) => telegramTurnEnvelope(ownerTyped({ updateId: 1, chatId: 7, text: 'hi' }) as never, surface).presentation?.delivery;

  it('gives the app native approval buttons, the same as Telegram', () => {
    expect(delivery('app')).toEqual({ text: true, approval: 'native_buttons', reactions: false, attachments: false });
  });

  it('leaves Telegram, WhatsApp and any other surface as they were', () => {
    expect(delivery()).toEqual({ text: true, approval: 'native_buttons', reactions: true, attachments: false });
    expect(delivery('whatsapp')).toEqual({ text: true, approval: 'text_callback', reactions: false, attachments: false });
    expect(delivery('imessage')).toEqual({ text: true, approval: 'none', reactions: false, attachments: false });
  });

  it('a real app turn tells the model its approvals arrive as buttons, never that it has no approval delivery', async () => {
    const name = 'app-approval-presentation';
    await runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
      claimStore(state.storage.sql);
      ensureSchema(state.storage);
      state.storage.kv.put('do_name', name);
      const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
        const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'client-approval-0001', text: 'Email Sam that Thursday works.' }) }));
        expect(sent.status).toBe(202);
        const { message_id: id } = await sent.json() as { message_id: string };
        await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
        const replyPrompts = model.requests.filter(request => request.includes('Surface: app.'));
        expect(replyPrompts).not.toHaveLength(0);
        for (const request of replyPrompts) {
          expect(request).toContain('Surface: app. Approval delivery: native_buttons.');
          expect(request).not.toContain('Approval delivery: none');
        }
      } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
    });
  });
});
