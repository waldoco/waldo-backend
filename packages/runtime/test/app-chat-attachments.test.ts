// A voice note, photo or file in the app's chat (APP_CHAT_ATTACHMENTS): uploaded first, then sent as the message's one
// attachment, through the real owner object, inbox and the shared media pipeline every chat surface uses. The model is
// scripted and the transcription provider answers from a fixture; every byte is synthetic.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { APP_CHAT_UPLOAD_PATH, appChatUploadResultV1Schema } from '../../contracts/src/app/core';
import { appSubjectFor } from '../src/channels/app-api';
import type { AppInboxRecord } from '../src/channels/app-inbox';
import type { LLMGatewayRequest } from '../src/llm/provider';
import { claimStore } from '../src/memory/claims';
import { ensureSchema } from '../src/tracer/schema';

const model = vi.hoisted(() => ({ requests: [] as string[] }));
vi.mock('../src/channels/telegram-turn', async load => {
  const original = await load<typeof import('../src/channels/telegram-turn')>();
  const gateway = { async complete({ request }: LLMGatewayRequest) {
    const reply = (text: string) => ({ ok: true as const, data: { model: request.model, text, input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } });
    if (request.response_format) return reply('{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}');
    model.requests.push(JSON.stringify(request));
    return reply('Got it.');
  } };
  return { ...original, createTelegramResponder: (...args: Parameters<typeof original.createTelegramResponder>) => { args[11] = gateway; return original.createTelegramResponder(...args); } };
});
const { OwnerDO } = await import('../src/channels/owner-do');

const OWNER_ID = '7c1e5a90-2b3d-4e6f-8a71-0b2c3d4e5f60';
const TRANSCRIPT = 'Move the dentist to Thursday afternoon please';
const directory = { SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'synthetic-publishable', WALDO_ROUTER_HMAC_SECRET: 'synthetic-router-secret' };
const stt = vi.hoisted(() => ({ calls: [] as { name: string; type: string; bytes: number }[], fail: false }));

beforeEach(() => {
  model.requests = []; stt.calls = []; stt.fail = false;
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === 'https://api.openai.com/v1/audio/transcriptions') {
      const file = (init?.body as FormData).get('file') as unknown as File;
      stt.calls.push({ name: file.name, type: file.type, bytes: file.size });
      return stt.fail ? Response.json({ error: { code: 'server_error' } }, { status: 500 }) : Response.json({ text: TRANSCRIPT });
    }
    const fn = /\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    const asked = init?.body && typeof init.body === 'string' ? JSON.parse(init.body) as Record<string, string> : {};
    if (fn === 'app_session_authority') return Response.json({ owner_id: OWNER_ID, do_name: asked.p_do_name, session_hash: asked.p_session_hash, state_version: 0, admission_revision: '1', expires_at: Date.now() + 3_600_000 });
    if (fn === 'owner_runtime_authority') return Response.json({ owner_id: OWNER_ID, auth_user_id: OWNER_ID, do_name: asked.p_do_name, state_version: 1, admission_revision: '5' });
    if (fn === 'health_context_read') return Response.json(null);
    return new Response('unexpected', { status: 500 });
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

type Owner = InstanceType<typeof OwnerDO>;
const bytes = (size: number, fill: number) => new Uint8Array(size).fill(fill);
const base64 = (data: Uint8Array) => btoa(String.fromCharCode(...data));
const fixture = (name: string, switches: Record<string, string | undefined>, work: (o: {
  owner: Owner; state: DurableObjectState;
  upload(kind: string, type: string, body: Uint8Array, fileName?: string): Promise<Response>;
  send(clientId: string, body: Record<string, unknown>): Promise<Response>;
  settled(messageId: string): Promise<AppInboxRecord>;
  staged(): string[];
}) => Promise<void>) => runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
  claimStore(state.storage.sql); ensureSchema(state.storage);
  state.storage.kv.put('do_name', name);
  state.storage.kv.put('app_subject', String(appSubjectFor(name)));
  const quiet = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const owner = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-fixture',
    WALDO_OWNER_TIMEZONE: 'UTC', ELEVENLABS_API_KEY: undefined, SMALLEST_AI_API_KEY: undefined, WALDO_STT_PROVIDER: undefined, WALDO_FILE_TOOLS: '0', ...switches } as never);
  const session = { 'x-waldo-do-name': name, 'x-waldo-app-session-hash': 'b'.repeat(64) };
  try {
    await work({
      owner, state,
      upload: (kind, type, body, fileName) => owner.fetch(new Request(`https://telegram-owner${APP_CHAT_UPLOAD_PATH}`, { method: 'POST', body,
        headers: { ...session, 'content-type': type, 'x-waldo-upload-kind': kind, ...(fileName ? { 'x-waldo-upload-name': fileName } : {}) } })),
      send: (clientId, body) => owner.fetch(new Request('https://telegram-owner/app/v1/chat/main/messages', { method: 'POST',
        headers: { ...session, 'content-type': 'application/json' }, body: JSON.stringify({ client_message_id: clientId, ...body }) })),
      settled: async messageId => {
        let row: AppInboxRecord | undefined;
        await vi.waitFor(() => { row = state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${messageId}`); expect(['completed', 'interrupted']).toContain(row?.state); }, { timeout: 10_000, interval: 20 });
        return row!;
      },
      staged: () => [...state.storage.kv.list({ prefix: 'app_upload' })].map(([key]) => key).filter(key => key.startsWith('app_upload:') || key.startsWith('app_upload_part:')),
    });
  } finally { quiet.mockRestore(); await state.storage.deleteAlarm(); }
});
const uploaded = async (response: Response) => { expect(response.status).toBe(201); return appChatUploadResultV1Schema.parse(await response.json()); };
const admitted = async (response: Response) => { expect(response.status).toBe(202); return (await response.json() as { message_id: string }).message_id; };
const ON = { APP_CHAT_ATTACHMENTS: '1' };

describe('a voice note, photo or file sent in the app chat', { timeout: 30_000 }, () => {
  it('a voice note is transcribed by the shared transcriber, reaches the turn and the owner\'s row, and its audio is not kept', async () => {
    await fixture('attach-voice', ON, async ({ upload, send, settled, staged, state }) => {
      const audio = bytes(48_000, 7);
      const { upload_id, kind, bytes: size } = await uploaded(await upload('voice', 'audio/mp4', audio));
      expect([kind, size]).toEqual(['voice', audio.length]);
      expect(staged().length).toBeGreaterThan(0);
      const id = await admitted(await send('voice-client-0001', { text: '', attachments: [{ upload_id }] }));
      expect((await settled(id)).state).toBe('completed');
      expect(stt.calls).toEqual([{ name: 'voice.m4a', type: 'audio/mp4', bytes: audio.length }]);
      expect(model.requests.join('\n')).toContain(TRANSCRIPT);
      expect(staged()).toEqual([]);
      // The owner's file list points only at media its provider keeps; an app attachment is gone once its message closes.
      const listed = state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'owner_files'").one().n
        ? state.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM owner_files').one().n : 0;
      expect(listed).toBe(0);
    });
  });

  it('a photo goes to the model as an image with its caption, and a file as a readable attachment', async () => {
    await fixture('attach-photo-file', ON, async ({ upload, send, settled, staged }) => {
      const photo = bytes(2_048, 9);
      const shot = await uploaded(await upload('photo', 'image/png', photo));
      await settled(await admitted(await send('photo-client-0001', { text: 'Which of these is the receipt?', attachments: [{ upload_id: shot.upload_id }] })));
      const sent = model.requests.join('\n');
      expect(sent).toContain('Which of these is the receipt?');
      expect(sent).toContain(base64(photo));
      expect(sent).toContain('image/png');

      const pdf = bytes(1_500_000, 5);
      const doc = await uploaded(await upload('file', 'application/pdf', pdf, 'lease.pdf'));
      model.requests = [];
      await settled(await admitted(await send('file-client-0001', { text: '', attachments: [{ upload_id: doc.upload_id }] })));
      expect(model.requests.join('\n')).toContain('application/pdf');
      expect(model.requests.join('\n')).toContain('lease.pdf');
      expect(staged()).toEqual([]);
    });
  });

  it('a voice note that cannot be transcribed still runs the turn and says so, and its audio is still dropped', async () => {
    await fixture('attach-voice-stt-down', ON, async ({ upload, send, settled, staged }) => {
      stt.fail = true;
      const { upload_id } = await uploaded(await upload('voice', 'audio/ogg', bytes(9_000, 3)));
      expect((await settled(await admitted(await send('voice-client-0002', { text: '', attachments: [{ upload_id }] })))).state).toBe('completed');
      expect(model.requests.join('\n')).toContain('could not be transcribed');
      expect(staged()).toEqual([]);
    });
  });

  it('a sent upload cannot be sent again', async () => {
    await fixture('attach-twice', ON, async ({ upload, send, settled }) => {
      const { upload_id } = await uploaded(await upload('photo', 'image/jpeg', bytes(1_000, 1)));
      const first = await admitted(await send('twice-client-0001', { text: 'look', attachments: [{ upload_id }] }));
      expect((await send('twice-client-0002', { text: 'again', attachments: [{ upload_id }] })).status).toBe(409);
      await settled(first);
    });
  });

  it('a photo sent in a thread reaches that thread\'s turn', async () => {
    await fixture('attach-thread', ON, async ({ owner, upload, settled }) => {
      const headers = { 'x-waldo-do-name': 'attach-thread', 'x-waldo-app-session-hash': 'b'.repeat(64), 'content-type': 'application/json' };
      const { thread_id } = await (await owner.fetch(new Request('https://telegram-owner/app/v1/threads', { method: 'POST', headers,
        body: JSON.stringify({ operation_id: '0b6f3c1e-8a2d-4f5b-9c7e-000000000001', title: 'Receipts' }) }))).json() as { thread_id: string };
      const { thread } = await (await owner.fetch(new Request(`https://telegram-owner/app/v1/threads/${thread_id}`, { headers }))).json() as { thread: { revision: number } };
      const photo = bytes(700, 4);
      const { upload_id } = await uploaded(await upload('photo', 'image/webp', photo));
      const sent = await owner.fetch(new Request(`https://telegram-owner/app/v1/threads/${thread_id}/messages`, { method: 'POST', headers,
        body: JSON.stringify({ client_message_id: 'thread-client-0001', text: '', attachments: [{ upload_id }], expected_revision: thread.revision }) }));
      expect((await settled(await admitted(sent))).state).toBe('completed');
      expect(model.requests.join('\n')).toContain(base64(photo));
    });
  });

  it('a file named in any script arrives under that name, percent-encoded; a malformed encoding is refused', async () => {
    await fixture('attach-names', ON, async ({ upload, send, settled }) => {
      const doc = await uploaded(await upload('file', 'application/pdf', bytes(400, 6), encodeURIComponent('Rapport déc 予定.pdf')));
      await settled(await admitted(await send('names-client-0001', { text: '', attachments: [{ upload_id: doc.upload_id }] })));
      expect(model.requests.join('\n')).toContain('Rapport déc 予定.pdf');
      expect((await upload('file', 'application/pdf', bytes(10, 1), '%E0%A4%A')).status).toBe(400);
    });
  });
});

describe('an upload nobody sends', () => {
  it('wakes the owner object at its expiry and is dropped by the alarm there, with attachments since switched off', async () => {
    await fixture('attach-expiry', ON, async ({ upload, send, settled, staged, state }) => {
      const { upload_id, expires_at } = await uploaded(await upload('voice', 'audio/mp4', bytes(5_000, 2)));
      expect(state.storage.kv.get<number>('app_uploads_due_v1')).toBe(expires_at);
      // An upload nobody has sent yet is not an owner message waiting: background work does not yield to it.
      const { ownerMessageWaiting } = await import('../src/channels/owner-first');
      expect(ownerMessageWaiting(state.storage.kv, expires_at)).toBe(false);
      // A message run meanwhile moves the inbox's own wake and leaves the uploads' wake on the waiting upload's expiry.
      await settled(await admitted(await send('expiry-client-001', { text: 'something else first' })));
      expect(state.storage.kv.get<number>('app_uploads_due_v1')).toBe(expires_at);
      expect(await state.storage.getAlarm()).toBeLessThanOrEqual(expires_at);
      const meta = state.storage.kv.get<{ expiresAt: number }>(`app_upload:${upload_id}`)!;
      state.storage.kv.put(`app_upload:${upload_id}`, { ...meta, expiresAt: Date.now() - 1 });
      const off = new OwnerDO(state, { ...env, ...directory, TELEGRAM_BOT_TOKEN: undefined, WALDO_OWNER_TELEGRAM_ID: undefined, OPENAI_API_KEY: 'synthetic-fixture', WALDO_OWNER_TIMEZONE: 'UTC', APP_CHAT_ATTACHMENTS: '0' } as never);
      await off.alarm();
      expect(staged()).toEqual([]);
      expect(state.storage.kv.get('app_uploads_due_v1')).toBeNull();
    });
  });
});

describe('every way an app message closes drops its upload', () => {
  const closes: ReadonlyArray<readonly [string, (inbox: import('../src/channels/app-inbox').AppInbox, id: string, state: DurableObjectState, name: string) => void]> = [
    ['the owner stops it', (inbox, _id, _state, name) => { inbox.cancel(name, 'close-client-0001', 'owner:x'); }],
    ['its session is revoked', (inbox) => { inbox.revokeSession('b'.repeat(64)); }],
    ['its session lapsed before it ran', (inbox, id) => { inbox.claim(id, false); }],
    ['it was running when the object restarted', (inbox, id) => { inbox.claim(id, true); inbox.recover(new Set()); }],
    ['its turn finished', (inbox, id) => { const row = inbox.claim(id, true)!; inbox.settle(row, true); }],
    ['its chat was deleted', (inbox, _id, state) => { state.storage.transactionSync(() => inbox.eraseChat('owner:x')); }],
  ];
  it.each(closes)('when %s', async (why, close) => {
    const name = `attach-close-${closes.findIndex(([each]) => each === why)}`;
    await fixture(name, ON, async ({ state, staged }) => {
      const { AppInbox } = await import('../src/channels/app-inbox');
      const { stageAppUpload } = await import('../src/channels/app-uploads');
      const inbox = new AppInbox(state.storage);
      const upload = stageAppUpload(state.storage, { owner: name, kind: 'voice', mime: 'audio/ogg', name: 'voice.ogg', data: bytes(600_000, 8) }, Date.now());
      if (upload === 'capacity') throw new Error('fixture expected room for one upload');
      const admittedRow = await inbox.admit(name, 'b'.repeat(64), 'close-client-0001', '', 'owner:x', undefined, undefined, upload.id);
      if (admittedRow.kind !== 'admitted') throw new Error('fixture expected the message admitted');
      expect(staged().length).toBe(3);
      close(inbox, admittedRow.record.id, state, name);
      expect(staged()).toEqual([]);
      expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${admittedRow.record.id}`)?.upload).toBeUndefined();
    });
  });
});

describe('what an upload or send is refused', () => {
  it('refuses a type its kind does not take, an unnamed file, an empty body, an over-long caption and an unknown upload id', async () => {
    await fixture('attach-refusals', ON, async ({ upload, send, staged }) => {
      expect((await upload('voice', 'image/png', bytes(10, 1))).status).toBe(415);
      expect((await upload('photo', 'image/heic', bytes(10, 1))).status).toBe(415);
      expect((await upload('file', 'application/pdf', bytes(10, 1))).status).toBe(400);
      expect((await upload('file', 'application/pdf', bytes(10, 1), '../../etc/passwd')).status).toBe(400);
      expect((await upload('sticker', 'image/png', bytes(10, 1))).status).toBe(400);
      expect((await upload('photo', 'image/png', new Uint8Array())).status).toBe(400);
      expect(staged()).toEqual([]);
      const { upload_id } = await uploaded(await upload('photo', 'image/png', bytes(10, 1)));
      // A send that does not parse is refused as every app send always has been.
      expect((await send('caption-client-001', { text: 'x'.repeat(1025), attachments: [{ upload_id }] })).status).toBe(403);
      expect((await send('unknown-client-01', { text: '', attachments: [{ upload_id: `up_${'A'.repeat(22)}` }] })).status).toBe(409);
      expect((await send('empty-client-0001', { text: '' })).status).toBe(403);
    });
  });

  it('caps the uploads waiting to be sent, and drops one left unsent past its hour', async () => {
    await fixture('attach-capacity', ON, async ({ upload, send, staged, state }) => {
      const waiting: { upload_id: string }[] = [];
      for (let n = 0; n < 4; n += 1) waiting.push(await uploaded(await upload('photo', 'image/png', bytes(10, n + 1))));
      expect((await upload('photo', 'image/png', bytes(10, 9))).status).toBe(429);
      const meta = state.storage.kv.get<{ expiresAt: number }>(`app_upload:${waiting[0]!.upload_id}`)!;
      state.storage.kv.put(`app_upload:${waiting[0]!.upload_id}`, { ...meta, expiresAt: Date.now() - 1 });
      expect((await send('expired-client-01', { text: '', attachments: [{ upload_id: waiting[0]!.upload_id }] })).status).toBe(409);
      expect(staged().some(key => key.includes(waiting[0]!.upload_id))).toBe(false);
      await uploaded(await upload('photo', 'image/png', bytes(10, 9)));
    });
  });

  it('with the switch off, has no upload route and refuses a send that names an attachment; a text send is unchanged', async () => {
    await fixture('attach-off', { APP_CHAT_ATTACHMENTS: '0' }, async ({ upload, send, settled, staged, state }) => {
      expect((await upload('photo', 'image/png', bytes(10, 1))).status).toBe(404);
      expect((await send('off-client-00001', { text: 'hi', attachments: [{ upload_id: `up_${'B'.repeat(22)}` }] })).status).toBe(409);
      // One staged while the switch was on is refused once it is off, and left to expire.
      const { stageAppUpload } = await import('../src/channels/app-uploads');
      const earlier = stageAppUpload(state.storage, { owner: 'attach-off', kind: 'photo', mime: 'image/png', name: 'photo.png', data: bytes(10, 1) }, Date.now());
      if (earlier === 'capacity') throw new Error('fixture expected room for one upload');
      expect((await send('off-client-00003', { text: 'hi', attachments: [{ upload_id: earlier.id }] })).status).toBe(409);
      expect(model.requests.join('\n')).not.toContain('hi');
      expect((await settled(await admitted(await send('off-client-00002', { text: 'plain text still works' }))))).toMatchObject({ state: 'completed' });
      expect(model.requests.join('\n')).toContain('plain text still works');
      expect(staged()).toHaveLength(2);
    });
  });
});

describe('a message with an attachment in a running turn\'s chat', () => {
  it('is never folded into that turn, whose note carries words only; a plain waiting message still is', async () => {
    await fixture('attach-no-fold', ON, async ({ state }) => {
      const { AppInbox } = await import('../src/channels/app-inbox');
      const { stageAppUpload } = await import('../src/channels/app-uploads');
      const inbox = new AppInbox(state.storage);
      const staged = stageAppUpload(state.storage, { owner: 'attach-no-fold', kind: 'photo', mime: 'image/png', name: 'photo.png', data: bytes(10, 1) }, Date.now());
      if (staged === 'capacity') throw new Error('fixture expected room for one upload');
      const withPhoto = await inbox.admit('attach-no-fold', 'b'.repeat(64), 'fold-client-0001', '', 'owner:x', undefined, undefined, staged.id);
      const plain = await inbox.admit('attach-no-fold', 'b'.repeat(64), 'fold-client-0002', 'and also this', 'owner:x');
      if (withPhoto.kind !== 'admitted' || plain.kind !== 'admitted') throw new Error('fixture expected both admitted');
      expect(state.storage.transactionSync(() => inbox.fold(withPhoto.record.id, 'app-running'))).toBe(false);
      expect(state.storage.transactionSync(() => inbox.fold(plain.record.id, 'app-running'))).toBe(true);
      expect(state.storage.kv.get<AppInboxRecord>(`app:inbox-record:${withPhoto.record.id}`)?.state).toBe('admitted');
    });
  });
});
