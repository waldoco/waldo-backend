import { carriesTopic } from '../memory/forget-guard';
import { HEALTH_SPAN_MARKER, redactNumericHealth } from '../scribe/sanitiser';
import { REPLY_QUOTE_LIMIT } from './owner-turn-envelope';

// What the owner's WhatsApp reactions and swipe-replies point at: the words of each message Waldo sent there, by its message
// id (wamid), and the owner's reactions waiting for their next turn. Meta delivers a reaction or a reply to a business
// message only within 30 days of it, so an older record can never be named again and goes; the newest 200 are kept.
// Numbers that could be health readings are masked before anything is kept.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
type Row = Readonly<{ at: number; text: string }>;

const SENT = 'wa_sent:';
const NOTE = 'wa_reaction_note:';
export const WHATSAPP_CONTEXT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SENT_KEPT = 200, NOTES_KEPT = 20;

const trim = (kv: Kv, prefix: string, keep: number, now: number) => {
  const rows = [...kv.list<Row>({ prefix })].sort(([, a], [, b]) => b.at - a.at);
  rows.forEach(([key, row], index) => { if (index >= keep || now - row.at >= WHATSAPP_CONTEXT_RETENTION_MS) kv.delete(key); });
};

export const recordWhatsAppSent = (kv: Kv, id: string, text: string, now: number): void => {
  const words = text.trim();
  if (!id || !words) return;
  kv.put(`${SENT}${id}`, { at: now, text: redactNumericHealth(words, HEALTH_SPAN_MARKER).slice(0, REPLY_QUOTE_LIMIT) } satisfies Row);
  trim(kv, SENT, SENT_KEPT, now);
};

export const whatsappSentText = (kv: Kv, id: string, now: number): string | null => {
  const row = kv.get<Row>(`${SENT}${id}`);
  return row && now - row.at < WHATSAPP_CONTEXT_RETENTION_MS ? row.text : null;
};

// The owner's reaction on a message Waldo sent waits for their next turn as one line. A later reaction on the same message
// replaces it, and taking it back (Meta sends the reaction without an emoji) removes it. A reaction on any other message
// names nothing Waldo can show, so it is not kept.
export const noteWhatsAppReaction = (kv: Kv, target: string, emoji: unknown, now: number): void => {
  const sent = whatsappSentText(kv, target, now);
  if (sent === null) return;
  const key = `${NOTE}${target}`;
  if (typeof emoji !== 'string' || emoji === '' || emoji.length > 32) { kv.delete(key); return; }
  kv.put(key, { at: now, text: `[Owner reacted ${emoji} to your message: ${JSON.stringify(sent)}]` } satisfies Row);
  trim(kv, NOTE, NOTES_KEPT, now);
};

// The waiting lines, oldest first, taken by the turn that reads them.
export const takeWhatsAppReactionNotes = (kv: Kv, now: number): string[] => {
  const rows = [...kv.list<Row>({ prefix: NOTE })];
  for (const [key] of rows) kv.delete(key);
  return rows.filter(([, row]) => now - row.at < WHATSAPP_CONTEXT_RETENTION_MS).sort(([, a], [, b]) => a.at - b.at).map(([, row]) => row.text);
};

// Owner forget: a kept message or a waiting line that carries a forgotten literal goes. Answers the forget stores' shape;
// nothing is left behind, so remaining is always 0.
export const forgetWhatsAppContext = (kv: Kv, texts: readonly string[]): Readonly<{ rewritten: number; remaining: number }> => {
  const needles = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  let rewritten = 0;
  if (needles.length) for (const prefix of [SENT, NOTE]) for (const [key, row] of [...kv.list<Row>({ prefix })]) {
    if (needles.some(needle => carriesTopic(row.text, needle))) { kv.delete(key); rewritten += 1; }
  }
  return { rewritten, remaining: 0 };
};

// What one WhatsApp number was told never reaches the next one.
export const clearWhatsAppContext = (kv: Kv): void => {
  for (const prefix of [SENT, NOTE]) for (const [key] of [...kv.list<unknown>({ prefix })]) kv.delete(key);
};
