// A file forwarded on WhatsApp, through the owner object's real admission path, with Meta's webhook shape: a forward carries
// context.forwarded (or frequently_forwarded) and no caption, so the owner's question arrives as its own message after it.
// Graph, the signed directory RPC and R2 are local; the model is scripted.
import { env, runInDurableObject } from 'cloudflare:test';
import { beforeEach, expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { toolOutput } from './fixtures/tool-output';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

type Item = { type?: string; call_id?: string; output?: string; role?: string; content?: unknown };
type RequestBody = { input: string | Item[]; text?: { format?: { name?: string } } };
type Call = { type: 'function_call'; call_id: string; name: string; arguments: string };
const model = vi.hoisted(() => ({ requests: [] as RequestBody[] }));
const replySteps = () => model.requests.filter(request => !request.text?.format);
const outputOf = <T>(request: RequestBody, id: string) => (Array.isArray(request.input) ? request.input : [])
  .filter(item => item.type === 'function_call_output' && item.call_id === id).map(item => toolOutput<T>(item.output!))[0];
// The files a model step was handed, as the Responses API reads them.
const filesOf = (request: RequestBody) => (Array.isArray(request.input) ? request.input : []).flatMap(item => Array.isArray(item.content) ? item.content as { type?: string; filename?: string; file_data?: string; image_url?: string }[] : [])
  .filter(part => part.type === 'input_file' || part.type === 'input_image');
// The model answers a file it was handed. Asked about one it no longer has, it opens it from the upload note, then answers.
const reply = (body: RequestBody): Call[] | string => {
  const text = JSON.stringify(body.input);
  if (filesOf(body).length) return 'Your train leaves at 07:40.';
  const note = /file_id ([0-9a-f-]{36}), revision (\d+)/.exec(text);
  if (text.includes('in that file?') && note && !outputOf(body, 'open')) return [{ type: 'function_call', call_id: 'open', name: 'workspace_read', arguments: JSON.stringify({ file_id: note[1], revision: Number(note[2]) }) }];
  return 'I cannot see that file.';
};
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: RequestBody) => {
    model.requests.push(structuredClone(body));
    const format = body.text?.format?.name;
    const result = format ? format === 'claim_ops'
      ? '{"add":[],"corrections":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}'
      : format === 'reaction' ? '{"reaction":"👌"}' : format === 'task_source_scope' ? '{"decision":"retain","sources":[]}' : '{}'
      : reply(body);
    return { id: 'fixture', output_text: typeof result === 'string' ? result : '', output: Array.isArray(result) ? result : [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));

const OWNER = '00000000-0000-4000-8000-0000000000f1';
const SUBJECT = '15550001111';
// A PDF's second line is a comment of high bytes, so the file is not text.
const PDF = new Uint8Array([...new TextEncoder().encode('%PDF-1.7\n%'), 0xe2, 0xe3, 0xcf, 0xd3, ...new TextEncoder().encode('\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n')]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const TEXT = new TextEncoder().encode('Train 12127 leaves Pune at 07:40.\n');
const MEDIA: Record<string, Uint8Array> = { '1458377352214907': PDF, '879011204771342': PNG, '1093327716028811': TEXT };

beforeEach(() => { model.requests = []; });

const whatsappOwner = (name: string, run: (deliver: (message: Record<string, unknown>) => Promise<void>, logs: string[]) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const bytes = new Map<string, Uint8Array>();
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const fixtureEnv = { ...env, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace, WALDO_FILE_TOOLS: '1',
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
      ARTIFACTS: {
        put: async (key: string, value: Uint8Array) => { bytes.set(key, value.slice()); return null; },
        get: async (key: string) => { const value = bytes.get(key); return value ? { arrayBuffer: async () => value.slice().buffer } : null; },
        delete: async (key: string) => { bytes.delete(key); },
      } as unknown as R2Bucket,
    };
    const logs: string[] = [];
    const log = vi.spyOn(console, 'log').mockImplementation((line: unknown) => { logs.push(String(line)); });
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      const lookup = /^https:\/\/graph\.facebook\.com\/v26\.0\/(\d+)$/.exec(url);
      // Meta's media lookup answers the id with a short-lived URL on its media host, which is fetched with the same bearer.
      if (lookup) return MEDIA[lookup[1]!] ? Response.json({ messaging_product: 'whatsapp', url: `https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=${lookup[1]}&ext=1&hash=x`, mime_type: 'application/octet-stream', id: lookup[1] }) : Response.json({ error: { code: 100 } }, { status: 404 });
      const mid = /^https:\/\/lookaside\.fbsbx\.com\/whatsapp_business\/attachments\/\?mid=(\d+)/.exec(url);
      if (mid) return new Response(MEDIA[mid[1]!]!.slice());
      if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') return Response.json({ messages: [{ id: `wamid.out.${Math.random()}` }] });
      if (url === `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/workspace_owner_binding`) return Response.json({ ...mapping });
      if (url.startsWith(`${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`)) return Response.json(url.endsWith('health_log_recent') ? [] : url.endsWith('assert_channel_presence') ? true : null);
      throw new Error(`local fixture denies unexpected network: ${url}`);
    });
    const instance = new OwnerDO(state, fixtureEnv);
    const deliver = async (message: Record<string, unknown>) => {
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, 'x-waldo-do-name': name, 'x-waldo-origin': 'https://waldo.example' },
        body: JSON.stringify({ messaging_product: 'whatsapp', metadata: { display_phone_number: '15550009999', phone_number_id: 'fictional-phone-id' },
          contacts: [{ profile: { name: 'Owner' }, wa_id: SUBJECT }], messages: [{ from: SUBJECT, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] }),
      }));
      expect(response.status).toBe(200);
      await drainWhatsAppTurns(instance);
    };
    try { await run(deliver, logs); } finally { log.mockRestore(); network.mockRestore(); await state.storage.deleteAlarm(); }
  });

it('a forwarded PDF, then the owner\'s question in its own message: the model opens the kept file and reads it on the question\'s turn', async () => {
  await whatsappOwner('wa-forward-then-ask', async (deliver) => {
    await deliver({ id: 'wamid.HBgMMTU1NTAwMDExMTEVAgASGBQzQTk1', type: 'document', context: { forwarded: true },
      document: { filename: 'Ticket.pdf', mime_type: 'application/pdf', sha256: 'q0qJmOQyQzvbmSc8gq8cHUmDE8pjuSHCiUQ+AHB2h00=', id: '1458377352214907' } });
    expect(filesOf(replySteps().at(-1)!)).toEqual([expect.objectContaining({ type: 'input_file', filename: 'Ticket.pdf' })]);
    const before = replySteps().length;
    await deliver({ id: 'wamid.HBgMMTU1NTAwMDExMTEVAgASGBQzQTk2', type: 'text', text: { body: 'what time is the train in that file?' } });
    const turn = replySteps().slice(before);
    // The question's first step has only the upload note; the model opens the file, and the next step carries it.
    expect(filesOf(turn[0]!)).toEqual([]);
    expect(JSON.stringify(turn[0]!.input)).toContain('workspace_read opens it again');
    expect(outputOf(turn[1]!, 'open')).toMatchObject({ ok: true, data: { text: null, opened: 'attached' } });
    expect(filesOf(turn[1]!)).toEqual([{ type: 'input_file', filename: 'Ticket.pdf', file_data: `data:application/pdf;base64,${btoa(String.fromCharCode(...PDF))}` }]);
  });
}, 60_000);

it('a forwarded document with no file name is read as the PDF its type and bytes say it is', async () => {
  await whatsappOwner('wa-forward-nameless-pdf', async (deliver) => {
    await deliver({ id: 'wamid.nameless', type: 'document', context: { forwarded: true }, document: { mime_type: 'application/pdf', sha256: 'x', id: '1458377352214907' } });
    const prompt = JSON.stringify(replySteps().at(-1)!.input);
    expect(prompt).not.toContain('cannot be read yet');
    expect(filesOf(replySteps().at(-1)!)).toEqual([expect.objectContaining({ type: 'input_file', filename: 'file.pdf', file_data: expect.stringMatching(/^data:application\/pdf;base64,/) })]);
  });
}, 60_000);

it('a frequently forwarded photo is attached as the PNG its bytes are, and a forwarded text file of no declared type as text', async () => {
  await whatsappOwner('wa-forward-png-and-text', async (deliver) => {
    await deliver({ id: 'wamid.png', type: 'image', context: { frequently_forwarded: true }, image: { mime_type: 'image/jpeg', sha256: 'x', id: '879011204771342' } });
    expect(filesOf(replySteps().at(-1)!)).toEqual([expect.objectContaining({ type: 'input_image', image_url: expect.stringMatching(/^data:image\/png;base64,/) })]);
    await deliver({ id: 'wamid.txt', type: 'document', context: { forwarded: true }, document: { filename: 'train', mime_type: 'application/octet-stream', sha256: 'x', id: '1093327716028811' } });
    expect(filesOf(replySteps().at(-1)!)).toEqual([expect.objectContaining({ type: 'input_file', filename: 'train.txt', file_data: expect.stringMatching(/^data:text\/plain;base64,/) })]);
  });
}, 60_000);

it('a forwarded file Meta will not hand over is said to the model and logged by the failing step, never silently dropped', async () => {
  await whatsappOwner('wa-forward-lookup-refused', async (deliver, logs) => {
    await deliver({ id: 'wamid.gone', type: 'document', context: { forwarded: true }, document: { filename: 'Gone.pdf', mime_type: 'application/pdf', sha256: 'x', id: '999' } });
    expect(JSON.stringify(replySteps().at(-1)!.input)).toContain('Owner sent a forwarded file \\"Gone.pdf\\", but it could not be downloaded.');
    expect(logs.map(line => { try { return JSON.parse(line) as { hop?: string }; } catch { return {}; } }).filter(line => line.hop === 'media_download'))
      .toEqual([{ hop: 'media_download', ok: false, kind: 'document', error: 'whatsapp media lookup failed: 404' }]);
  });
}, 60_000);

it('a forwarded Word file reaches the model as its text, named so, and the owner is told it was read as text only', async () => {
  const { Document, Packer, Paragraph } = await import('docx');
  MEDIA['1200000000000001'] = new Uint8Array(await (await Packer.toBlob(new Document({ sections: [{ children: [new Paragraph('Check-in after 14:00 at Gate B.')] }] }))).arrayBuffer());
  await whatsappOwner('wa-forward-docx', async (deliver) => {
    await deliver({ id: 'wamid.docx', type: 'document', context: { forwarded: true },
      document: { filename: 'Booking.docx', mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', sha256: 'x', id: '1200000000000001' } });
    const step = replySteps().at(-1)!;
    expect(JSON.stringify(step.input)).toContain('Owner sent a forwarded file \\"Booking.docx\\", attached as its text only.');
    expect(filesOf(step)).toEqual([{ type: 'input_file', filename: 'Booking.docx.txt', file_data: `data:text/plain;base64,${btoa('Check-in after 14:00 at Gate B.')}` }]);
    // Asked about it later, the model opens the kept Word file and gets its text again.
    const before = replySteps().length;
    await deliver({ id: 'wamid.docx.ask', type: 'text', text: { body: 'when is check-in in that file?' } });
    const opened = replySteps().slice(before)[1]!;
    expect(outputOf(opened, 'open')).toMatchObject({ ok: true, data: { text: null, opened: 'attached' } });
    expect(filesOf(opened)).toEqual([expect.objectContaining({ type: 'input_file', filename: 'Booking.docx.txt' })]);
  });
}, 60_000);
