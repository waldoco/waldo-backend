// Hermetic Telegram ingress seam for two fake owners. Webhook routing and listener are real;
// provider/world state and outbound sends are intercepted. This is a transport smoke only:
// scripted responders here cannot score a W/R model answer or emulate provider effects.
import { handleTelegramWebhook } from '../src/channels/telegram-webhook';
import { TelegramOwnerListener, type TelegramTurnOutcome, type TelegramOwnerApi, type TurnLogEntry } from '../src/channels/telegram-listener';
import type { OwnerDirectory, OwnerRoute } from '../src/identity/owner-directory';

export type IngressRecord = Readonly<{
  owner: string;
  outcome: TelegramTurnOutcome;
  sends: readonly Readonly<{ method: string; request: unknown }>[];
  hops: readonly TurnLogEntry[];
}>;
export type IsolatedIngressWorld = Readonly<{
  deliver(owner: string, text: string): Promise<IngressRecord>;
  snapshot(owner: string): IngressRecord;
}>;

export const isolatedTelegramIngress = (
  identities: Readonly<Record<string, { subject: number; timezone: string }>>,
  respond: (owner: string, text: string) => Promise<string>,
): IsolatedIngressWorld => {
  const routes = new Map<string, OwnerRoute>();
  const buckets = new Map<string, { sends: { method: string; request: unknown }[]; hops: TurnLogEntry[]; outcomes: TelegramTurnOutcome[] }>();
  for (const [name, identity] of Object.entries(identities)) {
    if (!Number.isSafeInteger(identity.subject) || identity.subject <= 0 || routes.has(String(identity.subject))) throw new Error('invalid or duplicate test identity');
    routes.set(String(identity.subject), { doName: name, subject: String(identity.subject), timezone: identity.timezone });
    buckets.set(name, { sends: [], hops: [], outcomes: [] });
  }
  const directory: OwnerDirectory = {
    byPresence: async (provider, subject) => provider === 'telegram' ? routes.get(subject) ?? null : null,
    redeem: async () => null,
  };
  const namespace = {
    idFromName: (name: string) => name,
    get: (name: string) => ({ fetch: async (_url: string, options: RequestInit) => {
      const bucket = buckets.get(name);
      const route = [...routes.values()].find((r) => r.doName === name);
      if (!bucket || !route) throw new Error('unknown test owner route');
      const parsed = JSON.parse(String(options.body)) as { update_id: number; message: { from: { id: number }; chat: { id: number }; text: string } };
      const sender = parsed.message.from.id;
      if (String(sender) !== route.subject || parsed.message.chat.id !== sender ||
          (options.headers as Record<string, string>)['x-waldo-telegram-subject'] !== route.subject) throw new Error('owner substitution at test DO');
      const api: TelegramOwnerApi = {
        setMessageReaction: async (request) => { bucket.sends.push({ method: 'setMessageReaction', request }); },
        sendChatAction: async (request) => { bucket.sends.push({ method: 'sendChatAction', request }); },
        sendMessage: async (request) => { bucket.sends.push({ method: 'sendMessage', request }); return { message_id: bucket.sends.length }; },
      };
      const listener = new TelegramOwnerListener({
        ownerTelegramId: sender, api,
        respond: async (turn) => respond(name, turn.text),
        saveOffset: async () => undefined,
        log: (entry) => bucket.hops.push(entry),
      });
      bucket.outcomes.push(await listener.handle({ updateId: parsed.update_id, messageId: null, senderId: sender, chatId: sender, sentAt: null, text: parsed.message.text }));
      return new Response('ok');
    } }),
  } as unknown as DurableObjectNamespace;
  let sequence = 0;
  const snapshot = (owner: string): IngressRecord => {
    const bucket = buckets.get(owner);
    if (!bucket) throw new Error('unknown test owner');
    return { owner, outcome: bucket.outcomes.at(-1) ?? 'ignored', sends: [...bucket.sends], hops: [...bucket.hops] };
  };
  return {
    snapshot,
    async deliver(owner, text) {
      const subject = identities[owner]?.subject;
      if (subject === undefined) throw new Error('unknown test owner');
      const pending: Promise<unknown>[] = [];
      const response = await handleTelegramWebhook(new Request('https://fixture.invalid/telegram/webhook', {
        method: 'POST', headers: { 'x-telegram-bot-api-secret-token': 'fixture-secret' },
        body: JSON.stringify({ update_id: ++sequence, message: { from: { id: subject }, chat: { id: subject, type: 'private' }, text } }),
      }), { TELEGRAM_WEBHOOK_SECRET: 'fixture-secret', TELEGRAM_OWNER_DO: namespace }, (work) => pending.push(work), directory);
      if (response.status !== 200) throw new Error(`test ingress returned ${response.status}`);
      await Promise.all(pending);
      return snapshot(owner);
    },
  };
};
