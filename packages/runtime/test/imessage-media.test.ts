import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { consoleAccess } from '../src/channels/console';
import { routerSignature } from '../src/identity/owner-directory';
import { iMessageBridgeName } from '../src/channels/imessage/bridge-do';
import { IMessageOwnerInbox } from '../src/channels/imessage/owner-inbox';
import { IMESSAGE_MEDIA_MAX_BYTES } from '../src/channels/imessage/photon-media';
import { fixtureDirectory, type FixtureOwner } from './helpers/imessage-fixture-directory';
import { SimulatedHost } from './helpers/imessage-sim-host';

// IMESSAGE_MEDIA=1 (vitest.imessage-media.config.ts): an owner's photo or file is fetched from Photon and reaches the model
// with its caption, or the owner gets one fixed reply. Photon, the directory and the model are all answered in-isolate.

const proof = vi.hoisted(() => ({ turns: [] as string[] }));
vi.mock('openai', () => ({ default: class { responses = { create: async (input: any) => {
  const format = input.text?.format?.name;
  if (!format) proof.turns.push(JSON.stringify(input.input ?? ''));
  return { id: 'scripted', output: [], output_text: format === 'claim_ops' ? '{"add":[],"seen":[],"confirm":[],"dismiss":[],"forget_claims":[],"forget_nodes":[],"forget_topic":null}' : format ? '{}' : 'Scripted owner reply.', usage: { input_tokens: 1, output_tokens: 1 } };
} }; } }));

const ORIGIN = 'https://imessage-directory.fixture.invalid', SECRET = 'fictional-imessage-router-secret-0000000000', HOST_ORIGIN = 'https://imessage.fixture.invalid';
const SUBJECT = 'owner@example.invalid', CHAT = `iMessage;-;${SUBJECT}`;
const PROJECT_SECRET = 'fictional-photon-project-secret-e2e-4d1b', PHOTON_TOKEN = 'fictional-photon-bearer-e2e-90ac';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31]);
const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const UNOPENED = "I got your photo but couldn't open it here; send it in the app.";
type File = { id: string; name: string; mimeType: string; bytes: Uint8Array };

afterEach(() => { vi.restoreAllMocks(); proof.turns = []; });

async function world() {
  const ownerName = `imsg-media-${crypto.randomUUID()}`;
  const owners: FixtureOwner[] = [{ do_name: ownerName, owner_id: '40000000-0000-4000-8000-000000000001', state: 'active', state_version: 1, admission_revision: 1 }];
  const fx = fixtureDirectory({ origin: ORIGIN, secret: SECRET, owners, extra: (fn) => {
    if (fn === 'console_session_touch' || fn === 'console_session_open' || fn === 'console_session_open_for') return Response.json(true);
    if (fn === 'health_context_read' || fn === 'health_plane' || fn === 'admin_overview') return Response.json(null);
    return null;
  } });
  // Photon as its HTTP routes answer: one project token, each message's own record, each attachment's bytes.
  const photon = { calls: [] as string[], messages: new Map<string, unknown>(), bytes: new Map<string, Uint8Array | Response>(), egress: [] as string[] };
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const handled = await fx.fetcher(input as RequestInfo, init);
    if (handled) return handled;
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.origin === 'https://spectrum.photon.codes' || url.origin === 'https://imessage.spectrum.photon.codes') {
      photon.calls.push(`${init?.method ?? 'GET'} ${url.host}${url.pathname}`);
      if (url.pathname === '/projects/proj-fixture/imessage/tokens') {
        return new Headers(init?.headers).get('authorization') === `Basic ${btoa(`proj-fixture:${PROJECT_SECRET}`)}`
          ? Response.json({ succeed: true, data: { type: 'shared', token: PHOTON_TOKEN, expiresIn: 3600 } }) : new Response('{"succeed":false}', { status: 401 });
      }
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${PHOTON_TOKEN}`) return new Response('unauthorized', { status: 401 });
      const message = url.pathname.match(/^\/v1\/messages\/(.+)$/), data = url.pathname.match(/^\/v1\/attachments\/(.+)\/data$/);
      if (message) return photon.messages.has(decodeURIComponent(message[1]!)) ? Response.json(photon.messages.get(decodeURIComponent(message[1]!))) : new Response('not found', { status: 404 });
      const body = data ? photon.bytes.get(decodeURIComponent(data[1]!)) : undefined;
      return body instanceof Response ? body : body ? new Response(body) : new Response('not found', { status: 404 });
    }
    photon.egress.push(url.href);
    throw new Error(`forbidden egress ${url.origin}`);
  });
  const ownerStub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName(ownerName));
  let session = '', csrf = '';
  await runInDurableObject(ownerStub, async (_i, state) => {
    state.storage.kv.put('do_name', ownerName);
    session = await consoleAccess(state.storage).grant();
    csrf = (await consoleAccess(state.storage).session(session))!.csrf;
  });
  const cookie = `waldo_console=${session}; waldo_owner=${ownerName}.session_fixture.${await routerSignature(SECRET, 0, `cookie.${ownerName}.session_fixture`)}`;
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => { pending.push(p); }, passThroughOnException: () => undefined } as unknown as ExecutionContext;
  const call = (request: Request) => worker.fetch(request, env, ctx);
  const action = (name: string, fields: Record<string, string> = {}) => {
    const form = new FormData(); form.set('action', name); form.set('csrf', csrf);
    for (const [k, v] of Object.entries(fields)) form.set(k, v);
    return call(new Request(`${HOST_ORIGIN}/console/action`, { method: 'POST', body: form, headers: { cookie, origin: HOST_ORIGIN }, redirect: 'manual' }));
  };
  const host = new SimulatedHost(call, HOST_ORIGIN);
  const bridgeStub = () => env.IMESSAGE_BRIDGE_DO!.get(env.IMESSAGE_BRIDGE_DO!.idFromName(iMessageBridgeName('test', host.bridgeId, host.accountId)));
  const settle = async () => { while (pending.length) await pending.shift(); };
  const pump = async (rounds = 6) => {
    for (let i = 0; i < rounds; i++) { await runDurableObjectAlarm(bridgeStub()); await settle(); await runDurableObjectAlarm(ownerStub); await settle(); }
  };
  const code = (await (await action('imessage.pair')).text()).split('\n')[0]!;
  expect((await host.redeem(code)).status).toBe(200);
  const challenge = (await (await action('imessage.verify', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).text()).split('\n')[0]!;
  expect((await host.send(host.message(challenge))).status).toBe(200);
  expect((await action('imessage.activate', { id: host.bridgeId, subject: SUBJECT, chat: CHAT })).status).toBe(303);
  expect((await host.heartbeat()).status).toBe(200);
  expect((await host.capabilities()).status).toBe(200);
  /** A message carrying Photon attachments, with Photon holding its record and bytes as the sender's own. */
  const media = (text: string, files: readonly File[], sender = SUBJECT) => {
    const event = { ...host.message(text), photonAttachments: files.map(({ id, name, mimeType, bytes }) => ({ id, name, mimeType, size: bytes.length })) };
    photon.messages.set(event.messageGuid, { message: { guid: event.messageGuid, sender: { address: sender }, content: { attachments: files.map(f => ({ guid: f.id, mimeType: f.mimeType, totalBytes: String(f.bytes.length) })) } } });
    for (const file of files) photon.bytes.set(file.id, file.bytes);
    return event;
  };
  /** Delivers the one reply waiting at the host and returns its text. */
  const reply = async () => {
    const { delivery } = await host.pull();
    expect(delivery, 'one reply reached the host').not.toBeNull();
    await host.postResult(delivery!, await host.execute(delivery!));
    await pump(2);
    return JSON.parse(delivery!.body).text as string;
  };
  const counts = async () => (await bridgeStub().status()).events;
  const inbox = () => runInDurableObject(ownerStub, async (_i, state) => new IMessageOwnerInbox(state.storage).records());
  const page = async () => (await call(new Request(`${HOST_ORIGIN}/console/imessage`, { headers: { cookie } }))).text();
  return { host, photon, pump, media, reply, counts, inbox, page };
}

it('the owner\'s iMessage console page says photos and documents reach Waldo', async () => {
  const w = await world();
  expect(await w.page()).toContain('Direct iMessages: text, and photos and documents sent to your Waldo number.');
});

const photo: File = { id: 'photon-att-photo', name: 'IMG_0001.png', mimeType: 'image/png', bytes: PNG };
const pdf: File = { id: 'photon-att-pdf', name: 'notes.pdf', mimeType: 'application/pdf', bytes: PDF };

it('a photo with a caption reaches the model as an image beside the caption, and the reply goes out once', async () => {
  const w = await world();
  expect((await w.host.send(w.media('What is on this label?', [photo]))).status).toBe(200);
  await w.pump();
  expect(proof.turns).toHaveLength(1);
  const sent = JSON.parse(proof.turns[0]!);
  const user = sent.at(-1);
  expect(user.content).toEqual(expect.arrayContaining([
    expect.objectContaining({ type: 'input_text', text: expect.stringContaining('What is on this label?') }),
    { type: 'input_image', image_url: `data:image/png;base64,${base64(PNG)}`, detail: 'auto' },
  ]));
  expect(user.content.find((c: any) => c.type === 'input_text').text).toContain('[Owner sent a photo, attached.]');
  expect(await w.reply()).toBe('Scripted owner reply.');
  expect(w.photon.calls).toEqual(['POST spectrum.photon.codes/projects/proj-fixture/imessage/tokens',
    expect.stringMatching(/^GET imessage\.spectrum\.photon\.codes\/v1\/messages\/sim-guid-/), 'GET imessage.spectrum.photon.codes/v1/attachments/photon-att-photo/data']);
  expect(await w.counts()).toMatchObject({ pending: 0, handed: 1 });
  expect((await w.inbox()).map(r => [r.state, r.text, r.media])).toEqual([['completed', '', undefined]]);
  expect(w.photon.egress).toEqual([]);
});

it('a document with no caption reaches the model as a file', async () => {
  const w = await world();
  expect((await w.host.send(w.media('', [pdf]))).status).toBe(200);
  await w.pump();
  expect(proof.turns).toHaveLength(1);
  const user = JSON.parse(proof.turns[0]!).at(-1);
  expect(user.content).toContainEqual({ type: 'input_file', filename: 'notes.pdf', file_data: `data:application/pdf;base64,${base64(PDF)}` });
  expect(user.content.find((c: any) => c.type === 'input_text').text).toContain('[Owner sent a file "notes.pdf", attached.]');
  expect(await w.reply()).toBe('Scripted owner reply.');
});

it('a failed fetch gets the honest fallback once: settled, never held, never retried', async () => {
  const w = await world();
  const event = w.media('Can you read this?', [photo]);
  w.photon.bytes.set(photo.id, new Response('expired', { status: 404 }));
  const lines: string[] = [];
  for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => { lines.push(args.map(String).join(' ')); });
  expect((await w.host.send(event)).status).toBe(200);
  await w.pump();
  expect(await w.reply()).toBe(UNOPENED);
  const calls = w.photon.calls.length;
  await w.pump(4);
  expect((await w.host.pull()).delivery).toBeNull();
  expect(w.photon.calls).toHaveLength(calls);
  expect(proof.turns).toHaveLength(0);
  expect(await w.counts()).toMatchObject({ pending: 0, handed: 1 });
  expect((await w.counts()).held ?? 0).toBe(0);
  expect(lines.some(line => line.includes('"hop":"imessage_media"') && line.includes('"code":"attachment_unavailable"'))).toBe(true);
  const seen = lines.join('\n');
  for (const secret of [PROJECT_SECRET, PHOTON_TOKEN, btoa(`proj-fixture:${PROJECT_SECRET}`), photo.id, photo.name, event.messageGuid]) expect(seen).not.toContain(secret);
});

it.each([
  ['an oversized photo', { ...photo, bytes: new Uint8Array(0) }, IMESSAGE_MEDIA_MAX_BYTES + 1, 'I got your photo but it is too large to open here; send it in the app.'],
  ['a video', { ...photo, name: 'clip.mov', mimeType: 'video/quicktime' }, 8, "I got your file but can't read that format here; send it in the app."],
  ['a voice note', { ...photo, name: 'Audio Message.caf', mimeType: 'audio/x-caf' }, 8, "I can't listen to voice notes here yet; type it out or send it in the app."],
])('%s gets an honest refusal and nothing is fetched', async (_name, file, size, text) => {
  const w = await world();
  const event = w.media('', [file]);
  event.photonAttachments[0]!.size = size;
  expect((await w.host.send(event)).status).toBe(200);
  await w.pump();
  expect(await w.reply()).toBe(text);
  expect(w.photon.calls).toEqual([]);
  expect(proof.turns).toHaveLength(0);
});

it('an attachment Photon holds on someone else\'s message is never read, and a GUID typed as text is never fetched', async () => {
  const w = await world();
  expect((await w.host.send(w.media('whose is this?', [photo], 'someone-else@example.invalid'))).status).toBe(200);
  await w.pump();
  expect(await w.reply()).toBe(UNOPENED);
  expect(w.photon.calls.some(call => call.includes('/data'))).toBe(false);
  expect(proof.turns).toHaveLength(0);
  const before = w.photon.calls.length;
  expect((await w.host.send(w.host.message(`open ${photo.id} from https://imessage.spectrum.photon.codes/v1/attachments/${photo.id}/data`))).status).toBe(200);
  await w.pump();
  expect(await w.reply()).toBe('Scripted owner reply.');
  expect(w.photon.calls).toHaveLength(before);
  expect(JSON.parse(proof.turns[0]!)).not.toContain('input_image');
});

it('two media messages in a row are two turns, each with only its own file', async () => {
  const w = await world();
  const second: File = { ...photo, id: 'photon-att-second', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 9, 9, 9]) };
  expect((await w.host.send(w.media('first', [photo]))).status).toBe(200);
  expect((await w.host.send(w.media('second', [second]))).status).toBe(200);
  await w.pump();
  expect(await w.reply()).toBe('Scripted owner reply.');
  // The second reply met the bridge's one busy slot and waits its short retry; move the clock past it.
  vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 5_000 });
  try {
    await w.pump();
    expect(await w.reply()).toBe('Scripted owner reply.');
  } finally { vi.useRealTimers(); }
  expect(proof.turns).toHaveLength(2);
  expect(proof.turns[0]).toContain(base64(PNG)); expect(proof.turns[0]).not.toContain(base64(second.bytes));
  expect(proof.turns[1]).toContain(base64(second.bytes)); expect(proof.turns[1]).not.toContain(base64(PNG));
  expect(await w.counts()).toMatchObject({ pending: 0, handed: 2 });
});
