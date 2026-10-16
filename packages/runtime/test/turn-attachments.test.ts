// A file the model attaches to its reply: the tool only queues it for the turn; the host sends it after the reply,
// once, under its own effect intent, and a file WhatsApp cannot carry degrades to a text with the owner link.
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { ATTACH_FILE_MAX_PER_TURN } from '@waldo/contracts';
import { workspaceStore, type WorkspaceState, type WorkspaceStore } from '@waldo/workspace';
import { attachFileHandler } from '../src/tools/live/attach-file';
import { deliverTurnAttachments, turnAttachmentBook, type AttachmentSend } from '../src/channels/turn-attachments';
import { EffectNotAppliedError, EffectUnknownError, ownerEffectLedger } from '../src/channels/owner-effect-ledger';
import { deliverWhatsAppFile, whatsappOutboundKind, type WhatsAppOutboundFile } from '../src/channels/whatsapp-api';
import { TelegramOwnerListener, type TelegramOwnerApi } from '../src/channels/telegram-listener';
import { TelegramPollingAdapter } from '../src/channels/telegram-polling';

const id = (n: number) => `abcdefab-cdef-4abc-8abc-${n.toString(16).padStart(12, '0')}`;
const PDF = new TextEncoder().encode('%PDF-1.4 plan');

const workspace = async () => {
  let state: WorkspaceState = { binding: null, files: [], bodies: [], operations: [] }; let n = 10; const objects = new Map<string, Uint8Array>();
  const store = await workspaceStore({ binding: { ownerId: id(1), environment: 'test', namespace: 'ns', doName: 'owner', doId: 'do', stateVersion: 1, mappingVersion: 1 }, admit: async () => ({ status: 'ok' }),
    metadata: { transaction(f) { const s = structuredClone(state); const r = f(s); state = s; return r; } },
    bodies: { put: async (b, v) => { objects.set(b.blob_id, v); }, get: async b => objects.get(b.blob_id) ?? null, remove: async b => { objects.delete(b.blob_id); } }, now: () => 0, newId: () => id(n++) });
  const write = (path: string, bytes: Uint8Array, mime: string, expected_revision = 0) => store.write({ path, bytes, mime, expected_revision, provenance: 'agent_generated', operation_id: id(n++) });
  return { store, write };
};
const ownerTurn = { authenticatedUserId: 'owner', turnId: 'whatsapp-1', toolCallId: 'call-1', trigger: 'user_message', ownerInitiated: true } as never;

describe('attach_file queues a workspace file for this turn\'s reply', () => {
  it('queues the current revision by its file name, once per file', async () => {
    const { store, write } = await workspace();
    const pdf = await write('reports/plan.pdf', PDF, 'application/pdf');
    const book = turnAttachmentBook();
    const tool = attachFileHandler({ open: async () => store, book });
    expect(await tool.handle({ file_id: pdf.file_id, revision: 1 }, ownerTurn)).toEqual({ ok: true, source_taint: null, data: { queued: true, filename: 'plan.pdf', attachments_left: ATTACH_FILE_MAX_PER_TURN - 1 } });
    expect(await tool.handle({ file_id: pdf.file_id, revision: 1 }, ownerTurn)).toMatchObject({ data: { queued: true, attachments_left: ATTACH_FILE_MAX_PER_TURN - 1 } });
    expect(book.take('whatsapp-1')).toEqual([{ file_id: pdf.file_id, revision: 1, filename: 'plan.pdf', mime: 'application/pdf' }]);
    expect(book.take('whatsapp-1')).toEqual([]);
  });

  it('names the current revision when the model holds an older one, and refuses a missing file', async () => {
    const { store, write } = await workspace();
    const first = await write('plan.md', new TextEncoder().encode('one'), 'text/markdown');
    await write('plan.md', new TextEncoder().encode('two'), 'text/markdown', 1);
    const book = turnAttachmentBook();
    const tool = attachFileHandler({ open: async () => store, book });
    expect(await tool.handle({ file_id: first.file_id, revision: 1 }, ownerTurn)).toMatchObject({ data: { queued: false, reason: 'revision_changed', current_revision: 2 } });
    expect(await tool.handle({ file_id: id(999), revision: 1 }, ownerTurn)).toMatchObject({ data: { queued: false, reason: 'not_found' } });
    expect(await tool.handle({ file_id: 'not-a-file', revision: 1 }, ownerTurn)).toMatchObject({ data: { queued: false, reason: 'not_found' } });
    expect(book.take('whatsapp-1')).toEqual([]);
  });

  it('attaches nothing outside an owner turn, past the per-turn bound, or when the workspace is closed', async () => {
    const { store, write } = await workspace();
    const book = turnAttachmentBook();
    const tool = attachFileHandler({ open: async () => store, book });
    const files = [];
    for (let i = 0; i <= ATTACH_FILE_MAX_PER_TURN; i++) files.push(await write(`f${i}.pdf`, PDF, 'application/pdf'));
    expect(await tool.handle({ file_id: files[0]!.file_id, revision: 1 }, { ...ownerTurn as object, trigger: 'heartbeat' } as never)).toMatchObject({ data: { queued: false, reason: 'not_owner_turn' } });
    expect(await tool.handle({ file_id: files[0]!.file_id, revision: 1 }, { ...ownerTurn as object, ownerInitiated: false } as never)).toMatchObject({ data: { queued: false, reason: 'not_owner_turn' } });
    for (const file of files.slice(0, ATTACH_FILE_MAX_PER_TURN)) expect(await tool.handle({ file_id: file.file_id, revision: 1 }, ownerTurn)).toMatchObject({ data: { queued: true } });
    expect(await tool.handle({ file_id: files.at(-1)!.file_id, revision: 1 }, ownerTurn)).toMatchObject({ data: { queued: false, reason: 'limit_reached', max_per_turn: ATTACH_FILE_MAX_PER_TURN } });
    const closed = attachFileHandler({ open: async () => { throw new Error('run is closed or expired'); }, book: turnAttachmentBook() });
    expect(await closed.handle({ file_id: files[0]!.file_id, revision: 1 }, ownerTurn)).toMatchObject({ data: { queued: false, reason: 'unavailable' } });
    expect(book.take('whatsapp-1')).toHaveLength(ATTACH_FILE_MAX_PER_TURN);
  });
});

// Mirrors the WhatsApp shim: a type WhatsApp cannot carry is refused before any upload.
const whatsappLike = (sent: Array<{ method: string; file?: WhatsAppOutboundFile; text?: string }>, blocked = false): AttachmentSend =>
  (file, fallback) => deliverWhatsAppFile(async (method, body) => {
    const b = body as { file?: WhatsAppOutboundFile; text?: string };
    if (method === 'sendDocument') whatsappOutboundKind(b.file!);
    sent.push({ method, ...b });
    return blocked ? undefined : { messages: [{ id: 'wamid.doc' }] };
  }, 15550001111, file, fallback);

const delivering = (name: string, run: (state: DurableObjectState) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`turn-attachments-${name}-${crypto.randomUUID()}`)), async (_instance, state) => run(state));
const options = (state: DurableObjectState, store: WorkspaceStore, send: AttachmentSend) => ({
  trace: 'whatsapp-1', ownerRef: 'owner', effects: ownerEffectLedger(state.storage, Date.now), open: async () => store, send,
  delivery: { origin: async () => 'https://waldo.example', durable: true },
});

describe('the host sends queued files after the reply', () => {
  it('sends the stored bytes under the file name and records the provider receipt', async () => {
    await delivering('sent', async state => {
      const { store, write } = await workspace();
      const pdf = await write('reports/plan.pdf', PDF, 'application/pdf');
      const sent: Array<{ method: string; file?: WhatsAppOutboundFile }> = [];
      await deliverTurnAttachments([{ file_id: pdf.file_id, revision: 1, filename: 'plan.pdf', mime: 'application/pdf' }], options(state, store, whatsappLike(sent)));
      expect(sent).toEqual([{ method: 'sendDocument', chat_id: 15550001111, file: { bytes: PDF, mime: 'application/pdf', filename: 'plan.pdf' } }]);
      const records = [...state.storage.kv.list<{ tool: string; state: string; receipt: { provider_id: string } }>({ prefix: 'owner:effect:' })].map(([, r]) => r);
      expect(records).toMatchObject([{ tool: 'attach_file', state: 'done', receipt: { provider_id: 'wamid.doc' } }]);
      // The intent names the file, never its bytes or name.
      expect(JSON.stringify(records)).not.toContain('PDF-1.4');
    });
  });

  it('a file WhatsApp cannot carry goes as a text naming it, with the owner link', async () => {
    await delivering('degraded', async state => {
      const { store, write } = await workspace();
      const md = await write('notes/plan.md', new TextEncoder().encode('# Plan'), 'text/markdown');
      const sent: Array<{ method: string; text?: string }> = [];
      await deliverTurnAttachments([{ file_id: md.file_id, revision: 1, filename: 'plan.md', mime: 'text/markdown' }], options(state, store, whatsappLike(sent)));
      expect(sent).toEqual([{ method: 'sendMessage', chat_id: 15550001111, text: `WhatsApp can't carry plan.md (this file type). Open it here: https://waldo.example/console/workspace/file?id=${md.file_id}&revision=1` }]);
    });
  });

  it('a send whose outcome is unknown is never sent again, even when the same turn delivers twice', async () => {
    await delivering('unknown', async state => {
      const { store, write } = await workspace();
      const pdf = await write('plan.pdf', PDF, 'application/pdf');
      let sends = 0;
      const lost: AttachmentSend = async () => { sends += 1; throw new Error('upload connection reset'); };
      const attachment = [{ file_id: pdf.file_id, revision: 1, filename: 'plan.pdf', mime: 'application/pdf' }];
      await expect(deliverTurnAttachments(attachment, options(state, store, lost))).rejects.toBeInstanceOf(EffectUnknownError);
      await expect(deliverTurnAttachments(attachment, options(state, store, lost))).rejects.toBeInstanceOf(EffectUnknownError);
      expect(sends).toBe(1);
    });
  });

  it('a blocked send and a file gone before the send are recorded as not applied, and stop the rest', async () => {
    await delivering('not-applied', async state => {
      const { store, write } = await workspace();
      const one = await write('one.pdf', PDF, 'application/pdf');
      const two = await write('two.pdf', PDF, 'application/pdf');
      const sent: Array<{ method: string }> = [];
      await expect(deliverTurnAttachments([{ file_id: one.file_id, revision: 1, filename: 'one.pdf', mime: 'application/pdf' }, { file_id: two.file_id, revision: 1, filename: 'two.pdf', mime: 'application/pdf' }],
        options(state, store, whatsappLike(sent, true)))).rejects.toBeInstanceOf(EffectNotAppliedError);
      expect(sent).toHaveLength(1);
      await store.tombstone(two.file_id, 1);
      await expect(deliverTurnAttachments([{ file_id: two.file_id, revision: 1, filename: 'two.pdf', mime: 'application/pdf' }], { ...options(state, store, whatsappLike(sent)), trace: 'whatsapp-2' })).rejects.toBeInstanceOf(EffectNotAppliedError);
      expect(sent).toHaveLength(1);
      const states = [...state.storage.kv.list<{ state: string }>({ prefix: 'owner:effect:' })].map(([, r]) => r.state);
      expect(states).toEqual(['rejected', 'rejected']);
    });
  });
});

const OWNER = 15550001111;
const recorder = (blocked = false) => {
  const calls: string[] = [];
  const api: TelegramOwnerApi = {
    setMessageReaction: async () => { calls.push('react'); },
    sendChatAction: async () => { calls.push('typing'); },
    sendMessage: async () => { calls.push('text'); return blocked ? undefined : { messages: [{ id: 'wamid.text' }] }; },
  };
  return { calls, api };
};
const owned = (id: number) => new TelegramPollingAdapter({ getUpdates: async () => [{ update_id: id, message: { message_id: id, date: 1, from: { id: OWNER, is_bot: false, first_name: 'A' }, chat: { id: OWNER, type: 'private' }, text: 'send me the plan' } }] });

describe('the listener hands queued files over only after the reply is out', () => {
  it('runs the attachment step after the reply text and before the done reaction, with the turn trace', async () => {
    const { calls, api } = recorder();
    const traces: string[] = [];
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, surface: 'whatsapp', api, respond: async () => 'Here is the plan.', saveOffset: async () => undefined,
      deliverAttachments: async trace => { calls.push('files'); traces.push(trace); } });
    await expect(listener.pollOnce(owned(7), 0)).resolves.toEqual(['answered']);
    expect(calls.filter(call => call !== 'typing')).toEqual(['react', 'text', 'files', 'react']);
    expect(traces).toEqual(['whatsapp-7']);
  });

  it('a blocked reply sends no files', async () => {
    const { calls, api } = recorder(true);
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, surface: 'whatsapp', api, respond: async () => 'Here is the plan.', saveOffset: async () => undefined,
      deliverAttachments: async () => { calls.push('files'); } });
    await expect(listener.pollOnce(owned(8), 0)).rejects.toThrow('telegram send blocked');
    expect(calls).not.toContain('files');
  });

  it('a failed attachment step fails the WhatsApp turn, so its check-first notice goes out', async () => {
    const { api } = recorder();
    const listener = new TelegramOwnerListener({ ownerTelegramId: OWNER, surface: 'whatsapp', api, respond: async () => 'Here is the plan.', saveOffset: async () => undefined,
      deliverAttachments: async () => { throw new EffectUnknownError(); } });
    await expect(listener.pollOnce(owned(9), 0)).rejects.toBeInstanceOf(EffectUnknownError);
  });
});
