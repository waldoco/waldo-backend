import { ownerDirectory, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { createWhatsAppCaller, sendWhatsAppText } from './whatsapp-api';

export type WhatsAppWebhookEnv = Readonly<{
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
}> & OwnerDirectoryEnv;

export const WHATSAPP_WEBHOOK_PATH = '/whatsapp/webhook';

const sameBytes = (given: string, expected: string): boolean => {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

const hmacSha256Hex = async (secret: string, body: string): Promise<string> => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))].map((b) => b.toString(16).padStart(2, '0')).join('');
};

type WaMessage = { from?: string; id?: string; type?: string };
type WaValue = { metadata?: { phone_number_id?: string }; messages?: WaMessage[]; statuses?: unknown[] };
type WaBody = { entry?: { changes?: { value?: WaValue }[] }[] };

// One payload can carry several senders; each owner's DO receives only its own sender's messages.
const bySender = (body: WaBody): { sender: string; value: WaValue }[] => {
  const out = new Map<string, { sender: string; value: WaValue }>();
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
    const value = change.value ?? {};
    for (const message of value.messages ?? []) {
      if (!message.from) continue;
      const bucket = out.get(message.from) ?? { sender: message.from, value: { metadata: value.metadata, messages: [] } };
      (bucket.value.messages as WaMessage[]).push(message);
      out.set(message.from, bucket);
    }
  }
  return [...out.values()];
};

const linkCode = (body: WaBody, senderId: string): string | null => {
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
    for (const message of change.value?.messages ?? []) {
      if (message.from !== senderId) continue;
      const text = (message as { text?: { body?: string } }).text?.body?.trim() ?? '';
      const [command, code] = text.split(/\s+/, 2);
      if (command?.toLowerCase() === 'waldo' && code) return code;
    }
  }
  return null;
};

// The webhook verifies Meta's signature, resolves which owner a WhatsApp sender belongs to and
// wakes only that owner's Durable Object. Status callbacks are acknowledged and dropped.
// A sender with no owner can only redeem a one-time link code ("waldo CODE") from the console.
export const handleWhatsAppWebhook = async (
  request: Request,
  env: WhatsAppWebhookEnv,
  waitUntil: (work: Promise<unknown>) => void,
  directory: OwnerDirectory = ownerDirectory(env),
): Promise<Response> => {
  if (!env.TELEGRAM_OWNER_DO) return new Response('not found', { status: 404 });
  const url = new URL(request.url);
  if (request.method === 'GET') {
    if (url.searchParams.get('hub.mode') === 'subscribe' && env.WHATSAPP_VERIFY_TOKEN && sameBytes(url.searchParams.get('hub.verify_token') ?? '', env.WHATSAPP_VERIFY_TOKEN)) {
      return new Response(url.searchParams.get('hub.challenge') ?? '', { status: 200 });
    }
    return new Response('forbidden', { status: 403 });
  }
  if (request.method !== 'POST' || !env.WHATSAPP_APP_SECRET) return new Response('not found', { status: 404 });
  const body = await request.text();
  const signature = request.headers.get('x-hub-signature-256') ?? '';
  const expected = `sha256=${await hmacSha256Hex(env.WHATSAPP_APP_SECRET, body)}`;
  if (!sameBytes(signature, expected)) return new Response('forbidden', { status: 403 });
  const payload = JSON.parse(body) as WaBody;
  const owners = env.TELEGRAM_OWNER_DO;
  const origin = url.origin;
  waitUntil((async () => {
    for (const { sender, value } of bySender(payload)) {
      const route = await directory.byPresence('whatsapp', sender);
      if (route) {
        const headers: Record<string, string> = { 'x-waldo-origin': origin, 'x-waldo-whatsapp-subject': route.subject };
        if (route.timezone) headers['x-waldo-timezone'] = route.timezone;
        await owners.get(owners.idFromName(route.doName)).fetch('https://telegram-owner/whatsapp-turn', { method: 'POST', body: JSON.stringify(value), headers });
        continue;
      }
      const code = linkCode(payload, sender);
      if (!code || !env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) continue;
      const linked = await directory.redeem('whatsapp', sender, code).catch(() => null);
      const call = createWhatsAppCaller(env.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID);
      await sendWhatsAppText(call, sender, linked ? 'Linked. This chat now talks to your Waldo.' : 'That code did not work. Get a new one from your console.');
    }
  })().catch((error: unknown) => console.log(JSON.stringify({ hop: 'whatsapp_route', ok: false, error: String(error) }))));
  return new Response('ok');
};
