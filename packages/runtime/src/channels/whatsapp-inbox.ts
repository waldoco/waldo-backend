// Durable inbox dedupe for WhatsApp ingress (channel invariants: stable provider event IDs,
// durable dedupe, tombstone-never-delete). Meta message IDs are the provider event ID; the
// synthetic sequence counter only orders updates within a turn batch and is never an identity.
//
// Tombstone contract: a processed entry keeps EXACTLY { provider_event_id (the storage key
// suffix), received_at, result } - never the message body or any derived content. Entries are
// never deleted; a redelivery sees the tombstone and is a no-op. A message whose turn failed
// has NO entry, so a later redelivery retries it (at-least-once in, exactly-once effect).
export type WaInboxEntry = Readonly<{ received_at: number; result: 'processed' }>;

// The storage face the DO provides; kv get/put on the DO's transactional storage.
export type WaInboxStore = Readonly<{
  get<T>(key: string): T | undefined;
  put(key: string, value: unknown): void;
}>;

const KEY = 'wa_inbox:';

const log = (ok: boolean, detail: string) => console.log(JSON.stringify({ hop: 'whatsapp_inbox', ok, detail }));

// Splits a batch into fresh messages and replays. A message with no provider ID fails
// closed: Meta always assigns one, so its absence means a malformed or hostile payload.
export const waInboxFilter = <M extends { id?: string }>(messages: readonly M[], store: WaInboxStore): M[] => {
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
    fresh.push(message);
  }
  return fresh;
};

// Tombstone one processed message. Called only after its turn completed - a throw leaves
// no entry, so the next redelivery retries.
export const waInboxMark = (store: WaInboxStore, providerId: string, now: number): void => {
  store.put(KEY + providerId, { received_at: now, result: 'processed' } satisfies WaInboxEntry);
};
