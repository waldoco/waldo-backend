import { consoleAuth } from '../identity/console-auth';
import { hex, ownerDirectory, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { newWhatsAppLinkToken, whatsappLinkDirectory, whatsappLinkTokenHash, whatsappLinkUrl, type WhatsAppLinkDirectory } from '../identity/whatsapp-link';
import { CONSOLE_AUTH_WINDOW_SECONDS } from './console-signin';
import { createWhatsAppCaller, sendWhatsAppText, whatsappForwarded } from './whatsapp-api';
import { WHATSAPP_REENGAGEMENT_ERROR } from './whatsapp-window';

export type WhatsAppWebhookEnv = Readonly<{
  OWNER_DO?: DurableObjectNamespace;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  // Where a sender with no Waldo account is sent (the waitlist). Unset, the reply carries no link.
  WHATSAPP_ONBOARDING_URL?: string;
}> & OwnerDirectoryEnv;

// Text-first linking for a sender with no owner: the link request and a per-sender reply throttle, both held by the
// directory. Absent (no directory configured), unlinked senders get no reply.
export type WhatsAppTextFirst = Readonly<{ links: WhatsAppLinkDirectory; throttle(key: string, limit: number, windowSeconds: number): Promise<boolean> }>;
const textFirstFromEnv = (env: WhatsAppWebhookEnv): WhatsAppTextFirst | null => {
  const links = whatsappLinkDirectory(env), auth = consoleAuth(env);
  return links && auth ? { links, throttle: (key, limit, windowSeconds) => auth.throttle(key, limit, windowSeconds) } : null;
};
// One reply per sender per 15 minutes: a live link already answers repeat texts ('pending'), so this bounds waitlist
// replies. The window must be the console auth window: console_auth_throttle drops every row two buckets behind the
// caller's own window, so a counter on any longer window is wiped by the next sign-in attempt.
const TEXT_FIRST_REPLIES = 1;
const TEXT_FIRST_WINDOW_SECONDS = CONSOLE_AUTH_WINDOW_SECONDS;

const textFirstReply = async (sender: string, origin: string, env: WhatsAppWebhookEnv, textFirst: WhatsAppTextFirst): Promise<string | null> => {
  const senderKey = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`whatsapp.${sender}`)));
  if (!(await textFirst.throttle(`walink.${senderKey}`, TEXT_FIRST_REPLIES, TEXT_FIRST_WINDOW_SECONDS))) return null;
  const token = newWhatsAppLinkToken();
  const opened = await textFirst.links.open(sender, await whatsappLinkTokenHash(token));
  if (opened === 'opened') return `Tap to link this WhatsApp number to your Waldo. You'll sign in and confirm the number; the link works once, for 10 minutes: ${whatsappLinkUrl(origin, token)}`;
  // pending: the link sent earlier still works, so the sender is not sent a second one.
  if (opened === 'linked' || opened === 'pending') return null;
  const waitlist = /^https:\/\/[^\s]+$/.test(env.WHATSAPP_ONBOARDING_URL ?? '') ? ` Join the waitlist: ${env.WHATSAPP_ONBOARDING_URL}` : '';
  return `Waldo is invite-only for now.${waitlist}\n\nAlready on Waldo? Link WhatsApp from your console.`;
};

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

// Meta can accept a send and refuse it afterwards because the 24-hour window had closed on its clock: a failed status
// carrying 131047. Only those are kept, with the time Meta refused them, grouped by the recipient they were sent to; every
// other status is dropped.
type WaStatus = { id?: unknown; status?: unknown; timestamp?: unknown; recipient_id?: unknown; errors?: { code?: unknown }[] };
type WaRefusal = { id: string; at: number | null };
const windowRefusals = (body: WaBody): Map<string, WaRefusal[]> => {
  const out = new Map<string, WaRefusal[]>();
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) for (const status of (Array.isArray(change.value?.statuses) ? change.value.statuses : []) as WaStatus[]) {
    if (status?.status !== 'failed' || typeof status.id !== 'string' || !status.id || typeof status.recipient_id !== 'string' || !status.recipient_id) continue;
    if (!Array.isArray(status.errors) || !status.errors.some(error => error?.code === WHATSAPP_REENGAGEMENT_ERROR)) continue;
    const at = typeof status.timestamp === 'string' && /^\d{1,12}$/.test(status.timestamp) ? Number(status.timestamp) * 1000 : null;
    out.set(status.recipient_id, [...(out.get(status.recipient_id) ?? []), { id: status.id, at }]);
  }
  return out;
};

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
// wakes only that owner's Durable Object. A status callback reaches the owner only when Meta refused a send for the
// 24-hour window; the rest are acknowledged and dropped.
// A sender with no owner can redeem a one-time console link code ("waldo CODE"); any other message gets the
// text-first reply: a one-tap sign-in link when one owner has this number on file, otherwise the waitlist.
export const handleWhatsAppWebhook = async (
  request: Request,
  env: WhatsAppWebhookEnv,
  waitUntil: (work: Promise<unknown>) => void,
  directory: OwnerDirectory = ownerDirectory(env),
  textFirst: WhatsAppTextFirst | null = textFirstFromEnv(env),
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
    if (!env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) continue;
    if (!code) {
      if (!textFirst) continue;
      // The reply goes straight to the sender: there is no owner yet, so no owner gate applies. It never asks for a
      // link preview, and the link itself is never logged.
      deferred.push((async () => {
        const reply = await textFirstReply(sender, origin, env, textFirst);
        console.log(JSON.stringify({ hop: 'whatsapp_text_first', ok: true, replied: reply !== null }));
        if (reply) await sendWhatsAppText(createWhatsAppCaller(env.WHATSAPP_ACCESS_TOKEN!, env.WHATSAPP_PHONE_NUMBER_ID!), sender, reply);
      })().catch((error: unknown) => console.log(JSON.stringify({ hop: 'whatsapp_text_first', ok: false, error: error instanceof Error ? error.name : 'unknown' }))));
      continue;
    }
    deferred.push((async () => {
      const linked = await directory.redeem('whatsapp', sender, code).catch(() => null);
      const call = createWhatsAppCaller(env.WHATSAPP_ACCESS_TOKEN!, env.WHATSAPP_PHONE_NUMBER_ID!);
      await sendWhatsAppText(call, sender, linked ? 'Linked. This chat now talks to your Waldo.' : 'That code did not work. Get a new one from your console.');
    })().catch((error: unknown) => console.log(JSON.stringify({ hop: 'whatsapp_route', ok: false, error: String(error) }))));
  }
  // A refusal the owner could not take for now (unreachable, or a 5xx) answers 503, so Meta delivers it again; the owner
  // handles each message id once. A definite refusal (a 4xx: a subject no longer bound, a malformed batch) is acknowledged,
  // since redelivering it can never succeed.
  for (const [recipient, refused] of windowRefusals(payload)) {
    try {
      const route = await directory.byPresence('whatsapp', recipient);
      if (!route) continue;
      const taken = await owners.get(owners.idFromName(route.doName)).fetch('https://telegram-owner/whatsapp-status', {
        method: 'POST', body: JSON.stringify({ refused }), headers: { 'x-waldo-whatsapp-subject': route.subject } });
      if (!taken.ok) { console.log(JSON.stringify({ hop: 'whatsapp_status', ok: false, status: taken.status })); if (taken.status >= 500) unavailable = true; }
    } catch (error) { console.log(JSON.stringify({ hop: 'whatsapp_status', ok: false, error: String(error) })); unavailable = true; }
  }
  if (deferred.length) waitUntil(Promise.all(deferred));
  if (unavailable) return new Response('unavailable', { status: 503 });
  return new Response('ok');
};
