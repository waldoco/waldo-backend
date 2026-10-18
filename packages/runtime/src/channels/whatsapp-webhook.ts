import { ownerDirectory, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { createWhatsAppCaller, sendWhatsAppText, whatsappForwarded } from './whatsapp-api';
import { WHATSAPP_REENGAGEMENT_ERROR } from './whatsapp-window';

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

// Meta accepts a send and reports later what became of it. Three kinds reach the recipient's owner, by message id with the
// time Meta reported it: a refusal for the 24-hour window (a failed status carrying 131047), arrival on the phone (delivered,
// read or played; Meta skips delivered when a message is read at once), and any other failure. `sent` only says Meta's
// servers sent it, and a failure can still follow, so it is dropped with every other status.
type WaStatus = { id?: unknown; status?: unknown; timestamp?: unknown; recipient_id?: unknown; errors?: { code?: unknown }[] };
type WaReport = { id: string; at: number | null };
type WaReports = { refused: WaReport[]; delivered: WaReport[]; failed: WaReport[] };
const ARRIVED = new Set(['delivered', 'read', 'played']);
const statusReports = (body: WaBody): Map<string, WaReports> => {
  const out = new Map<string, WaReports>();
  for (const entry of body.entry ?? []) for (const change of entry.changes ?? []) for (const status of (Array.isArray(change.value?.statuses) ? change.value.statuses : []) as WaStatus[]) {
    if (typeof status?.id !== 'string' || !status.id || typeof status.recipient_id !== 'string' || !status.recipient_id) continue;
    const kind = ARRIVED.has(String(status.status)) ? 'delivered' as const
      : status.status !== 'failed' ? null
        : Array.isArray(status.errors) && status.errors.some(error => error?.code === WHATSAPP_REENGAGEMENT_ERROR) ? 'refused' as const : 'failed' as const;
    if (!kind) continue;
    const at = typeof status.timestamp === 'string' && /^\d{1,12}$/.test(status.timestamp) ? Number(status.timestamp) * 1000 : null;
    const reports = out.get(status.recipient_id) ?? { refused: [], delivered: [], failed: [] };
    reports[kind].push({ id: status.id, at });
    out.set(status.recipient_id, reports);
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
// wakes only that owner's Durable Object. A status callback reaches the owner when it reports a send's outcome: refused for
// the 24-hour window, arrived on the phone, or failed; the rest are acknowledged and dropped.
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
      const headers: Record<string, string> = { 'x-waldo-origin': origin, 'x-waldo-whatsapp-subject': route.subject, 'x-waldo-do-name': route.doName };
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
  // Reports the owner could not take for now (unreachable, or a 5xx) answer 503, so Meta delivers them again; the owner
  // handles each report once. A definite refusal (a 4xx: a subject no longer bound, a malformed batch) is acknowledged,
  // since redelivering it can never succeed.
  for (const [recipient, reports] of statusReports(payload)) {
    try {
      const route = await directory.byPresence('whatsapp', recipient);
      if (!route) continue;
      const taken = await owners.get(owners.idFromName(route.doName)).fetch('https://telegram-owner/whatsapp-status', {
        method: 'POST', body: JSON.stringify(reports), headers: { 'x-waldo-whatsapp-subject': route.subject } });
      if (!taken.ok) { console.log(JSON.stringify({ hop: 'whatsapp_status', ok: false, status: taken.status })); if (taken.status >= 500) unavailable = true; }
    } catch (error) { console.log(JSON.stringify({ hop: 'whatsapp_status', ok: false, error: String(error) })); unavailable = true; }
  }
  if (deferred.length) waitUntil(Promise.all(deferred));
  if (unavailable) return new Response('unavailable', { status: 503 });
  return new Response('ok');
};
