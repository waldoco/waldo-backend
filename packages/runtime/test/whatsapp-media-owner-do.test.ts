// WhatsApp media through the owner object's real admission path: a document reaches the turn as an attached file, a video
// gets the honest unsupported reply instead of silence, and Waldo marks the owner's message read with the typing indicator
// while it works.
import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it, vi } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { drainWhatsAppTurns } from './helpers/whatsapp-drain';

const { modelInputs } = vi.hoisted(() => ({ modelInputs: [] as unknown[] }));
vi.mock('openai', () => ({ default: class {
  responses = { create: async (body: unknown) => {
    modelInputs.push(body);
    return { id: `fixture-${modelInputs.length}`, output_text: 'Your train is at 07:40.', output: [], usage: { input_tokens: 1, output_tokens: 1, input_tokens_details: { cached_tokens: 0 } } };
  } };
} }));

const OWNER = '00000000-0000-4000-8000-0000000000e1';
const SUBJECT = '15550001111';
type GraphCall = Record<string, unknown>;

const whatsappOwner = (name: string, run: (deliver: (message: Record<string, unknown>) => Promise<void>, graph: GraphCall[], storage: DurableObjectStorage) => Promise<void>, extraEnv: Record<string, string> = {}) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(name)), async (_instance, state) => {
    const bytes = new Map<string, Uint8Array>();
    const graph: GraphCall[] = [];
    const mapping = { owner_id: OWNER, environment: 'fixture', namespace: 'fixture-owner-namespace', do_name: name, do_id: state.id.toString(), state_version: 0, mapping_version: 1 };
    const fixtureEnv = { ...env, OPENAI_API_KEY: 'fictional-model-key', WHATSAPP_ACCESS_TOKEN: 'fictional-whatsapp-token', WHATSAPP_PHONE_NUMBER_ID: 'fictional-phone-id',
      WALDO_ENVIRONMENT: mapping.environment, WALDO_OWNER_DO_NAMESPACE: mapping.namespace,
      SUPABASE_PROJECT_URL: 'https://signed-metadata.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable', WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
      ARTIFACTS: {
        put: async (key: string, value: Uint8Array) => { bytes.set(key, value.slice()); return null; },
        get: async (key: string) => { const value = bytes.get(key); return value ? { arrayBuffer: async () => value.slice().buffer } : null; },
        delete: async (key: string) => { bytes.delete(key); },
      } as unknown as R2Bucket, ...extraEnv,
    };
    const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === 'https://graph.facebook.com/v26.0/media-doc') return Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=doc' });
      if (url === 'https://graph.facebook.com/v26.0/media-zip') return Response.json({ url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=zip' });
      if (url.endsWith('mid=zip')) return new Response(new Uint8Array([0x50, 0x4b, 0x05, 0x06, ...new Array(18).fill(0)]), { headers: { 'content-type': 'application/zip' } });
      if (url.startsWith('https://lookaside.fbsbx.com/')) return new Response('Fictional itinerary: train leaves at 07:40.', { headers: { 'content-type': 'text/plain' } });
      if (url === 'https://graph.facebook.com/v26.0/fictional-phone-id/messages') { graph.push(JSON.parse(String(init?.body))); return Response.json({ messages: [{ id: `wamid.out.${graph.length}` }] }); }
      if (url === `${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/workspace_owner_binding`) return Response.json({ ...mapping });
      if (url.startsWith(`${fixtureEnv.SUPABASE_PROJECT_URL}/rest/v1/rpc/`)) return Response.json(url.endsWith('health_log_recent') ? [] : url.endsWith('assert_channel_presence') ? true : null);
      throw new Error(`local fixture denies unexpected network: ${url}`);
    });
    const instance = new OwnerDO(state, fixtureEnv);
    const deliver = async (message: Record<string, unknown>) => {
      const response = await instance.fetch(new Request('https://telegram-owner/whatsapp-admit', {
        method: 'POST', headers: { 'x-waldo-whatsapp-subject': SUBJECT, 'x-waldo-do-name': name, 'x-waldo-origin': 'https://waldo.example' },
        body: JSON.stringify({ messages: [{ from: SUBJECT, timestamp: String(Math.floor(Date.now() / 1000)), ...message }] }),
      }));
      expect(response.status).toBe(200);
      await drainWhatsAppTurns(instance);
    };
    try { await run(deliver, graph, state.storage); } finally { network.mockRestore(); await state.storage.deleteAlarm(); }
  });

const texts = (graph: readonly GraphCall[]) => graph.flatMap(call => typeof (call.text as { body?: unknown } | undefined)?.body === 'string' ? [(call.text as { body: string }).body] : []);

it('a document reaches the turn as an attached file, the owner\'s message is marked read with typing, and the reply goes out', async () => {
  await whatsappOwner('wa-media-document', async (deliver, graph) => {
    await deliver({ id: 'wamid.doc', type: 'document', document: { id: 'media-doc', filename: 'itinerary.txt', mime_type: 'text/plain', caption: 'when is my train?' } });
    const prompt = JSON.stringify(modelInputs);
    expect(prompt).toContain('when is my train?');
    expect(prompt).toContain('Owner sent a file \\"itinerary.txt\\", attached.');
    expect(graph).toContainEqual({ messaging_product: 'whatsapp', status: 'read', message_id: 'wamid.doc', typing_indicator: { type: 'text' } });
    expect(texts(graph)).toContain('Your train is at 07:40.');
  });
}, 60_000);

it('a captioned video starts a turn on its caption, and the model is told the video itself was not seen', async () => {
  await whatsappOwner('wa-media-video-caption', async (deliver) => {
    await deliver({ id: 'wamid.video.c', type: 'video', video: { id: 'media-video', caption: 'what do you think of my serve?' } });
    expect(JSON.stringify(modelInputs.at(-1))).toContain("Sent a video Waldo can't watch yet. Its caption: what do you think of my serve?");
  });
}, 60_000);

it('a video gets the honest unsupported reply and starts no turn', async () => {
  await whatsappOwner('wa-media-video', async (deliver, graph) => {
    const turns = modelInputs.length;
    await deliver({ id: 'wamid.video', type: 'video', video: { id: 'media-video' } });
    expect(texts(graph).some(text => /can read text, photos, documents and voice notes/.test(text))).toBe(true);
    expect(modelInputs.slice(turns).filter(input => JSON.stringify(input).includes('wamid.video'))).toEqual([]);
  });
}, 60_000);

it.each(['1', '0'])('a zip on WhatsApp with WALDO_FILE_TOOLS=%s: kept in the owner\'s workspace and named to the model, or the old note', async (on) => {
  await whatsappOwner(`wa-media-zip-${on}`, async (deliver, _graph, storage) => {
    await deliver({ id: 'wamid.zip', type: 'document', document: { id: 'media-zip', filename: 'photos.zip', mime_type: 'application/zip', caption: 'what is in this?' } });
    const prompt = JSON.stringify(modelInputs.at(-1));
    const manifest = storage.sql.exec<{ state_json: string }>('SELECT state_json FROM workspace_manifest').toArray()[0];
    const files = manifest ? (JSON.parse(manifest.state_json) as { files: { path: string; provenance: string; file_id: string }[] }).files : [];
    if (on === '1') {
      expect(files).toEqual([expect.objectContaining({ path: expect.stringMatching(/^uploads\/[0-9a-f]{8}\/photos\.zip$/), provenance: 'owner_upload' })]);
      expect(prompt).toContain(`Saved in their workspace as ${files[0]!.path}`);
      expect(prompt).not.toContain('cannot be read yet');
    } else {
      expect(files).toEqual([]);
      expect(prompt).toContain('Owner sent a file \\"photos.zip\\". This file type cannot be read yet.');
    }
  }, { WALDO_FILE_TOOLS: on });
}, 60_000);
