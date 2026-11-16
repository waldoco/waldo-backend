import type { Change } from './update-cards';

// EVENT_TURNS: a verified, admitted webhook reaches the model as a change the update sweep judges with the owner's calendar and
// mail changes. Its envelope is someone else's text: the sweep reads it as outside content, and a batch that carries one is never
// a run Waldo started, so every effect it asks for is a card until its source is reviewed. The owner object is the only writer.
type Kv = Readonly<{ get<T>(key: string): T | undefined; put(key: string, value: unknown): void }>;
const KEY = 'webhook_changes_v1';
// Bounds the waiting queue between sweeps; past it the oldest give way, and the count says how many did.
export const WEBHOOK_CHANGES_MAX = 50;
const WEBHOOK_REF = 'webhook:';

export type WebhookEnvelope = Readonly<{ kind: string; title: string; detail?: string; url?: string; occurred_at?: string }>;
const cut = (value: unknown, max: number): string | undefined => typeof value === 'string' && value.trim() ? value.slice(0, max) : undefined;

export const webhookChange = (source: string, delivery: string, envelope: WebhookEnvelope): Change => ({
  source: 'webhook', kind: 'new', ref: `${WEBHOOK_REF}${source}:${delivery}`,
  // '<' escaped, so no text of the sender's closes the fence the change is shown in; it reads back the same as JSON.
  detail: JSON.stringify({ source, kind: cut(envelope.kind, 60), title: cut(envelope.title, 200), detail: cut(envelope.detail, 1_000), url: cut(envelope.url, 300), occurred_at: cut(envelope.occurred_at, 40) })
    .replace(/</g, '\\u003c'),
});
// A job whose refs name one carried a webhook, whatever its record holds by the time it is applied.
export const carriesWebhook = (refs: readonly string[]): boolean => refs.some(ref => ref.startsWith(WEBHOOK_REF));

export const webhookChanges = (kv: Kv) => {
  const waiting = (): Change[] => { const stored = kv.get<unknown>(KEY); return Array.isArray(stored) ? stored as Change[] : []; };
  return {
    // How many waiting changes gave way to newer ones (0 when none did).
    add(change: Change): number {
      const next = [...waiting(), change];
      kv.put(KEY, next.slice(-WEBHOOK_CHANGES_MAX));
      return Math.max(0, next.length - WEBHOOK_CHANGES_MAX);
    },
    waiting: (): number => waiting().length,
    // Hands every waiting change to one sweep. Called inside the sweep's transaction, so a sweep that rolls back keeps them.
    take(): readonly Change[] {
      const all = waiting();
      if (all.length) kv.put(KEY, []);
      return all;
    },
  };
};
