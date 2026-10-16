import { consoleAuth } from '../identity/console-auth';
import { hex, ownerDirectory, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { CONSOLE_AUTH_WINDOW_SECONDS } from './console-signin';
import { createWhatsAppCaller, sendWhatsAppText, whatsappForwarded } from './whatsapp-api';

export type WhatsAppWebhookEnv = Readonly<{
  OWNER_DO?: DurableObjectNamespace;
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

// from is the sender's phone number; Meta omits it when it may not share the number, for a sender with a WhatsApp
// username. from_user_id (the business-scoped user id, BSUID) and contacts[].user_id are always present.
type WaMessage = { from?: string; from_user_id?: string; id?: string; type?: string };
type WaContact = { wa_id?: string; user_id?: string; profile?: { name?: string; username?: string } };
type WaValue = { metadata?: { phone_number_id?: string }; contacts?: WaContact[]; messages?: WaMessage[]; statuses?: unknown[] };
type WaBody = { entry?: { changes?: { value?: WaValue }[] }[] };

// Presences are keyed by phone digits and nothing downstream checks the shape, so only E.164 digits are a sender.
const phoneOf = (message: WaMessage): string | null => message.from && /^\d{1,15}$/.test(message.from) ? message.from : null;

// One payload can carry several senders; each owner's DO receives only its own sender's messages.
const bySender = (body: WaBody): { sender: string; value: WaValue }[] => {
  const out = new Map<string, { sender: string; value: WaValue }>();
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
    const value = change.value ?? {};
    for (const message of value.messages ?? []) {
      const sender = phoneOf(message);
      if (!sender) continue;
      const bucket = out.get(sender) ?? { sender, value: { metadata: value.metadata, messages: [] } };
      (bucket.value.messages as WaMessage[]).push(message);
      out.set(sender, bucket);
    }
  }
  return [...out.values()];
};

// Owners are bound by phone number, so a sender Meta names only by BSUID cannot be routed to one yet: such a sender is
// told so, and their messages, a "waldo CODE" included, go no further.
const hiddenNumberSenders = (body: WaBody): string[] => {
  const out = new Set<string>();
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
    for (const message of change.value?.messages ?? []) if (!phoneOf(message) && message.from_user_id) out.add(message.from_user_id);
  }
  return [...out];
};

const WHATSAPP_HIDDEN_NUMBER_REPLY = "WhatsApp didn't share this chat's phone number, so I can't tell which Waldo account it belongs to and couldn't act on your message. Please use the Waldo app for now.";
// console_auth_throttle's cleanup drops older buckets across all keys, and a bucket's number depends on its window, so
// any window other than the sign-in one is wiped by the next sign-in call. At most one reply per sign-in window.
const HIDDEN_NUMBER_REPLIES = 1;

const linkCode = (body: WaBody, senderId: string): string | null => {
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) {
    for (const message of change.value?.messages ?? []) {
      // A forwarded code is someone else's text, never this sender's setup command.
      if (message.from !== senderId || whatsappForwarded(message)) continue;
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
  if (!env.OWNER_DO) return new Response('not found', { status: 404 });
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
  const owners = env.OWNER_DO;
  const origin = url.origin;
  // Admission before the ack: a payload is acknowledged only after each owner's Durable Object has durably admitted it.
  // A failed or refused admission answers 503, so Meta redelivers (its non-200 retry); the DO dedupes by wamid, so a
  // redelivery of a payload that did land is not run twice. Link-code redemption stays deferred: it is not a message turn.
  let unavailable = false;
  const deferred: Promise<unknown>[] = [];
  for (const { sender, value } of bySender(payload)) {
    let route;
    try { route = await directory.byPresence('whatsapp', sender); } catch (error) {
      console.log(JSON.stringify({ hop: 'whatsapp_route', ok: false, error: String(error) })); unavailable = true; continue;
    }
    if (route) {
      const headers: Record<string, string> = { 'x-waldo-origin': origin, 'x-waldo-whatsapp-subject': route.subject };
      if (route.timezone) headers['x-waldo-timezone'] = route.timezone;
      try {
        const admitted = await owners.get(owners.idFromName(route.doName)).fetch('https://telegram-owner/whatsapp-admit', { method: 'POST', body: JSON.stringify(value), headers });
        if (!admitted.ok) { console.log(JSON.stringify({ hop: 'whatsapp_admit', ok: false, status: admitted.status })); unavailable = true; }
      } catch (error) { console.log(JSON.stringify({ hop: 'whatsapp_admit', ok: false, error: String(error) })); unavailable = true; }
      continue;
    }
    const code = linkCode(payload, sender);
    if (!code || !env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) continue;
    deferred.push((async () => {
      const linked = await directory.redeem('whatsapp', sender, code).catch(() => null);
      const call = createWhatsAppCaller(env.WHATSAPP_ACCESS_TOKEN!, env.WHATSAPP_PHONE_NUMBER_ID!);
      await sendWhatsAppText(call, sender, linked ? 'Linked. This chat now talks to your Waldo.' : 'That code did not work. Get a new one from your console.');
    })().catch((error: unknown) => console.log(JSON.stringify({ hop: 'whatsapp_route', ok: false, error: String(error) }))));
  }
  const auth = consoleAuth(env);
  for (const userId of hiddenNumberSenders(payload)) {
    // The reply is the only answer such a sender can get, so it needs the token and a durable per-sender throttle;
    // without either the sender is only logged. The BSUID is never logged.
    if (!auth || !env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
      console.log(JSON.stringify({ hop: 'whatsapp_hidden_number', ok: true, replied: false }));
      continue;
    }
    const call = createWhatsAppCaller(env.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID);
    deferred.push((async () => {
      const senderKey = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`whatsapp.bsuid.${userId}`)));
      // A prefix of the hash correlates one sender's log lines; the BSUID itself is never logged.
      const sender = senderKey.slice(0, 16);
      try {
        const allowed = await auth.throttle(`wahidden.${senderKey}`, HIDDEN_NUMBER_REPLIES, CONSOLE_AUTH_WINDOW_SECONDS);
        // Meta addresses a BSUID through recipient, never to.
        if (allowed) await call({ recipient: userId, type: 'text', text: { body: WHATSAPP_HIDDEN_NUMBER_REPLY } });
        console.log(JSON.stringify({ hop: 'whatsapp_hidden_number', ok: true, replied: allowed, sender }));
      } catch (error) {
        // Not retried: the slot is spent and the payload is still acked. The Graph status shows whether v21.0 refuses
        // recipient; the response body is never logged.
        const status = error instanceof Error ? /^whatsapp (\d{3}):/.exec(error.message)?.[1] : undefined;
        console.log(JSON.stringify({ hop: 'whatsapp_hidden_number', ok: false, sender, error: error instanceof Error ? error.name : 'unknown', ...(status ? { status: Number(status) } : {}) }));
      }
    })());
  }
  if (deferred.length) waitUntil(Promise.all(deferred));
  if (unavailable) return new Response('unavailable', { status: 503 });
  return new Response('ok');
};
