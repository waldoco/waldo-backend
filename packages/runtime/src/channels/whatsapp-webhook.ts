import { consoleAuth } from '../identity/console-auth';
import { hex, ownerDirectory, signedRpc, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { newWhatsAppLinkToken, whatsappLinkDirectory, whatsappLinkTokenHash, whatsappLinkUrl, type WhatsAppLinkDirectory } from '../identity/whatsapp-link';
import { createWhatsAppCaller, sendWhatsAppText, WhatsAppApiError, whatsappForwarded } from './whatsapp-api';
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
// Three replies per sender per hour: a live link already answers repeat texts ('pending'), so this bounds waitlist replies
// and links reissued after one expires. The throttle expires each row on its own window, so a shorter window used by
// another caller does not reset this one.
const TEXT_FIRST_REPLIES = 3;
const TEXT_FIRST_WINDOW_SECONDS = 3600;

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

// from is the sender's phone number; Meta omits it when it may not share the number, for a sender with a WhatsApp
// username. from_user_id (the business-scoped user id, BSUID) and contacts[].user_id are always present.
type WaMessage = { from?: string; from_user_id?: string; id?: string; type?: string };
type WaContact = { wa_id?: string; user_id?: string; profile?: { name?: string; username?: string } };
type WaValue = { metadata?: { phone_number_id?: string }; contacts?: WaContact[]; messages?: WaMessage[]; statuses?: unknown[] };
type WaBody = { entry?: { changes?: { value?: WaValue }[] }[] };

const DEFINITE_ADMIT_REFUSALS = new Set([400, 403, 404]);

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
  // An admission the owner could not take for now (unreachable, or a 5xx) answers 503, so Meta redelivers (its non-200
  // retry); the DO dedupes by wamid, so a redelivery of a payload that did land is not run twice. A definite refusal is
  // acknowledged and logged, since Meta would otherwise redeliver it for 7 days: 400 (a malformed batch), 403 (the
  // directory no longer has the sender as this owner's number, or the name does not address it), 404 (the object is not an
  // owner). The message is not handled. Any other answer may be temporary and answers 503. Link-code redemption stays
  // deferred: it is not a message turn.
  let unavailable = false;
  const deferred: Promise<unknown>[] = [];
  for (const { sender, value } of bySender(payload)) {
    let route;
    try { route = await directory.byPresence('whatsapp', sender); } catch (error) {
      console.log(JSON.stringify({ hop: 'whatsapp_route', ok: false, error: String(error) })); unavailable = true; continue;
    }
    if (route) {
      const headers: Record<string, string> = { 'x-waldo-origin': origin, 'x-waldo-whatsapp-subject': route.subject, 'x-waldo-do-name': route.doName };
      if (route.timezone) headers['x-waldo-timezone'] = route.timezone;
      try {
        const admitted = await owners.get(owners.idFromName(route.doName)).fetch('https://telegram-owner/whatsapp-admit', { method: 'POST', body: JSON.stringify(value), headers });
        if (!admitted.ok) { console.log(JSON.stringify({ hop: 'whatsapp_admit', ok: false, status: admitted.status })); if (!DEFINITE_ADMIT_REFUSALS.has(admitted.status)) unavailable = true; }
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
  // At most one reply per sender per 30 days and 20 an hour overall, decided by the directory from the hash alone.
  const onboard = signedRpc(env);
  for (const userId of hiddenNumberSenders(payload)) {
    // The reply is the only answer such a sender can get, so it needs the token and the durable per-sender limit;
    // without either the sender is only logged. The BSUID is never logged.
    if (!onboard || !env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
      console.log(JSON.stringify({ hop: 'whatsapp_hidden_number', ok: true, replied: false }));
      continue;
    }
    const call = createWhatsAppCaller(env.WHATSAPP_ACCESS_TOKEN, env.WHATSAPP_PHONE_NUMBER_ID);
    deferred.push((async () => {
      const senderKey = hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`whatsapp.bsuid.${userId}`)));
      // A prefix of the hash correlates one sender's log lines; the BSUID itself is never logged.
      const sender = senderKey.slice(0, 16);
      try {
        const allowed = (await onboard('whatsapp_onboarding_allowed', `waonboard.${senderKey}`, { p_subject_hash: senderKey })) === true;
        // Meta addresses a BSUID through recipient, never to.
        if (allowed) await call({ recipient: userId, type: 'text', text: { body: WHATSAPP_HIDDEN_NUMBER_REPLY } });
        console.log(JSON.stringify({ hop: 'whatsapp_hidden_number', ok: true, replied: allowed, sender }));
      } catch (error) {
        // Not retried, and the payload is still acked. The Graph status and Meta's error code say why the send was
        // refused (131062: a BSUID recipient is not supported for this message); the response body is never logged.
        const graph = error instanceof WhatsAppApiError ? { status: error.status, code: error.code } : {};
        console.log(JSON.stringify({ hop: 'whatsapp_hidden_number', ok: false, sender, error: error instanceof Error ? error.name : 'unknown', ...graph }));
      }
    })());
  }
  if (deferred.length) waitUntil(Promise.all(deferred));
  if (unavailable) return new Response('unavailable', { status: 503 });
  return new Response('ok');
};
