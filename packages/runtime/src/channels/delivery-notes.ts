import { carriesTopic } from '../memory/forget-guard';
import { HEALTH_SPAN_MARKER, redactNumericHealth } from '../scribe/sanitiser';
import { redactSecretUrls } from './egress-guard';
import { recordKind } from './proactive-surface';
import { localIso } from './reminders';
import type { FinalRecord } from './telegram-final-outbox';

// A message of Waldo's that ended without reaching the owner, or without proof it did, waits for the owner's next turn as one
// line the model reads beside their words: what it was, where it went, when, why, and how it began. So Waldo never tells the
// owner a message went out when it did not, and can offer it again elsewhere. A record replaced by a newer one, held by the
// surface for later, or cancelled by the owner's own forget is no failure and leaves no line. The newest few are kept, for a week.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void; delete(key: string): unknown; list<T>(options: { prefix: string }): Iterable<[string, T]> }>;
type Row = Readonly<{ at: number; text: string }>;
type Surface = 'telegram' | 'whatsapp' | 'app' | 'imessage';

const NOTE = 'delivery_note:';
const KEPT = 10, RETENTION_MS = 7 * 24 * 60 * 60 * 1000, EXCERPT_CHARS = 200;
const NOT_FAILURES: ReadonlySet<string> = new Set(['superseded', 'owner_forget', 'surface_held']);
const SURFACES: Readonly<Record<Surface, string>> = { app: 'the app', whatsapp: 'WhatsApp', telegram: 'Telegram', imessage: 'iMessage' };
const WHY: Readonly<Record<string, string>> = {
  expired: 'it expired before it could go', lapsed: "it waited 30 days for the owner's WhatsApp window", provider_failed: 'the provider refused it',
  provider_rejected_terminal: 'the provider refused it', surface_unlinked: 'that surface was unlinked', owner_binding: 'that surface no longer admitted the owner',
  egress_blocked: 'the send gate stopped it', delivery_unconfirmed: 'no arrival report came', send_unknown: 'the send ended with no answer',
  restart_during_send: 'a restart cut the send short', invalid_ack: 'the provider gave no usable receipt',
};

export const noteUndelivered = (kv: Kv, record: FinalRecord, surface: Surface, timezone: string, now: number): void => {
  if ((record.status !== 'blocked' && record.status !== 'quarantined') || NOT_FAILURES.has(record.reason ?? '')) return;
  const said = redactNumericHealth(redactSecretUrls((record.payload.fallback_text ?? record.payload.text).trim()).text, HEALTH_SPAN_MARKER);
  const excerpt = said.length > EXCERPT_CHARS ? `${said.slice(0, EXCERPT_CHARS - 1)}…` : said;
  const kind = recordKind(record).replace(/_/g, ' '), what = record.dayCard ? `${kind} (${record.dayCard.card.replace('card:', '')})` : kind;
  const outcome = record.status === 'quarantined' ? 'may not have reached the owner' : 'did not reach the owner';
  const text = `[Delivery: your ${what} for ${SURFACES[surface]}, written ${localIso(record.createdAt, timezone).slice(0, 16).replace('T', ' ')}, ${outcome}`
    + ` (${WHY[record.reason ?? ''] ?? record.reason ?? record.status}). It began: ${JSON.stringify(excerpt)}]`;
  kv.put(`${NOTE}${record.id}`, { at: now, text } satisfies Row);
  const rows = [...kv.list<Row>({ prefix: NOTE })].sort(([, a], [, b]) => b.at - a.at);
  rows.forEach(([key, row], index) => { if (index >= KEPT || now - row.at >= RETENTION_MS) kv.delete(key); });
};

// The waiting lines, oldest first, taken by the turn that reads them.
export const takeDeliveryNotes = (kv: Kv, now: number): string[] => {
  const rows = [...kv.list<Row>({ prefix: NOTE })];
  for (const [key] of rows) kv.delete(key);
  return rows.filter(([, row]) => now - row.at < RETENTION_MS).sort(([, a], [, b]) => a.at - b.at).map(([, row]) => row.text);
};

// Owner forget: a waiting line that carries a forgotten literal goes, whole.
export const forgetDeliveryNotes = (kv: Kv, texts: readonly string[]): Readonly<{ rewritten: number; remaining: number }> => {
  const needles = [...new Set(texts.map(text => text.trim()).filter(Boolean))];
  let rewritten = 0;
  if (needles.length) for (const [key, row] of [...kv.list<Row>({ prefix: NOTE })]) {
    if (needles.some(needle => carriesTopic(row.text, needle))) { kv.delete(key); rewritten += 1; }
  }
  return { rewritten, remaining: 0 };
};
