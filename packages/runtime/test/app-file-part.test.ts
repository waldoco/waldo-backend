import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { appHistoryResultV1Schema } from '../../contracts/src/app/core';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { sha256Hex, stableJson } from '../src/context-composer/canonical';
import { ensureSchema } from '../src/tracer/schema';

import { APP_CONTRACT_HEADER } from '../../contracts/src/app/core';
import { replyFilePartV1Schema } from '../../contracts/src/app/parts';
import { artifactBook, r2ArtifactBodies } from '../src/channels/artifacts';

// A PDF the turn exported reaches a chat-4 app as a typed file part it can open; an older reader never receives one.
const probe = vi.hoisted(() => ({ artifact: '' }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const done = (text: string, tool_calls?: Array<{ call_id: string; name: string; arguments: string }>) => ({ ok: true as const, data: { model: request.model, text, ...(tool_calls ? { tool_calls } : {}), input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return done(request.response_format.name === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    const asked = String(request.messages.at(-1)?.content ?? '');
    if (asked.includes('export') && !request.tool_turns?.length) return done('', [{ call_id: 'export', name: 'export_artifact', arguments: JSON.stringify({ artifact_id: probe.artifact, expected_revision: 1, format: 'pdf' }) }]);
    return done('Here it is.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '4b3a2918-0f7e-4d6c-9b5a-4c3d2e1f0a9b';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
beforeEach(() => {
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

const headers = (name: string) => ({ 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'a'.repeat(64), 'content-type': 'application/json' });
const replyTo = async (name: string, text: string, contract?: string) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  const bucket = (env as typeof env & { ARTIFACTS: R2Bucket }).ARTIFACTS;
  probe.artifact = (await artifactBook(state.storage.sql, r2ArtifactBodies(bucket, state.id.toString()), { timezone: 'UTC', now: () => new Date() }, () => crypto.randomUUID())
    .create({ name: 'Fictional boarding pass', kind: 'document', body_markdown: '# Fictional boarding pass\n\nSeat 12A' }, 'test')).id;
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_OWNER_TELEGRAM_ID: undefined });
  try {
    const sent = await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST', headers: headers(name), body: JSON.stringify({ client_message_id: 'files-client-001', text }) }));
    const { message_id: id } = await sent.json() as { message_id: string };
    await vi.waitFor(() => expect(state.storage.kv.get<{ state: string }>(`app:inbox-record:${id}`)?.state).toBe('completed'), { timeout: 10_000, interval: 20 });
    const read = async (revision?: string) => appHistoryResultV1Schema.parse(await (await owner.fetch(new Request('https://telegram-owner/app/v1/chat/main', { headers: { ...headers(name), ...(revision ? { [APP_CONTRACT_HEADER]: revision } : {}) } }))).json())
      .messages.find(message => message.role === 'assistant')!;
    const reply = await read(contract), older = await read();
    const file = reply.parts.find(part => part.type === 'file') as { file_ref: string } | undefined;
    const opened = file ? await owner.fetch(new Request(`https://telegram-owner/app/v1/files/${encodeURIComponent(file.file_ref)}`, { headers: headers(name) })) : undefined;
    return { reply, older, opened: opened ? { status: opened.status, head: new TextDecoder().decode((await opened.arrayBuffer()).slice(0, 5)) } : undefined };
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
});

it('a chat-4 reply carries the exported PDF as a file part the app opens; text and older readers are unchanged', async () => {
  const { reply, older, opened } = await replyTo(`app-files-${crypto.randomUUID()}`, 'please export my boarding pass', 'chat=4');
  const files = reply.parts.filter(part => part.type === 'file');
  expect(files).toHaveLength(1);
  const file = replyFilePartV1Schema.parse(files[0]);
  expect(file).toMatchObject({ name: 'Fictional boarding pass.pdf', mime: 'application/pdf', fallback_text: 'Fictional boarding pass.pdf (PDF)' });
  expect(file.file_ref).toMatch(/^exp:/);
  expect(reply.parts.at(-1)?.type).toBe('receipt');
  expect(opened).toEqual({ status: 200, head: '%PDF-' });
  expect(older.text).toBe(reply.text);
  expect(older.parts.some(part => part.type === 'file')).toBe(false);
});
it('chat 3 never receives a file part', async () => {
  const { reply } = await replyTo(`app-files-3-${crypto.randomUUID()}`, 'please export my boarding pass', 'chat=3');
  expect(reply.parts.some(part => part.type === 'file')).toBe(false);
});
