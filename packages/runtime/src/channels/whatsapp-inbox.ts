// Durable inbox dedupe for WhatsApp ingress (channel invariants: stable provider event IDs,
// durable dedupe, tombstone-never-delete). Meta message IDs are the provider event ID; the
// synthetic sequence counter only orders updates within a turn batch and is never an identity.
//
// Tombstone contract: an entry keeps EXACTLY { provider_event_id (the storage key suffix),
// received_at, result } - never the message body or any derived content. A 'processed'
// tombstone is never deleted; a redelivery sees it and is a no-op. The claim pass writes
// 'processing' SYNCHRONOUSLY, so a concurrent duplicate delivery is suppressed at claim time -
// a filter-then-mark window would let both copies through. A turn failure releases the
// 'processing' claim (claims may be removed; processed tombstones never), so the next
// redelivery retries it: at-least-once in, exactly-once in flight, exactly-once effect.
export type WaInboxEntry = Readonly<{ received_at: number; result: 'processing' | 'processed' }>;

// The storage face the DO provides; kv get/put on the DO's transactional storage.
export type WaInboxStore = Readonly<{
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
  delete(key: string): void;
}>;

const KEY = 'wa_inbox:';

const log = (ok: boolean, detail: string) => console.log(JSON.stringify({ hop: 'whatsapp_inbox', ok, detail }));

// Claims fresh messages and suppresses replays in one synchronous pass: each fresh id gets a
// 'processing' entry immediately, so a second delivery racing the turn sees the claim and is
// suppressed before any await. A message with no provider ID fails closed: Meta always assigns
// one, so its absence means a malformed or hostile payload.
export const waInboxFilter = <M extends { id?: string }>(messages: readonly M[], store: WaInboxStore, now: number): M[] => {
  const fresh: M[] = [];
  for (const message of messages) {
    if (!message.id) {
      log(false, 'missing_provider_id');
      continue;
    }
    if (store.get<WaInboxEntry>(KEY + message.id)) {
      log(true, 'replay_suppressed');
      continue;
    }
    store.put(KEY + message.id, { received_at: now, result: 'processing' } satisfies WaInboxEntry);
    fresh.push(message);
  }
  return fresh;
};

// Release a claim whose turn failed - only ever a 'processing' claim, never a processed
// tombstone. The next redelivery retries from scratch.
export const waInboxRelease = (store: WaInboxStore, providerId: string): void => {
  const entry = store.get<WaInboxEntry>(KEY + providerId);
  if (entry?.result === 'processing') store.delete(KEY + providerId);
};

// Tombstone one processed message. Called only after its turn completed - a throw leaves
// no entry, so the next redelivery retries.
export const waInboxMark = (store: WaInboxStore, providerId: string, now: number): void => {
  store.put(KEY + providerId, { received_at: now, result: 'processed' } satisfies WaInboxEntry);
};
