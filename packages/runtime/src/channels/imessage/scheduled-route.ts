import type { OutboxRoute } from '../delivery-routes';
import { TelegramFinalOutbox, observeSurfaceStatuses, type SurfaceStatus } from '../telegram-final-outbox';
import { IMessageFinalOutbox } from './final-outbox';

// Scheduled work for an owner whose only surface is iMessage goes through the delivery outbox, as WhatsApp's does. Each part
// is frozen into the iMessage outbox, Waldo's custody, under the record's id and the part's place, so sending it again freezes
// the same command; the bridge re-checks the sender before it sends. The record then waits, accepted, for the bridge's report
// and settles its job only on that report: a hand-off alone finishes nothing.
// How long a record waits for that report. The bridge proves a command it never sent not_started within its own deadlines, well
// inside this; past it the record ends unconfirmed.
export const IMESSAGE_ARRIVAL_MS = 24 * 60 * 60_000;

// The outbox hands a record's parts over in order and counts those the surface took, so deliveredParts is this part's place.
// `freeze` answers the command id the part was frozen under.
export const iMessageScheduledRoute = (inner: OutboxRoute, freeze: (id: string, text: string) => Promise<string>, now: () => number = Date.now): OutboxRoute => ({
  ...inner,
  send: async (payload, record) => ({ command_id: await freeze(`${record.id}:${record.deliveredParts ?? 0}`, payload.text) }),
  receipt: result => {
    const id = (result as { command_id?: unknown } | null)?.command_id;
    return typeof id === 'string' && id !== '' ? { providerMessageId: id, arrivalBy: now() + IMESSAGE_ARRIVAL_MS } : null;
  },
});

// The bridge's terminal results on those commands, read as the outbox reads a surface's reports: a message the line recorded
// as sent, or delivered, has arrived; one proved not_started failed. An unknown result is no report, so its record waits out
// arrivalBy and ends unconfirmed. A result settled on the owner side (a hand-off that aged out) counts the same as one the
// bridge reported. Storage only, in one transaction; answers how many delivery records changed.
export const observeIMessageReports = (storage: DurableObjectStorage, subject: string | undefined, now: number): number => storage.transactionSync(() => {
  if (subject === undefined) return 0;
  const addressed = (record: { ownerSubject: string }) => record.ownerSubject === subject;
  const waiting = new Set(new TelegramFinalOutbox(storage.kv).records().filter(r => addressed(r) && (r.status === 'accepted' || r.status === 'pending'))
    .flatMap(r => r.providerMessageIds ?? []).filter((id): id is string => id !== null));
  if (!waiting.size) return 0;
  const statuses = new IMessageFinalOutbox(storage).records().flatMap((row): SurfaceStatus[] => {
    const kind = !waiting.has(row.commandId) ? null : row.result?.state === 'local_recorded' || row.result?.state === 'delivered' ? 'arrived' : row.result?.state === 'rejected' ? 'failed' : null;
    return kind ? [{ id: row.commandId, kind, at: now }] : [];
  });
  return statuses.length ? observeSurfaceStatuses(storage.kv, statuses, addressed, now) : 0;
});
